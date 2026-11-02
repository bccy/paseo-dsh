/**
 * The timeline row a finished rewind leaves behind, plus its one-shot capsule.
 *
 * The row is the "timeline prompt line" the product asks for: the provider emits
 * a `session.notice` after `request.completed` and Paseo would normally draw a
 * generic notification for it. Taking that item over — `query: { itemType:
 * "notification" }` in `index.client.tsx`, which the host routes through the
 * same transform as every other timeline item — is what makes this row a React
 * component and therefore what makes `useToast()` reachable at all: the capsule
 * API is a hook, and a plugin has no other always-mounted surface.
 *
 * **Why the toast is gated inside the row instead of a subscription.** A
 * timeline renderer is the only per-agent component a plugin can get mounted
 * without an extra protocol shape. Its mounts are also exactly the moments that
 * must be filtered: replaying a session paints the whole history in one pass
 * (the batch rule in `client/newest.ts`), reopening or scrolling re-paints old
 * rows (the timestamp-age rule in `client/rewind-notice-data.ts`), and a React
 * remount repeats the same row (the gate's id set). All three are asserted by
 * `harness/rewind-notice-check.cjs` against these compiled modules.
 *
 * @module dsh-paseo/client/rewind-notice
 */
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useEffect } from "react";
import { Text, View } from "react-native";
import { useRowPulse } from "./newest";
import {
  RewindToastGate,
  rewindToastMessage,
  type RewindNoticeData,
} from "./rewind-notice-data";
import { ROW_FONT_SIZE, ROW_LINE_HEIGHT } from "./tokens";

/** One gate per client bundle: every mounted row shares the same id set. */
const gate = new RewindToastGate();

/**
 * One rewind report line.
 *
 * The full notice text is shown verbatim (a partial-file failure keeps its
 * detail lines). The capsule only repeats the headline — see
 * `rewindToastMessage`.
 */
export function RewindNotice({
  agentId,
  item,
  timestamp,
  theme,
}: PluginTimelineItemProps<RewindNoticeData>) {
  const toast = useToast();
  const data = item.data;
  const pulse = useRowPulse(agentId, timestamp);
  // The failure row keeps the host's original error tint; success is green.
  const color = data.tone === "warning" ? theme.colors.statusDanger : theme.colors.statusSuccess;

  useEffect(() => {
    const now = Date.now();
    if (!gate.shouldToast({ agentId, timestamp, message: data.message, fresh: pulse.fresh, now })) {
      return;
    }
    toast.show(rewindToastMessage(data), {
      variant: data.tone === "warning" ? "warning" : "success",
    });
  }, [agentId, data.message, data.tone, pulse.fresh, timestamp, toast]);

  return (
    <View
      style={{
        marginVertical: 4,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
        borderLeftWidth: 3,
        borderLeftColor: color,
      }}
    >
      <Text
        selectable
        style={{ color: theme.colors.foreground, fontSize: ROW_FONT_SIZE, lineHeight: ROW_LINE_HEIGHT }}
      >
        {data.message}
      </Text>
    </View>
  );
}
