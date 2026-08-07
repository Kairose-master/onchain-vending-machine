/**
 * Environment config — Base Sepolia only. This is a zero-value testnet toy;
 * there is no path to mainnet in this repo on purpose (see README).
 */
import 'dotenv/config'
import { parseUnits } from 'viem'

function required(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) throw new Error(`${name} is required — copy .env.example to .env and fill it in`)
  return v
}

export const USDC_DECIMALS = 6

// Circle's official Base Sepolia testnet USDC, verified against
// https://developers.circle.com/stablecoins/usdc-contract-addresses (2026-08).
const DEFAULT_USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const DEFAULT_RPC_URL = 'https://sepolia.base.org'

export const config = {
  rpcUrl: process.env.RPC_URL?.trim() || DEFAULT_RPC_URL,
  usdcAddress: (process.env.USDC_ADDRESS?.trim() || DEFAULT_USDC_ADDRESS) as `0x${string}`,
  // The wallet the vending machine "owns" — payments are watched TO this
  // address. No default: shipping a default here would mean two vending
  // machines built from this repo silently share a till.
  vendingWallet: required('VENDING_WALLET_ADDRESS') as `0x${string}`,
  priceBaseUnits: parseUnits(process.env.PRICE_USDC?.trim() || '0.01', USDC_DECIMALS).toString(),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5000),
  port: Number(process.env.PORT ?? 8787),
  // How far back to look on every poll, in blocks. Deliberately re-scans a
  // window past the last-seen block rather than trusting a single stored
  // "last block" cursor — an RPC that briefly reorgs or a process that
  // crashed mid-write should re-see a payment, not lose it. queue.ts's
  // seenTxHashes dedup is what makes re-scanning safe.
  scanWindowBlocks: Number(process.env.SCAN_WINDOW_BLOCKS ?? 500),
  stateFile: process.env.STATE_FILE?.trim() || './state.json',
}
