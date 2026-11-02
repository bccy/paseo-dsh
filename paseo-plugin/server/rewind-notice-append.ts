/**
 * How a finished rewind reports itself: append a plugin timeline row, not a
 * provider notice.
 *
 * A `session.notice` from the rewind branch cannot be delivered reliably. The
 * host holds a foreground run lock for the whole rewind (`createPendingRun`
 * before the provider call, `settleForegroundRun` in the `finally` of
 * `AgentManager.rewind`), and `enqueueSessionEvent` pushes every provider event
 * that arrives meanwhile into `pendingRun.stagedEvents`, which `clearRun`
 * deletes instead of replaying (`agent-manager.js`, `agent-run-state.js`). The
 * previous implementation therefore guessed a 300 ms delay past the host's tail;
 * a real rewind took 1128 ms once (daemon log), and the report was dropped
 * silently.
 *
 * `paseo.agents.ref(agentId).timeline.append(...)` is deterministic instead:
 * the daemon's `appendTimelineItem` records the row and dispatches it directly
 * (`agent-manager.js`), never through `enqueueSessionEvent`, so the run lock
 * cannot swallow it, and the row does not enter the provider history the host
 * rebuilds a timeline from — a later rewind cannot resurrect it.
 *
 * Two facts shape the delivery:
 *
 * - **The row must land after the host's timeline rebuild.** A conversation or
 *   `both` rewind force-hydrates the timeline from provider history, which
 *   deletes every row first (`hydrateTimelineFromProvider` →
 *   `forceHydrateTimelineFromLegacyProviderHistory`: `timelineStore.delete` then
 *   re-record). A row appended before that is wiped. The host dispatches
 *   `agent.timeline.replacement` right after the rebuild and before it releases
 *   the run lock, so the delivery subscribes to the agent's live timeline
 *   **before** the revert is sent and appends only after that replacement
 *   arrives. `files` never rebuilds the conversation, so it appends straight
 *   after the receipt.
 * - **The provider connection has no Paseo API handle.** `connect()` is handed
 *   `{ launch, versions, capabilities }` only; the handle lives in the plugin
 *   process and is passed to hook/RPC/tool callbacks (`PluginHandlerContext`).
 *   It is therefore captured from those callbacks ({@link capturePaseo}) — the
 *   turn hooks and the `jobs.list` RPC cover normal use, and the client bundle
 *   calls `rewind.notice.arm` on load to cover a daemon restart with no turn
 *   since. If a rewind lands before any capture, the report is queued and
 *   appended on the next capture instead of being dropped; the wait is logged.
 *
 * Failure is loud, never silent: an append that throws is reported on stderr
 * (the plugin's log surface) and falls back to the provider notice channel as a
 * best-effort second path — that one can still be dropped by the run lock, which
 * is exactly why the append exists, but a user with a broken host at least sees
 * a log line naming the report that did not land.
 *
 * @module dsh-paseo/server/rewind-notice-append
 */
import type { PaseoApi } from "@getpaseo/client";
import {
  REWIND_NOTICE_ITEM_ID,
  REWIND_NOTICE_KIND,
  REWIND_NOTICE_VERSION,
  type RewindNoticePayload,
  type RewindScope,
  type RewindTone,
} from "../shared/rewind-notice";
import { PROVIDER_ID } from "../shared/provider";

/**
 * How long the delivery waits for the host's `timeline.replacement` event
 * before appending anyway.
 *
 * The replacement is dispatched inside the rewind, after the rebuild and before
 * the run lock is released, so on a host that behaves it always arrives — the
 * wait is what makes the append land *after* the rebuild. It is bounded only so
 * a host that stops dispatching (or a subscription that never established)
 * cannot lose the report forever; a rebuild slower than this bound is possible
 * on a very long session, so the timeout path verifies the row afterwards and
 * re-appends once when the rebuild ate it.
 *
 * Ten seconds is far above the measured rewind tail (the daemon log's slowest
 * rewind is 1128 ms; a 5 s hydrate is modelled by the harness) and short enough
 * that a degraded host still shows the report while the user is looking.
 * `DSH_PASEO_REWIND_REPLACEMENT_TIMEOUT_MS` exists for the harness, which has to
 * drive the degraded path without waiting out the real bound.
 */
