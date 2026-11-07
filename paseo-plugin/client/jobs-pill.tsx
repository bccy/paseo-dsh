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
 * so the pill asks on a timer. One timer per agent, not one for the composer:
 * the count has to be known before that composer is shown. The polling policy
 * itself (interval, jitter, backoff, terminal errors) lives in `./jobs-polling`
 * so it can be driven by a fake clock instead of reviewed by eye.
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
import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Platform, Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { jobsList, splitJobs, type Job } from "../shared/jobs";
import { createJobsPoller, jobsPillCopy, jobsPillPresentation, type JobsViewState, type PillIcon, type PillPresentation } from "./jobs-polling";
import {
  CHEVRON_BOX,
  FACTS_FONT_SIZE,
  MARK_BOX,
  MARK_DOT_SIZE,
  SECTION_SEPARATOR_COLOR,
  SECTION_SEPARATOR_HEIGHT,
  SECTION_SEPARATOR_MARGIN_VERTICAL,
  TITLE_FONT_SIZE,
  chevronColorToken,
  chevronRotation,
  popoverRootBox,
  rowActiveFill,
  rowBox,
  rowTextColumn,
  sectionDivided,
  statusMark,
  type JobStatus,
} from "./jobs-popover-layout";
import { JobsPillIcon, JobsSpinner } from "./jobs-spinner";
import { localeText, type JobsText } from "./locale";

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

