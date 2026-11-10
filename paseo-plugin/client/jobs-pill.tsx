/**
 * The composer pill that shows how many DeepSeek Harness background jobs the
 * current agent has, and what they are.
 *
 * A pill is a per-agent button in the composer's track bar; Paseo owns the
 * pressable and the placement, this module owns the label, the visibility rule
 * and the popover body.
 *
 * **Where the data comes from (2026-11-11, Paseo 0.16).** DSH's job registry has
 * an event stream, but it lives in the `dsh` child process and the provider
 * protocol has no request shape that would carry those events to the app —
 * inventing one is the self-invented protocol this repo forbids. The plugin's own
 * `jobs.snapshot` subscription (`../shared/jobs`) is the supported channel: the
 * server half reads the registry once per agent (`server/pill-feed`, shared by
 * every client watching that agent) and pushes a complete snapshot only when it
 * changes. This module therefore holds no timer; it owns the registration, the
 * visibility rule and the popover body, and `./jobs-polling` owns the answer →
 * pill mapping that used to sit behind the four-second poll.
 *
 * **A failed read does not become a pill.** An unreadable registry is not "no
 * jobs", but it is not a job either: the RPC answers `available: false`, the pill
 * keeps whatever job list was last readable (hidden when that list had nothing
 * live), and the popover puts the runtime's own message above those rows. One
 * console line marks the transition into and out of the failed state
 * (`jobs-polling.ts`), so "could not read" stays loud without a pill that appears
 * and disappears on its own. A pill that silently disappears when the runtime is
 * broken is still forbidden — the log line is what keeps that from happening.
 *
 * @module dsh-paseo/client/jobs-pill
 */
import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  Text,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { jobsSnapshot, jobsStop, splitJobs, type Job, type JobsAnswer } from "../shared/jobs";
import { createAgentSubscriptions } from "./agent-subscriptions";
import {
  JOB_STOP_BOX,
  JOB_STOP_GLYPH,
  JOB_STOP_HIT_SLOP,
  JOB_STOP_RADIUS,
  JOB_STOP_TIMEOUT_MS,
  createJobsProjection,
  isTerminalJobsErrorCode,
  jobRowTitle,
  jobStopA11yLabel,
  jobStopAnswer,
  jobStopDroppedIds,
  jobStopNoteOf,
  jobStopPendingOf,
  jobStopPushed,
  jobStopRefusalNote,
  jobStopStart,
  jobStopTimedOut,
  jobStoppable,
  jobsPillCopy,
  jobsPillPresentation,
  jobsPillViewState,
  type JobStopNote,
  type JobStopStates,
  type JobsViewState,
  type PillIcon,
  type PillPresentation,
} from "./jobs-polling";
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
 * **The row itself stays read-only, with one trailing exception.** There is no
 * row-level press (opening nothing), so the row keeps the host's
 * "no `onPress`/`opensPage`" shape and no hover fill; the **stop button** in the
 * trailing slot is the only pressable inside a job row (2026-11-11), and it owns
 * its own hover/press state. Density follows `layout.compact` for the same reason
 * as the host: its row is taller under a finger.
 *
 * The title is {@link jobRowTitle}, shared with the stop button's accessibility
 * name so the row and its button can never name the job differently.
 */
function JobRow({
  job,
  theme,
  text,
  compact,
  stop,
}: {
  job: Job;
  theme: PopoverTheme;
  text: JobsText;
  compact: boolean;
  /** The trailing stop control, present only for a row the runtime can stop. */
  stop?: { readonly pending: boolean; readonly onPress: () => void };
}) {
  const statusWord = text.statuses[job.status] ?? job.status;
  const progress = job.progress ?? job.detail;
  const description = job.description;
  // With a description the title is prose and the command moves down; without
  // one the row is unchanged, so a job whose call this session never saw (or a
  // non-bash producer) still reads correctly instead of showing an empty title.
  const titled = description !== undefined && description !== "";
  const title = jobRowTitle(job);
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
      {stop === undefined ? null : (
        <StopJobButton job={job} theme={theme} text={text} pending={stop.pending} onPress={stop.onPress} />
      )}
    </View>
  );
}

