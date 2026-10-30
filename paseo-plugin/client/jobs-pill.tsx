/**
 * The composer pill that shows how many DeepSeek Harness background jobs the
 * current agent has, and what they are.
 *
 * A pill is a per-agent button in the composer's track bar; Paseo owns the
 * pressable and the placement, this module owns the label, the visibility rule
 * and the popover body.
 *
 * **Why it polls.** DSH's job registry has an event stream, but it lives in the
 * `dsh` child process and the provider protocol has no request shape that would
 * carry those events to the app — inventing one is the self-invented protocol
 * this repo forbids. A plugin can define its own RPC, which is request/response,
 * so the pill asks on a timer. One timer per agent, not one for the composer: the
 * count has to be known before that composer is shown.
 *
 * **What is never shown.** An unreadable registry is not "no jobs": the RPC
 * answers `available: false` with the runtime's own message and the popover says
 * so. A pill that silently disappears when the runtime is broken is the failure
 * this repo keeps finding.
 *
 * @module dsh-paseo/client/jobs-pill
 */
import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { isLiveStatus, jobsList, type Job } from "../shared/jobs";
import { PROVIDER_ID } from "../shared/provider";
import {
  FACTS_FONT_SIZE,
  MARK_BOX,
  MARK_DOT_SIZE,
  TITLE_FONT_SIZE,
  isPermissionDeniedError,
  popoverRootBox,
  rowBox,
  rowTextColumn,
  statusMark,
  type JobStatus,
} from "./jobs-popover-layout";
import { JobsSpinner } from "./jobs-spinner";
import { createPollSequence } from "./poll-sequence";
import { localeText, type JobsText } from "./locale";

/**
 * How often each agent's job list is re-read.
 *
 * Four seconds: fast enough that a job the user just started is on the pill,
 * slow enough that a screen full of agents is not a steady stream of IPC. Paired
 * with the server's `JOBS_READ_TIMEOUT_MS` (15 s) — see the in-flight skip below.
 */
const POLL_MS = 4000;

/** One agent's latest answer, plus the listeners the popover subscribes with. */
interface AgentJobs {
  jobs: Job[];
  /** `false` when the runtime could not be read — never confused with "none". */
  available: boolean;
  error?: string;
  /** Popover bodies re-render from this set when a poll lands. */
  readonly listeners: Set<() => void>;
}

/** The live answer per agent, shared by the pill's label and its popover. */
type JobStore = Map<string, AgentJobs>;

/** One agent's registered pill and its poll state. */
interface AgentEntry {
  readonly registration: PluginButtonRegistration;
  timer: ReturnType<typeof setInterval>;
  /** A poll is already awaiting the daemon; this tick is skipped. */
  inFlight: boolean;
  /**
   * Whether the last `update` left the spinner in the icon slot.
   *
   * `update()` merges, so re-sending `icon` on every poll would replace the
   * `JobsSpinner` component with an equal-but-new element on each tick. React
   * reconciles by element type, so that alone would not remount — but the host
   * re-validates and republishes the button on every update, and a republish that
   * swaps the component identity is exactly what restarts the animation from zero.
   * Tracking the state here is what makes the icon part of `update` **only** when it
   * actually changes, which is the one thing that guarantees the ring never stutters.
   */
  spinning: boolean;
  /**
   * Set when the daemon refused this RPC on **permission** grounds.
   *
   * A restricted client (a hub-routed connection, or one whose
   * `sessionPermissions` ceiling omits `daemon.manage`) is refused
   * `plugin.rpc.invoke` outright — see {@link isPermissionDenied}. That answer is
   * not "the registry could not be read": retrying cannot change it, so the
   * entry stops polling and its pill is hidden instead of showing an error every
   * four seconds forever. See {@link POLL_MS} and the catch branch in `poll`.
   */
  unauthorized: boolean;
}

