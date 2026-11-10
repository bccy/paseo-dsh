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
 *   after the receipt. A rebuild can still be slower than the wait: then the row
 *   is appended anyway and the delivery keeps verifying it (see
 *   {@link verifyReportSurvived}), so a late rebuild is repaired instead of
 *   silently eating the report.
 * - **The provider connection has no Paseo API handle.** `connect()` is handed
 *   `{ launch, versions, capabilities }` only; the handle lives in the plugin
 *   process and is passed to hook/RPC/tool callbacks (`PluginHandlerContext`).
 *   It is therefore captured from those callbacks ({@link capturePaseo}) — the
 *   turn hooks and the `jobs.snapshot` subscription cover normal use, and the client bundle
 *   calls `rewind.notice.arm` on load to cover a daemon restart with no turn
 *   since. If a rewind lands before any capture, the report is queued and
 *   appended on the next capture instead of being dropped; the wait is logged.
 *   A handle captured *between* arming the report and delivering it builds the
 *   same replacement subscription late — the report never appends blind.
 *
 * Failure is loud, never silent: an append that throws is reported on stderr
 * (the plugin's log surface) and falls back to the provider notice channel as a
 * best-effort second path — that one can still be dropped by the run lock, which
 * is exactly why the append exists, but a user with a broken host at least sees
 * a log line naming the report that did not land. The fallback notice also
 * carries a marker line ({@link REWIND_FALLBACK_MARKERS}) so the client's
 * legacy-row filter cannot mistake it for an old replayed report and hide it.
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
 * on a very long session, so the timeout path keeps its subscription and
 * verifies the row afterwards, re-appending it when the rebuild ate it.
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

/** How long the timeout path waits before each check of whether the row survived. */
export const REWIND_REPLACEMENT_VERIFY_DELAY_MS = 1500;

/**
 * How many delayed checks the timeout path makes before it stops.
 *
 * The checks are the fallback for a subscription that never announces a
 * replacement (a host that does not dispatch one, or one whose subscription
 * failed): they cannot run forever, so the last one is followed by an explicit
 * "could not be confirmed" log rather than silence.
 */
export const REWIND_REPLACEMENT_VERIFY_ATTEMPTS = 4;

/**
 * The line a fallback notice's description carries.
 *
 * A fallback notice reports the **same outcome** as the old delivery path's
 * notices, so its title is one of the copy-table sentences — the exact text the
 * client's legacy-row filter removes from a rebuilt timeline. Without a marker
 * the client cannot tell a live degraded report from an old replayed row and
 * would delete it too, making an append failure invisible in the UI. The marker
 * line both makes the fallback recognisable and tells the user the delivery is
 * degraded.
 *
 * The client half keeps its own copy of these strings (`client/rewind-notice-data`):
 * the shared module is the natural home, but the client bundle cannot import a
 * server module (`process` is read at load here). `harness/rewind-notice-check.cjs`
 * asserts the two copies are identical.
 */
export const REWIND_FALLBACK_MARKERS: Readonly<Record<"en" | "zh-CN", string>> = Object.freeze({
  en: "Degraded delivery: the report row could not be written to the timeline; this notice may not persist",
  "zh-CN": "降级送达：报告行未能写入时间线，这条提示可能不会保留",
});

/**
 * The description a fallback notice carries: the marker line, then the report's
 * detail lines (when the report has any).
 */
export function fallbackNoticeDescription(locale: "en" | "zh-CN", detail: string): string {
  const marker = REWIND_FALLBACK_MARKERS[locale];
  return detail === "" ? marker : `${marker}\n${detail}`;
}

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
 * guarantee. The provider marks its description with
 * {@link REWIND_FALLBACK_MARKERS} so the client keeps it visible.
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

/** The row payload for one report; `noticeId` makes each append individually recognisable. */
function noticePayload(report: RewindReport): RewindNoticePayload {
  appendSeq += 1;
  return {
    message: report.message,
    tone: report.tone,
    noticeId: `${report.agentId}-${Date.now().toString(36)}-${appendSeq.toString(36)}`,
  };
}

/**
 * Append one report row with an already-built payload.
 *
 * The row id is fixed ({@link REWIND_NOTICE_ITEM_ID}) so a second report from
 * the same plugin replaces the first instead of stacking; the payload is built
 * once per rewind and reused by a re-append, so a repair keeps the row's
 * identity (a new `noticeId` would read as a new live arrival to the client's
 * one-shot capsule).
 */
async function appendPayload(report: RewindReport, payload: RewindNoticePayload): Promise<void> {
  const api = paseo;
  if (api === null) throw new Error("the plugin API handle is not available yet");
  await api.agents.ref(report.agentId).timeline.append({
    type: "plugin",
    id: REWIND_NOTICE_ITEM_ID,
    kind: REWIND_NOTICE_KIND,
    version: REWIND_NOTICE_VERSION,
    data: payload,
  });
}

/** Append one report row, generating its payload. */
async function appendReport(report: RewindReport): Promise<RewindNoticePayload> {
  const payload = noticePayload(report);
  await appendPayload(report, payload);
  return payload;
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

/** Whether a report with this notice id is still on the agent's timeline tail. */
async function rowSurvived(api: PaseoApi, agentId: string, noticeId: string): Promise<boolean> {
  const page = await api.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 20 });
  return pageHasNotice(page, noticeId);
}

