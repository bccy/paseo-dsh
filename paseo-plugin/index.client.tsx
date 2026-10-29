import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeStreamStats } from "./client/stream-stats";

export default function contribute(client: PluginClientContext) {
  return contributeStreamStats(client);
}
