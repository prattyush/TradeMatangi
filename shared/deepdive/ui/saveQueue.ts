export type SaveState = { status: 'idle' } | { status: 'saving' } | { status: 'saved' } | { status: 'error'; message: string }

/**
 * Saves run one after another in the order the user made the changes, so a slow answer can never overwrite a newer one.
 * The state it reports ("Saving…", "Saved", an error) is what the screen shows next to the day.
 */
export class SaveQueue {
  private chain: Promise<unknown> = Promise.resolve()
  private pending = 0
  private failure: string | null = null
  constructor(private readonly report: (state: SaveState) => void, private readonly describe: (error: unknown) => string) {}

  enqueue(task: () => Promise<unknown>): Promise<void> {
    this.pending += 1
    this.failure = null
    this.report({ status: 'saving' })
    const run = this.chain.then(task).then(() => undefined, error => { this.failure = this.describe(error) })
    this.chain = run
    return run.then(() => {
      this.pending -= 1
      if (this.pending > 0) return
      this.report(this.failure === null ? { status: 'saved' } : { status: 'error', message: this.failure })
    })
  }
}
