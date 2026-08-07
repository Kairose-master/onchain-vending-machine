# onchain-vending-machine

A real vending machine that dispenses when it sees an on-chain payment.
Weekend project — zero-value Base Sepolia testnet only, no mainnet path.

```
buyer sends USDC  -->  watcher (Node.js, polls the chain)  -->  ESP32 (WiFi)  -->  servo drops an item
```

## Pieces

| | |
|---|---|
| `watcher/` | Node.js/TypeScript service. Polls Base Sepolia for USDC `Transfer` events to the machine's wallet, queues one dispense credit per qualifying payment, serves two HTTP routes the ESP32 polls. |
| `firmware/onchain_vending/` | ESP32 (Arduino) sketch. Polls the watcher, rotates a servo on a pending credit, acks after the servo actually moves. |
| `docs/wiring.md` | Parts list, pin diagram, bring-up order. |

## Quick start

```bash
cd watcher
npm install
cp .env.example .env   # fill in VENDING_WALLET_ADDRESS
npm run test           # 8 tests, pure queue logic — no chain, no hardware needed
npm run dev
```

Then flash `firmware/onchain_vending/onchain_vending.ino` with your WiFi
creds and the watcher's LAN address. Full bring-up steps: `docs/wiring.md`.

## How a payment becomes a dispense

1. `watcher` polls `getLogs` for USDC `Transfer` events where `to` is the
   machine's wallet (`chain-watch.ts`).
2. Each transfer is fed through `enqueueIfNew` (`queue.ts`, pure, tested):
   dedup by tx hash, and only credits amounts that clear the price. Every
   tx hash is remembered so a restart's re-scan can never double-credit.
3. The ESP32 polls `GET /dispense-queue`. If `pending > 0`, it rotates the
   servo, **then** calls `POST /dispense-queue/ack`. Ack happens after the
   physical motion on purpose — see the comment in the `.ino` file.

## What this deliberately doesn't do (v1)

- No QR code / payment-reference display — one wallet, one price, print the
  address on a sticker. See `docs/wiring.md` for the exact tradeoffs this costs.
- No public internet exposure — ESP32 and watcher must share a LAN.
- No mainnet. This never touches real money; it's a testnet toy.

## License

Do whatever you want with it.
