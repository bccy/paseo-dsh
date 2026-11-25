/**
 * The team panel (T3, design T2 direction B; roster reworked in T5; readability
 * refresh with shared frameless popover primitives): the shared tasks grouped
 * by state, under a one-line roster summary, and an in-place detail page for
 * one task.
 *
 * **No member rows (T5).** Ten members filled a phone's first screen and could
 * not be opened, while Paseo's own subagent panel already lists them and opens
 * each conversation. The roster is one headline (T7): whale + 「DeepSeek」 +
 * 「N 名成员」 (teammates only) and soft-tinted status pills (创建失败 danger,
 * 运行中 with the host ring, 已停止 neutral dot, 任务完成 N/M with the host
 * check), and who is working shows where it matters: right after an owner's
 * name, the host running ring when the server says the owner runs, a warning
 * 已停止 tag when it says the owner stopped (an in-progress task left behind —
 * DSH does not release on exit), and the 进行中 header counts the latter.
 *
 * **Native Paseo frameless.** Pure `surface0`, `rowBox` track geometry
 * (32/40px), `surface2` hover/press fill, `1px` hairlines, soft-tinted pills,
 * and structured selectable prose — zero boxed `surface1` cards and zero
 * HTML/DOM/CSS.
 *
 * **The detail page is in place, not a host page.** The host's sub-pages
 * (`MenuSurface pages`) are reachable only from a `menu` behavior; a `popover`
 * Content cannot register one in Paseo 0.15+. So the page is a mode of this
 * body (like the goal panel's edit page) with a minimal back bar on the left
 * and quiet monospace task id + revision on the right.
 *
 * Read-only throughout: there is no team write path the bridge could carry.
 *
 * @module dsh-paseo/client/team-popover
 */
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Platform, Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import type { TeamMember, TeamTask, TeamView } from "../shared/team";
import { mono, tint } from "./console-theme";
import { DeepSeekMark } from "./deepseek-mark";
import {
  CHEVRON_BOX,
  FACTS_FONT_SIZE,
  TITLE_FONT_SIZE,
  chevronColorToken,
  chevronRotation,
  popoverRootBox,
  ringColorFor,
  rowActiveFill,
  rowBox,
  rowTextColumn,
} from "./jobs-popover-layout";
import type { TeamText } from "./locale";
import { parseProseBlocks } from "./popover-prose";
import {
  POPOVER_DETAIL_TITLE_LINE,
  POPOVER_DETAIL_TITLE_SIZE,
  PopoverAlertRow,
  PopoverHairline,
  PopoverPill,
  PopoverProse,
  PopoverSectionHeader,
  type PopoverPillTone,
  type PopoverTheme,
} from "./popover-ui";
import { StatusRingMark } from "./status-ring";
import {
  TEAM_HEAD_LEVELS,
  TEAM_TASK_ICONS,
  teamHeadAt,
  teamHeadItems,
  teamHeadLabel,
  teamHeadLevel,
  teamMateCount,
  teamOwnerLabel,
  teamOwnerState,
  teamStoppedOwnerCount,
  teamTaskFacts,
  teamTaskFactsParts,
  teamTaskGroups,
  teamTaskMark,
  teamWarningText,
  type TeamHeadItem,
  type TeamHeadKey,
  type TeamHeadLevel,
  type TeamOwnerState,
  type TeamTaskMark,
} from "./team-polling";

type HoverState = PressableStateCallbackType & { hovered?: boolean };

/** The mark slot: the host's 16px icon slot (`task-list-row.tsx`). */
export const TEAM_MARK_SIZE = 16;
/** Title / facts line boxes (host `fontSize.base` 14 → 20, `sm` 12 → 16). */
const TITLE_LINE = 20;
const FACTS_LINE = 16;
/** The main list shows at most two lines of a task's subject. */
export const TEAM_SUBJECT_LINES = 2;
/** The main list shows at most two lines of a task's description. */
export const TEAM_DESCRIPTION_LINES = 2;

