/**
 * The client half of the three composer pills: which agents have a pill, and how
 * one subscription's answers become a pill's published state.
 *
 * **What changed in the 0.16 port.** This module replaces `client/agent-polling`,
 * which drove one timer per agent per pill and called `jobs.list` / `goal.current`
 * / `team.read` every four seconds. Paseo 0.16's plugin subscriptions push the
 * same snapshots from the server (`server/pill-feed`), so the timers, the jitter,
 * the backoff, the in-flight guard and the poll sequence all have one owner now —
 * the side that owns the data — and this module keeps only what is genuinely
 * client-side:
 *
 * - **the directory diff**: which agents get a pill, refreshed (not rebuilt) from
 *   every agent-list snapshot the host pushes;
 * - **one subscription per agent**, opened when the pill is registered and
 *   released with it, so nothing is read for an agent the user cannot see;
 * - **the publish guards**: an answer identical to the last published one does not
 *   repaint the composer, and a failed answer's meaning is each pill's own policy
 *   (jobs publishes the failure and hides, goal/team keep the last state).
 *
 * A *subscriber* is still per agent and per pill: three pills, three
 * subscriptions, three answers — that is how the host's contract is shaped
 * (`defineSubscription` carries one event type), and the server shares the
 * underlying read anyway, so two pills never make two reads of the same data.
 *
 * The host is injected in full, so `harness/jobs-poll-check.cjs` drives this with
 * a fake subscribe (it pushes answers by hand) and a fake directory page: no
 * React, no host types, no clock.
 *
 * @module dsh-paseo/client/agent-subscriptions
 */
import { PROVIDER_ID } from "../shared/provider";
import { isPermissionDeniedError } from "./jobs-popover-layout";

/** Safety cap on directory pagination (200 agents per page → 10,000 agents). */
export const MAX_AGENT_DIRECTORY_PAGES = 50;

/** One answer's shape after the pill's projection: absent data on a failed read. */
export interface PillReadResult<D> {
  available: boolean;
  data?: D;
  error?: { message: string; code?: string };
}

/** One agent's state as the popover store keeps it. */
export interface PillViewState<D> {
  data: D;
  available: boolean;
  error?: string;
  code?: string;
}

/**
 * The fields of an agent a pill cares about — plus `metadata`.
 *
 * `metadata` is Paseo's durable per-agent plugin record. The goal and team pills
 * keep their "seen" signature under a namespaced key there
 * (`shared/pill-metadata`), which is why it travels with the directory snapshot:
 * the value is known before the pill is first presented, so no finished state
 * flashes while a separate read is in flight (the plugin-settings version needed
 * a hydrate gate for exactly that).
 */