function replacementTimeoutMs(): number {
  const override = Number(process.env["DSH_PASEO_REWIND_REPLACEMENT_TIMEOUT_MS"]);
  return Number.isFinite(override) && override > 0 ? override : 10_000;
}

export const REWIND_REPLACEMENT_TIMEOUT_MS = replacementTimeoutMs();

/** How long the timeout path waits before checking whether the row survived. */
export const REWIND_REPLACEMENT_VERIFY_DELAY_MS = 1500;

/** One finished rewind, in the form the row is appended with. */
export interface RewindReport {
  /** Paseo's agent id the row belongs to. */
  agentId: string;
  /** The scope Paseo asked for; decides whether a replacement is awaited. */
  scope: RewindScope;
  /** Row tone: success, or the warning used by a partial file restore. */
  tone: RewindTone;
  /** Full report text, shown verbatim on the row. */
  message: string;
}

/**
 * The fallback for an append that failed: emit the provider notice instead.
 *
 * Kept a callback so this module does not have to know the provider session id
 * or the notice shape. The provider's notice can still be dropped by the run
 * lock (see the module doc) — it is the second-best path, not a second
 * guarantee.
 */
export type RewindReportFallback = (report: RewindReport) => void;

/** The Paseo API handle captured from a hook/RPC callback, when one has fired. */
let paseo: PaseoApi | null = null;

/** Reports waiting for the first handle capture, at most one per agent. */
const pending = new Map<string, { report: RewindReport; fallback?: RewindReportFallback }>();

/** Distinguishes appends that share a millisecond. */
let appendSeq = 0;

/**
 * Keep the plugin API handle from a callback that was given one.
 *
 * Called from every lifecycle hook and RPC handler the server half registers.
 * Idempotent: the handle is the plugin process's one instance, so a later
 * capture replaces the earlier one (which also survives a plugin API restart).
 * Any queued reports are flushed on the first capture.
 */
export function capturePaseo(api: PaseoApi): void {
  const first = paseo === null;
  paseo = api;
  if (first) flushPending();
}

/** Whether a rewind report can be appended right now. */
export function hasPaseoHandle(): boolean {
  return paseo !== null;
}

/** Append every report that was waiting for a handle. */
function flushPending(): void {
  if (paseo === null || pending.size === 0) return;
  const reports = [...pending.values()];
  pending.clear();
  for (const entry of reports) {
    process.stderr.write(
      `[${PROVIDER_ID}] rewind report for agent ${entry.report.agentId} waited for the plugin API handle `
        + "(no hook or RPC had fired yet); appending it now — the rewind itself already finished, so the "
        + "timeline replacement is not awaited\n",
    );
    void appendReport(entry.report).catch((error: unknown) => {
      fail(entry.report, entry.fallback, error);
    });
  }
}

/** Log one failed append and hand the report to the provider notice fallback. */
function fail(report: RewindReport, fallback: RewindReportFallback | undefined, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `[${PROVIDER_ID}] could not append the rewind report for agent ${report.agentId}: ${reason}; `
      + `falling back to a provider notice (which the rewind run lock may drop): ${JSON.stringify(report.message)}\n`,
  );
  if (fallback === undefined) return;
  try {
    fallback(report);
  } catch (fallbackError) {
    process.stderr.write(
      `[${PROVIDER_ID}] the provider notice fallback for agent ${report.agentId} also failed: `
        + `${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}\n`,
    );
  }
}

/**
 * Append one report row.
 *
 * The row id is fixed ({@link REWIND_NOTICE_ITEM_ID}) so a second report from
 * the same plugin replaces the first instead of stacking; `noticeId` in the
 * payload is what makes each append individually recognisable to the client's
 * live monitor.
 */
