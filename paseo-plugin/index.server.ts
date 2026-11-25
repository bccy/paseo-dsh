import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { goalControl, goalSnapshot, isTerminalGoalErrorCode, type GoalAnswer } from "./shared/goal";
import { isTerminalJobsErrorCode, jobsSnapshot, jobsStop, type JobsAnswer } from "./shared/jobs";
import { isTerminalTeamErrorCode, teamSnapshot, type TeamAnswer } from "./shared/team";
import { subagentLiveSnapshot } from "./shared/subagent-live";
import { rewindNoticeArm } from "./shared/rewind-notice";
import { languageSettings, timelineStyleSettings } from "./shared/settings";
import { ensurePaseoProfile } from "./server/bootstrap";
import { DiagnosticsService, registerDiagnosticsRpc } from "./server/diagnostics";
import { DshPlugins } from "./server/dsh-plugins";
import { registerDshPluginsRpc } from "./server/dsh-plugins-rpc";
import { createPillFeed } from "./server/pill-feed";
import { PricingStore, registerPricingRpc } from "./server/pricing";
import { capturePaseo } from "./server/rewind-notice-append";
import { UsageStatsEngine, registerUsageStatsRpc } from "./server/usage-stats";
import {
  controlAgentGoal,
  createDshProvider,
  readAgentGoal,
  readAgentJobs,
  readAgentTeam,
  stopAgentJob,
  subscribeAgentSubagents,
} from "./server/provider";

/**
 * The lifecycle events the server half listens on **only** to capture the Paseo
 * API handle.
 *
 * A provider connection is not handed that handle: `connect()` receives the
 * launch configuration, protocol versions and capabilities, nothing else, and
 * the plugin process's single `PaseoApi` instance is passed to hook, RPC and
 * tool callbacks instead. The rewind report needs it (its timeline append is
 * the one delivery channel the host's rewind run lock cannot swallow — see
 * `server/rewind-notice-append`), so it is captured from every callback the
 * host offers.
 *
 * These use the public `addHook` API, never `agent.open.before`: the host
 * invalidates plugin sessions for a plugin that registers that before-hook on
 * every start and stop, which reloads every agent before its next prompt.
 */
const CAPTURE_HOOKS = [
  "agent.create.after",
  "agent.turn.before",
  "agent.turn.after",
  "agent.permission.before",
  "agent.permission.after",
  "agent.archive.after",
] as const;

/**
 * Register the DeepSeek Harness provider, provisioning the DSH profile it needs,
 * and the subscriptions the client half watches through.
 *
 * Paseo's plugin installer runs no install scripts, so this plugin is
 * self-sufficient: on load it writes `$DSH_HOME/profiles/<name>` and the bridge
 * bundle it carries (see server/bootstrap.ts). Provisioning is best-effort —
 * a filesystem failure is logged and the provider still registers, so the
 * failure surfaces as an honest error when a session tries to start `dsh`.
 * The log must say the profile is **not** ready in that case: a provisioning
 * failure is a different state from "profile ready", and a message that does
 * not name it leaves a half-written or stale bridge looking like a working
 * install.
 *
 * **The three subscriptions are how the composer pills get their data.** Their
 * client half lives in the app's bundle while the data lives in a DSH child
 * process: the client cannot reach `ctx.jobs`/`ctx.goals`/`agentTeam`, and the
 * provider protocol has no request shape for "background jobs / current goal /
 * team board of this agent" (that would be a Paseo protocol extension, not
 * something a plugin may invent). Until 0.16 the only supported channel was a
 * plugin RPC the client polled; 0.16's plugin subscriptions are the same channel
 * with the polling moved to the side that owns the data (`server/pill-feed`):
 * one read per agent, shared by every client watching it, pushed only when the
 * snapshot changes, and stopped when the last subscriber releases.
 *
 * **`goal.control` is the one RPC that stays.** It carries the popover's button
 * presses into DSH's `/goal` command path, and after it succeeds it asks the goal
 * feed to re-read immediately — that is what keeps the pill's phase correct in
 * the same interaction instead of up to one interval later.
 *
 * The rewind-notice arm RPC carries no answer at all. It exists because the
 * handle can only be captured from a callback, and after a daemon restart the
 * user may rewind before any turn hook fires; the client bundle calls it once
 * when it loads, so a connected app always has a captured handle. It is the
 * same capture the hooks above perform — see {@link CAPTURE_HOOKS}.
 */