function publish(store: JobStore, agentId: string, next: Omit<AgentJobs, "listeners">): void {
  const previous = store.get(agentId);
  const entry: AgentJobs = { ...next, listeners: previous?.listeners ?? new Set() };
  store.set(agentId, entry);
  for (const listener of [...entry.listeners]) {
    try {
      listener();
    } catch {
      /* a popover that threw while re-rendering must not stop the others */
    }
  }
}

/** The number of jobs still doing work; what the pill counts. */
function liveCount(jobs: readonly Job[]): number {
  return jobs.filter((job) => isLiveStatus(job.status)).length;
}

/** The popover's body type, so the theme slot is not spelled out at every call. */
type PopoverTheme = PluginButtonContentProps["theme"];

/**
 * One job's leading mark, in the host's fixed 14px box so every row's text lands
 * on the same rail.
 *
 * Ring while live, filled dot once settled — the shape carries the state, which
 * is the host's own rule (`ComposerTrackMark` substitutes the same way). The ring
 * is {@link JobsSpinner}, not drawn here, so the panel and the pill cannot
 * disagree about what "working" looks like. Which status draws which is
 * {@link statusMark}'s table rather than a decision made here.
 */
function JobMark({ status, theme }: { status: JobStatus; theme: PopoverTheme }) {
  const mark = statusMark(status);
  const box = { width: MARK_BOX, height: MARK_BOX } as const;
  return (
    <View style={{ ...box, alignItems: "center", justifyContent: "center" }}>
      {mark.kind === "ring" ? (
        <JobsSpinner size={MARK_BOX} color={theme.colors.foregroundMuted} theme={theme} />
      ) : (
        <View
          style={{
            width: MARK_DOT_SIZE,
            height: MARK_DOT_SIZE,
            borderRadius: MARK_DOT_SIZE / 2,
            backgroundColor: theme.colors[mark.color],
          }}
        />
      )}
    </View>
  );
}

/**
 * One job, laid out as the host lays out a subagent row: a mark, then a two-line
 * column.
 *
 * The title is routinely a whole shell command, so it is ellipsised on one line
 * rather than wrapped — wrapping pushed every following row out of the popover.
 * The facts line joins the status word to any progress with the host's own `·`.
 *
 * **Read-only, no hover fill.** There is nothing to press (killing a job is the
 * model's `job_kill` tool), and the host's rule for that case is a
 * `ComposerTrackRow` with no `onPress`/`opensPage`, which renders
 * `renderRow(false)` and never mounts the pointer handlers. Density follows
 * `layout.compact` for the same reason: the host's row is taller under a finger.
 */
function JobRow({
  job,
  theme,
  text,
  compact,
}: {
  job: Job;
  theme: PopoverTheme;
  text: JobsText;
  compact: boolean;
}) {
  const statusWord = text.statuses[job.status] ?? job.status;
  const progress = job.progress ?? job.detail;
  const facts =
    progress === undefined || progress === "" ? statusWord : `${statusWord} · ${progress}`;
  return (
    <View style={rowBox({ compact })}>
      <JobMark status={job.status} theme={theme} />
      <View style={rowTextColumn()}>
        <Text numberOfLines={1} style={{ fontSize: TITLE_FONT_SIZE, color: theme.colors.foreground }}>
          {job.label}
        </Text>
        <Text
          numberOfLines={1}
          style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}
        >
          {facts}
        </Text>
      </View>
    </View>
  );
}

/**
 * A line of prose for the two states that have no rows: the runtime could not be
 * read, and every job has settled.
 *
 * It wears a row's box, minus the mark. A bare `<Text>` measured 24px tall —
 * shorter than one row — so an empty panel collapsed to a stub that read as a
 * clipped list.
 */
function NoteLine({
  children,
  theme,
  compact,
}: {
  children: string;
  theme: PopoverTheme;
  compact: boolean;
}) {
  return (
    <View style={rowBox({ compact })}>
      <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>
        {children}
      </Text>
    </View>
  );
}

