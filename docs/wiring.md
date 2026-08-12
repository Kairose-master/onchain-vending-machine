# Wiring — the goods dispenser

> 한국어 전체 제작 설명서 (회로 + 골판지 조립 + 캘리브레이션):
> **`docs/dispenser-build.ko.md`**

The dispenser board serves the **slot market**: each leased slot is one
servo channel, and the watcher tells the board which slot to fire per
sale. (The pen plotter is a separate board — a GRBL/ESP32 kit with its own
guide in `docs/operating-guide.ko.md` §2.)

## Parts list

- 1× ESP32 dev board (any variant with WiFi — e.g. ESP32-WROOM-32)
- 1× SG90 (or similar) hobby servo **per slot** — enough torque to push one
  item off a shelf/spiral. Default firmware maps 4 slots.
- 1× small vending mechanism per slot — spiral coil, gumball-style gate, or
  a servo-actuated trapdoor. The firmware only knows "rotate to X and back".
- USB power for the ESP32; a **separate 5V supply** for the servos (the
  ESP32's 5V pin browns out under servo stall current). Use a dumb wall
  adapter — smart chargers cut output at low draw and the servos die
  mid-shift.
- A laptop/Raspberry Pi on the same WiFi network running the watcher.

## Connections

```
ESP32                          servos (SG90)
-----                          -------------
GPIO 18  ─────────────────>    slot 1 signal (orange/yellow)
GPIO 19  ─────────────────>    slot 2 signal
GPIO 21  ─────────────────>    slot 3 signal
GPIO 22  ─────────────────>    slot 4 signal
5V rail (separate supply) ─>   all servo V+ (red)
GND (common!)             ─>   all servo GND (brown/black) + ESP32 GND
```

`SLOT_SERVO_PINS[]` in `onchain_vending.ino` sets the mapping — its length
must match `SLOT_COUNT` in the watcher's `.env`. Ground must be common
between the ESP32 and the servo supply.

## How a payment reaches a servo

There is no QR-per-purchase or payment reference. **The price is the
address**: every leased slot has a unique price (enforced at lease time,
also distinct from the plotter card price), so the exact amount of a USDC
transfer identifies the slot. The watcher routes it, queues a dispense,
and the board:

1. polls `GET /slot-dispenses` → `{"pending":N,"next":{"slotId":K,…}}`
2. fires slot K's servo
3. **then** `POST /slot-dispenses/ack` — ack strictly after the physical
   motion, so a crash between them re-shows the dispense next poll.
   Worst case is a free item, never a paid-for item that never arrived.

Known limitations, stated up front:
- **No change.** Pay a non-matching amount and it routes to the card lane
  (>= card price) or is recorded-but-refused (under it).
- **Sold-out slots refund, not dispense** — the watcher ledgers the payment
  and sends it back when the hot key is configured (`operating-guide.ko.md` §5).
- **LAN only.** The ESP32 talks to the watcher over the local network.

## Bring-up order

1. `cd watcher && npm install && cp .env.example .env`, fill in
   `VENDING_WALLET_ADDRESS` (a fresh wallet you hold the key to — Base
   Sepolia testnet only). Set `SLOT_COUNT` to your servo count.
2. `npm run dev` — confirm `listening on :8787` and the `[slots]` boot line.
3. From another machine on the LAN:
   `curl http://<watcher-ip>:8787/slot-dispenses` → `{"pending":0,"next":null}`.
4. Flash `firmware/onchain_vending/onchain_vending.ino` with your WiFi
   creds and `WATCHER_BASE_URL` pointed at that IP.
5. Lease a slot in the kiosk (슬롯 tab) with a distinct price and stock it.
6. Get Base Sepolia USDC (https://faucet.circle.com) and send the slot's
   **exact price** to `VENDING_WALLET_ADDRESS`.
7. Within one poll interval, that slot's servo moves — and the lessee's
   share pays out (or accrues) per `operating-guide.ko.md` §5.
