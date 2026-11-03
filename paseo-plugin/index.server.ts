import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { goalControl, goalCurrent } from "./shared/goal";
import { jobsList } from "./shared/jobs";
import { teamRead } from "./shared/team";
import { rewindNoticeArm } from "./shared/rewind-notice";
import { ensurePaseoProfile } from "./server/bootstrap";
import { capturePaseo } from "./server/rewind-notice-append";
import { controlAgentGoal, createDshProvider, readAgentGoal, readAgentJobs, readAgentTeam } from "./server/provider";

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
 * and the RPCs the client half asks through.
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
 * The jobs and goal RPCs exist because their pills live in the app's client
 * bundle while the data lives in a DSH child process: the client cannot reach
 * `ctx.jobs` or `ctx.goals`, and the provider protocol has no request shape for
 * "background jobs / current goal of this agent" (that would be a Paseo protocol
 * extension, not something a plugin may invent). A plugin RPC is the supported
 * channel for exactly this: daemon-side work the client asks for.
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

  server.handle(jobsList, async ({ agentId }, context) => {
    capture(context);
    // The two ordinary "nothing to show" cases answer an empty list, which is the
    // truth from this process's point of view. A real read failure comes back as
    // `available: false` so the pill can say "could not read".
    const result = await readAgentJobs(agentId);
    return {
      available: result.available,
      jobs: result.jobs,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  });

  // The goal pill's two RPCs, mirroring the jobs pair. DSH owns the goal state
  // (there is no Paseo goal protocol and the plugin declares no capability for
  // it), so the client polls the daemon side for it — a plugin RPC is the
  // supported channel for daemon-side reads. `goal.control` exists because a
  // hand-typed `/goal …` during a running turn is steered into the model as
  // plain text; the pill's buttons must reach the command registry instead.
  server.handle(goalCurrent, async ({ agentId }, context) => {
    capture(context);
    const result = await readAgentGoal(agentId);
    return {
      available: result.available,
      goal: result.goal,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  });

  server.handle(goalControl, async ({ agentId, action, objective }, context) => {
    capture(context);
    const result = await controlAgentGoal(agentId, action, objective);
    // DSH's own answer travels verbatim in both directions: a refused command
    // (a paused goal at its round cap rejects `resume`) must reach the popover as
    // the runtime's sentence, never as a success.
    return result.ok
      ? { ok: true, message: result.message }
      : { ok: false, error: result.error };
  });

  // The team pill's read (T3): DSH's agentTeam projection plus live `running`.
  // Read-only — there is no team write path the bridge could carry honestly.
  server.handle(teamRead, async ({ agentId }, context) => {
    capture(context);
    const result = await readAgentTeam(agentId);
    return {
      available: result.available,
      team: result.team,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  });

  server.handle(rewindNoticeArm, (_input, context) => {
    capture(context);
    return {};
  });

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