/**
 * The popover body: one row per job, live while it is open.
 *
 * It reads the shared store rather than issuing its own RPC, so opening the
 * popover does not double the request rate. No heading, no separator, no group
 * split: the host's track panels have none of the three, and the mark's shape
 * already says which rows are live.
 *
 * **Why the root has a negative margin.** A plugin popover body is wrapped in
 * `PluginPopoverContent` (12pt on every side) while a host track panel's rows go
 * straight into `MenuSurface`; both then get `MenuPage`'s 4. Cancelling the 12 at
 * the root — and adding no page padding of our own — is what puts a row on the
 * subagent panel's rail. That composition is asserted in the harness, because
 * per-constant checks cannot see it.
 *
 * **No inner ScrollView.** The surface is already scrollable at the host's own
 * `maxHeight`; a second one capped the list shorter and gave the panel two scroll
 * regions.
 */
function makeJobsPopover(store: JobStore, agentId: string) {
  function JobsPopover({ theme, layout }: PluginButtonContentProps) {
    const [entry, setEntry] = useState<AgentJobs | undefined>(store.get(agentId));

    useEffect(() => {
      const current = store.get(agentId);
      setEntry(current);
      if (current === undefined) return;
      const listener = () => {
        setEntry(store.get(agentId));
      };
      current.listeners.add(listener);
      return () => {
        current.listeners.delete(listener);
      };
    }, []);

    const text = localeText().jobs;
    const root = popoverRootBox();

    if (entry !== undefined && !entry.available) {
      return (
        <View style={root}>
          <NoteLine theme={theme} compact={layout.compact}>
            {entry.error ?? text.unavailable}
          </NoteLine>
        </View>
      );
    }

    if (entry === undefined || entry.jobs.length === 0) {
      return (
        <View style={root}>
          <NoteLine theme={theme} compact={layout.compact}>
            {text.allSettled}
          </NoteLine>
        </View>
      );
    }

    return (
      <View style={root}>
        {entry.jobs.map((job) => (
          <JobRow
            key={job.id}
            job={job}
            theme={theme}
            text={text}
            compact={layout.compact}
          />
        ))}
      </View>
    );
  }
  return JobsPopover;
}

/**
 * Register one pill per agent of this provider and keep it current.
 *
 * Returns the contribution's cleanup, which Paseo calls when the plugin, the
 * client entrypoint or the host connection goes away: every timer, every pill
 * and the agent observation are released there.
 */
