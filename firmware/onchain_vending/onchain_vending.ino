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

const int SERVO_PIN = 18;
const int SERVO_REST_DEG = 0;
const int SERVO_DISPENSE_DEG = 90;
const unsigned long POLL_INTERVAL_MS = 3000;
const unsigned long SERVO_MOVE_MS = 500; // time to let the servo actually get there

Servo dispenserServo;
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

// Returns the "pending" count from GET /dispense-queue, or -1 on any failure
// (network error, bad JSON, non-200). -1 means "do nothing this tick" —
// never treat a failed read as zero pending, or a flaky WiFi link starves
// a paying customer.
int fetchPendingCount() {
  HTTPClient http;
  http.begin(String(WATCHER_BASE_URL) + "/dispense-queue");
  int code = http.GET();
  if (code != 200) {
    Serial.printf("GET /dispense-queue -> %d\n", code);
    http.end();
    return -1;
  }
  String body = http.getString();
  http.end();

  int key = body.indexOf("\"pending\":");
  if (key == -1) return -1;
  int start = key + strlen("\"pending\":");
  return body.substring(start).toInt();
}

bool ackDispense() {
  HTTPClient http;
  http.begin(String(WATCHER_BASE_URL) + "/dispense-queue/ack");
  int code = http.POST("");
  http.end();
  return code == 200;
}

void dispenseOne() {
  Serial.println("Dispensing one item...");
  dispenserServo.write(SERVO_DISPENSE_DEG);
  delay(SERVO_MOVE_MS);
  dispenserServo.write(SERVO_REST_DEG);
  delay(SERVO_MOVE_MS);

  // Only ack AFTER the physical motion completed — see the file header for why.
  if (!ackDispense()) {
    Serial.println("WARNING: dispensed but ack failed — will retry ack next tick by re-reading pending count");
  }
}

void setup() {
  Serial.begin(115200);
  dispenserServo.attach(SERVO_PIN);
  dispenserServo.write(SERVO_REST_DEG);
  connectWifi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWifi();
  }

  unsigned long now = millis();
  if (now - lastPollAt >= POLL_INTERVAL_MS) {
    lastPollAt = now;
    int pending = fetchPendingCount();
    if (pending > 0) {
      dispenseOne();
    }
  }
}
