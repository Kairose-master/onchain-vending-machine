/*
 * onchain_vending — ESP32 firmware.
 *
 * Polls the watcher's HTTP endpoint. When it reports a pending dispense,
 * rotates a servo to drop one item, then ACKs — in that order, on purpose:
 * the servo moves BEFORE the ack, so a crash between them re-shows the item
 * as pending on the next poll (worst case: a free item, never a paid-for
 * item that never arrives, which is the failure mode that actually matters
 * for a machine handling real payments).
 *
 * Board: any ESP32 dev board. Libraries needed (Arduino IDE Library
 * Manager): "ESP32Servo" by Kevin Harrington / John K. Bennett.
 */
#include <WiFi.h>
#include <HTTPClient.h>
#include <ESP32Servo.h>

// ---- fill these in ----
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
// The watcher's address on your local network, e.g. "http://192.168.0.42:8787"
const char* WATCHER_BASE_URL = "http://192.168.0.42:8787";
// ------------------------

// One servo per leased SLOT (the slot market: watcher /slot-dispenses).
// Index 0 = slot 1, index 1 = slot 2, … — match SLOT_COUNT on the watcher.
const int SLOT_SERVO_PINS[] = {18, 19, 21, 22};
const int SLOT_COUNT = sizeof(SLOT_SERVO_PINS) / sizeof(SLOT_SERVO_PINS[0]);
const int SERVO_REST_DEG = 0;
const int SERVO_DISPENSE_DEG = 90;
const unsigned long POLL_INTERVAL_MS = 3000;
const unsigned long SERVO_MOVE_MS = 500; // time to let the servo actually get there

Servo slotServos[SLOT_COUNT];
unsigned long lastPollAt = 0;

void connectWifi() {
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("Connected, IP: ");
  Serial.println(WiFi.localIP());
}

// Returns the next slot to dispense from GET /slot-dispenses, or -1 when
// the queue is empty or on ANY failure (network error, bad JSON, non-200).
// A failed read means "do nothing this tick" — never treat it as empty, or
// a flaky WiFi link starves a paying customer.
int fetchNextSlotId() {
  HTTPClient http;
  http.begin(String(WATCHER_BASE_URL) + "/slot-dispenses");
  int code = http.GET();
  if (code != 200) {
    Serial.printf("GET /slot-dispenses -> %d\n", code);
    http.end();
    return -1;
  }
  String body = http.getString();
  http.end();

  // {"pending":N,"next":{"slotId":K,...}} — or "next":null when empty.
  int key = body.indexOf("\"slotId\":");
  if (key == -1) return -1;
  int start = key + strlen("\"slotId\":");
  int slotId = body.substring(start).toInt();
  if (slotId < 1 || slotId > SLOT_COUNT) {
    Serial.printf("slotId %d out of range (this board has %d) — leaving it queued\n", slotId, SLOT_COUNT);
    return -1;
  }
  return slotId;
}

bool ackDispense() {
  HTTPClient http;
  http.begin(String(WATCHER_BASE_URL) + "/slot-dispenses/ack");
  int code = http.POST("");
  http.end();
  return code == 200;
}

void dispenseFromSlot(int slotId) {
  Serial.printf("Dispensing from slot %d...\n", slotId);
  Servo &servo = slotServos[slotId - 1];
  servo.write(SERVO_DISPENSE_DEG);
  delay(SERVO_MOVE_MS);
  servo.write(SERVO_REST_DEG);
  delay(SERVO_MOVE_MS);

  // Only ack AFTER the physical motion completed — see the file header for why.
  if (!ackDispense()) {
    Serial.println("WARNING: dispensed but ack failed — will retry ack next tick by re-reading the queue");
  }
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < SLOT_COUNT; i++) {
    slotServos[i].attach(SLOT_SERVO_PINS[i]);
    slotServos[i].write(SERVO_REST_DEG);
  }
  connectWifi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWifi();
  }

  unsigned long now = millis();
  if (now - lastPollAt >= POLL_INTERVAL_MS) {
    lastPollAt = now;
    int slotId = fetchNextSlotId();
    if (slotId > 0) {
      dispenseFromSlot(slotId);
    }
  }
}