/** The plugin theme lacks `foregroundExtraMuted`; the host's done/pending marks use it. */
function extraMuted(theme: PopoverTheme): string {
  return (theme.colors as Record<string, string>).foregroundExtraMuted ?? theme.colors.foregroundMuted;
}

/** The owner's running ring: the host ring at the 12px facts line's size (the ring's own 12px box). */
export const TEAM_OWNER_RING_SIZE = 12;

/**
 * The mark after an owner's name, in a facts line or the detail page's owner
 * strip (T5): the host running ring when the server says the owner runs, a
 * warning-tinted 已停止 pill when it says the owner stopped, nothing otherwise
 * (`teamOwnerState`).
 */
function OwnerMark({ state, theme, text }: { state: TeamOwnerState | undefined; theme: PopoverTheme; text: TeamText }) {
  if (state === "running") {
    return (
      <View
        accessibilityRole="progressbar"
        style={{ width: TEAM_OWNER_RING_SIZE, height: FACTS_LINE, alignItems: "center", justifyContent: "center", marginLeft: 4 }}
      >
        <StatusRingMark size={TEAM_OWNER_RING_SIZE} color={ringColorFor(theme.colors.surface0)} />
      </View>
    );
  }
  if (state === "stopped") {
    return <PopoverPill theme={theme} label={text.ownerStopped} tone="warning" compact style={{ marginLeft: 4 }} />;
  }
  return null;
}

function headChipTone(key: TeamHeadKey): PopoverPillTone {
  switch (key) {
    case "running":
      return "running";
    case "done":
      return "success";
    case "failed":
      return "danger";
    case "stopped":
      return "neutral";
  }
}

/** A chip's leading glyph: host ring (运行中), grey dot (已停止), host check (任务完成), red dot (创建失败). */
function HeadGlyph({ item, theme }: { item: TeamHeadItem; theme: PopoverTheme }) {
  const box = { width: 12, height: 12, alignItems: "center", justifyContent: "center" } as const;
  if (item.key === "running") {
    return (
      <View style={box}>
        <StatusRingMark size={12} color={ringColorFor(theme.colors.surface0)} />
      </View>
    );
  }
  if (item.key === "done") {
    return (
      <View style={box}>
        <Icon name="CircleCheck" size={12} color={theme.colors.statusSuccess} />
      </View>
    );
  }
  const color = item.key === "failed" ? theme.colors.statusDanger : theme.colors.foregroundMuted;
  return (
    <View style={box}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, opacity: item.key === "stopped" ? 0.6 : 1 }} />
    </View>
  );
}

function HeadChip({ item, theme, text, short }: { item: TeamHeadItem; theme: PopoverTheme; text: TeamText; short: boolean }) {
  return (
    <PopoverPill
      theme={theme}
      label={teamHeadLabel(item, text, short)}
      tone={headChipTone(item.key)}
      leading={<HeadGlyph item={item} theme={theme} />}
      compact
      testID={`team-chip-${item.key}`}
    />
  );
}

/**
 * The roster headline (T7, direction 2): whale + 「DeepSeek」 + 「N 名成员」, then
 * the status chips, all on one line. Not pressable — Paseo's own subagent
 * panel lists and opens the members.
 *
 * The chips are fitted by measurement: every `TEAM_HEAD_LEVELS` level is laid
 * out once, invisibly; the first whose width fits the room the title left is
 * shown (`teamHeadLevel`). `onLayout` works the same on web and native.
 */
