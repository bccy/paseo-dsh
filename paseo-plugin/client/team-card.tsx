/**
 * The team task tools' timeline block (T3).
 *
 * Uses the frameless left-rail flow (`framelessBlockStyle` in `./tokens`) and
 * caps the task list inside a bounded scroll region (`expandedScrollStyle`) so
 * long team boards scroll in place without pushing the timeline down. Each task
 * keeps the host task-list mark, its `task-N` id, key/value fields, and a
 * two-line clamped description with an in-place 展开/收起 toggle.
 *
 * Its own module rather than a block inside `./tool-call`: the row's head is
 * held to one colour per glyph by `harness/style-check.cjs`, and the task
 * state marks are a second colour family that belongs to the task block, not
 * the head.
 *
 * @module dsh-paseo/client/team-card
 */
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { EXPANDED_MAX_HEIGHT_DEFAULT } from "../shared/settings";
import { SCROLL_BOX_TEST_ID } from "./row-entrance";
import { TEAM_TASK_ICONS } from "./team-polling";
import type { TeamBlockData, TeamTaskCard } from "./tool-call-data";
import { useLocaleText } from "./use-locale";
import {
  GOAL_CARD_LINE_HEIGHT,
  GOAL_FIELDS_MARGIN_TOP,
  GOAL_FIELD_COLUMN_GAP,
  GOAL_FIELD_LABEL_WIDTH,
  GOAL_FIELD_ROW_GAP,
  ROW_FONT_SIZE,
  expandedScrollStyle,
  framelessBlockStyle,
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
  const text = useLocaleText().team;
  const markColor = card.mark === "doing" ? colors.running : card.mark === "ready" ? colors.foregroundMuted : colors.extraMuted;
  const description = card.description.trim();
  const value = { color: colors.foreground, fontSize: ROW_FONT_SIZE, lineHeight: GOAL_CARD_LINE_HEIGHT, flex: 1, minWidth: 0 } as const;
  const label = { color: colors.foregroundMuted, fontSize: ROW_FONT_SIZE, lineHeight: GOAL_CARD_LINE_HEIGHT, width: GOAL_FIELD_LABEL_WIDTH } as const;
  return (
    <View
      style={{
        paddingVertical: 6,
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
              <Pressable
                onPress={(event) => {
                  event?.stopPropagation?.();
                  setOpen(!open);
                }}
                accessibilityRole="button"
                hitSlop={6}
                style={{ alignSelf: "flex-start" }}
              >
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

/** The whole frameless block for one `team_task_*` result. */
export function TeamBlockView({
  data,
  colors,
  hairline,
  maxHeight = EXPANDED_MAX_HEIGHT_DEFAULT,
  onCollapse,
}: {
  data: TeamBlockData;
  colors: TeamCardColors;
  hairline: number;
  maxHeight?: number;
  onCollapse?: (event?: unknown) => void;
}) {
  const text = useLocaleText().team;
  const line = { color: colors.foregroundMuted, fontSize: SMALL, lineHeight: 18 } as const;
  const strip = { paddingVertical: 4 } as const;
  return (
    <View style={framelessBlockStyle(colors)}>
      {data.caption === "" ? null : (
        <View style={{ ...strip, borderBottomWidth: hairline, borderColor: colors.border }}>
          <Text style={line}>{data.caption}</Text>
        </View>
      )}
      <ScrollView
        style={expandedScrollStyle(maxHeight)}
        nestedScrollEnabled
        testID={SCROLL_BOX_TEST_ID}
      >
        <Pressable onPress={onCollapse}>
          {data.tasks.map((card, index) => (
            <TeamTaskItem key={card.id} card={card} colors={colors} hairline={hairline} divided={index < data.tasks.length - 1 || data.more} />
          ))}
          {data.more ? (
            <View style={strip}>
              <Text style={line}>{text.card.more}</Text>
            </View>
          ) : null}
        </Pressable>
      </ScrollView>
    </View>
  );
}
