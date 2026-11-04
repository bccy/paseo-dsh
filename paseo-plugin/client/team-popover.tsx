/**
 * The team panel (T3, design T2 direction B; roster reworked in T5): the
 * shared tasks grouped by state, under a one-line roster summary, and an
 * in-place detail page for one task.
 *
 * **No member rows (T5).** Ten members filled a phone's first screen and could
 * not be opened, while Paseo's own subagent panel already lists them and opens
 * each conversation. The roster is one summary line in the section-label slot
 * (「10 名成员 · 2 个运行中」, red 「1 个创建失败」), and who is working shows
 * where it matters: right after an owner's name, the host running ring when the
 * server says the owner runs, a grey 已停止 tag when it says the owner stopped
 * (an in-progress task left behind — DSH does not release on exit), and the
 * 进行中 header counts the latter.
 *
 * Every box is one this plugin already draws: `rowBox` (the host's track row,
 * 32/40px), 14px title + 12px muted facts, 16px marks, the host's running ring
 * (`StatusRingMark`), the jobs panel's folding header for the done group, and
 * the host `MenuLabel` geometry for section headers.
 *
 * **The detail page is in place, not a host page.** The host's sub-pages
 * (`MenuSurface pages`) are reachable only from a `menu` behavior; a `popover`
 * Content cannot register one in Paseo 0.15. So the page is a mode of this body
 * (like the goal panel's edit page) with the host sheet header's own back row:
 * an 18px muted `ChevronLeft` in a 24px box, then the title at 14px medium.
 *
 * Read-only throughout: there is no team write path the bridge could carry.
 *
 * @module dsh-paseo/client/team-popover
 */
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Platform, Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import type { TeamMember, TeamTask, TeamView } from "../shared/team";
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
import { StatusRingMark } from "./status-ring";
import {
  TEAM_TASK_ICONS,
  teamMemberSummary,
  teamMemberSummaryText,
  teamOwnerState,
  teamStoppedOwnerCount,
  teamTaskFacts,
  teamTaskFactsParts,
  teamTaskFields,
  teamTaskGroups,
  teamTaskMark,
  teamWarningText,
  type TeamOwnerState,
  type TeamTaskMark,
} from "./team-polling";

type PopoverTheme = PluginButtonContentProps["theme"];
type HoverState = PressableStateCallbackType & { hovered?: boolean };

/** The mark slot: the host's 16px icon slot (`task-list-row.tsx`). */
export const TEAM_MARK_SIZE = 16;
/** Title / facts line boxes (host `fontSize.base` 14 → 20, `sm` 12 → 16). */
const TITLE_LINE = 20;
const FACTS_LINE = 16;
/** The main list shows at most two lines of a task's description. */
export const TEAM_DESCRIPTION_LINES = 2;

/** The plugin theme lacks `foregroundExtraMuted`; the host's done/pending marks use it. */
function extraMuted(theme: PopoverTheme): string {
  return (theme.colors as Record<string, string>).foregroundExtraMuted ?? theme.colors.foregroundMuted;
}

/** Host `MenuLabel`: 12px muted, 12px sides, 8 top / 4 bottom; the count in the trailing slot. */
function SectionLabel({ theme, label, count, note }: { theme: PopoverTheme; label: string; count?: number; note?: string }) {
  return (
    <View
      accessibilityRole="header"
      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 }}
    >
      <Text style={{ flexGrow: 1, flexShrink: 1, fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>{label}</Text>
      {count === undefined ? null : (
        <Text numberOfLines={1} style={{ flexShrink: 2, minWidth: 0, fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>
          {note === undefined || note === "" ? String(count) : `${String(count)} · ${note}`}
        </Text>
      )}
    </View>
  );
}

/** The owner's running ring: the host ring at the 12px facts line's size (the ring's own 12px box). */
export const TEAM_OWNER_RING_SIZE = 12;

/**
 * The mark after an owner's name, in a facts line or the detail page's owner
 * field (T5): the host running ring when the server says the owner runs, a grey
 * 已停止 tag when it says the owner stopped, nothing otherwise
 * (`teamOwnerState`).
 */
function OwnerMark({ state, theme, text }: { state: TeamOwnerState | undefined; theme: PopoverTheme; text: TeamText }) {
  if (state === "running") {
    return (
      <View accessibilityRole="progressbar" style={{ width: TEAM_OWNER_RING_SIZE, height: FACTS_LINE, alignItems: "center", justifyContent: "center", marginLeft: 4 }}>
        <StatusRingMark size={TEAM_OWNER_RING_SIZE} color={ringColorFor(theme.colors.surface0)} />
      </View>
    );
  }
  if (state === "stopped") {
    return (
      <View style={{ marginLeft: 4, paddingHorizontal: 4, borderRadius: 4, backgroundColor: theme.colors.surface2, flexShrink: 0 }}>
        <Text style={{ fontSize: TEAM_TAG_FONT_SIZE, lineHeight: FACTS_LINE - 2, color: theme.colors.foregroundMuted }}>{text.ownerStopped}</Text>
      </View>
    );
  }
  return null;
}

/** The stopped tag's text: one step under the 12px facts line. */
const TEAM_TAG_FONT_SIZE = 11;

/**
 * The roster in one line (T5), in the section-label slot right above the
 * tasks: 「10 名成员 · 2 个运行中」, a red 「· 1 个创建失败」 when someone failed
 * to start. Not pressable — Paseo's own subagent panel lists the members.
 */
function MemberSummary({ team, theme, text }: { team: TeamView; theme: PopoverTheme; text: TeamText }) {
  const summary = teamMemberSummaryText(teamMemberSummary(team.members), text);
  const label = summary.failed === "" ? summary.plain : `${summary.plain} · ${summary.failed}`;
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={label}
      style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 }}
    >
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>
        {summary.plain}
        {summary.failed === "" ? null : (
          <>
            <Text>{" · "}</Text>
            <Text style={{ color: theme.colors.statusDanger }}>{summary.failed}</Text>
          </>
        )}
      </Text>
    </View>
  );
}

