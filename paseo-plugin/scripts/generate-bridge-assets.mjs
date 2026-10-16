#!/usr/bin/env node
/**
 * Generates `paseo-plugin/server/bridge-assets.ts` from `../dsh-bridge` and
 * `../templates`.
 *
 * Paseo installs plugins from npm or git and runs no install scripts, so the
 * plugin cannot depend on the repo's `install.sh` to place the DSH bridge in
 * the profile. Instead the bridge bundle and the profile patch template are
 * embedded as base64 and materialized at plugin load (see server/bootstrap.ts).
 *
 * Run after any change under `dsh-bridge/` or `templates/`, and before publish
 * (wired to `prepack`). The generated file is committed so git installs work
 * without a build step.
 *
 * Usage: node scripts/generate-bridge-assets.mjs
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const bridgeDir = join(repoRoot, "dsh-bridge");
const templateFile = join(repoRoot, "templates", "cordis.patch.yml");
const outFile = join(here, "..", "server", "bridge-assets.ts");

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === ".git") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split("\\").join("/"));
  }
  return out;
}

// Only the files a DSH profile needs to load the bundle as a package.
const wanted = walk(bridgeDir).filter((path) => {
  const leaf = path.split("/").pop();
  return leaf === "package.json" || leaf === "cordis.patch.yml" || path.endsWith(".js");
});

const bridgeFiles = wanted.map((path) => [path, readFileSync(join(bridgeDir, path), "utf8")]);
const patchTemplate = readFileSync(templateFile, "utf8");
const b64 = (value) => Buffer.from(value, "utf8").toString("base64");

/**
 * Base64 as a concatenation of short string chunks, one per line.
 *
 * Emitting one string per file made a single ~77 KB line, and every commit that
 * touched the bridge produced a diff of a dozen lines in which *one line was
 * 77 K characters long*. Anything that highlights a change within a line has to
 * diff the two versions of that line, and character-level diffing is quadratic:
 * 77318² is 6.0e9 cells, ~22 GB of table. Paseo's checkout-diff panel froze on
 * it. Chunked like a PEM body the longest line is 76 characters, so a
 * regenerated bridge reads as many short changed lines — linear work.
 */
const BRIDGE_ASSET_CHUNK = 76;
function literal(value, indent) {
  if (value.length <= BRIDGE_ASSET_CHUNK) return JSON.stringify(value);
  const chunks = [];
  for (let at = 0; at < value.length; at += BRIDGE_ASSET_CHUNK) {
    chunks.push(`${indent}${JSON.stringify(value.slice(at, at + BRIDGE_ASSET_CHUNK))}`);
  }
  return chunks.join(" +\n");
}

const lines = [
  "// GENERATED FILE — do not edit by hand.",
  "// Regenerate with: node scripts/generate-bridge-assets.mjs",
  "//",
  "// The DSH bridge bundle and profile patch template, embedded so the plugin can",
  "// provision ~/.dsh/profiles/<name> at load without shipping the bridge as",
  "// separate files (npm and git plugin installs run no install scripts).",
  "//",
  "// The base64 is chunked to keep every line short: one string per file used to",
  "// put ~77 K characters on a single line, and diffing that is quadratic.",
  "",
  'export const BRIDGE_PACKAGE_NAME = "dsh-paseo-bridge";',
  "",
  "/** Path -> base64 file content, relative to the bridge package root. */",
  "export const BRIDGE_FILES: Readonly<Record<string, string>> = {",
  ...bridgeFiles.map(([path, content]) => `  ${JSON.stringify(path)}:\n${literal(b64(content), "    ")},`),
  "};",
  "",
  "/** The starter cordis.patch.yml written only when the profile has none. */",
  `export const PROFILE_PATCH_TEMPLATE_BASE64 =\n${literal(b64(patchTemplate), "  ")};`,
  "",
];

writeFileSync(outFile, lines.join("\n"), "utf8");
console.log(
  `wrote ${relative(repoRoot, outFile)} (${bridgeFiles.length} bridge files, patch template ${patchTemplate.length} bytes)`,
);
