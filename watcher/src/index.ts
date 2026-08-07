import { main } from './server'

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
