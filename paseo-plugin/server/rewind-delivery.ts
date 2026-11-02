/**
 * When a rewind report may be sent, and why it cannot be sent right away.
 *
 * The daemon holds a foreground run lock for the whole rewind — `createPendingRun`
 * before the provider call and `settleForegroundRun` in the `finally`
 * (`AgentManager.rewind`, host `agent-manager.js:2387-2430`). While that run is
 * pending, `enqueueSessionEvent` (`agent-manager.js:2869`) pushes every provider
 * event into `pendingRun.stagedEvents` instead of dispatching it
 * (`agent-manager.js:2884`). Only the normal prompt path ever replays those
 * events (`agent-manager.js:1926`); the rewind settles through `clearRun`
 * (`agent-run-state.js:64-69`, `:132`), which deletes the run and its staged
 * events. A `session.notice` sent from the rewind branch is therefore dropped —
 * before *or* after `request.completed` — and never reaches the daemon's timeline
 * store, which is why the completion report was invisible on a real daemon even
 * though the plugin sent it and the client had a renderer for it.
 * `harness/rewind-notice-delivery-check.mjs` reproduces that on the real host
 * code and asserts the fix.
 *
 * There is no provider-facing call after the lock is released to hook instead.
 * The host's post-receipt tail is `hydrateTimelineFromProvider` (conversation and
 * both only), `refreshSessionState`, `persistSnapshot`, `emitState`, then
 * `settleForegroundRun`; the provider-session methods those touch
 * (`getRuntimeInfo`, `streamHistory`, …) are served by the host's own
 * `PluginAgentSession`, so none of them crosses back into the plugin. The plugin
 * cannot observe the settle.
 *
 * The report is therefore delayed: long enough to be past that tail on any host,
 * short enough that the user still reads it as feedback for the click. The tail
 * is bounded by one snapshot write (the only real I/O — a `writeJsonFileAtomic`
 * of the agent record) plus, for conversation/both, the timeline rebuild from
 * provider history, whose cost grows with the session's length. Measured against
 * the real host with a modelled 3 ms snapshot write: 4 ms (files) and 38 ms
 * (conversation) from receipt to settle. 300 ms leaves more than an order of
 * magnitude of headroom and stays imperceptible next to a rewind that itself
 * costs tens to hundreds of milliseconds.
 *
 * This is a **heuristic**, not a protocol guarantee: a host whose snapshot write
 * or timeline rebuild stalls past the delay drops the report again. There is no
 * deterministic signal to wait for, and the alternative is no report at all (the
 * failure this replaced). The check asserts the margin against the tail it
 * measures, so shrinking this constant below the host's own work is caught.
 *
 * @module dsh-paseo/server/rewind-delivery
 */

/** How long after a rewind receipt its report is sent, in milliseconds. */
export const REWIND_NOTICE_DELAY_MS = 300;

/**
 * Pending reports, one set of timers per provider session.
 *
 * A session can close inside the delay (the user rewinds and immediately closes
 * the tab), and the report would then be logged as a dropped notice for a
 * session nobody is looking at. Cancelling on close keeps that log honest and
 * leaves no timer behind on a daemon shutdown.
 */
export class RewindNoticeTimers {
  readonly #bySession = new Map<string, Set<ReturnType<typeof setTimeout>>>();

  /** Queue one report for `sessionId`; it fires once after the delay. */
  schedule(sessionId: string, deliver: () => void): void {
    const timer = setTimeout(() => {
      this.#forget(sessionId, timer);
      deliver();
    }, REWIND_NOTICE_DELAY_MS);
    // A pending report must not keep the plugin process alive: the daemon may be
    // shutting down, and waiting out the delay would only delay teardown.
    (timer as { unref?: () => void }).unref?.();
    const timers = this.#bySession.get(sessionId) ?? new Set<ReturnType<typeof setTimeout>>();
    timers.add(timer);
    this.#bySession.set(sessionId, timers);
  }

  /** Drop every pending report for one session. */
  cancel(sessionId: string): void {
    const timers = this.#bySession.get(sessionId);
    if (timers === undefined) return;
    this.#bySession.delete(sessionId);
    for (const timer of timers) clearTimeout(timer);
  }

  /** Drop every pending report (connection teardown). */
  cancelAll(): void {
    for (const sessionId of [...this.#bySession.keys()]) this.cancel(sessionId);
  }

  #forget(sessionId: string, timer: ReturnType<typeof setTimeout>): void {
    const timers = this.#bySession.get(sessionId);
    if (timers === undefined) return;
    timers.delete(timer);
    if (timers.size === 0) this.#bySession.delete(sessionId);
  }
}
