/*
 * Load this package's TypeScript modules in `node --test` files without leaving
 * compiled artifacts behind.
 *
 * The plugin sources are ESM with extensionless relative specifiers, which the
 * plain `node` resolver cannot follow from a CommonJS test: registering the
 * `.ts`/`.tsx` extensions teaches `require` to resolve and transpile those
 * modules, including the extensionless imports between them. Type errors are
 * not reported here — `tsc --noEmit` is the typecheck — because `transpileModule`
 * is deliberately a per-file emit with no type analysis.
 *
 * Ported from the upstream provider's test harness (same module, same options),
 * so the two test trees stay conceptually identical: a test can require
 * `../server/provider.ts` directly and drive the real provider.
 */
const fs = require("node:fs");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: filename,
  });
  module._compile(outputText, filename);
};
require.extensions[".tsx"] = require.extensions[".ts"];