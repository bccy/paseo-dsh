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
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect } from "react";
import { Text, View } from "react-native";
import { font, radius, space, tint } from "./console-theme";
import { rewindToastMessage, type RewindNoticeData } from "./rewind-notice-data";
import { activeRewindLiveMonitor } from "./rewind-notice-live";

/** Split a report into its first-line sentence and any verbatim detail lines. */
function splitNoticeMessage(message: string): { headline: string; detail: string } {
  const newline = message.indexOf("\n");
  if (newline === -1) return { headline: message, detail: "" };
  return {
    headline: message.slice(0, newline),
    detail: message.slice(newline + 1).trim(),
  };
}

/**
 * One lightweight rewind report row.
 *
 * Success renders borderless over the timeline surface; warning/partial failure
 * adds a soft danger wash and preserves every verbatim detail line underneath
 * the headline. The capsule only repeats the headline — see `rewindToastMessage`.
 */
export function RewindNotice({
  agentId,
  item,
  theme,
}: PluginTimelineItemProps<RewindNoticeData>) {
  const toast = useToast();
  const data = item.data;
  const { colors } = theme;
  const isWarning = data.tone === "warning";
  const iconName = isWarning ? "TriangleAlert" : "RotateCcw";
  const iconColor = isWarning ? colors.statusDanger : colors.statusSuccess;
  const { headline, detail } = splitNoticeMessage(data.message);

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
        flexDirection: "row",
        gap: space.sm,
        alignItems: "flex-start",
        marginVertical: space.xs,
        paddingVertical: space.xs,
        paddingHorizontal: space.sm,
        borderRadius: radius.md,
        backgroundColor: isWarning ? tint(colors.statusDanger, 0.08) : "transparent",
      }}
    >
      <View style={{ paddingTop: 2 }}>
        <Icon name={iconName} size={14} color={iconColor} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: space.xxs }}>
        <Text selectable style={{ ...font.small, color: colors.foreground }}>
          {headline}
        </Text>
        {detail !== "" ? (
          <Text selectable style={{ ...font.caption, color: colors.foregroundMuted }}>
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
