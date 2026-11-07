#!/usr/bin/env node
/**
 * Standalone launcher for the model-route probe.
 *
 * The implementation lives in `paseo-plugin/lib/probe-provider.mjs`, which the
 * installed plugin's CLI also runs (`<plugin dir>/bin/paseo-dsh.mjs probe`,
 * where `<plugin dir>` is the DIRECTORY column of `paseo plugin ls`). This
 * script is the checkout-only launcher; `npx paseo-dsh` is the npm upstream
 * stable line, not this branch.
 *
 * Usage:
 *   node tools/probe-provider.mjs \
 *     --base-url https://gateway.example/v1 \
 *     --api-key-env MY_API_KEY \
 *     --model deepseek-v4-flash
 */
import { runProbe } from "../paseo-plugin/lib/probe-provider.mjs";

await runProbe(process.argv.slice(2), "node tools/probe-provider.mjs");
