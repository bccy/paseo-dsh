/**
 * The team task tools' timeline card (T3).
 *
 * The goal card's geometry, value for value (`GOAL_CARD_*` in `./tokens`: 14/10
 * padding, 72px label column, 20px lines, a hairline card on the timeline's
 * surface). A task's title carries the host task-list mark and its `task-N`;
 * the description is clamped to two lines with a quiet 展开/收起 that toggles
 * it in place. A list is one card: a caption row, then one item per task with a
 * hairline between them, and a closing line when DSH answered `nextCursor`.
 *
 * Its own module rather than a block inside `./tool-call`: the row's head is
 * held to one colour per glyph by `harness/style-check.cjs`, and the card's
 * state marks are a second colour family that belongs to the card, not the head.
 *
 * @module dsh-paseo/client/team-card
 */
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { localeText } from "./locale";
import { TEAM_TASK_ICONS } from "./team-polling";
import type { TeamBlockData, TeamTaskCard } from "./tool-call-data";
import {
  GOAL_CARD_LINE_HEIGHT,
  GOAL_CARD_PADDING_HORIZONTAL,
  GOAL_CARD_PADDING_VERTICAL,
  GOAL_FIELDS_MARGIN_TOP,
  GOAL_FIELD_COLUMN_GAP,
  GOAL_FIELD_LABEL_WIDTH,
  GOAL_FIELD_ROW_GAP,
  ROW_FONT_SIZE,
  cardStyle,
  type TokenColors,
} from "./tokens";

/** The colours the card needs; the caller resolves them from the plugin theme. */
export interface TeamCardColors extends TokenColors {
  extraMuted: string;
  /** The running blue, `ringColorFor(surface0)`. */
  running: string;
  warning: string;
}

/** Small muted text: captions, the id after a subject, the toggle. */
const SMALL = 12;

function TeamTaskItem({ card, colors, divided, hairline }: { card: TeamTaskCard; colors: TeamCardColors; divided: boolean; hairline: number }) {
  const [open, setOpen] = useState(false);
  const text = localeText().team;
  const markColor = card.mark === "doing" ? colors.running : card.mark === "ready" ? colors.foregroundMuted : colors.extraMuted;
  const description = card.description.trim();
  const value = { color: colors.foreground, fontSize: ROW_FONT_SIZE, lineHeight: GOAL_CARD_LINE_HEIGHT, flex: 1, minWidth: 0 } as const;
  const label = { color: colors.foregroundMuted, fontSize: ROW_FONT_SIZE, lineHeight: GOAL_CARD_LINE_HEIGHT, width: GOAL_FIELD_LABEL_WIDTH } as const;
  return (
    <View
      style={{
        paddingVertical: GOAL_CARD_PADDING_VERTICAL,
        paddingHorizontal: GOAL_CARD_PADDING_HORIZONTAL,
        ...(divided ? { borderBottomWidth: hairline, borderColor: colors.border } : {}),
      }}
    >
      <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
        <View style={{ height: GOAL_CARD_LINE_HEIGHT, justifyContent: "center" }}>
          <Icon name={TEAM_TASK_ICONS[card.mark]} size={16} color={markColor} />
        </View>
        <Text style={value} selectable>
          {card.subject}
          <Text style={{ color: colors.foregroundMuted, fontSize: SMALL }}>{`  ${card.id}`}</Text>
        </Text>
      </View>
      <View style={{ marginTop: GOAL_FIELDS_MARGIN_TOP, gap: GOAL_FIELD_ROW_GAP }}>
        {card.fields.map((field, index) => (
          <View key={`${field.label}-${String(index)}`} style={{ flexDirection: "row", gap: GOAL_FIELD_COLUMN_GAP }}>
            <Text style={label}>{field.label}</Text>
            <Text style={field.tone === "warning" ? { ...value, color: colors.warning } : value} selectable>
              {field.value}
            </Text>
          </View>
        ))}
        {description === "" ? null : (
          <View style={{ flexDirection: "row", gap: GOAL_FIELD_COLUMN_GAP }}>
            <Text style={label}>{text.fields.description}</Text>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ ...value, color: colors.foregroundMuted }} numberOfLines={open ? undefined : 2} selectable={open}>
                {open ? description : description.replace(/\s*\n+\s*/g, " ")}
              </Text>
              <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" hitSlop={6} style={{ alignSelf: "flex-start" }}>
                <Text style={{ color: colors.foregroundMuted, fontSize: SMALL, lineHeight: GOAL_CARD_LINE_HEIGHT, textDecorationLine: "underline" }}>
                  {open ? text.card.collapse : text.card.expand}
                </Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

/** The whole card for one `team_task_*` result. */
export function TeamBlockView({ data, colors, hairline }: { data: TeamBlockData; colors: TeamCardColors; hairline: number }) {
  const line = { color: colors.foregroundMuted, fontSize: SMALL, lineHeight: 18 } as const;
  const strip = { paddingVertical: 6, paddingHorizontal: GOAL_CARD_PADDING_HORIZONTAL } as const;
  return (
    <View style={cardStyle(colors, hairline)}>
      {data.caption === "" ? null : (
        <View style={{ ...strip, borderBottomWidth: hairline, borderColor: colors.border }}>
          <Text style={line}>{data.caption}</Text>
        </View>
      )}
      {data.tasks.map((card, index) => (
        <TeamTaskItem key={card.id} card={card} colors={colors} hairline={hairline} divided={index < data.tasks.length - 1 || data.more} />
      ))}
      {data.more ? (
        <View style={strip}>
          <Text style={line}>{localeText().team.card.more}</Text>
        </View>
      ) : null}
    </View>
  );
}
