import type { PluginClientContext } from "@getpaseo/plugin/client";
import { StreamStatsSettingsScreen } from "./client/settings-screen";
import { contributeStreamStats } from "./client/stream-stats";

export default function contribute(client: PluginClientContext) {
  const removeStats = contributeStreamStats(client);
  const removeSettings = client.addSettingsScreen({
    id: "stream-stats",
    title: "回答统计行",
    icon: "SlidersHorizontal",
    Component: StreamStatsSettingsScreen,
  });
  return () => {
    removeStats();
    removeSettings();
  };
}