function TeamHeadline({ team, theme, text }: { team: TeamView; theme: PopoverTheme; text: TeamText }) {
  const items = teamHeadItems(team);
  const [room, setRoom] = useState<number | undefined>(undefined);
  const [widths, setWidths] = useState<(number | undefined)[]>([]);
  const level = TEAM_HEAD_LEVELS[teamHeadLevel(widths, room)];
  // Teammates only (the Lead is the main session); none → no 「0 名成员」.
  const mateCount = teamMateCount(team);
  const members = mateCount > 0 ? text.memberCount(mateCount) : undefined;
  const shown = teamHeadAt(items, level);
  const cluster = (candidate: TeamHeadLevel) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      {teamHeadAt(items, candidate).map((item) => (
        <HeadChip key={item.key} item={item} theme={theme} text={text} short={candidate.short} />
      ))}
    </View>
  );
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={[text.head.title, ...(members === undefined ? [] : [members]), ...shown.map((item) => teamHeadLabel(item, text, false))].join("，")}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 }}
    >
      <DeepSeekMark size={16} />
      <Text numberOfLines={1} style={{ flexShrink: 0, fontSize: TITLE_FONT_SIZE, fontWeight: "600", color: theme.colors.foreground }}>
        {text.head.title}
      </Text>
      {members === undefined ? null : (
        <Text numberOfLines={1} style={{ flexShrink: 0, fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>
          {members}
        </Text>
      )}
      {items.length === 0 ? null : (
        <View
          style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, flexDirection: "row", justifyContent: "flex-end" }}
          onLayout={(event) => setRoom(event.nativeEvent.layout.width)}
        >
          {TEAM_HEAD_LEVELS.map((candidate, index) => (
            <View
              key={index}
              aria-hidden
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              pointerEvents="none"
              style={{ position: "absolute", right: 0, top: 0, opacity: 0 }}
              onLayout={(event) => {
                const width = event.nativeEvent.layout.width;
                setWidths((prev) => {
                  if (prev[index] === width) return prev;
                  const next = [...prev];
                  next[index] = width;
                  return next;
                });
              }}
            >
              {cluster(candidate)}
            </View>
          ))}
          <View testID="team-head-chips">{cluster(level)}</View>
        </View>
      )}
    </View>
  );
}

function taskMarkTone(mark: TeamTaskMark): PopoverPillTone {
  switch (mark) {
    case "doing":
      return "running";
    case "done":
      return "success";
    case "blocked":
      return "warning";
    case "ready":
      return "neutral";
  }
}

/** The host task-list row's marks: running blue `CircleDot`, muted `Circle`, warning `CircleDashed`, extra-muted `CircleCheck`. */
function TaskMarkIcon({ mark, theme, lineHeight = TITLE_LINE }: { mark: TeamTaskMark; theme: PopoverTheme; lineHeight?: number }) {
  const color =
    mark === "doing"
      ? ringColorFor(theme.colors.surface0)
      : mark === "blocked"
        ? theme.colors.statusWarning
        : mark === "ready"
          ? theme.colors.foregroundMuted
          : extraMuted(theme);
  return (
    <View style={{ width: TEAM_MARK_SIZE, height: lineHeight, justifyContent: "center" }}>
      <Icon name={TEAM_TASK_ICONS[mark]} size={TEAM_MARK_SIZE} color={color} />
    </View>
  );
}

function TaskDetailStatusGlyph({ mark, ownerState, theme }: { mark: TeamTaskMark; ownerState: TeamOwnerState | undefined; theme: PopoverTheme }) {
  const box = { width: 12, height: 12, alignItems: "center", justifyContent: "center" } as const;
  if (mark === "doing" && ownerState === "running") {
    return (
      <View style={box}>
        <StatusRingMark size={12} ring={10} color={ringColorFor(theme.colors.surface0)} />
      </View>
    );
  }
  const color =
    mark === "doing"
      ? ringColorFor(theme.colors.surface0)
      : mark === "done"
        ? theme.colors.statusSuccess
        : mark === "blocked"
          ? theme.colors.statusWarning
          : theme.colors.foregroundMuted;
  return (
    <View style={box}>
      <Icon name={TEAM_TASK_ICONS[mark]} size={11} color={color} />
    </View>
  );
}