async function appendReport(report: RewindReport): Promise<string> {
  const api = paseo;
  if (api === null) throw new Error("the plugin API handle is not available yet");
  appendSeq += 1;
  const payload: RewindNoticePayload = {
    message: report.message,
    tone: report.tone,
    noticeId: `${report.agentId}-${Date.now().toString(36)}-${appendSeq.toString(36)}`,
  };
  await api.agents.ref(report.agentId).timeline.append({
    type: "plugin",
    id: REWIND_NOTICE_ITEM_ID,
    kind: REWIND_NOTICE_KIND,
    version: REWIND_NOTICE_VERSION,
    data: payload,
  });
  return payload.noticeId;
}

/** Whether one fetched timeline page still holds the report row we appended. */
function pageHasNotice(page: unknown, noticeId: string): boolean {
  if (page === null || typeof page !== "object") return false;
  const entries = Reflect.get(page, "entries");
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const item = Reflect.get(entry, "item");
    if (item === null || typeof item !== "object") continue;
    if (Reflect.get(item, "type") !== "plugin" || Reflect.get(item, "kind") !== REWIND_NOTICE_KIND) continue;
    const data = Reflect.get(item, "data");
    if (data !== null && typeof data === "object" && Reflect.get(data, "noticeId") === noticeId) return true;
  }
  return false;
}

/**
 * Check that a report appended after the timeout survived the host's rebuild.
 *
 * The timeout path appends without having seen the replacement, so the rebuild
 * may still be running and wipe the row. One bounded re-check after a short
 * delay re-appends it when that happened; a fetch failure is logged, not
 * guessed at.
 */
async function verifyAfterTimeout(agentId: string, noticeId: string, report: RewindReport): Promise<void> {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, REWIND_REPLACEMENT_VERIFY_DELAY_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  const api = paseo;
  if (api === null) return;
  try {
    const page = await api.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 20 });
    if (pageHasNotice(page, noticeId)) return;
    process.stderr.write(
      `[${PROVIDER_ID}] the rewind report for agent ${agentId} was wiped by a rebuild that arrived after the `
        + `${String(REWIND_REPLACEMENT_TIMEOUT_MS)}ms replacement timeout; appending it again\n`,
    );
    await appendReport(report);
  } catch (error) {
    process.stderr.write(
      `[${PROVIDER_ID}] could not verify the rewind report for agent ${agentId}: `
        + `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/** How long the rewind waits for the timeline subscription to be acknowledged. */
export const REWIND_SUBSCRIBE_READY_TIMEOUT_MS = 1000;

/**
 * Subscribe to one agent's live timeline and resolve when the replacement is
 * dispatched (or the wait times out).
 *
 * `ready` settles when the subscription is acknowledged (or after
 * {@link REWIND_SUBSCRIBE_READY_TIMEOUT_MS}): the caller awaits it **before**
 * sending the revert, so the subscription is in place before the host can
 * dispatch the replacement it is waiting for.
 */
function replacementWatch(api: PaseoApi, agentId: string): {
  ready: Promise<void>;
  replaced: Promise<boolean>;
  release: () => void;
} {
  let resolveReplaced: (replaced: boolean) => void = () => {};
  const replaced = new Promise<boolean>((done) => {
    resolveReplaced = done;
  });
  let settled = false;
  const settle = (value: boolean): void => {
    if (settled) return;
    settled = true;
    resolveReplaced(value);
  };
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((done) => {
    resolveReady = done;
  });
  let readySettled = false;
  const markReady = (): void => {
    if (readySettled) return;
    readySettled = true;
    resolveReady();
  };
  const readyTimer = setTimeout(markReady, REWIND_SUBSCRIBE_READY_TIMEOUT_MS);
  (readyTimer as { unref?: () => void }).unref?.();
  const subscription = api.agents.ref(agentId).timeline.subscribe((message) => {
    if (message.event.type === "replacement") settle(true);
    else if (message.event.type === "error") settle(false);
  });
  subscription.ready.then(
    () => {
      clearTimeout(readyTimer);
      markReady();
    },
    (error: unknown) => {
      clearTimeout(readyTimer);
      process.stderr.write(
        `[${PROVIDER_ID}] could not subscribe to agent ${agentId}'s timeline for the rewind report: `
          + `${error instanceof Error ? error.message : String(error)}; the replacement wait is skipped\n`,
      );
      markReady();
      settle(false);
    },
  );
  const timer = setTimeout(() => settle(false), REWIND_REPLACEMENT_TIMEOUT_MS);
  (timer as { unref?: () => void }).unref?.();
  return {
    ready,
    replaced,
    release: () => {
      clearTimeout(readyTimer);
      clearTimeout(timer);
      void subscription.release().catch(() => undefined);
    },
  };
}

