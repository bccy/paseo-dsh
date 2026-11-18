/**
 * Resolve the official Windows npm launcher to its Node entrypoint.
 * No command shell is inserted, so stdio, argv and child termination stay native.
 *
 * Why this exists: `dsh` installed with `npm -g` on Windows is a `dsh.cmd` shim.
 * Node's `spawn("dsh", ...)` cannot execute it (and `execFile("dsh.cmd", ...)`
 * fails with EINVAL as well), so every caller that launches DSH — the plugin
 * process, the doctor, the harness probes — would start nothing at all. This
 * module is the one place that recognises the official npm layout and rewrites
 * it to `node.exe <package>/<bin entry>`; POSIX and native executables pass
 * through unchanged. It is deliberately dependency-free and side-effect-free so
 * both the TypeScript plugin and the standalone doctor can share it.
 *
 * Recognised case: `binary` is `dsh`, `dsh.cmd` or `dsh.ps1` (a bare name or a
 * path, case-insensitive), the platform is win32, and the directory holding the
 * shim also holds `node_modules/@deepseek-ai/dsh/package.json` naming a `bin`
 * entry that exists inside that package. Anything else — a custom wrapper, a
 * native `dsh.exe`, an install whose package.json is missing or unrecognised —
 * is returned unchanged so the normal spawn error stays loud.
 *
 * @param {string} binary - configured launcher (`DSH_BINARY` or the default `dsh`).
 * @param {NodeJS.ProcessEnv} [env] - launch environment (its PATH is used).
 * @param {string} [cwd] - base directory for relative PATH entries and paths.
 * @returns {{ command: string, args: string[] }}
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function resolveDshCommand(binary, env = process.env, cwd = process.cwd()) {
  const unchanged = { command: binary, args: [] };
  if (process.platform !== "win32" || !/^dsh(?:\.cmd|\.ps1)?$/i.test(basename(binary))) return unchanged;

  const explicit = /[/\\]/.test(binary);
  // Node uses the first case-insensitive PATH key in lexicographic order.
  const pathKey = Object.keys(env).sort().find((key) => key.toLowerCase() === "path");
  const directories = explicit
    ? [dirname(resolve(cwd, binary))]
    : (env[pathKey] ?? "")
        .split(";")
        .map((value) => resolve(cwd, value.replace(/^"|"$/g, "")));

  for (const directory of directories) {
    // Preserve a native executable that would take precedence over an npm shim.
    if (!explicit && (existsSync(join(directory, "dsh.exe")) || existsSync(join(directory, "dsh.com")))) {
      return unchanged;
    }
    if (!existsSync(explicit ? resolve(cwd, binary) : join(directory, "dsh.cmd"))) continue;
    const packageDir = join(directory, "node_modules", "@deepseek-ai", "dsh");
    try {
      const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.dsh;
      if (pkg.name !== "@deepseek-ai/dsh" || typeof bin !== "string") return unchanged;
      const entry = resolve(packageDir, bin);
      const local = relative(packageDir, entry);
      if (isAbsolute(local) || local === ".." || local.startsWith(".." + sep) || !existsSync(entry)) return unchanged;
      // Match npm's launcher: use node.exe beside the shim, otherwise Node on PATH.
      const node = join(directory, "node.exe");
      return { command: existsSync(node) ? node : "node.exe", args: [entry] };
    } catch {
      // Leave missing or unrecognized installations to the normal spawn error.
      return unchanged;
    }
  }
  return unchanged;
}