/** One delayed step, unref'd so it cannot hold the plugin process open. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

/**
 * Keep checking that a row appended before the rebuild finished survived it.
 *
 * The timeout path appends without having seen the replacement, so the rebuild
 * may still be running and delete the row afterwards. Two mechanisms cover that:
 *
 * - the subscription is **kept alive after its timeout**, because a replacement
 *   that arrives late is the moment the rebuild finished; the row is checked
 *   (and re-appended) when that event finally comes;
 * - a bounded number of delayed checks re-append the row whenever they find it
 *   gone, which covers a subscription that never announces anything.
 *
 * The bound is a trade-off, not a silent drop: every re-append and the final
 * "could not be confirmed" are logged on stderr. A fetch failure is logged too
 * and retried on the next check instead of being read as "the row is gone".
 */
async function verifyReportSurvived(
  report: RewindReport,
  payload: RewindNoticePayload,
  watch: ReplacementWatch | null,
): Promise<void> {
  const api = paseo;
  if (api === null) return;
  const attempts = String(REWIND_REPLACEMENT_VERIFY_ATTEMPTS);
  let presentAtLastCheck: boolean | undefined;
  for (let attempt = 1; attempt <= REWIND_REPLACEMENT_VERIFY_ATTEMPTS; attempt += 1) {
    await delay(REWIND_REPLACEMENT_VERIFY_DELAY_MS);
    try {
      presentAtLastCheck = await rowSurvived(api, report.agentId, payload.noticeId);
    } catch (error) {
      process.stderr.write(
        `[${PROVIDER_ID}] could not verify the rewind report for agent ${report.agentId}: `
          + `${error instanceof Error ? error.message : String(error)} (check ${String(attempt)}/${attempts})\n`,
      );
      continue;
    }
    if (!presentAtLastCheck) {
      process.stderr.write(
        `[${PROVIDER_ID}] the rewind report for agent ${report.agentId} was wiped by a timeline rebuild; `
          + `appending it again (check ${String(attempt)}/${attempts})\n`,
      );
      await appendPayload(report, payload);
      presentAtLastCheck = true;
      continue;
    }
    if (watch?.sawReplacement() === true) {
      process.stderr.write(
        `[${PROVIDER_ID}] the rewind report for agent ${report.agentId} survived the timeline replacement `
          + `(confirmed ${String(attempt)} check(s) after the timeout)\n`,
      );
      return;
    }
  }
  // The subscription is still live and can announce the rebuild after the checks
  // ran out; that event is the moment the row can be wiped, so wait for it
  // (bounded) instead of declaring the report safe.
  if (watch !== null && watch.sawReplacement() === false) {
    const late = await Promise.race([
      watch.lateReplaced,
      delay(REWIND_REPLACEMENT_TIMEOUT_MS).then(() => false),
    ]);
    if (late) {
      await delay(REWIND_REPLACEMENT_VERIFY_DELAY_MS);
      try {
        presentAtLastCheck = await rowSurvived(api, report.agentId, payload.noticeId);
      } catch (error) {
        process.stderr.write(
          `[${PROVIDER_ID}] could not verify the rewind report for agent ${report.agentId} after the late `
            + `timeline replacement: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        presentAtLastCheck = undefined;
      }
      if (presentAtLastCheck === false) {
        process.stderr.write(
          `[${PROVIDER_ID}] the rewind report for agent ${report.agentId} was wiped by a rebuild that finished `
            + "after the replacement timeout; appending it again\n",
        );
        await appendPayload(report, payload);
        return;
      }
      if (presentAtLastCheck === true) {
        process.stderr.write(
          `[${PROVIDER_ID}] the rewind report for agent ${report.agentId} survived the late timeline replacement\n`,
        );
        return;
      }
    }
  }
  process.stderr.write(
    `[${PROVIDER_ID}] the rewind report for agent ${report.agentId} could not be confirmed: `
      + `${
        presentAtLastCheck === true
          ? "the row was present at the last check"
          : "the row could not be read at the last check"
      }, but no timeline replacement arrived within the checks; a rebuild that finishes later can still remove it\n`,
  );
}

/** How long the rewind waits for the timeline subscription to be acknowledged. */
export const REWIND_SUBSCRIBE_READY_TIMEOUT_MS = 1000;

/** Whether a rewind of this scope needs to wait for the host's timeline rebuild. */
function needsReplacementWatch(agentId: string, scope: RewindScope): boolean {
  return scope !== "files" && agentId !== "";
}

/**
 * One live-timeline observation, as the report delivery uses it.
 *
 * `ready` settles when the subscription is acknowledged (or after
 * {@link REWIND_SUBSCRIBE_READY_TIMEOUT_MS}), `replaced` when a replacement is
 * dispatched or the timeout elapses, and `lateReplaced` when a replacement
 * arrives *after* the timeout (the rebuild finished late). `release` ends the
 * observation and settles anything still pending.
 */
interface ReplacementWatch {
  ready: Promise<void>;
  replaced: Promise<boolean>;
  lateReplaced: Promise<boolean>;
  /** Whether a replacement arrived at any point, including after the timeout. */
  sawReplacement(): boolean;
  release: () => void;
}

/**
 * Subscribe to one agent's live timeline and resolve when the replacement is
 * dispatched (or the wait times out).
 *
 * The subscription is established synchronously, so the caller awaits `ready`
 * **before** sending the revert: the replacement event cannot be dispatched
 * before the subscription exists.
 */
function replacementWatch(api: PaseoApi, agentId: string): ReplacementWatch {
  let resolveReplaced: (replaced: boolean) => void = () => {};
  const replaced = new Promise<boolean>((done) => {
    resolveReplaced = done;
  });
  let resolveLate: (replaced: boolean) => void = () => {};
  const lateReplaced = new Promise<boolean>((done) => {
    resolveLate = done;
  });
  let settled = false;
  let lateSettled = false;
  let sawReplacement = false;
  const settle = (value: boolean): void => {
    if (settled) {
      // A replacement that arrives after the timeout still matters: the rebuild
      // it announces can wipe a row appended in the meantime.
      if (value && !lateSettled) {
        lateSettled = true;
        resolveLate(true);
      }
      return;
    }
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
    if (message.event.type === "replacement") {
      sawReplacement = true;
      settle(true);
    } else if (message.event.type === "error") {
      settle(false);
    }
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
    lateReplaced,
    sawReplacement: () => sawReplacement,
    release: () => {
      clearTimeout(readyTimer);
      clearTimeout(timer);
      // Settle anything still pending so a concurrent `deliver` cannot await a
      // released watch forever.
      settle(false);
      if (!lateSettled) {
        lateSettled = true;
        resolveLate(false);
      }
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
  #watch: ReplacementWatch | null;
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
    this.#watch = api !== null && needsReplacementWatch(agentId, scope)
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
    let watch = this.#watch;
    if (watch === null && needsReplacementWatch(full.agentId, full.scope)) {
      // The handle was captured **after** this delivery was created — an arm RPC
      // or a jobs.snapshot push landed while the rewind was in flight — so the
      // constructor could not subscribe. Subscribe now: appending without a
      // watch can land before the host's rebuild and be wiped silently.
      try {
        watch = replacementWatch(paseo, full.agentId);
        this.#watch = watch;
        process.stderr.write(
          `[${PROVIDER_ID}] agent ${full.agentId}: the plugin API handle arrived after the rewind report was `
            + "armed; subscribing to the timeline now so the report waits for (or is verified after) the rebuild\n",
        );
      } catch (error) {
        process.stderr.write(
          `[${PROVIDER_ID}] could not subscribe to agent ${full.agentId}'s timeline for the rewind report: `
            + `${error instanceof Error ? error.message : String(error)}; the report is appended and verified `
            + "afterwards\n",
        );
      }
    }
    const payload = noticePayload(full);
    let replaced = true;
    if (watch !== null) {
      replaced = await watch.replaced;
      if (!replaced) {
        process.stderr.write(
          `[${PROVIDER_ID}] agent ${full.agentId} sent no timeline replacement within `
            + `${String(REWIND_REPLACEMENT_TIMEOUT_MS)}ms; appending the rewind report anyway and `
            + "verifying it afterwards\n",
        );
      }
    } else if (needsReplacementWatch(full.agentId, full.scope)) {
      // No subscription could be established at all: append and verify, never
      // append blind.
      replaced = false;
    }
    if (this.#cancelled) return;
    try {
      await appendPayload(full, payload);
      if (!replaced) await verifyReportSurvived(full, payload, watch);
    } finally {
      // Release even when the append threw: the fallback notice is handled by
      // `deliver`'s catch, and a thrown append must not leave the subscription
      // (and its timers) behind.
      watch?.release();
    }
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