/** One agent's registered pill. Polling state lives in `./jobs-polling`. */
interface PillEntry {
  readonly registration: PluginButtonRegistration;
  /**
   * The mark the last `update` left in the icon slot.
   *
   * `update()` merges, so re-sending `icon` on every poll would replace the
   * `JobsPillIcon` component with an equal-but-new element on each tick. React
   * reconciles by element type, so that alone would not remount — but the host
   * re-validates and republishes the button on every update, and a republish that
   * swaps the component identity is exactly what restarts the animation from zero.
   * Tracking the state here is what makes the icon part of `update` **only** when it
   * actually changes, which is the one thing that guarantees the ring never stutters.
   */
  icon: PillIcon;
  /** What the host was last told; an unchanged recompute publishes nothing. */
  visible: boolean;
  label: string;
  title: string;
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
 * **The title prefers the model's own words.** A bash job registers with the raw
 * command as its `label`, so the pill printed shell source while the tool row
 * above it already read in Chinese — DSH requires a one-line `description` on
 * every bash call and titles its own row with it. When that sentence reached us
 * (`job.description`), it becomes the title and the command drops to the facts
 * line, where it stays visible for anyone checking which command this actually
 * is. Without it the row is exactly what it was: the command, ellipsised.
 *
 * The title is ellipsised on one line rather than wrapped — wrapping pushed
 * every following row out of the popover. The facts line joins its parts with
 * the host's own `·`.
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
  const description = job.description;
  // With a description the title is prose and the command moves down; without
  // one the row is unchanged, so a job whose call this session never saw (or a
  // non-bash producer) still reads correctly instead of showing an empty title.
  const titled = description !== undefined && description !== "";
  const title = titled ? description : job.label;
  // The command is only worth repeating when it is not already the title.
  const facts = [statusWord, titled ? job.label : undefined, progress]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" · ");
  return (
    <View style={rowBox({ compact })}>
      <JobMark status={job.status} theme={theme} />
      <View style={rowTextColumn()}>
        <Text numberOfLines={1} style={{ fontSize: TITLE_FONT_SIZE, color: theme.colors.foreground }}>
          {title}
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
 * The disclosure row's style callback state.
 *
 * `PressableStateCallbackType` carries only `pressed` in both the plugin's and
 * the host's React Native typings, while RN Web does hand `hovered` to the
 * callback — so the host crosses the two everywhere it reads hover
 * (`packages/app/src/components/settings/row-header.tsx`'s `type HoverState`,
 * `packages/app/src/components/ui/menu/menu-item.tsx`). Same here.
 */
type HoverState = PressableStateCallbackType & { hovered?: boolean };

/**
 * The disclosure row over the finished rows: a label, the count in the trailing
 * muted slot, and a chevron that turns down when the section opens.
 *
 * **The geometry is the host's expandable row.** The host's `docs/design.md`
 * §12: "An expandable row uses a trailing right chevron that rotates down when
 * expanded (`SettingsCollapsibleRow`); pressing the row reveals its child rows in
 * place."
 * `packages/app/src/components/settings/row-header.tsx` is that implementation —
 * a trailing `ChevronRight` at `ICON_SIZE.sm` that rotates `90deg`, its colour
 * lifting from `foregroundMuted` to `foreground` while the row is hovered. The
 * label/count split follows the host's own panel rows instead of the settings
 * title: the count is a `rowTrailing` value
 * (`packages/app/src/subagents/track.tsx`) — `fontSize.sm`, `foregroundMuted`,
 * `flexShrink: 2` — so the words stay `fontSize.base` and `foreground` while the
 * number reads as secondary.
 *
 * **The box is still a track row.** `rowBox` is applied unchanged, because a
 * popover body that stopped using it would fall off the rail the subagent panel
 * shares (the composition is asserted in `harness/jobs-popover-check.cjs`). The
 * fill is `surface2` for hover *and* press, which is what the host's own
 * `ComposerTrackRow` paints for both (`rowActive`); the settings page's separate
 * `surface3` press state has no token in the plugin theme, and a menu surface
 * uses one fill anyway.
 *
 * **`aria-expanded` is set by hand on web.** React Native Web does not map
 * `accessibilityState.expanded` to `aria-expanded`, so the host passes it
 * explicitly on web and keeps `accessibilityState` for native
 * (`packages/app/src/composer/tracks.tsx`'s `ariaExpandedProps`) — the same split
 * here, because a disclosure whose state a screen reader cannot read is a button
 * that says nothing about what it does.
 *
 * It is the only pressable in the popover: a job row stays read-only, and the
 * rule is "no `Pressable` inside a row", not "no `Pressable`".
 */
function SettledHeader({
  count,
  expanded,
  theme,
  compact,
  onToggle,
  text,
}: {
  count: number;
  expanded: boolean;
  theme: PopoverTheme;
  compact: boolean;
  onToggle: () => void;
  text: JobsText;
}) {
  // A `Pressable` that styles itself from its own hover is the form the host's
  // `docs/hover.md` calls preferred, and this row has no nested `Pressable` for
  // hover to fight over.
  const rowStyle = ({ hovered = false, pressed }: HoverState) => {
    const active = rowActiveFill(hovered, pressed);
    return [rowBox({ compact }), active === undefined ? undefined : { backgroundColor: theme.colors[active] }];
  };
  const chevronBox = {
    width: CHEVRON_BOX,
    height: CHEVRON_BOX,
    alignItems: "center",
    justifyContent: "center",
    transform: chevronRotation(expanded),
  } as const;
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      // The words, then the count — the host's `label, summary` order
      // (`packages/app/src/components/settings/row-header.tsx`), minus its
      // `summary ? … : label` branch: this header is only rendered when
      // `settled.length > 0`, so the count is always at least 1 and there is no
      // empty case to fall back from.
      accessibilityLabel={`${text.settledLabel}, ${String(count)}`}
      accessibilityState={{ expanded }}
      // Web only, and via a spread so the prop does not exist at all on native
      // (the host's `isWeb ? { "aria-expanded": open } : null`).
      {...(Platform.OS === "web" ? { "aria-expanded": expanded } : null)}
      style={rowStyle}
    >
      {({ hovered = false, pressed }: HoverState) => (
        <>
          <Text
            numberOfLines={1}
            style={{ ...rowTextColumn(), fontSize: TITLE_FONT_SIZE, color: theme.colors.foreground }}
          >
            {text.settledLabel}
          </Text>
          <Text
            numberOfLines={1}
            style={{
              flexShrink: 2,
              minWidth: 0,
              fontSize: FACTS_FONT_SIZE,
              color: theme.colors.foregroundMuted,
            }}
          >
            {String(count)}
          </Text>
          <View style={chevronBox}>
            <Icon
              name="ChevronRight"
              size={CHEVRON_BOX}
              color={theme.colors[chevronColorToken(hovered, pressed)]}
            />
          </View>
        </>
      )}
    </Pressable>
  );
}

