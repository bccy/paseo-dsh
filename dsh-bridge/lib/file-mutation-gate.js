/**
 * Root-scoped admission for the tracked editing tools and file recovery.
 *
 * ## The gap this covers
 *
 * `DSH Agent.runMaintenance` protects one agent, not its independently running
 * descendants: a rewind calls it on the root and DSH keeps *that* agent's tools
 * out, but a native subagent that is still finishing a `write`/`edit` can commit
 * its journal line after the rewind has already planned the file restore. That
 * write is then missing from the plan — the file is left modified, and the
 * rewind still reports success. Its journal line is also pruned away by the same
 * rewind, so a second attempt has nothing left to restore from.
 *
 * This gate is the smallest thing that closes that seam: tracked executions of a
 * whole root family take a shared read ticket, and a rewind takes the exclusive
 * side, so a plan is only computed while no tracked write is in flight. It does
 * not schedule turns, cancel work, or order anything else.
 *
 * ## Drop condition
 *
 * Delete this module when DSH exposes an equivalent file-transaction scope that
 * spans a root and its descendants — i.e. when `runMaintenance` (or a
 * replacement) also excludes delegated agents' tool executions. Until then this
 * is the only thing standing between "a child finished mid-rewind" and a
 * silently wrong restore.
 *
 * All mutations use the same root identity as `FileSnapshots`, so the two agree
 * on which journal a write belongs to.
 *
 * @module dsh-bridge/file-mutation-gate
 */

/** A promise plus its resolver, so a waiter can be woken exactly once. */
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Await a promise, but give up as soon as `signal` aborts.
 *
 * `freeze` bounds its wait with `AbortSignal.timeout`, so without this a rewind
 * could sit out its whole timeout even though the caller is already gone.
 *
 * @param {Promise<unknown>} promise
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<unknown>}
 */
function wait(promise, signal) {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Per-root read/write admission for tracked file mutations.
 *
 * One instance per bridge process; the map is keyed by the ROOT session id
 * because that is the journal every descendant writes into.
 */
export class FileMutationGate {
  /** root id -> { active, waiting, blocked?, drained? } */
  #roots = new Map();

  #state(root) {
    let state = this.#roots.get(root);
    if (state === undefined) {
      state = { active: 0, waiting: 0, blocked: undefined, drained: undefined };
      this.#roots.set(root, state);
    }
    return state;
  }

  /**
   * Forget a root once nothing references it.
   *
   * Without this the map would keep one entry per conversation the process ever
   * served, which is the same unbounded-growth shape the route tables had to be
   * capped for.
   */
  #collect(root, state) {
    if (state.active === 0 && state.waiting === 0 && state.blocked === undefined
      && this.#roots.get(root) === state) {
      this.#roots.delete(root);
    }
  }

  /** Number of roots this gate currently tracks, for tests. */
  get size() {
    return this.#roots.size;
  }

  /**
   * Take a read ticket for one tracked execution.
   *
   * Resolves to the release function. The caller must call it exactly once, from
   * whichever of `tools/post-execute` / `tools/result` / the failure path runs —
   * `server.js` keeps the ticket so all three agree on the identity.
   *
   * @param {string} root - root session id whose journal this write lands in.
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<() => void>}
   */
  async enter(root, signal) {
    const state = this.#state(root);
    state.waiting += 1;
    try {
      // A freeze that arrives while this loop is waiting is observed on the next
      // iteration: `blocked` is set before any in-flight ticket is released, so
      // there is no window where a new writer slips past an active freeze.
      while (state.blocked !== undefined) await wait(state.blocked.promise, signal);
      signal?.throwIfAborted();
      // `freeze` cannot interleave between this check and the increment: both are
      // synchronous, and `freeze` only blocks after observing `active`.
      state.active += 1;
    } finally {
      state.waiting -= 1;
      this.#collect(root, state);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.active -= 1;
      if (state.active === 0) {
        state.drained?.resolve();
        state.drained = undefined;
      }
      this.#collect(root, state);
    };
  }

  /**
   * Block new tracked executions of a root until the returned function is called.
   *
   * Waits for the writers already in flight to finish, then hands back the
   * exclusive side. Both steps are bounded: `timeoutMs` is the total budget for
   * *draining*, and the caller's own `signal` aborts immediately (a rewind whose
   * agent is being disposed must not sit here).
   *
   * A second `freeze` on the same root is a programming error, not something to
   * queue: `server.js` already refuses a concurrent rewind per session
   * (`revertInflight`), so reaching here twice means that guard was lost.
   *
   * @param {string} root
   * @param {AbortSignal | undefined} signal
   * @param {number} [timeoutMs]
   * @returns {Promise<() => void>} the release function (idempotent).
   */
  async freeze(root, signal, timeoutMs = 15000) {
    const state = this.#state(root);
    if (state.blocked !== undefined) throw new Error(`file recovery already holds ${root}`);
    const blocked = deferred();
    state.blocked = blocked;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      state.blocked = undefined;
      blocked.resolve();
      this.#collect(root, state);
    };
    try {
      const deadline = AbortSignal.timeout(timeoutMs);
      const until = signal ? AbortSignal.any([signal, deadline]) : deadline;
      if (state.active > 0) {
        state.drained ??= deferred();
        await wait(state.drained.promise, until);
      }
      until.throwIfAborted();
      return release;
    } catch (error) {
      // Every failure path must unblock the root: leaving `blocked` set would
      // refuse every later edit in that conversation for the process's life.
      release();
      throw error;
    }
  }
}
