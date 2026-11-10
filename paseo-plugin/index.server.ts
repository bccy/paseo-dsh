import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { goalControl, goalSnapshot, isTerminalGoalErrorCode, type GoalAnswer } from "./shared/goal";
import { isTerminalJobsErrorCode, jobsSnapshot, jobsStop, type JobsAnswer } from "./shared/jobs";
import { isTerminalTeamErrorCode, teamSnapshot, type TeamAnswer } from "./shared/team";
import { rewindNoticeArm } from "./shared/rewind-notice";
import { ensurePaseoProfile } from "./server/bootstrap";
import { createPillFeed } from "./server/pill-feed";
import { capturePaseo } from "./server/rewind-notice-append";
import {
  controlAgentGoal,
  createDshProvider,
  readAgentGoal,
  readAgentJobs,
  readAgentTeam,
  stopAgentJob,
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
 * These are `on` hooks, never `before("agent.session_open")`: the host
 * invalidates plugin sessions for a plugin that registers that before-hook on
 * every start and stop, which reloads every agent before its next prompt.
 */
const CAPTURE_HOOKS = [
  "agent.created",
  "agent.turn_started",
  "agent.turn_ended",
  "agent.permission_requested",
  "agent.permission_resolved",
  "agent.archived",
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
  const cleanups = CAPTURE_HOOKS.map((name) => server.on(name, (_event, context) => capture(context)));

  server.registerProvider(createDshProvider());

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
    for (const cleanup of cleanups) cleanup();
    jobsFeed.dispose();
    goalFeed.dispose();
    teamFeed.dispose();
  };
}