/**
 * The popover body: one row per job, live while it is open.
 *
 * It reads the shared store rather than issuing its own RPC, so opening the
 * popover does not double the request rate.
 *
 * **Two groups, and the second one folds.** A session that runs a dozen commands
 * leaves a dozen finished rows behind — the registry keeps a settled record until
 * its owner is disposed — so a flat list becomes a wall of history to scroll past
 * before reaching the one row that is still running. `splitJobs` divides them,
 * and while anything is live the finished half collapses to a single header.
 * This mirrors DSH's own job list (`settledExpanded = settledOpen ?? liveRows.length === 0`);
 * it is not a local invention. The pill itself is a live indicator, so the
 * finished half is a fold inside a live session; the `live.length === 0` default
 * only resolves the section open while the last job's answer is being applied.
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
 *
 * **The rule between the two groups.** The host separates one kind of content
 * from the list with a `MenuSeparator` rather than with chrome
 * (`ComposerTrackActions`: "The divider is what separates them from the list, not
 * their chrome"), so the folded section gets the same 1px rule above it — but
 * only when there is something above it. With nothing running the section is the
 * whole body, and a rule there would just be a line under the panel's top edge.
 *
 * It is a plain `View`, not a `Pressable`, and it takes **no horizontal margin**:
 * `packages/app/src/components/ui/menu/menu-item.tsx`'s separator comment says the
 * rule "still runs the full width of the surface", and the root already cancels
 * the host's 12 on both sides.
 */
function makeJobsPopover(store: JobStore, agentId: string) {
  function JobsPopover({ theme, layout }: PluginButtonContentProps) {
    const [entry, setEntry] = useState<AgentJobs | undefined>(store.get(agentId));
    // `undefined` means "not chosen yet": the section follows the live count
    // until the user taps it, and a tap wins from then on. DSH's own list uses
    // exactly this shape (`settledOpen ?? liveRows.length === 0`), so a session
    // that goes idle does not keep a section the user collapsed.
    const [settledOpen, setSettledOpen] = useState<boolean | undefined>(undefined);

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

    // The transient guard for a popover whose store row is missing or empty:
    // before the first poll lands, or while a terminal read is about to hide the
    // pill. The pill hides as soon as nothing is live, so this is not an idle
    // "session with history" path; the body must render something rather than
    // throw.
    if (entry === undefined || entry.jobs.length === 0) {
      return (
        <View style={root}>
          <NoteLine theme={theme} compact={layout.compact}>
            {text.allSettled}
          </NoteLine>
        </View>
      );
    }

    const { live, settled } = splitJobs(entry.jobs);
    // While anything runs, the finished half starts folded; with nothing running
    // there is nothing to protect the live rows from, so it starts open.
    // `splitJobs` partitions the same statuses `isLiveStatus` classifies, and a
    // status outside `JOB_STATUSES` never reaches here — the wire schema rejects
    // the whole answer — so both groups empty is unreachable, not a fallback.
    const expanded = settledOpen ?? live.length === 0;
    // Same condition the host uses to decide a divider has two things to separate
    // (`ComposerTrackActions` draws none when what follows it is empty).
    const divided = sectionDivided(live.length, settled.length);
    const separator = {
      height: SECTION_SEPARATOR_HEIGHT,
      marginVertical: SECTION_SEPARATOR_MARGIN_VERTICAL,
      backgroundColor: theme.colors[SECTION_SEPARATOR_COLOR],
    } as const;

    return (
      <View style={root}>
        {/* Live rows first in start order — the thing the user opened this for. */}
        {live.map((job) => (
          <JobRow
            key={job.id}
            job={job}
            theme={theme}
            text={text}
            compact={layout.compact}
          />
        ))}
        {divided ? <View style={separator} /> : null}
        {settled.length > 0 ? (
          <SettledHeader
            count={settled.length}
            expanded={expanded}
            theme={theme}
            compact={layout.compact}
            onToggle={() => {
              setSettledOpen(!expanded);
            }}
            text={text}
          />
        ) : null}
        {/* Settled rows stay newest-first, so an expanded section reads as a
            history log rather than in the order the commands happened to run. */}
        {expanded
          ? settled.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                theme={theme}
                text={text}
                compact={layout.compact}
              />
            ))
          : null}
      </View>
    );
  }
  return JobsPopover;
}

