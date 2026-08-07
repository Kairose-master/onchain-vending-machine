import { createPublicClient, http, parseAbiItem } from 'viem'
import { baseSepolia } from 'viem/chains'

const pub = createPublicClient({ chain: baseSepolia, transport: http('https://sepolia.base.org') })
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const
const latest = await pub.getBlockNumber()
const logs = await pub.getLogs({
  address: USDC,
  event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
  fromBlock: latest - 1900n,
  toBlock: latest,
})
console.log('transfers in last 1900 blocks:', logs.length)
// Most recent recipients of >= 0.01 USDC
const rich = logs.filter((l) => (l.args.value as bigint) >= 10000n).slice(-5)
for (const l of rich) {
  console.log(`block ${l.blockNumber} to ${l.args.to} value ${l.args.value} tx ${l.transactionHash?.slice(0, 18)}...`)
}
