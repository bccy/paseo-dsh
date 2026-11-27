import type { PluginHandlerContext } from "@getpaseo/plugin/server";

/** The Paseo API handed to plugin handlers and hooks. */
export type PaseoApi = PluginHandlerContext["paseo"];
