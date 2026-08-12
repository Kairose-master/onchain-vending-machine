# onchain-vending-machine

A physical machine where **anyone can run a business** — the first node of
the physical-operatorship thesis
([handsel `docs/physical-operatorship.md`](https://github.com/Kairose-master/handsel/blob/main/docs/physical-operatorship.md)).

One pen plotter + one dispenser board + one on-chain wallet, carrying all
three operatorship archetypes as working software:

| Archetype | Lane | Who earns |
|---|---|---|
| **Physical app market** | Recipe gallery — register a card design, earn a royalty per sale | the design's author |
| **Operator market** | Slot market — lease a dispenser channel, stock YOUR goods, set YOUR price | the slot's lessee |
| **Machine labor market** | `[machine:plot]` bounties — external demand posts a job, the machine performs it | the machine (as a Handsel worker) |

Plus the base lane: a customer pays USDC, types a phrase (or uploads an
image), and the pen plotter draws it on a real card.

**Zero-value Base Sepolia testnet only, no mainnet path — by decision.**
Testnet tokens are gifts that cost nothing; real money buys physical goods
only. Every sales counter, royalty and payout shown anywhere is a real
transaction or it is not shown.

```
buyer pays USDC ──> watcher (Node.js, polls Base Sepolia)
                      ├─ exact slot price?  ──> dispense queue ──> ESP32 servo drops the item
                      ├─ >= card price?     ──> kiosk credit  ──> pen plotter draws the card
                      └─ every sale settles on Handsel (escrow → grading → signed proof)
```

## Pieces

| | |
|---|---|
| `watcher/` | The whole booth brain: chain watcher, kiosk web UI, plotter pipeline (fonts → strokes → G-code → GRBL over USB/WiFi), recipe market, slot market, machine-labor worker, Handsel settlement client, on-chain royalty payouts |
| `firmware/onchain_vending/` | ESP32 sketch for the goods dispenser — polls `/slot-dispenses`, fires the right slot's servo, acks after the physical motion |
| `docs/wiring.md` | Dispenser parts list, multi-servo pins, bring-up order |
| `docs/operating-guide.ko.md` | **운영자 매뉴얼 (Korean)** — 설치부터 행사 운영, 트러블슈팅까지 |

## Quick start (dry run — no hardware, no chain money needed)

```bash
cd watcher
npm install
cp .env.example .env        # fill in VENDING_WALLET_ADDRESS (any address you watch)
npm test                    # 85 tests, all pure logic — no chain, no hardware
npm run dev                 # kiosk at http://localhost:8787
```

Without a plotter configured, plots land as G-code files in `./out/` —
every lane works end-to-end in dry-run.

## The lanes, briefly

- **문구/이미지 (base lane)** — pay `PRICE_USDC` to the booth wallet, type a
  phrase or upload an image, the plotter draws it. Fonts: Korean (Nanum Pen)
  and Chinese (Ma Shan Zheng) ship in-repo; the best-covering font wins per
  phrase. Auto-layout fills the card.
- **갤러리 (recipe market)** — register a design (validated by the REAL
  pipeline at registration). Each sale splits `RECIPE_AUTHOR_BPS`
  (default 70/30) and, with a hot key, pays the author on-chain per sale.
- **슬롯 (slot market)** — lease a dispenser channel, stock it physically,
  set a **unique price**. The price is the address: pay a slot's exact
  amount and the machine dispenses from it. Sold-out payments go to a
  refund ledger and are sent back, never silently kept.
- **기계 노동 (machine labor)** — set `MACHINE_WORKER=1`; the booth claims
  external Handsel bounties titled `[machine:plot] …` (with a
  `plot: <text>` line in the description), plots them physically, and
  submits a production record. Evidence class is disclosed: stats and
  G-code — this machine has no camera, and says so.
- **Handsel settlement** — with the `HANDSEL_*` env set, every plotted card
  becomes a real escrowed, graded, proof-carrying job on
  [handsel-nu](https://handsel-nu.vercel.app); the kiosk shows the live
  timeline per card.

Full setup for each lane (env, hardware, payments, troubleshooting):
**`docs/operating-guide.ko.md`**.

## Hardware

Two independent boards:

- **Pen plotter** — a GRBL/ESP32 open kit (60×60mm work area). USB serial
  (`PLOTTER_SERIAL`) or WiFi telnet (`PLOTTER_TCP`, port 23 — the board's
  firmware joins your network in STA mode). Neither set = dry-run.
- **Dispenser** — any ESP32 + one SG90 servo per slot
  (`firmware/onchain_vending/`, `docs/wiring.md`). Optional; the plotter
  lanes work without it.

## License

Do whatever you want with it.