/**
 * One in-flight rewind's report delivery.
 *
 * Created **before** the revert is sent, because the replacement event it waits
 * for is dispatched after the receipt and a subscription established then would
 * miss it. `deliver` is called with the finished report once the receipt has
 * been read; `cancel` releases the subscription when the revert failed.
 */
export class RewindReportDelivery {
  readonly #report: Omit<RewindReport, "message" | "tone">;
  readonly #fallback: RewindReportFallback | undefined;
  readonly #watch: { ready: Promise<void>; replaced: Promise<boolean>; release: () => void } | null;
  #cancelled = false;

  constructor(
    agentId: string,
    scope: RewindScope,
    fallback?: RewindReportFallback,
  ) {
    this.#report = { agentId, scope };
    this.#fallback = fallback;
    const api = paseo;
    // `files` does not touch the conversation, so there is no replacement to
    // wait for; a session with no Paseo handle cannot subscribe at all and is
    // queued by `deliver` instead.
    this.#watch = api !== null && scope !== "files" && agentId !== ""
      ? replacementWatch(api, agentId)
      : null;
  }

  /**
   * Resolves once the timeline subscription is acknowledged (or bounded).
   *
   * The caller awaits this **before** sending the revert, so the replacement
   * event cannot be dispatched before the subscription exists. A delivery with
   * no subscription (files scope, missing handle) resolves immediately.
   */
  get ready(): Promise<void> {
    return this.#watch?.ready ?? Promise.resolve();
  }

  /** Append the report once the timeline is ready for it. */
  deliver(report: Pick<RewindReport, "message" | "tone">): void {
    void this.#deliver(report).catch((error: unknown) => {
      fail({ ...this.#report, ...report }, this.#fallback, error);
    });
  }

  async #deliver(report: Pick<RewindReport, "message" | "tone">): Promise<void> {
    if (this.#cancelled) return;
    const full: RewindReport = { ...this.#report, ...report };
    if (paseo === null) {
      // The handle can only come from a hook/RPC callback; queue and let
      // `capturePaseo` flush. Not silent: the queue is logged on capture and a
      // later failure is logged too.
      pending.set(full.agentId, { report: full, fallback: this.#fallback });
      process.stderr.write(
        `[${PROVIDER_ID}] rewind report for agent ${full.agentId} is queued: the plugin API handle has `
          + "not been captured yet (no hook or RPC has fired in this plugin process)\n",
      );
      return;
    }
    let replaced = true;
    if (this.#watch !== null) {
      replaced = await this.#watch.replaced;
      this.#watch.release();
      if (!replaced) {
        process.stderr.write(
          `[${PROVIDER_ID}] agent ${full.agentId} sent no timeline replacement within `
            + `${String(REWIND_REPLACEMENT_TIMEOUT_MS)}ms; appending the rewind report anyway and `
            + "verifying it afterwards\n",
        );
      }
    }
    const noticeId = await appendReport(full);
    if (!replaced) await verifyAfterTimeout(full.agentId, noticeId, full);
  }

  /** Drop the delivery (the revert failed, so there is nothing to report). */
  cancel(): void {
    this.#cancelled = true;
    this.#watch?.release();
  }
}

/**
 * Start one rewind's report delivery.
 *
 * Must be called **before** the revert is sent so the replacement event cannot
 * be missed (see the module doc).
 */
export function beginRewindReport(
  agentId: string,
  scope: RewindScope,
  fallback?: RewindReportFallback,
): RewindReportDelivery {
  return new RewindReportDelivery(agentId, scope, fallback);
}
