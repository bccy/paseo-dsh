/**
 * Offline check that `paseo-plugin/server/bridge-assets.ts` matches `dsh-bridge/`
 * and `templates/`.
 *
 * AGENTS.md makes regenerating the embedded bridge a hard rule — "改了
 * `dsh-bridge/` 必须重生成内嵌桥" — and nothing enforced it. The consequence is
 * worse than a stale generated file: every plugin-level harness script loads
 * `index.server.js`, which calls `ensurePaseoProfile()` and *unconditionally
 * rewrites* the user's `~/.dsh/profiles/<p>/node_modules/dsh-paseo-bridge` from
 * these embedded bytes. So a forgotten regeneration is silent, and one run of
 * any plugin-level check installs the stale bridge into the live profile — after
 * which the "real profile" checks (`archive-registry-check`, `stream-probe`,
 * `subagent-live`, `probe`, `route-test`, `catalog`) go green on old code too.
 *
 * This recomputes the generated text in memory and compares it byte for byte. It
 * never writes, so it is safe to run at any time, and it needs neither a profile
 * nor a daemon.
 *
 * Usage: node harness/bridge-assets-check.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const bridgeDir = join(repoRoot, "dsh-bridge");
const templateFile = join(repoRoot, "templates", "cordis.patch.yml");
const assetsFile = join(repoRoot, "paseo-plugin", "server", "bridge-assets.ts");

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  — ${detail}`}`);
};

// ---- rebuild exactly what the generator would write ----------------------
// Kept in step with `paseo-plugin/scripts/generate-bridge-assets.mjs` on
// purpose: if the generator changes shape, this comparison has to change with
// it, and a mismatch shows up as a failure rather than as silence.
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

const wanted = walk(bridgeDir).filter((path) => {
  const leaf = path.split("/").pop();
  return leaf === "package.json" || leaf === "cordis.patch.yml" || path.endsWith(".js");
});

const bridgeFiles = wanted.map((path) => [path, readFileSync(join(bridgeDir, path), "utf8")]);
const patchTemplate = readFileSync(templateFile, "utf8");
const b64 = (value) => Buffer.from(value, "utf8").toString("base64");

// Kept in step with the generator's `literal`, chunk width included: the whole
// point of the chunking is that no line here is ever long enough for a
// character-level diff of it to explode.
const BRIDGE_ASSET_CHUNK = 76;
function literal(value, indent) {
  if (value.length <= BRIDGE_ASSET_CHUNK) return JSON.stringify(value);
  const chunks = [];
  for (let at = 0; at < value.length; at += BRIDGE_ASSET_CHUNK) {
    chunks.push(`${indent}${JSON.stringify(value.slice(at, at + BRIDGE_ASSET_CHUNK))}`);
  }
  return chunks.join(" +\n");
}

const expected = [
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
].join("\n");

const actual = readFileSync(assetsFile, "utf8");

check(
  "bridge-assets.ts is exactly what the generator would write",
  actual === expected,
  actual === expected ? `${bridgeFiles.length} bridge files` : "differs — run `node paseo-plugin/scripts/generate-bridge-assets.mjs`",
);

// The whole file is base64, so a careless edit cannot change what it *means*
// without changing these bytes; but a long line is its own defect, independent of
// whether the bytes still match.
const longest = actual.split("\n").reduce((most, line) => Math.max(most, line.length), 0);
check("and no line is long enough to make its diff quadratic", longest <= 200, `longest line ${longest} characters`);

// ---- and when it differs, say which file drifted ------------------------
// A bare byte comparison tells a maintainer to regenerate; naming the file tells
// them what they forgot.
if (actual !== expected) {
  const block = /export const BRIDGE_FILES[^{]*\{([\s\S]*?)\n\};/.exec(actual)?.[1] ?? "";
  // An entry is a key followed by one or more concatenated string chunks, so the
  // value has to be joined back together before it can be compared.
  const entries = new Map();
  for (const [, key, body] of block.matchAll(
    /^\s*("(?:[^"\\]|\\.)*"):\s*((?:"(?:[^"\\]|\\.)*"(?:\s*\+)?\s*)+),/gm,
  )) {
    entries.set(
      JSON.parse(key),
      [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(([, text]) => text).join(""),
    );
  }
  const drifted = [];
  for (const [path, content] of bridgeFiles) {
    const embedded = entries.get(path);
    if (embedded === undefined) drifted.push(`${path} (absent from the assets)`);
    else if (embedded !== b64(content)) drifted.push(`${path} (content differs)`);
  }
  for (const path of entries.keys()) {
    if (!bridgeFiles.some(([bridgePath]) => bridgePath === path)) drifted.push(`${path} (no such file under dsh-bridge/)`);
  }
  const templateBody = /PROFILE_PATCH_TEMPLATE_BASE64\s*=\s*((?:"(?:[^"\\]|\\.)*"(?:\s*\+)?\s*)+);/.exec(actual)?.[1];
  const template =
    templateBody === undefined
      ? undefined
      : [...templateBody.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(([, text]) => text).join("");
  if (template !== undefined && template !== b64(patchTemplate)) {
    drifted.push("templates/cordis.patch.yml (content differs)");
  }
  check("the drift is attributable to a named file", drifted.length > 0, drifted.join(", ") || "(nothing identified)");
}

const failed = results.filter((result) => !result.pass).length;
console.log(`\n  ${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