export default function contribute(server: PluginServerContext) {
  try {
    const provisioned = ensurePaseoProfile();
    process.stderr.write(
      `[dsh-paseo] DSH profile "${provisioned.profile}" ready at ${provisioned.dir}`
        + ` (${provisioned.bridgeFiles} bridge files${provisioned.patchCreated ? ", starter patch written" : ""})\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[dsh-paseo] DSH profile is NOT ready: provisioning failed: `
        + `${error instanceof Error ? error.message : String(error)}. `
        + "The provider is still registered; the previous bridge generation (if any) stays in place, "
        + "and sessions fail if it cannot serve this plugin build\n",
    );
  }

  // Every callback the host hands us carries the same plugin-scoped Paseo API
  // instance; keeping it is what lets a rewind report reach the timeline.
  const capture = (context: PluginHandlerContext): void => {
    capturePaseo(context.paseo);
  };
  const cleanups = CAPTURE_HOOKS.map((name) => server.addHook(name, async (_event: unknown, context: PluginHandlerContext) => capture(context)));

  server.registerProvider(createDshProvider());
  server.registerSettings(timelineStyleSettings);
  server.registerSettings(languageSettings);

  // The DSH Plugins page manages the profile this provider drives. One manager
  // for the whole plugin process: its in-flight job is the page's serialization
  // point, and the write lock it takes is DSH's own (`package.json.lock`), so a
  // page action queues behind a DSH-side install instead of racing it.
  const dshPlugins = new DshPlugins();
  const disposeDshPlugins = registerDshPluginsRpc(server, dshPlugins);

  // Environment & Route Overview + on-demand full Doctor RPCs for Console Tab 3.
  const diagnostics = new DiagnosticsService();
  const disposeDiagnostics = registerDiagnosticsRpc(server, diagnostics, { onCall: capture });

  // Dual-currency pricing store & incremental DSH session usage analytics for Console Tab 1 & Tab 3.
  const pricingStore = new PricingStore();
  const usageEngine = new UsageStatsEngine({ pricer: pricingStore });
  const disposePricing = registerPricingRpc(server, pricingStore, {
    getSeenModels: () => usageEngine.seenPricingModels({ waitMs: 0 }),
    getConfiguredModels: async () => {
      try {
        const [overview, resolver] = await Promise.all([
          diagnostics.overview(),
          pricingStore.resolver(),
        ]);
        const configured = new Map<string, string>();
        const record = (modelId: string | undefined, providerId: string | undefined, label?: string): void => {
          const trimmedId = modelId?.trim();
          if (!trimmedId) return;
          const key = resolver.resolveKey(trimmedId, providerId);
          if (!key || key === "unknown") return;
          if (!configured.has(key)) {
            configured.set(key, label?.trim() || trimmedId);
          }
        };
        for (const provider of overview.providers) {
          for (const model of provider.models) {
            record(model.id, provider.id, model.name);
          }
        }
        if (overview.route.model) {
          record(overview.route.model, overview.route.provider);
        }
        return configured;
      } catch {
        return new Map<string, string>();
      }
    },
    startAutoSync: true,
    autoSyncDelayMs: 4_000,
    onContext: capture,
  });
  const disposeUsageStats = registerUsageStatsRpc(server, usageEngine, {
    startPrewarm: true,
    prewarmDelayMs: 3_000,
    onContext: capture,
  });

  /**
   * One feed per pill. Each is a singleton for the plugin process, which is what
   * makes "two app windows, one read" true: the second window's subscription
   * joins the running feed instead of starting its own.
   *
   * Only a **read that threw** reaches these log lines; a returned
   * `available: false` is an answer, and the client's pill decides what it means.
   */
  const jobsFeed = createPillFeed<JobsAnswer>({
    read: readAgentJobs,
    isTerminal: (answer) => !answer.available && isTerminalJobsErrorCode(answer.error?.code),
    onError: (message, error) => {
      process.stderr.write(
        `[dsh-paseo] ${message}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    },
  });
  const goalFeed = createPillFeed<GoalAnswer>({
    read: readAgentGoal,
    isTerminal: (answer) => !answer.available && isTerminalGoalErrorCode(answer.error?.code),
    onError: (message, error) => {
      process.stderr.write(
        `[dsh-paseo] ${message}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    },
  });
  const teamFeed = createPillFeed<TeamAnswer>({
    read: readAgentTeam,
    isTerminal: (answer) => !answer.available && isTerminalTeamErrorCode(answer.error?.code),
    onError: (message, error) => {
      process.stderr.write(
        `[dsh-paseo] ${message}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    },
  });

  // A subscription handler starts the work and returns; the subscription stays
  // open until `signal` aborts. Returning an already-settled promise here would
  // close it on the spot, so the return value is deliberately `void`.
  server.handle(jobsSnapshot, ({ agentId }, context) => {
    capture(context);
    jobsFeed.subscribe(agentId, (answer) => context.push(answer), context.signal);
  });

  server.handle(goalSnapshot, ({ agentId }, context) => {
    capture(context);
    goalFeed.subscribe(agentId, (answer) => context.push(answer), context.signal);
  });

  server.handle(teamSnapshot, ({ agentId }, context) => {
    capture(context);
    teamFeed.subscribe(agentId, (answer) => context.push(answer), context.signal);
  });

  // Event-driven cross-turn live updates for `subagent` / `subagent_fork`
  // timeline cards (zero polling; opened only while a card is `"running"`).
  server.handle(subagentLiveSnapshot, ({ agentId }, context) => {
    capture(context);
    subscribeAgentSubagents(agentId, (event) => context.push(event), context.signal);
  });

  // The jobs popover's stop button. Paseo's own background-task bar
  // (`background_work`) is not forwarded to plugin providers, so stopping a DSH
  // background command is this package's job: the RPC asks the bridge, which
  // calls DSH's registry `kill()`. A refusal is a value (`ok: false` + a shared
  // code), never a quiet success — see `shared/jobs.ts`.
  server.handle(jobsStop, async ({ agentId, jobId }, context) => {
    capture(context);
    return await stopAgentJob(agentId, jobId);
  });

  server.handle(goalControl, async ({ agentId, action, objective }, context) => {
    capture(context);
    const result = await controlAgentGoal(agentId, action, objective);
    // A refused command changed nothing, so only a success is worth a re-read.
    // The read is the feed's, so the pill and the popover see the new phase
    // through their own subscription instead of this answer.
    if (result.ok) goalFeed.refresh(agentId);
    // DSH's own answer travels verbatim in both directions: a refused command
    // (a paused goal at its round cap rejects `resume`) must reach the popover as
    // the runtime's sentence, never as a success.
    return result.ok
      ? { ok: true, message: result.message }
      : { ok: false, error: result.error };
  });

  server.handle(rewindNoticeArm, (_input, context) => {
    capture(context);
    return {};
  });

  return () => {
    disposeUsageStats();
    disposePricing();
    disposeDiagnostics();
    disposeDshPlugins();
    for (const cleanup of cleanups) cleanup();
    jobsFeed.dispose();
    goalFeed.dispose();
    teamFeed.dispose();
  };
}