/** One task row: mark, two-line subject, facts, warnings, two lines of description; the whole row opens the detail page. */
function TaskRow({
  task,
  members,
  theme,
  text,
  compact,
  onOpen,
}: {
  task: TeamTask;
  members: readonly TeamMember[];
  theme: PopoverTheme;
  text: TeamText;
  compact: boolean;
  onOpen: () => void;
}) {
  const mark = teamTaskMark(task);
  const facts = teamTaskFactsParts(task, text);
  const ownerState = teamOwnerState(task, members);
  const done = mark === "done";
  const description = task.description.replace(/\s*\n+\s*/g, " ").trim();
  const hasIdPrefix = task.id !== "" && facts.lead.startsWith(task.id);
  const idPart = hasIdPrefix ? task.id : "";
  const ownerPart = hasIdPrefix ? facts.lead.slice(task.id.length) : facts.lead;
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${task.subject}，${text.marks[mark]}，${teamTaskFacts(task, text)}${ownerState === "stopped" ? `，${text.ownerStopped}` : ""}`}
      style={({ hovered = false, pressed }: HoverState) => {
        const fill = rowActiveFill(hovered, pressed);
        return [{ ...rowBox({ compact }), alignItems: "flex-start" as const }, fill === undefined ? undefined : { backgroundColor: theme.colors[fill] }];
      }}
    >
      {({ hovered = false, pressed }: HoverState) => (
        <>
          <TaskMarkIcon mark={mark} theme={theme} />
          <View style={rowTextColumn()}>
            <Text
              numberOfLines={TEAM_SUBJECT_LINES}
              style={{
                fontSize: TITLE_FONT_SIZE,
                lineHeight: TITLE_LINE,
                fontWeight: "500",
                color: done ? extraMuted(theme) : theme.colors.foreground,
                textDecorationLine: done ? "line-through" : "none",
              }}
            >
              {task.subject}
            </Text>
            {/* The owner's mark sits right after the owner's name, so the line
                is id (mono), owner, the mark, then · blockers · scopes. */}
            <View style={{ flexDirection: "row", alignItems: "center", minWidth: 0, marginTop: 2 }}>
              {idPart === "" ? null : (
                <Text numberOfLines={1} style={{ flexShrink: 0, fontFamily: mono, fontSize: 11.5, lineHeight: FACTS_LINE, color: extraMuted(theme) }}>
                  {idPart}
                </Text>
              )}
              {ownerPart === "" ? null : (
                <Text
                  numberOfLines={1}
                  style={{
                    flexShrink: 0,
                    fontSize: FACTS_FONT_SIZE,
                    lineHeight: FACTS_LINE,
                    color: done ? extraMuted(theme) : facts.owner ? tint(theme.colors.foreground, 0.78) : theme.colors.foregroundMuted,
                  }}
                >
                  {ownerPart}
                </Text>
              )}
              {facts.owner ? <OwnerMark state={ownerState} theme={theme} text={text} /> : null}
              {facts.trail === "" ? null : (
                <Text numberOfLines={1} style={{ flexShrink: 1, minWidth: 0, fontSize: FACTS_FONT_SIZE, lineHeight: FACTS_LINE, color: theme.colors.foregroundMuted }}>
                  {facts.trail}
                </Text>
              )}
            </View>
            {task.writeScopeWarnings.map((warning) => (
              <View key={warning} style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 }}>
                <Icon name="TriangleAlert" size={12} color={theme.colors.statusWarning} />
                <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: FACTS_FONT_SIZE, lineHeight: FACTS_LINE, color: theme.colors.statusWarning }}>
                  {teamWarningText(warning, text)}
                </Text>
              </View>
            ))}
            {description === "" ? null : (
              <Text
                numberOfLines={TEAM_DESCRIPTION_LINES}
                style={{ marginTop: 3, fontSize: 12.5, lineHeight: 18, color: theme.colors.foregroundMuted }}
              >
                {description}
              </Text>
            )}
          </View>
          <View style={{ width: CHEVRON_BOX, height: TITLE_LINE, alignItems: "center", justifyContent: "center" }}>
            <Icon name="ChevronRight" size={CHEVRON_BOX} color={theme.colors[chevronColorToken(hovered, pressed)]} />
          </View>
        </>
      )}
    </Pressable>
  );
}

/** The done group's header: the jobs panel's folding row (label, trailing count, turning chevron). */
function DoneHeader({
  theme,
  text,
  count,
  open,
  compact,
  onToggle,
}: {
  theme: PopoverTheme;
  text: TeamText;
  count: number;
  open: boolean;
  compact: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={`${text.marks.done}, ${String(count)}`}
      accessibilityState={{ expanded: open }}
      {...(Platform.OS === "web" ? { "aria-expanded": open } : null)}
      style={({ hovered = false, pressed }: HoverState) => {
        const fill = rowActiveFill(hovered, pressed);
        return [rowBox({ compact }), fill === undefined ? undefined : { backgroundColor: theme.colors[fill] }];
      }}
    >
      {({ hovered = false, pressed }: HoverState) => (
        <>
          <Text numberOfLines={1} style={{ ...rowTextColumn(), fontSize: TITLE_FONT_SIZE, color: theme.colors.foreground }}>
            {text.marks.done}
          </Text>
          <Text style={{ flexShrink: 2, minWidth: 0, fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>{String(count)}</Text>
          <View style={{ width: CHEVRON_BOX, height: CHEVRON_BOX, alignItems: "center", justifyContent: "center", transform: chevronRotation(open) }}>
            <Icon name="ChevronRight" size={CHEVRON_BOX} color={theme.colors[chevronColorToken(hovered, pressed)]} />
          </View>
        </>
      )}
    </Pressable>
  );
}

/** A one-line note in a row's box (empty board, unreadable team). */
function NoteLine({ theme, compact, children }: { theme: PopoverTheme; compact: boolean; children: string }) {
  return (
    <View style={rowBox({ compact })}>
      <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>{children}</Text>
    </View>
  );
}

/** DSH's projection failure: a danger alert row, the sentence verbatim and selectable. */
function FailureRow({ theme, text, failure }: { theme: PopoverTheme; text: TeamText; failure: string }) {
  return (
    <View style={{ paddingTop: 8, paddingBottom: 2 }}>
      <PopoverAlertRow theme={theme} tone="danger" icon="CircleAlert" message={text.failure(failure)} />
    </View>
  );
}

/**
 * One task in full: minimal top bar (back on left, quiet mono id · vN on right),
 * 16px semibold title, single-line status + owner meta strip, optional
 * blockers / write scopes / warnings, hairline divider, and structured
 * selectable prose description.
 */
function TaskDetail({
  task,
  members,
  theme,
  text,
  compact,
  onBack,
}: {
  task: TeamTask;
  members: readonly TeamMember[];
  theme: PopoverTheme;
  text: TeamText;
  compact: boolean;
  onBack: () => void;
}) {
  const mark = teamTaskMark(task);
  const done = mark === "done";
  const ownerLabel = teamOwnerLabel(task);
  const ownerState = teamOwnerState(task, members);
  const hasDescription = task.description.trim() !== "";
  const firstBlock = hasDescription ? parseProseBlocks(task.description)[0] : undefined;
  const showDescriptionLabel = firstBlock !== undefined && firstBlock.kind !== "kicker" && firstBlock.kind !== "heading";
  const hasExtraMeta = task.blockedBy.length > 0 || task.writeScopes.length > 0;

  return (
    <View style={{ ...popoverRootBox(), margin: -12, paddingBottom: 12 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          paddingHorizontal: 4,
          paddingTop: 4,
          paddingBottom: 2,
        }}
      >
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel={text.back}
          style={({ hovered = false, pressed }: HoverState) => {
            const fill = rowActiveFill(hovered, pressed);
            return [
              {
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                minHeight: compact ? 36 : 28,
                paddingLeft: 4,
                paddingRight: 10,
                paddingVertical: compact ? 6 : 4,
                borderRadius: 6,
              },
              fill === undefined ? undefined : { backgroundColor: theme.colors[fill] },
            ];
          }}
        >
          {({ hovered = false, pressed }: HoverState) => (
            <>
              <Icon name="ChevronLeft" size={16} color={theme.colors[chevronColorToken(hovered, pressed)]} />
              <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: "500", color: theme.colors[chevronColorToken(hovered, pressed)] }}>
                {text.back}
              </Text>
            </>
          )}
        </Pressable>
        <Text
          selectable
          numberOfLines={1}
          style={{
            flexShrink: 1,
            paddingRight: 8,
            fontFamily: mono,
            fontSize: 11.5,
            lineHeight: 16,
            color: extraMuted(theme),
          }}
        >
          {`${task.id} · v${String(task.revision)}`}
        </Text>
      </View>

      <View style={{ paddingHorizontal: 12, paddingTop: 6, gap: 8 }}>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
          <TaskMarkIcon mark={mark} theme={theme} lineHeight={POPOVER_DETAIL_TITLE_LINE} />
          <Text
            selectable
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: POPOVER_DETAIL_TITLE_SIZE,
              lineHeight: POPOVER_DETAIL_TITLE_LINE,
              fontWeight: "600",
              color: done ? extraMuted(theme) : theme.colors.foreground,
              textDecorationLine: done ? "line-through" : "none",
            }}
          >
            {task.subject}
          </Text>
        </View>

        <View style={{ paddingLeft: 24, flexDirection: "row", flexWrap: "wrap", alignItems: "center", rowGap: 6, columnGap: 10 }}>
          <PopoverPill
            theme={theme}
            label={text.marks[mark]}
            tone={taskMarkTone(mark)}
            leading={<TaskDetailStatusGlyph mark={mark} ownerState={ownerState} theme={theme} />}
          />
          <View style={{ flexDirection: "row", alignItems: "center", flexShrink: 1, minWidth: 0 }}>
            <Text style={{ fontSize: FACTS_FONT_SIZE, lineHeight: 18, color: theme.colors.foregroundMuted, marginRight: 5 }}>
              {text.fields.owner}
            </Text>
            <Text
              selectable
              numberOfLines={1}
              style={{
                flexShrink: 1,
                minWidth: 0,
                fontSize: FACTS_FONT_SIZE,
                lineHeight: 18,
                fontWeight: "500",
                color: ownerLabel === undefined ? theme.colors.foregroundMuted : theme.colors.foreground,
              }}
            >
              {ownerLabel ?? text.unowned}
            </Text>
            {ownerState === undefined ? null : <OwnerMark state={ownerState} theme={theme} text={text} />}
          </View>
        </View>

        {hasExtraMeta ? (
          <View style={{ paddingLeft: 24, gap: 4 }}>
            {task.blockedBy.length === 0 ? null : (
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
                <Text style={{ fontSize: FACTS_FONT_SIZE, lineHeight: 18, color: theme.colors.foregroundMuted, flexShrink: 0 }}>
                  {text.fields.blockedBy}
                </Text>
                <Text selectable style={{ flex: 1, minWidth: 0, fontFamily: mono, fontSize: 12, lineHeight: 18, color: theme.colors.foreground }}>
                  {task.blockedBy.join(text.listSeparator)}
                </Text>
              </View>
            )}
            {task.writeScopes.length === 0 ? null : (
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
                <Text style={{ fontSize: FACTS_FONT_SIZE, lineHeight: 18, color: theme.colors.foregroundMuted, flexShrink: 0 }}>
                  {text.fields.writeScopes}
                </Text>
                <Text selectable style={{ flex: 1, minWidth: 0, fontFamily: mono, fontSize: 11.5, lineHeight: 18, color: theme.colors.foreground }}>
                  {task.writeScopes.join("\n")}
                </Text>
              </View>
            )}
          </View>
        ) : null}

        {task.writeScopeWarnings.map((warning) => (
          <PopoverAlertRow
            key={warning}
            theme={theme}
            tone="warning"
            icon="TriangleAlert"
            message={teamWarningText(warning, text)}
            marginHorizontal={0}
          />
        ))}
      </View>

      {hasDescription ? (
        <>
          <PopoverHairline theme={theme} inset={12} marginVertical={10} />
          <View style={{ paddingHorizontal: 12, gap: 6 }}>
            {showDescriptionLabel ? (
              <Text style={{ fontSize: 11.5, lineHeight: 16, fontWeight: "600", color: theme.colors.foregroundMuted }}>
                {text.fields.description}
              </Text>
            ) : null}
            <PopoverProse text={task.description} theme={theme} />
          </View>
        </>
      ) : null}
    </View>
  );
}

/** Everything the panel draws. State lives here (detail page, done fold); data in `team-pill.tsx`. */
export interface TeamPanelProps {
  team: TeamView;
  text: TeamText;
  theme: PopoverTheme;
  compact: boolean;
  /** Preview/test only: start on one task's detail page. */
  initialTaskId?: string;
  /** Preview/test only: start with the done group open. */
  initialDoneOpen?: boolean;
}

/**
 * The panel body. A task that disappears from the board while its page is open
 * (deleted, or the next poll is a different board) drops back to the list.
 */
export function TeamPanel({ team, text, theme, compact, initialTaskId, initialDoneOpen = false }: TeamPanelProps) {
  const [taskId, setTaskId] = useState<string | undefined>(initialTaskId);
  const [doneOpen, setDoneOpen] = useState(initialDoneOpen);
  const open = taskId === undefined ? undefined : team.tasks.find((task) => task.id === taskId);
  if (open !== undefined) {
    return <TaskDetail task={open} members={team.members} theme={theme} text={text} compact={compact} onBack={() => setTaskId(undefined)} />;
  }
  // Owners the server saw stop on an in-progress task (DSH does not release a
  // task when its owner exits, so these stay 进行中 — the header says so).
  const stopped = teamStoppedOwnerCount(
    team.tasks.filter((task) => teamTaskMark(task) === "doing"),
    team.members,
  );
  const groups = teamTaskGroups(team.tasks);
  const hasActiveGroups = groups.some((group) => group.mark !== "done");
  const row = (task: TeamTask) => (
    <TaskRow key={task.id} task={task} members={team.members} theme={theme} text={text} compact={compact} onOpen={() => setTaskId(task.id)} />
  );
  return (
    <View style={{ ...popoverRootBox(), margin: -12, paddingBottom: 6 }}>
      {team.failure === undefined ? null : <FailureRow theme={theme} text={text} failure={team.failure} />}
      <TeamHeadline team={team} theme={theme} text={text} />
      <PopoverHairline theme={theme} marginVertical={2} />
      {team.tasks.length === 0 ? (
        <NoteLine theme={theme} compact={compact}>
          {text.noTasks}
        </NoteLine>
      ) : (
        groups.map((group, index) =>
          group.mark === "done" ? (
            <View key={group.mark}>
              {hasActiveGroups ? <PopoverHairline theme={theme} marginVertical={4} /> : null}
              <DoneHeader theme={theme} text={text} count={group.tasks.length} open={doneOpen} compact={compact} onToggle={() => setDoneOpen(!doneOpen)} />
              {doneOpen ? group.tasks.map(row) : null}
            </View>
          ) : (
            <View key={group.mark}>
              <PopoverSectionHeader
                theme={theme}
                label={text.marks[group.mark]}
                count={group.tasks.length}
                note={group.mark === "doing" && stopped > 0 ? text.stoppedOwners(stopped) : undefined}
                noteTone={group.mark === "doing" && stopped > 0 ? "warning" : "muted"}
                paddingTop={index === 0 ? 6 : 10}
              />
              {group.tasks.map(row)}
            </View>
          ),
        )
      )}
    </View>
  );
}

/** The body before the first poll lands, or when the board could not be read. */
export function TeamPanelNote({ theme, compact, message }: { theme: PopoverTheme; compact: boolean; message: string }) {
  return (
    <View style={{ ...popoverRootBox(), margin: -12 }}>
      <NoteLine theme={theme} compact={compact}>
        {message}
      </NoteLine>
    </View>
  );
}