export function contributeJobsPill(client: PluginClientContext) {
  const store: JobStore = new Map();
  /**
   * agentId -> the registration, its poll timer, and the in-flight flag.
   *
   * One entry per agent because the RPC is per agent. The sequence counter is
   * deliberately **not** here — see {@link sequence}.
   */
  const agents = new Map<string, AgentEntry>();
  /**
   * Which poll answer is allowed to publish.
   *
   * A module of its own so the rule is testable without React. Numbers are
   * globally monotonic and never reset, so a number issued before any teardown
   * can never look newest again.
   */
  const sequence = createPollSequence();
  const lifetime = new AbortController();
  // Captured here and handed to the popover rather than read through a React
  // context: a popover body is rendered by the host's own tree, and depending on
  // where that sits would throw "useRpc must run inside a contributed plugin
  // surface".
  const rpc = (input: { agentId: string }) => client.rpc(jobsList, input);

  const apply = (agentId: string, entry: AgentEntry, next: Omit<AgentJobs, "listeners">) => {
    /**
     * Publish only for the entry that is **currently registered**.
     *
     * The sequence guard is not enough on its own: `remove()` deletes the entry
     * and the agent can be registered again in the same tick, and an answer
     * already past its `await` must not write into the new entry's store row or
     * call `update()` on the old registration. Comparing entry identity covers
     * every teardown path without each one remembering to invalidate something.
     */
    if (agents.get(agentId) !== entry) return;
    if (lifetime.signal.aborted) return;
    publish(store, agentId, next);
    const text = localeText().jobs;
    const count = next.available ? liveCount(next.jobs) : 0;
    // A runtime that could not be read is not "nothing running" — it keeps the
    // pill visible so the popover can explain itself.
    const visible = next.available ? count > 0 : true;
    // Written on **every** update: `update()` merges, so omitting it would leave
    // a stale count on screen after a failed read.
    const label = !next.available ? text.title : count > 0 ? text.label(count) : text.title;
    /**
     * Spinner while jobs run, static mark otherwise — and sent **only when the
     * boolean flips**. `update()` merges, so re-sending the same component every
     * tick makes the host republish the button, and a republish that swaps the
     * component identity restarts the animation from zero: the ring visibly
     * stutters once per poll.
     *
     * The static mark only appears with `available: false`, where it must not
     * spin — a turning ring is this UI's word for "working", so spinning on a
     * failed read would claim progress that is not happening.
     */
    const spinning = count > 0;
    const iconPatch = spinning === entry.spinning ? {} : { icon: spinning ? JobsSpinner : "ListChecks" };
    entry.spinning = spinning;
    /**
     * `title` is the neutral noun, **never the count**: on compact the popover is
     * a sheet and the sheet's header is drawn from the button's title, so a title
     * carrying the count would make this the one panel whose heading changes
     * while you look at it. The count belongs on the label.
     */
    entry.registration.update({ visible, label, title: text.title, ...iconPatch });
  };

  /**
   * One poll, with the three guards that keep the count monotonic in time.
   *
   * **In-flight skip.** The server bounds a read at `JOBS_READ_TIMEOUT_MS` (15 s)
   * while this fires every 4 s, so without it a slow daemon would stack four
   * concurrent RPCs per agent.
   *
   * **Sequence guard.** A pill can be removed and re-registered while its
   * previous poll is in flight, and without a guard the stale answer lands last
   * and the count steps backwards. Only the newest issued poll may publish — see
   * `./poll-sequence`.
   *
   * **Entry guard.** `apply()` refuses an answer whose entry is no longer
   * registered, which covers the teardown paths the sequence cannot see.
   */
  const poll = async (agentId: string, entry: AgentEntry) => {
    if (entry.inFlight) return;
    if (lifetime.signal.aborted) return;
    entry.inFlight = true;
    const seq = sequence.issue(agentId);
    /** Still the newest poll for this agent, and still alive. */
    const current = () => !lifetime.signal.aborted && sequence.isCurrent(agentId, seq);
    try {
      const result = await rpc({ agentId });
      if (!current()) return;
      apply(agentId, entry, {
        jobs: result.jobs,
        available: result.available,
        ...(result.error === undefined ? {} : { error: result.error.message }),
      });
    } catch (error) {
      if (!current()) return;
      /**
       * A permission refusal is **terminal for this agent**, not a failed read:
       * retrying cannot change it, and continuing would leave an undismissable
       * error pill retrying every four seconds forever. Stop the timer, hide the
       * pill.
       *
       * The entry stays in `agents` so a later `upsert` (a reconnect with wider
       * permissions) can retry it — see `register`.
       */
      if (isPermissionDeniedError(error)) {
        entry.unauthorized = true;
        clearInterval(entry.timer);
        entry.registration.update({ visible: false, label: localeText().jobs.title });
        // Dropped rather than kept: the popover must not show a stale list for an
        // agent whose jobs this client may not read.
        store.delete(agentId);
        console.error(
          "[dsh-paseo] jobs pill: this connection is not allowed to call plugin RPCs " +
            "(plugin.rpc.invoke needs daemon.manage); the jobs pill is disabled for this agent",
        );
        return;
      }
      // Any other failure is the same answer as an unreadable registry.
      apply(agentId, entry, {
        jobs: store.get(agentId)?.jobs ?? [],
        available: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Only the newest poll may clear the flag, or two requests could be in
      // flight again — exactly what the flag exists to stop.
      if (sequence.isCurrent(agentId, seq)) entry.inFlight = false;
    }
  };

  const register = (agent: { id: string; workspaceId?: string | null; provider?: string; status?: string }) => {
    if (lifetime.signal.aborted) return;
    // Only this provider's agents have DSH jobs. Registering for every agent
    // would put a pill on Claude/Codex composers that can only ever be empty.
    if (agent.provider !== undefined && agent.provider !== PROVIDER_ID) return;
    const workspaceId = agent.workspaceId ?? "";
    if (workspaceId === "") return;
    const agentId = agent.id;
    // A closed agent has no composer; polling it would keep asking about a
    // session the daemon has already dropped.
    if (agent.status === "closed") {
      remove(agentId);
      return;
    }
    const existing = agents.get(agentId);
    if (existing !== undefined) {
      /**
       * An entry disabled by a permission refusal gets one more chance on the
       * next `upsert` — the only way out of that state without a reload, since a
       * reconnect may come back with a wider permission set.
       */
      if (existing.unauthorized) {
        existing.unauthorized = false;
        existing.registration.update({ visible: false, label: localeText().jobs.title });
        existing.timer = setInterval(() => {
          void poll(agentId, existing);
        }, POLL_MS);
        (existing.timer as unknown as { unref?: () => void }).unref?.();
        void poll(agentId, existing);
      }
      return;
    }

    const registration = client.addComposerPill({
      id: "dsh-jobs",
      workspaceId,
      agentId,
      button: {
        // The spinner from the start: registering the static mark first would
        // flash it for one frame before the first `update` swapped it.
        icon: JobsSpinner,
        title: localeText().jobs.title,
        // Hidden until the first poll proves otherwise: a pill that appears and
        // then disappears is worse.
        visible: false,
        behavior: { kind: "popover", Content: makeJobsPopover(store, agentId) },
      },
    });
    // Built before the timer so the callback and the first poll share one object:
    // `inFlight` lives on the entry, and a detached copy would protect nothing.
    const entry: AgentEntry = {
      registration,
      timer: undefined as unknown as ReturnType<typeof setInterval>,
      inFlight: false,
      // Matches the icon registered above, so the first poll need not re-send it.
      spinning: true,
      // Assumed allowed until a refusal proves otherwise.
      unauthorized: false,
    };
    entry.timer = setInterval(() => {
      void poll(agentId, entry);
    }, POLL_MS);
    // Node keeps the process alive for a pending interval; a plugin must not be
    // the reason it never exits.
    (entry.timer as unknown as { unref?: () => void }).unref?.();
    agents.set(agentId, entry);
    void poll(agentId, entry);
  };

  const remove = (agentId: string) => {
    const entry = agents.get(agentId);
    if (entry === undefined) return;
    agents.delete(agentId);
    clearInterval(entry.timer);
    entry.registration.remove();
    store.delete(agentId);
    /**
     * Invalidate the in-flight poll. Deleting the entry is not enough: an answer
     * already past its `await` would still look newest and `apply()` would
     * re-create the store row just deleted — a ghost pill carrying the previous
     * session's jobs. `apply()`'s entry check is the second line of defence.
     */
    sequence.invalidate(agentId);
  };

  const removeAll = () => {
    for (const agentId of [...agents.keys()]) remove(agentId);
    /**
     * Every agent is torn down, so every number can go — safe only because the
     * counter is global and monotonic: the next `issue()` is larger than anything
     * issued before, so an in-flight poll cannot collide with it.
     */
    sequence.invalidateAll();
  };

  // An owned list subscription delivers the existing agents, then every update,
  // and a fresh snapshot after a reconnect — which is what keeps the pills
  // correct across a daemon restart without a reload of this bundle.
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            register(update.agent);
            return;
          }
          remove(update.agentId);
        },
      });
      return undefined;
    })
    .catch((error) => {
      // Without the agent list there is no pill at all; the console is the only
      // place that can say why, because a pill that was never registered has no
      // surface to report on. `console`, not `process.stderr`: this module runs
      // inside the app's client bundle, where there is no `process`.
      if (!lifetime.signal.aborted) {
        console.error(
          `[dsh-paseo] jobs pill could not observe agents: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });

  return () => {
    lifetime.abort();
    removeAll();
  };
}
