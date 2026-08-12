/**
 * Royalty payout — the author's share of a sale, as a REAL Base Sepolia
 * USDC transfer from the booth's hot wallet.
 *
 * Optional, like every on-chain feature here: without ROYALTY_PAYER_KEY
 * (falls back to HANDSEL_PAYER_KEY — the same booth hot wallet that pays
 * x402 fees) shares accrue in the recipe ledger and the kiosk says
 * "적립", never "지급". With it, each sale pays the author immediately and
 * the tx hash lands on the recipe — the receipt IS the demo.
 *
 * Note the one thing x402 spoiled us on: EIP-3009 was gasless, a plain
 * ERC-20 transfer is not. The payer key needs a little Base Sepolia ETH
 * for gas; a payout that fails (usually: no gas) leaves the share accrued
 * and the reason in the log — the customer's card and the author's ledger
 * are both already safe at that point.
 */
import { createWalletClient, createPublicClient, http, erc20Abi, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { config } from './config'

export function royaltyPayerKey(env: NodeJS.ProcessEnv = process.env): Hex | null {
  const raw = (env.ROYALTY_PAYER_KEY ?? env.HANDSEL_PAYER_KEY)?.trim()
  if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) return null
  return raw as Hex
}

export function isRoyaltyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return royaltyPayerKey(env) !== null
}

export async function payRoyalty(
  to: `0x${string}`,
  amountBaseUnits: bigint,
): Promise<{ ok: true; txHash: string } | { ok: false; reason: string }> {
  const key = royaltyPayerKey()
  if (!key) return { ok: false, reason: 'no payer key configured — accruing only' }
  if (amountBaseUnits <= 0n) return { ok: false, reason: 'zero amount' }
  try {
    const account = privateKeyToAccount(key)
    const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(config.rpcUrl) })
    const client = createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) })
    const txHash = await wallet.writeContract({
      address: config.usdcAddress,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [to, amountBaseUnits],
    })
    // Wait for inclusion so the recipe ledger only ever records payouts
    // that actually landed.
    await client.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 })
    return { ok: true, txHash }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
