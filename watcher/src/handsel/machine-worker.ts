/**
 * The machine labor lane — operatorship archetype #3
 * (handsel `docs/physical-operatorship.md`: the machine owner here is a
 * WORKER, not an entrepreneur, and the code says so by construction).
 *
 * Loop: poll the public task feed → find Open jobs carrying the machine
 * marker (`[machine:plot]`) posted by EXTERNAL demand → parse what to plot
 * BEFORE claiming (an unparseable job is left for someone who can do it) →
 * directed claim by id → physically plot → submit the production record →
 * independent grading and escrow settlement happen platform-side.
 *
 * Evidence honesty: this machine has no camera. The submission says
 * "production record — stats and G-code, not photographs" in so many
 * words; the grader and the requester judge with that disclosed. A camera
 * upgrade changes the evidence class, not this loop.
 *
 * Shares the settlement lane's worker identity (settle.ts registers it) —
 * registering again would rotate the secret out from under it. Shares the
 * booth's single-plot lock too: one pen, one job at a time, whether the
 * customer is standing at the kiosk or on the other side of the market.
 */
import { claimJob, fetchTaskDetails, submitWork, type HandselEnv, type WorkerAuth } from './client'
import {
  MACHINE_PLOT_MARKER,
  buildMachineSubmission,
  extractPlotText,
  isMachineBounty,
  type MachineWorkRecord,
  type MachineWorkStage,
} from './protocol'
import { plot, type PlotterEnv } from '../plotter/plot'

const POLL_INTERVAL_MS = 30_000

export interface MachineWorker {
  records(): MachineWorkRecord[]
  stop(): void
}

export function startMachineWorker(deps: {
  env: HandselEnv
  auth: WorkerAuth
  plotterEnv: PlotterEnv
  machineName: string
  /** The booth's single-plot lock — try to take it; false = busy this tick. */
  tryLockPlotter(): boolean
  releasePlotter(): void
}): MachineWorker {
  const records = new Map<number, MachineWorkRecord>()
  let stopped = false

  const push = (jobId: number, stage: MachineWorkStage, detail?: string) => {
    const r = records.get(jobId)
    if (!r) return
    r.entries.push({ stage, at: new Date().toISOString(), ...(detail ? { detail } : {}) })
    console.log(`[machine-work] job #${jobId}: ${stage}${detail ? ` — ${detail}` : ''}`)
  }

  async function tick() {
    const tasks = await fetchTaskDetails(deps.env, 'Open')
    for (const task of tasks) {
      const jobId = Number(task.id)
      if (!Number.isInteger(jobId)) continue
      if (task.chain) continue // a Solana entry's id is NOT claimable on this rail
      if (records.has(jobId)) continue
      if (!isMachineBounty(task.title)) continue

      const text = extractPlotText(task)
      if (!text) {
        console.log(`[machine-work] job #${jobId} carries the marker but no parseable plot text — leaving it`)
        continue
      }

      // One bounty per tick, and only when the pen is free — the customer
      // standing at the kiosk always outranks the market.
      if (!deps.tryLockPlotter()) return

      records.set(jobId, { jobId, taskId: null, title: task.title, plottedText: text, entries: [] })
      try {
        const claimed = await claimJob(deps.env, deps.auth, jobId)
        if (!claimed.ok) {
          push(jobId, 'failed', `claim refused: ${claimed.reason}`)
          continue
        }
        records.get(jobId)!.taskId = claimed.taskId
        push(jobId, 'claimed', `task ${claimed.taskId}`)

        const startedAt = Date.now()
        const outcome = await plot({ text }, deps.plotterEnv)
        if (!outcome.ok) {
          // Claimed but could not perform: say so upstream rather than going
          // silent — the platform's abandoned-claim recovery handles the rest.
          push(jobId, 'failed', `plot failed: ${outcome.reason}`)
          continue
        }
        push(jobId, 'plotted', `${outcome.mode} (${outcome.detail})`)

        const output = buildMachineSubmission({
          jobTitle: task.title,
          plottedText: text,
          stats: outcome.stats,
          machineName: deps.machineName,
          plottedAtIso: new Date().toISOString(),
        })
        await submitWork(deps.env, deps.auth, claimed.taskId, output, Math.round((Date.now() - startedAt) / 1000))
        push(jobId, 'submitted')
      } catch (err) {
        push(jobId, 'failed', err instanceof Error ? err.message : String(err))
      } finally {
        deps.releasePlotter()
      }
      return // one physical job per tick, by design
    }
  }

  const timer = setInterval(() => {
    if (stopped) return
    tick().catch((err) => console.error('[machine-work] tick failed:', err instanceof Error ? err.message : err))
  }, POLL_INTERVAL_MS)

  console.log(`[machine-work] ON — polling ${deps.env.url} every ${POLL_INTERVAL_MS / 1000}s for "${MACHINE_PLOT_MARKER}" bounties`)

  return {
    records: () => [...records.values()].reverse(),
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}