/**
 * The stop button in a running row's trailing slot (design 2026-11-11).
 *
 * A **28×28 icon box** (`hitSlop` 8 per side → a 44×44 target) that becomes a
 * small `ActivityIndicator` and disables itself while the request is in flight.
 * The glyph is Lucide's `Square` — the host's own stop mark (`Square` is
 * `STOP_ICON` in its workspace-scripts menu). Muted at rest, `statusDanger` while
 * hovered or pressed (the plugin theme has no separate `destructive` token); no
 * colour is written literally.
 *
 * It is mounted only when `canStop === true`: a row already stopping, or one
 * whose runtime refuses, does not get a button that would do nothing.
 */
function StopJobButton({
  job,
  theme,
  text,
  pending,
  onPress,
}: {
  job: Job;
  theme: PopoverTheme;
  text: JobsText;
  pending: boolean;
  onPress: () => void;
}) {
  // Hover and press are state, not a style callback: the **glyph** changes colour
  // too, and a `style` callback cannot reach the child. `onHoverIn`/`onHoverOut`
  // are what the goal popover's icon buttons use on the same host.
  const [hot, setHot] = useState(false);
  const [pressed, setPressed] = useState(false);
  const box = {
    width: JOB_STOP_BOX,
    height: JOB_STOP_BOX,
    borderRadius: JOB_STOP_RADIUS,
    alignItems: "center",
    justifyContent: "center",
  } as const;
  const touch = {
    top: JOB_STOP_HIT_SLOP,
    bottom: JOB_STOP_HIT_SLOP,
    left: JOB_STOP_HIT_SLOP,
    right: JOB_STOP_HIT_SLOP,
  } as const;
  const active = rowActiveFill(hot, pressed);
  return (
    <Pressable
      onPress={onPress}
      disabled={pending}
      hitSlop={touch}
      onHoverIn={() => setHot(true)}
      onHoverOut={() => setHot(false)}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      accessibilityRole="button"
      accessibilityLabel={jobStopA11yLabel(text, jobRowTitle(job))}
      accessibilityState={{ disabled: pending }}
      style={[
        box,
        active === undefined ? undefined : { backgroundColor: theme.colors[active] },
        pending ? { opacity: 0.6 } : undefined,
      ]}
    >
      {pending ? (
        <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
      ) : (
        <Icon
          name="Square"
          size={JOB_STOP_GLYPH}
          color={hot || pressed ? theme.colors.statusDanger : theme.colors.foregroundMuted}
        />
      )}
    </Pressable>
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
  tone = "neutral",
  numberOfLines,
}: {
  children: string;
  theme: PopoverTheme;
  compact: boolean;
  /**
   * `error` is the runtime's own sentence for something it refused or could not
   * do; `neutral` is a tip (see `jobStopRefusalNote`). The failure note above a
   * list keeps `neutral`, which is what it has always been.
   */
  tone?: "neutral" | "error";
  numberOfLines?: number;
}) {
  return (
    <View style={rowBox({ compact })}>
      <Text
        numberOfLines={numberOfLines}
        style={{
          fontSize: FACTS_FONT_SIZE,
          color: tone === "error" ? theme.colors.statusDanger : theme.colors.foregroundMuted,
        }}
      >
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
function makeJobsPopover(client: PluginClientContext, store: JobStore, agentId: string) {
  function JobsPopover({ theme, layout }: PluginButtonContentProps) {
    const [entry, setEntry] = useState<AgentJobs | undefined>(store.get(agentId));
    /**
     * The stop state per job row, and the 5-second timers that watch it.
     *
     * All of it is the **popover's**, not the pill's: the button exists only while
     * a panel is open, and a closed popover must not keep a timer alive. The
     * rules themselves are pure (`./jobs-polling`'s `jobStop*`), so the offline
     * check drives them without React.
     */
    const [stops, setStops] = useState<JobStopStates>({});
    /**
     * A ref mirror of `stops`.
     *
     * The RPC answer, the timer and the push listener all run outside the render
     * that created them, so each must apply its transition to the **latest**
     * state, not to the `stops` captured when the handler was created. Every
     * writer goes through {@link applyStops}, which updates both.
     */
    const stopsRef = useRef<JobStopStates>({});
    const stopTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    const applyStops = (next: JobStopStates): void => {
      if (next === stopsRef.current) return;
      stopsRef.current = next;
      setStops(next);
    };
    const clearStopTimer = (jobId: string): void => {
      const timer = stopTimers.current.get(jobId);
      if (timer === undefined) return;
      clearTimeout(timer);
      stopTimers.current.delete(jobId);
    };
    useEffect(
      () => () => {
        for (const timer of stopTimers.current.values()) clearTimeout(timer);
        stopTimers.current.clear();
      },
      [],
    );
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
        const next = store.get(agentId);
        setEntry(next);
        // A push is the truth about these rows: a job that stopped being
        // stoppable drops its button state, and a refusal note has been read
        // (the design's "下次推送…清除"). A pending row keeps waiting.
        if (next !== undefined) {
          const before = stopsRef.current;
          const after = jobStopPushed(before, next.jobs);
          // A row whose state the push dropped must not keep its 5 s timer: a late
          // timeout would re-enter a row the push already settled (review P3-5).
          for (const jobId of jobStopDroppedIds(before, after)) clearStopTimer(jobId);
          applyStops(after);
        }
      };
      current.listeners.add(listener);
      return () => {
        current.listeners.delete(listener);
      };
    }, []);

    const text = localeText().jobs;
    const root = popoverRootBox();

    /**
     * Press stop on one row.
     *
     * Pending starts immediately; the answer only decides the **note**. A success
     * changes nothing visible on purpose: the row must be updated by the
     * subscription, never by this client (design 2026-11-11), so a job cannot
     * look stopped in this window while the runtime still runs it. The 5-second
     * timer is the one exception — if the push has not ended the running state by
     * then, the row says the request was sent but the job is still running.
     */
    const stopJob = (job: Job): void => {
      const started = jobStopStart(stopsRef.current, job);
      // Not stoppable, or already pending: the design's "重复点击无效". Applying
      // the same object would be a no-op anyway; returning keeps the RPC from
      // being sent twice for one row.
      if (started === stopsRef.current) return;
      applyStops(started);
      clearStopTimer(job.id);
      stopTimers.current.set(
        job.id,
        setTimeout(() => {
          stopTimers.current.delete(job.id);
          const current = store.get(agentId)?.jobs ?? [];
          const row = current.find((candidate) => candidate.id === job.id);
          // A row that left the list is passed as "not stoppable", which drops
          // its state instead of reporting a verdict about a job nobody shows.
          applyStops(jobStopTimedOut(stopsRef.current, row ?? { id: job.id, canStop: false }, text));
        }, JOB_STOP_TIMEOUT_MS),
      );
      void client
        .rpc(jobsStop, { agentId, jobId: job.id })
        .then((result) => {
          applyStops(jobStopAnswer(stopsRef.current, job.id, result, text));
          if (!jobStopPendingOf(stopsRef.current, job.id)) clearStopTimer(job.id);
        })
        .catch((error: unknown) => {
          // A rejected request is a transport failure, not a refusal value from
          // the runtime: it has no code, so the message goes through as the
          // error-tone note (`jobStopRefusalNote`'s default branch).
          const message = error instanceof Error ? error.message : String(error);
          applyStops(jobStopAnswer(stopsRef.current, job.id, { ok: false, error: { message } }, text));
          clearStopTimer(job.id);
        });
    };

    /**
     * The failed-read note, when there is one.
     *
     * It is a **note above the list, not a replacement for it** (2026-11-10).
     * The store's rows are the last answer that could be read, and a failure is
     * a fact about the read, not about the jobs: replacing the rows with the
     * error is what made one transient RPC failure look like the registry had
     * changed — the same publish the pill reads for its count, so the two
     * surfaces disagreed on screen ("1 个运行中" over "Stream end encountered").
     * Keeping both means "could not read" stays loud *and* the user still sees
     * the job that is running.
     */
    const unavailableNote =
      entry !== undefined && !entry.available ? (
        <NoteLine theme={theme} compact={layout.compact}>
          {entry.error ?? text.unavailable}
        </NoteLine>
      ) : null;

    // The transient guard for a popover whose store row is missing or empty:
    // before the first poll lands, or while a terminal read is about to hide the
    // pill. The pill hides as soon as nothing is live, so this is not an idle
    // "session with history" path; the body must render something rather than
    // throw.
    if (entry === undefined || (entry.jobs.length === 0 && unavailableNote === null)) {
      return (
        <View style={root}>
          <NoteLine theme={theme} compact={layout.compact}>
            {text.allSettled}
          </NoteLine>
        </View>
      );
    }
    // An unreadable registry with no known job has nothing but the note: never
    // claim "all finished" for a list we could not read.
    if (entry.jobs.length === 0) return <View style={root}>{unavailableNote}</View>;

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
        {/* Above the rows so the failure is readable without scrolling. */}
        {unavailableNote}
        {/* Live rows first in start order — the thing the user opened this for. */}
        {live.map((job) => {
          const note = jobStopNoteOf(stops, job.id);
          return (
            <Fragment key={job.id}>
              <JobRow
                job={job}
                theme={theme}
                text={text}
                compact={layout.compact}
                // Only a row the runtime can stop gets the control (design:
                // `canStop === true`); a `stopping` row is already on its way.
                stop={
                  jobStoppable(job)
                    ? { pending: jobStopPendingOf(stops, job.id), onPress: () => stopJob(job) }
                    : undefined
                }
              />
              {note === undefined ? null : (
                <NoteLine theme={theme} compact={layout.compact} tone={note.tone} numberOfLines={1}>
                  {note.message}
                </NoteLine>
              )}
            </Fragment>
          );
        })}
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
 * client entrypoint or the host connection goes away: every subscription, every
 * pill and the agent observation are released there. The per-agent lifecycle is
 * `createAgentSubscriptions`; this function owns the host objects the controller
 * cannot see — the React store the popover reads, the composer registration, the
 * subscription call itself, and the locale.
 */
export function contributeJobsPill(client: PluginClientContext) {
  const store: JobStore = new Map();
  /** agentId -> the composer registration and its last published state. */
  const pills = new Map<string, PillEntry>();
  const lifetime = new AbortController();

  /**
   * One console line per transition, never per answer: a failing host must not
   * flood the log at the old poll rate.
   *
   * `console`, not `process.stderr`: this module runs inside the app's client
   * bundle, where there is no `process`. A recovery line carries no error, so the
   * suffix is omitted rather than printing "undefined".
   */
  const onError = (message: string, error?: unknown): void => {
    if (lifetime.signal.aborted) return;
    const detail = error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`[dsh-paseo] ${message}${detail}`);
  };

  /**
   * The jobs half of the answer mapping: settlements latched, and the one
   * console line per entry into the unreadable state (`./jobs-polling`).
   */
  const projection = createJobsProjection({ onError });

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

  const subscriptions = createAgentSubscriptions<readonly Job[], JobsAnswer>({
    /**
     * Watch this agent's snapshots.
     *
     * `client.subscribe` re-subscribes by itself after a reconnect and releases
     * what is left when the plugin stops; aborting `signal` releases this one, so
     * the controller deliberately keeps no handle. `onClosed` must not fire for
     * this controller's own release, and the `signal.aborted` guard makes sure a
     * late one is ignored.
     */
    open: (agentId, onAnswer, onEnd, signal) => {
      const handle = client.subscribe(jobsSnapshot, { agentId }, onAnswer, {
        signal,
        onClosed: (closed) => {
          if (signal.aborted) return;
          onEnd(closed.error);
        },
      });
      // A refused subscription rejects `ready` instead of closing: same path, so
      // the pill degrades exactly like a failed read (and a permission refusal
      // still removes it).
      void handle.ready.catch((error: unknown) => {
        if (signal.aborted) return;
        onEnd(error instanceof Error ? error : new Error(String(error)));
      });
    },
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
          behavior: { kind: "popover", Content: makeJobsPopover(client, store, agent.id) },
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
    updateAgent: () => {
      // The jobs pill keeps nothing in the agent's metadata: its whole state is
      // the pushed answer, so an agent update (status, title, metadata) has
      // nothing to re-present. The callback exists because the controller hands
      // every update to the pill that owns the agent; the goal and team pills
      // read their "seen" key from it here.
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
    // The controller carries the payload as `data`; `jobsPillViewState` names it
    // `jobs` for this pill's store row.
    publishState: (agentId, state) => publishState(agentId, jobsPillViewState(state)),
    project: (agentId, answer) => projection.project(agentId, answer),
    onError,
    isTerminalErrorCode: isTerminalJobsErrorCode,
    initialData: [],
    // The jobs pill's own copy, unchanged from before the transport moved: the
    // trigger, the popover and these log lines are the surface the user already
    // knows, and a genericised sentence would be a silent copy change.
    fallbackErrorMessage: "the DSH runtime could not list this session's jobs",
    pillLabel: "jobs pill",
  });

  // An owned list subscription delivers the existing agents, then every update,
  // and a fresh snapshot after a reconnect — which is what keeps the pills
  // correct across a daemon restart without a reload of this bundle.
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: (page) => {
          void subscriptions.applySnapshot(page);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            subscriptions.upsert(update.agent);
            return;
          }
          subscriptions.drop(update.agentId);
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
    subscriptions.dispose();
  };
}
