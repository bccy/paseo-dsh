/**
 * The timeline row a finished rewind leaves behind, plus its one-shot capsule.
 *
 * The server appends this row as a plugin timeline item
 * (`paseo.agents.ref(agentId).timeline.append`) — the one channel the host's
 * rewind run lock cannot swallow, and a row the provider history replay cannot
 * resurrect. Paseo draws plugin rows through the renderer registered in
 * `index.client.tsx`, which is what makes this a React component and therefore
 * what makes `useToast()` reachable at all: the capsule API is a hook, and a
 * plugin has no other always-mounted surface.
 *
 * **The capsule is driven by the live stream, not by rendering.** A timeline
 * renderer mounts for live rows *and* for rows painted from a fetch (session
 * reopen, scroll, the refetch after a timeline replacement), so mount timing
 * cannot tell them apart — the old implementation guessed with a render-cadence
 * (bulk) rule and a 6 s window, and both were wrong after a conversation rewind
 * rebuilt the timeline. `client/rewind-notice-live` subscribes to the agent's
 * live timeline and records the row's `noticeId` when it arrives there; this
 * component consumes that record once. A replayed row has no record, so it
 * renders without a capsule by construction.
 *
 * @module dsh-paseo/client/rewind-notice
 */
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useEffect } from "react";
import { Text, View } from "react-native";
import { rewindToastMessage, type RewindNoticeData } from "./rewind-notice-data";
import { activeRewindLiveMonitor } from "./rewind-notice-live";
import { ROW_FONT_SIZE, ROW_LINE_HEIGHT } from "./tokens";

/**
 * One rewind report line.
 *
 * The full report text is shown verbatim (a partial-file failure keeps its
 * detail lines). The capsule only repeats the headline — see
 * `rewindToastMessage`.
 */
export function RewindNotice({
  agentId,
  item,
  theme,
}: PluginTimelineItemProps<RewindNoticeData>) {
  const toast = useToast();
  const data = item.data;
  // The failure row keeps the host's original error tint; success is green.
  const color = data.tone === "warning" ? theme.colors.statusDanger : theme.colors.statusSuccess;

  useEffect(() => {
    const monitor = activeRewindLiveMonitor();
    if (monitor === null) return;
    // A mounted report row is proof that this agent's session is open, so it is
    // watched from now on: every later rewind in the session gets a capsule even
    // when the agent is old or outside the directory's watch bound.
    monitor.watch(agentId);
    if (!monitor.take(agentId, data.noticeId)) return;
    toast.show(rewindToastMessage(data), {
      variant: data.tone === "warning" ? "warning" : "success",
    });
  }, [agentId, data, toast]);

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