/** The host task-list row's marks: running blue `CircleDot`, muted `Circle`, extra-muted `CircleCheck`; plus `CircleDashed`. */
function TaskMarkIcon({ mark, theme }: { mark: TeamTaskMark; theme: PopoverTheme }) {
  const color = mark === "doing" ? ringColorFor(theme.colors.surface0) : mark === "ready" ? theme.colors.foregroundMuted : extraMuted(theme);
  return (
    <View style={{ width: TEAM_MARK_SIZE, height: TITLE_LINE, justifyContent: "center" }}>
      <Icon name={TEAM_TASK_ICONS[mark]} size={TEAM_MARK_SIZE} color={color} />
    </View>
  );
}

/** One task row: mark, title, facts, warnings, two lines of description; the whole row opens the detail page. */
function TaskRow({ task, members, theme, text, compact, onOpen }: { task: TeamTask; members: readonly TeamMember[]; theme: PopoverTheme; text: TeamText; compact: boolean; onOpen: () => void }) {
  const mark = teamTaskMark(task);
  const facts = teamTaskFactsParts(task, text);
  const ownerState = teamOwnerState(task, members);
  const done = mark === "done";
  const description = task.description.replace(/\s*\n+\s*/g, " ").trim();
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
              numberOfLines={1}
              style={{
                fontSize: TITLE_FONT_SIZE,
                lineHeight: TITLE_LINE,
                color: done ? extraMuted(theme) : theme.colors.foreground,
                textDecorationLine: done ? "line-through" : "none",
              }}
            >
              {task.subject}
            </Text>
            {/* The owner's ring sits right after the owner's name, so the line
                is three runs: id · owner, the ring, then · blockers · scopes. */}
            <View style={{ flexDirection: "row", alignItems: "center", minWidth: 0 }}>
              <Text numberOfLines={1} style={{ flexShrink: 0, fontSize: FACTS_FONT_SIZE, lineHeight: FACTS_LINE, color: theme.colors.foregroundMuted }}>
                {facts.lead}
              </Text>
              {facts.owner ? <OwnerMark state={ownerState} theme={theme} text={text} /> : null}
              {facts.trail === "" ? null : (
                <Text numberOfLines={1} style={{ flexShrink: 1, minWidth: 0, fontSize: FACTS_FONT_SIZE, lineHeight: FACTS_LINE, color: theme.colors.foregroundMuted }}>
                  {facts.trail}
                </Text>
              )}
            </View>
            {task.writeScopeWarnings.map((warning) => (
              <View key={warning} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Icon name="TriangleAlert" size={12} color={theme.colors.statusWarning} />
                <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: FACTS_FONT_SIZE, lineHeight: FACTS_LINE, color: theme.colors.statusWarning }}>
                  {teamWarningText(warning, text)}
                </Text>
              </View>
            ))}
            {description === "" ? null : (
              <Text
                numberOfLines={TEAM_DESCRIPTION_LINES}
                style={{ marginTop: 2, fontSize: FACTS_FONT_SIZE, lineHeight: 18, color: theme.colors.foregroundMuted }}
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
function DoneHeader({ theme, text, count, open, compact, onToggle }: { theme: PopoverTheme; text: TeamText; count: number; open: boolean; compact: boolean; onToggle: () => void }) {
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

/** DSH's projection failure: a red row, the sentence verbatim and selectable. */
function FailureRow({ theme, text, compact, failure }: { theme: PopoverTheme; text: TeamText; compact: boolean; failure: string }) {
  return (
    <View style={{ ...rowBox({ compact }), alignItems: "flex-start" }} accessibilityRole="alert">
      <View style={{ height: 18, justifyContent: "center" }}>
        <Icon name="CircleAlert" size={TEAM_MARK_SIZE} color={theme.colors.statusDanger} />
      </View>
      <Text selectable style={{ ...rowTextColumn(), fontSize: FACTS_FONT_SIZE, lineHeight: 18, color: theme.colors.statusDanger }}>
        {text.failure(failure)}
      </Text>
    </View>
  );
}

/**
 * One task in full: the host sheet header's back row, the subject, its fields
 * (the timeline card's 72px label column), and the whole description.
 */
function TaskDetail({ task, members, theme, text, compact, onBack }: { task: TeamTask; members: readonly TeamMember[]; theme: PopoverTheme; text: TeamText; compact: boolean; onBack: () => void }) {
  const mark = teamTaskMark(task);
  return (
    <View style={{ ...popoverRootBox(), margin: -12, paddingBottom: 8 }}>
      <Pressable
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel={text.back}
        style={({ hovered = false, pressed }: HoverState) => {
          const fill = rowActiveFill(hovered, pressed);
          return [rowBox({ compact }), fill === undefined ? undefined : { backgroundColor: theme.colors[fill] }];
        }}
      >
        <View style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center", marginLeft: -4 }}>
          <Icon name="ChevronLeft" size={18} color={theme.colors.foregroundMuted} />
        </View>
        <Text numberOfLines={1} style={{ ...rowTextColumn(), fontSize: TITLE_FONT_SIZE, fontWeight: "500", color: theme.colors.foreground }}>
          {`${task.id} · ${text.marks[mark]}`}
        </Text>
      </Pressable>
      <View style={{ paddingHorizontal: 12, paddingTop: 4, gap: 8 }}>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
          <TaskMarkIcon mark={mark} theme={theme} />
          <Text selectable style={{ flex: 1, minWidth: 0, fontSize: TITLE_FONT_SIZE, lineHeight: TITLE_LINE, color: theme.colors.foreground }}>
            {task.subject}
          </Text>
        </View>
        <View style={{ gap: 4 }}>
          {teamTaskFields(task, text, members).map((field, index) => (
            <View key={`${field.label}-${String(index)}`} style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
              <Text style={{ width: 72, fontSize: FACTS_FONT_SIZE, lineHeight: 18, color: theme.colors.foregroundMuted }}>{field.label}</Text>
              <Text
                selectable
                style={{
                  ...(field.owner === undefined ? { flex: 1 } : { flexShrink: 1 }),
                  minWidth: 0,
                  fontSize: FACTS_FONT_SIZE,
                  lineHeight: 18,
                  color: field.tone === "warning" ? theme.colors.statusWarning : theme.colors.foreground,
                }}
              >
                {field.value}
              </Text>
              {field.owner === undefined ? null : (
                <View style={{ height: 18, justifyContent: "center", marginLeft: -8 }}>
                  <OwnerMark state={field.owner} theme={theme} text={text} />
                </View>
              )}
            </View>
          ))}
        </View>
        {task.description.trim() === "" ? null : (
          <View style={{ gap: 4 }}>
            <Text style={{ fontSize: FACTS_FONT_SIZE, color: theme.colors.foregroundMuted }}>{text.fields.description}</Text>
            <Text selectable style={{ fontSize: FACTS_FONT_SIZE, lineHeight: 18, color: theme.colors.foreground }}>
              {task.description}
            </Text>
          </View>
        )}
      </View>
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
  const row = (task: TeamTask) => (
    <TaskRow key={task.id} task={task} members={team.members} theme={theme} text={text} compact={compact} onOpen={() => setTaskId(task.id)} />
  );
  return (
    <View style={{ ...popoverRootBox(), margin: -12, paddingBottom: 4 }}>
      {team.failure === undefined ? null : <FailureRow theme={theme} text={text} compact={compact} failure={team.failure} />}
      <MemberSummary team={team} theme={theme} text={text} />
      {team.tasks.length === 0 ? (
        <NoteLine theme={theme} compact={compact}>
          {text.noTasks}
        </NoteLine>
      ) : (
        teamTaskGroups(team.tasks).map((group) =>
          group.mark === "done" ? (
            <View key={group.mark}>
              <DoneHeader theme={theme} text={text} count={group.tasks.length} open={doneOpen} compact={compact} onToggle={() => setDoneOpen(!doneOpen)} />
              {doneOpen ? group.tasks.map(row) : null}
            </View>
          ) : (
            <View key={group.mark}>
              <SectionLabel
                theme={theme}
                label={text.marks[group.mark]}
                count={group.tasks.length}
                note={group.mark === "doing" && stopped > 0 ? text.stoppedOwners(stopped) : undefined}
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
