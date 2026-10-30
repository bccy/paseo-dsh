import type { PluginServerContext } from "@getpaseo/plugin/server";
import { jobsList } from "./shared/jobs";
import { ensurePaseoProfile } from "./server/bootstrap";
import { createDshProvider, readAgentJobs } from "./server/provider";

/**
 * Register the DeepSeek Harness provider, provisioning the DSH profile it needs,
 * and the one RPC the composer's jobs pill asks through.
 *
 * Paseo's plugin installer runs no install scripts, so this plugin is
 * self-sufficient: on load it writes `$DSH_HOME/profiles/<name>` and the bridge
 * bundle it carries (see server/bootstrap.ts). Provisioning is best-effort —
 * a filesystem failure is logged and the provider still registers, so the
 * failure surfaces as an honest error when a session tries to start `dsh`.
 *
 * The jobs RPC exists because the pill lives in the app's client bundle and the
 * jobs live in a DSH child process: the client cannot reach `ctx.jobs`, and the
 * provider protocol has no request shape for "background jobs of this agent"
 * (that would be a Paseo protocol extension, not something a plugin may invent).
 * A plugin RPC is the supported channel for exactly this: daemon-side work the
 * client asks for.
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
      `[dsh-paseo] could not provision the DSH profile: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }

  server.registerProvider(createDshProvider());

  server.handle(jobsList, async ({ agentId }) => {
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

  return () => {};
}