export interface PillAgent {
  id: string;
  workspaceId?: string | null;
  provider?: string;
  status?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

/** One page of the agent directory, structurally. */
export interface PillAgentPage {
  entries: readonly { agent: PillAgent }[];
  pageInfo?: { hasMore: boolean; nextCursor: string | null } | undefined;
}

/** Why an agent's pill was torn down; the host decides what to log. */
export type PillRemoveReason = "gone" | "unauthorized" | "terminal";

/**
 * The host half the pills need.
 *
 * `open` is the one new capability: it hands the controller a live answer stream
 * for one agent. Everything else is a callback into the pill module, which owns
 * the React store, the composer registration and the locale.
 */
export interface AgentSubscriptionHost<D, Answer> {
  /**
   * Watch one agent's snapshots until `signal` aborts.
   *
   * `onEnd` fires **only** when the host closes the subscription by itself (the
   * daemon dropped it, the plugin stopped, the subscription was refused); it must
   * not fire for a release this controller initiated, or a teardown would publish
   * a failure for a pill that is already gone.
   */
  open(
    agentId: string,
    onAnswer: (answer: Answer) => void,
    onEnd: (error?: Error) => void,
    signal: AbortSignal,
  ): void;
  /** One more directory page, only when the first snapshot said there is one. */
  listAgentPage(cursor: string): Promise<PillAgentPage>;
  addAgent(agent: PillAgent): void;
  /** An agent the pill already serves changed (status, metadata, title…). */
  updateAgent(agent: PillAgent): void;
  removeAgent(agentId: string, reason: PillRemoveReason, error?: PillReadResult<D>["error"]): void;
  publishState(agentId: string, state: PillViewState<D>): void;
  onError(message: string, error?: unknown): void;
  /**
   * Turn one pushed answer into the pill's payload.
   *
   * The agent id is passed because the jobs projector keys its settle latch and
   * its "could not read" console latch by agent; goal and team ignore it. A
   * projection that throws is reported and the answer is dropped, never
   * half-published.
   */
  project(agentId: string, answer: Answer): PillReadResult<D>;
  /**
   * Which error codes mean "waiting cannot help".
   *
   * Injected rather than imported: the three pills have their own terminal sets,
   * and the controller must not know any of them. A missing code is never
   * terminal — a server half that predates the codes keeps its normal retry.
   */
  isTerminalErrorCode(code: string | undefined): boolean;
  /**
   * The payload a failed answer carries forward.
   *
   * A failed answer reports the previous payload rather than a fabricated one:
   * the jobs pill keeps its last list, the goal pill its last goal.
   */
  initialData: D;
  /**
   * Whether a transient (non-terminal) failure publishes its own state.
   *
   * Publishing (the default) is the jobs behaviour: a transient failure **is
   * published**, so the popover can carry the runtime's message above the last
   * known rows. Visibility is not this flag's business — the jobs pill derives
   * its visible flag from the job data alone (FIELD-NOTES #97), so a published
   * failure can never create or keep a pill. The goal and team pills pass `false`
   * because their design says a transient read error **keeps the last state**: a
   * goal pill that flipped to "could not read" for one bad answer would look like
   * the goal changed, and a team board that vanished would read as "the team is
   * gone". Terminal codes are unaffected: they always remove the pill.
   */
  publishOnTransientError?: boolean;
  /**
   * The sentence a failed answer reports when the runtime supplied none.
   *
   * Injected rather than composed here because it is user-visible copy that
   * predates this module: the jobs pill has always said "could not list this
   * session's jobs", and a generic sentence would be a silent copy change for a
   * surface the user already knows.
   */
  fallbackErrorMessage: string;
  /** What this pill calls itself in diagnostics, e.g. `"jobs pill"`. */
  pillLabel: string;
}

/** The controller a pill drives from its agent subscription. */
export interface AgentSubscriptions {
  /** The first page of an agent-directory snapshot; fetches the rest itself. */
  applySnapshot(page: PillAgentPage): Promise<void>;
  upsert(agent: PillAgent): void;
  drop(agentId: string): void;
  dispose(): void;
}

/** One agent's pill and its live subscription. */
interface Entry<D, Answer> {
  readonly agentId: string;
  agent: PillAgent;
  /** Aborting this ends the host subscription (the SDK releases on abort). */
  readonly controller: AbortController;
  /** `true` while a subscription is open. */
  live: boolean;
  /** A terminal answer or a permission refusal: no pill until a new snapshot. */
  terminal: boolean;
  /** The host closed the subscription; the next directory snapshot reopens it. */
  ended: boolean;
  lastData: D;
  /**
   * The last answer handed to the host, as {@link answerSignature}; `undefined`
   * before the first answer, so a fresh registration always publishes once.
   */
  lastPublished: string | undefined;
}

/**
 * One answer as one comparable string.
 *
 * `publishState` is not free: it rebuilds the popover's store row (waking every
 * listener, including an open popover) and calls `registration.update()`, which
 * the host republishes unconditionally. Under the "hidden unless there is
 * something to show" rule the normal answer is the empty one, so publishing it
 * on every push would repaint the composer and an open popover for nothing. Both
 * payloads are Zod-parsed, flat data (an array of jobs, one goal or `null`, one
 * team board or `null`), so `JSON.stringify` is exact here.
 */
function answerSignature<D>(state: PillViewState<D>): string {
  return JSON.stringify([state.available, state.error ?? "", state.code ?? "", state.data]);
}

/**
 * Create the per-agent controller.
 *
 * Entry identity is implicit: every callback names the agent and re-reads
 * `agents`, so an answer or a close that arrives for a removed entry cannot
 * publish into a re-registered pill.
 */
export function createAgentSubscriptions<D, Answer>(
  host: AgentSubscriptionHost<D, Answer>,
): AgentSubscriptions {
  const agents = new Map<string, Entry<D, Answer>>();
  /**
   * Agents removed by an `agent_update` while a snapshot is still paginating.
   * The same `agent_update` could be followed by a later page that still lists
   * the agent; skipping tombstones keeps the removal from being undone by a page
   * that was already in flight when it happened.
   */
  const tombstones = new Set<string>();
  let generation = 0;
  let disposed = false;

  /**
   * The agent ids the **in-flight** directory snapshot has listed so far, if
   * any. `upsert` adds to it (see `applySnapshot`'s removal diff): an agent the
   * host pushes while the snapshot is still paginating is newer than the pages
   * already read, so it must not be mistaken for one the snapshot dropped.
   */
  let inflightListed: Set<string> | undefined;

  /** Hand one answer to the host, unless it is the same answer it already has. */
  const publishIfChanged = (entry: Entry<D, Answer>, state: PillViewState<D>): void => {
    const signature = answerSignature(state);
    if (entry.lastPublished === signature) return;
    entry.lastPublished = signature;
    host.publishState(entry.agentId, state);
  };

  /**
   * Report a transient failure, unless the pill asked to keep the last state.
   *
   * Skipping the publish also leaves `lastPublished` untouched, so the next
   * successful answer is compared against the last *published* one: an unchanged
   * goal after a flaky answer publishes nothing at all.
   */
  const publishTransient = (entry: Entry<D, Answer>, state: PillViewState<D>): void => {
    if (host.publishOnTransientError === false) return;
    publishIfChanged(entry, state);
  };

  const failedState = (entry: Entry<D, Answer>, error?: { message: string; code?: string }): PillViewState<D> => ({
    data: entry.lastData,
    available: false,
    error: error?.message ?? host.fallbackErrorMessage,
    ...(error?.code === undefined ? {} : { code: error.code }),
  });

  /** Open one entry's subscription; the callbacks ignore a stale entry. */
  const open = (entry: Entry<D, Answer>): void => {
    if (disposed || entry.terminal || entry.live) return;
    entry.live = true;
    entry.ended = false;
    host.open(
      entry.agentId,
      (answer) => onAnswer(entry, answer),
      (error) => onEnd(entry, error),
      entry.controller.signal,
    );
  };

  /** A terminal answer or a refusal: the pill goes and the stream is released. */
  const remove = (entry: Entry<D, Answer>, reason: PillRemoveReason, error?: PillReadResult<D>["error"]): void => {
    const current = agents.get(entry.agentId) === entry;
    if (reason !== "terminal") agents.delete(entry.agentId);
    entry.live = false;
    entry.controller.abort();
    if (current) host.removeAgent(entry.agentId, reason, error);
  };

  /**
   * One pushed answer.
   *
   * A terminal code stops the agent for good — retrying cannot help, and the
   * pill is removed with the reason logged once. That entry **stays** in `agents`
   * flagged `terminal`, which is what keeps a bare `upsert` from restarting a
   * stream that cannot succeed; only a whole new directory snapshot revives it
   * (`reviveTerminal`), because that is the host re-describing the world after a
   * reconnect, when a plugin reload may have rewritten the bridge.
   */
  const onAnswer = (entry: Entry<D, Answer>, answer: Answer): void => {
    if (disposed || entry.terminal) return;
    if (agents.get(entry.agentId) !== entry) return;
    let result: PillReadResult<D>;
    try {
      result = host.project(entry.agentId, answer);
    } catch (error) {
      host.onError(`${host.pillLabel} could not read one answer for ${entry.agentId}`, error);
      return;
    }
    // The publish itself is a host call, and a host store can throw. It must not
    // escape into the subscription's event dispatch (that would look like a
    // transport failure to the host), so it is reported like any other failed
    // answer path and the next answer still gets through.
    try {
      if (!result.available) {
        const error = result.error ?? { message: host.fallbackErrorMessage };
        if (host.isTerminalErrorCode(error.code)) {
          entry.terminal = true;
          remove(entry, "terminal", error);
          return;
        }
        publishTransient(entry, failedState(entry, error));
        return;
      }
      const data = result.data ?? host.initialData;
      entry.lastData = data;
      publishIfChanged(entry, { data, available: true });
    } catch (error) {
      host.onError(`${host.pillLabel} could not publish one answer for ${entry.agentId}`, error);
    }
  };

  /**
   * The host closed the subscription by itself.
   *
   * A refusal (`plugin.subscription.subscribe` needs a permission this
   * connection lacks) is terminal for this registration, like the old RPC's
   * `permission_denied`; a daemon-side close is treated exactly like a failed
   * read. Neither is retried here: Paseo re-subscribes on its own reconnect, and
   * a client-side retry timer is the polling this change removes. A fresh
   * directory snapshot reopens it (`applySnapshot`), which is the same
   * "host re-describes the world" edge that revives a terminal entry.
   */
  const onEnd = (entry: Entry<D, Answer>, error?: Error): void => {
    if (disposed || entry.terminal) return;
    if (agents.get(entry.agentId) !== entry) return;
    // `ready` rejecting and `onClosed` can both describe the same refusal; the
    // first one wins and the second is a no-op.
    if (!entry.live) return;
    entry.live = false;
    entry.ended = true;
    if (isPermissionDeniedError(error)) {
      remove(entry, "unauthorized");
      return;
    }
    host.onError(
      `${host.pillLabel}: the subscription for ${entry.agentId} ended; keeping the last known answer until the host re-subscribes`,
      error,
    );
    try {
      publishTransient(entry, failedState(entry, error === undefined ? undefined : { message: error.message }));
    } catch (publishError) {
      host.onError(`${host.pillLabel} could not publish the failed state for ${entry.agentId}`, publishError);
    }
  };

  const removeAll = (): void => {
    for (const entry of [...agents.values()]) remove(entry, "gone");
  };

  /**
   * Drop a `terminal` entry so a fresh registration can be built for it.
   *
   * Only the snapshot path calls this: `upsert` keeps the terminal entry.
   */
  const reviveTerminal = (agentId: string): void => {
    const entry = agents.get(agentId);
    if (entry === undefined || !entry.terminal) return;
    agents.delete(agentId);
    entry.controller.abort();
  };

  const register = (agent: PillAgent): void => {
    if (disposed) return;
    // Only this provider's agents have DSH jobs/goals. Registering for every
    // agent would put a pill on a Claude/Codex composer that can only ever be
    // empty. All three pills serve the same provider, so the filter is here
    // rather than repeated in each adapter.
    if (agent.provider !== undefined && agent.provider !== PROVIDER_ID) return;
    if ((agent.workspaceId ?? "") === "") return;
    if (agent.status === "closed") {
      const entry = agents.get(agent.id);
      if (entry !== undefined) remove(entry, "gone");
      return;
    }
    const existing = agents.get(agent.id);
    if (existing !== undefined) {
      existing.agent = agent;
      return;
    }
    const entry: Entry<D, Answer> = {
      agentId: agent.id,
      agent,
      controller: new AbortController(),
      live: false,
      terminal: false,
      ended: false,
      lastData: host.initialData,
      lastPublished: undefined,
    };
    agents.set(agent.id, entry);
    host.addAgent(agent);
    open(entry);
  };

  return {
    async applySnapshot(page: PillAgentPage): Promise<void> {
      if (disposed) return;
      const mine = ++generation;
      tombstones.clear();
      /**
       * Every agent the snapshot lists, across all of its pages. It is also the
       * retention set the diff at the end reads.
       *
       * A snapshot is a **refresh of the directory, not a teardown of every
       * pill**: an entry survives while the snapshot still lists it, so its host
       * registration, its subscription and its remembered state all survive too.
       * Removal is a diff — the old teardown path made a reconnect show a
       * completed pill the user had already closed (docs/GOAL.md, 2026-11-09).
       */
      const listed = new Set<string>();
      inflightListed = listed;
      const registerPage = (one: PillAgentPage): void => {
        for (const { agent } of one.entries) {
          if (tombstones.has(agent.id)) continue;
          listed.add(agent.id);
          reviveTerminal(agent.id);
          register(agent);
          // A snapshot is also how an interrupted subscription comes back: the
          // host has just re-described the world, so reopening is a fresh
          // attempt, not a retry timer.
          const entry = agents.get(agent.id);
          if (entry !== undefined && entry.ended) open(entry);
        }
      };
      try {
        registerPage(page);
        let hasMore = page.pageInfo?.hasMore === true;
        let cursor = page.pageInfo?.nextCursor ?? null;
        let pages = 0;
        while (hasMore && cursor !== null) {
          if (disposed || mine !== generation) return;
          if (pages >= MAX_AGENT_DIRECTORY_PAGES) {
            host.onError(`agent directory pagination did not terminate; the ${host.pillLabel} sees only the first pages`);
            return;
          }
          let nextPage: PillAgentPage;
          try {
            nextPage = await host.listAgentPage(cursor);
          } catch (error) {
            if (!disposed && mine === generation) host.onError("could not read the next page of agents", error);
            return;
          }
          if (disposed || mine !== generation) return;
          registerPage(nextPage);
          hasMore = nextPage.pageInfo?.hasMore === true;
          cursor = nextPage.pageInfo?.nextCursor ?? null;
          pages += 1;
        }
        if (disposed || mine !== generation) return;
        if (hasMore && cursor === null) {
          // An incomplete snapshot is not evidence that any agent left: the rest
          // of the directory was never read. Keep every pill and say so.
          host.onError("agent directory reported more pages without a next cursor");
          return;
        }
      } finally {
        // Only this snapshot may close its own window: a newer one already
        // installed its own set, and the `upsert`s it is collecting belong to
        // that one.
        if (inflightListed === listed) inflightListed = undefined;
      }
      // Only now, with the whole directory in hand, is "not listed" a removal.
      for (const agentId of [...agents.keys()]) {
        if (listed.has(agentId)) continue;
        const entry = agents.get(agentId);
        if (entry !== undefined) remove(entry, "gone");
      }
    },

    upsert(agent: PillAgent): void {
      // A host push can land while a snapshot is still paginating. That agent is
      // newer than the pages already read, so it joins the retention set; without
      // this the diff at the end of the snapshot would remove a pill the host
      // just told us about, for an agent that is still there.
      inflightListed?.add(agent.id);
      const existing = agents.get(agent.id);
      if (existing !== undefined && !existing.terminal) {
        existing.agent = agent;
        // The metadata the "seen" keys live in arrives on these updates; the
        // pill decides whether anything it shows actually changed.
        host.updateAgent(agent);
        return;
      }
      register(agent);
    },

    drop(agentId: string): void {
      tombstones.add(agentId);
      const entry = agents.get(agentId);
      if (entry === undefined) return;
      remove(entry, "gone");
    },

    dispose(): void {
      disposed = true;
      removeAll();
    },
  };
}