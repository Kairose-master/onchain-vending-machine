# Wiring

## Parts list

- 1× ESP32 dev board (any variant with WiFi — e.g. ESP32-WROOM-32)
- 1× SG90 (or similar) hobby servo — enough torque to push one item off a shelf/spiral
- 1× small vending mechanism — a spiral-coil snack dispenser, a gumball-style gate, or just a servo-actuated trapdoor. Doesn't matter which; the firmware only knows "rotate to X degrees and back"
- USB power for the ESP32; a separate 5V supply for the servo if it's a bigger one than an SG90 (the ESP32's 5V pin can brown out under a big servo's stall current)
- A laptop/Raspberry Pi/always-on machine on the same WiFi network to run the watcher

## Connections

```
ESP32                     SG90 servo
-----                     ----------
GPIO 18  ------------->   signal (orange/yellow wire)
5V       ------------->   V+ (red wire)
GND      ------------->   GND (brown/black wire)
```

Change `SERVO_PIN` in `onchain_vending.ino` if you wire it to a different GPIO.

## Payment side (v1 — deliberately simple)

There's no QR code display or payment-reference generation in v1. The
machine has ONE wallet address and ONE price. Print the address (or a QR
code you generate once, offline, from it) on a sticker on the machine.
Anyone who sends >= the configured price gets one dispense credit — see
`watcher/src/queue.ts` for exactly how that's decided.

Known v1 limitations, stated up front rather than discovered later:
- **No change.** Overpay and you still get exactly one item.
- **No per-purchase reference.** Two people paying at the same moment both
  queue correctly (FIFO), but the machine can't show *you specifically*
  "payment received" faster than "check the queue length went up".
- **LAN only.** The ESP32 talks to the watcher over your local network,
  not the public internet. Fine for a desk/room demo, not for a real
  install — that would need the watcher reachable from outside (a tunnel,
  or hosting it), which is out of scope for v1.

## Bring-up order

1. `cd watcher && npm install && cp .env.example .env`, fill in
   `VENDING_WALLET_ADDRESS` (any wallet you hold the key to — a fresh
   MetaMask account is fine, this is Base Sepolia testnet only).
2. `npm run dev` — confirm it logs `listening on :8787`.
3. From another machine on the same network: `curl http://<watcher-ip>:8787/dispense-queue` should return `{"pending":0}`.
4. Flash `firmware/onchain_vending/onchain_vending.ino`, with `WATCHER_BASE_URL` pointed at that same IP.
5. Get Base Sepolia testnet USDC from a faucet (search "Base Sepolia USDC faucet" — Circle's own faucet supports it) and send >= `PRICE_USDC` to `VENDING_WALLET_ADDRESS`.
6. Within one poll interval, the servo should move.