/** The daemon's page limit for the agent directory; also the max its schema accepts. */
const AGENT_DIRECTORY_PAGE_SIZE = 200;

/**
 * Register one pill per agent of this provider and keep it current.
 *
 * Returns the contribution's cleanup, which Paseo calls when the plugin, the
 * client entrypoint or the host connection goes away: every timer, every pill
 * and the agent observation are released there. Polling itself is
 * `createJobsPoller`; this function owns the host objects the controller cannot
 * see — the React store the popover reads, the composer registration, and the
 * locale.
 */
export function contributeJobsPill(client: PluginClientContext) {
  const store: JobStore = new Map();
  /** agentId -> the composer registration and its last published state. */
  const pills = new Map<string, PillEntry>();
  const lifetime = new AbortController();
  // Captured here and handed to the popover rather than read through a React
  // context: a popover body is rendered by the host's own tree, and depending on
  // where that sits would throw "useRpc must run inside a contributed plugin
  // surface".
  const rpc = (input: { agentId: string }) => client.rpc(jobsList, input);

  /**
   * Turn one presentation into the host update.
   *
   * The visibility/label rule itself is {@link jobsPillPresentation}; this
   * function only turns its keys into copy and keeps the icon patch
   * conditional. `title` is the neutral noun, **never the count**: on compact
   * the popover is a sheet and the sheet's header is drawn from the button's
   * title, so a title carrying the count would make this the one panel whose
   * heading changes while you look at it.
   */
  const applyPresentation = (agentId: string, presentation: PillPresentation): void => {
    const entry = pills.get(agentId);
    if (entry === undefined) return;
    const text = localeText().jobs;
    // The label is the bare noun 「后台」/「Background」 in every visible state
    // (user decision 2026-11-05): no count, no status word. The ring on the icon
    // says it is working; the popover says how many. There is no idle total:
    // the pill hides when nothing is live.
    const { label } = jobsPillCopy(presentation, text);
    const visible = presentation.visible;
    // Only a real change reaches the host: an identical `update` rebuilds the
    // button and the open popover's page elements for nothing.
    if (
      entry.visible === visible &&
      entry.label === label &&
      entry.title === text.title &&
      entry.icon === presentation.icon
    ) {
      return;
    }
    // `update()` merges, so the icon is sent only when the mark changes — see
    // `PillEntry.icon`. Every readable answer selects the terminal glyph with
    // the turning ring on its corner (the glyph stays, so a pill the host shrank
    // to its icon still reads as the jobs); the static glyph is the baseline
    // 2f71225 branch for an unreadable registry. `SquareTerminal`, not the old
    // `ListChecks`: that read like the host's own task-list pill beside it.
    const icon = presentation.icon === "spinner" ? JobsPillIcon : "SquareTerminal";
    const iconPatch = presentation.icon === entry.icon ? {} : { icon };
    entry.visible = visible;
    entry.label = label;
    entry.title = text.title;
    entry.icon = presentation.icon;
    entry.registration.update({ visible, label, title: text.title, ...iconPatch });
  };

  /**
   * Publish one poll answer: the popover store first (its listeners redraw from
   * it), then the registration.
   */
  const publishState = (agentId: string, next: JobsViewState<Job>) => {
    const entry = pills.get(agentId);
    if (entry === undefined) return;
    publish(store, agentId, {
      jobs: [...next.jobs],
      available: next.available,
      ...(next.error === undefined ? {} : { error: next.error }),
    });
    const presentation = jobsPillPresentation(next);
    applyPresentation(agentId, presentation);
  };

  const poller = createJobsPoller<Job>({
    readJobs: (agentId) => rpc({ agentId }),
    /**
     * The snapshot is only the directory's first page (the daemon defaults to
     * 200 entries); the controller walks `pageInfo.nextCursor` through this.
     */
    listAgentPage: async (cursor) => {
      const page = await client.paseo.agents.list({
        page: { limit: AGENT_DIRECTORY_PAGE_SIZE, cursor },
        signal: lifetime.signal,
      });
      return { entries: page.entries, pageInfo: page.pageInfo };
    },
    addAgent: (agent) => {
      const text = localeText().jobs;
      const registration = client.addComposerPill({
        id: "dsh-jobs",
        workspaceId: agent.workspaceId ?? "",
        agentId: agent.id,
        button: {
          // The ringed glyph from the start: registering the static mark first
          // would flash it for one frame before the first `update` swapped it.
          icon: JobsPillIcon,
          title: text.title,
          // Hidden until the first poll proves otherwise: a pill that appears and
          // then disappears is worse.
          visible: false,
          behavior: { kind: "popover", Content: makeJobsPopover(store, agent.id) },
        },
      });
      // The registration stays hidden until the first poll proves something to
      // show; its initial label is the visible noun, matching what the first
      // presentation would send, so a hidden idle poll repaints nothing.
      pills.set(agent.id, {
        registration,
        icon: "spinner",
        visible: false,
        label: text.pillLabel,
        title: text.title,
      });
      store.delete(agent.id);
    },
    removeAgent: (agentId, reason, error) => {
      const entry = pills.get(agentId);
      if (entry === undefined) return;
      pills.delete(agentId);
      entry.registration.remove();
      // Dropped rather than kept: the popover must not show a stale list for an
      // agent this client may not read, or whose runtime cannot serve jobs at all.
      store.delete(agentId);
      if (reason === "unauthorized") {
        console.error(
          "[dsh-paseo] jobs pill: this connection is not allowed to call plugin RPCs " +
            "(plugin.rpc.invoke needs daemon.manage); the jobs pill is disabled for this agent",
        );
      } else if (reason === "terminal") {
        // A terminal contract error cannot be fixed by polling. Say what to do
        // once in the log, then hide: a permanent error pill per agent is noise,
        // and the four-second retry it used to carry never changed the answer.
        console.error(
          `[dsh-paseo] jobs pill disabled for ${agentId}: ${error?.message ?? "a terminal jobs error"}`,
        );
      }
    },
    publishState,
    onError: (message, error) => {
      if (lifetime.signal.aborted) return;
      // `console`, not `process.stderr`: this module runs inside the app's client
      // bundle, where there is no `process`.
      console.error(`[dsh-paseo] ${message}: ${error instanceof Error ? error.message : String(error)}`);
    },
    setTimeout: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      // Node keeps the process alive for a pending timer; a plugin must not be
      // the reason it never exits.
      (timer as unknown as { unref?: () => void }).unref?.();
      return timer;
    },
    clearTimeout: (timer) => {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
    },
    random: () => Math.random(),
  });

  // An owned list subscription delivers the existing agents, then every update,
  // and a fresh snapshot after a reconnect — which is what keeps the pills
  // correct across a daemon restart without a reload of this bundle.
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: (page) => {
          void poller.applySnapshot(page);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            poller.upsert(update.agent);
            return;
          }
          poller.drop(update.agentId);
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
    poller.dispose();
  };
}
