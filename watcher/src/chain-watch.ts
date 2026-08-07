/**
 * Reads USDC `Transfer` events to the vending wallet on Base Sepolia.
 * Pure network I/O — no state, no queue logic (queue.ts owns that so it can
 * be tested without an RPC).
 */
import { createPublicClient, http, parseAbiItem } from 'viem'
import { baseSepolia } from 'viem/chains'
import { config } from './config'
import type { PendingPayment } from './queue'

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')

export function makeClient() {
  return createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) })
}

export type Client = ReturnType<typeof makeClient>

/**
 * Every USDC transfer TO the vending wallet in [fromBlock, toBlock].
 * Re-scanning the same block twice across polls is expected and safe —
 * queue.ts dedupes by tx hash.
 */
export async function scanTransfers(client: Client, fromBlock: bigint, toBlock: bigint): Promise<PendingPayment[]> {
  const logs = await client.getLogs({
    address: config.usdcAddress,
    event: TRANSFER_EVENT,
    args: { to: config.vendingWallet },
    fromBlock,
    toBlock,
  })
  return logs.map((log) => ({
    txHash: log.transactionHash,
    from: log.args.from as string,
    amountBaseUnits: (log.args.value as bigint).toString(),
  }))
}
