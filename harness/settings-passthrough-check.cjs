/**
 * Regression: DSH's runtime settings toggles must reach Paseo's composer.
 *
 * The feature: a third-party DSH plugin whose whole volatile Config form is one
 * boolean field (e.g. `dsh-unrestricted`'s `enabled`) becomes one `select` row
 * in `ProviderConfigState.settings` — `"on"`/`"off"` options, labelled with the
 * plugin's own display name — written back through the bridge's
 * `paseo/settings/set` (which calls DSH's `settings.mutate` — profile patch +
 * configEditor reconcile, no HMR). The bridge contract stays boolean; the
 * on/off strings exist only in the composer projection. The first projection
 * was a `toggle`, which the desktop toolbar draws as an icon-only button with
 * no state feedback, so the select is what this check now pins (the reason
 * lives in `session.ts`'s `dshSettingSelectValue`).
 *
 * What this check pins, against the fake bridge (no real DSH, no model):
 *
 *   1. **list becomes a select row.** The bridge's `paseo/settings/list` answer
 *      must appear in `session.config` as a `controls` entry plus its value in
 *      `providerOptions` (Paseo 0.16's split of the old `settings` array) —
 *      `{type:"select", id:"dsh:<ns>:<path>", label:<localized title>,
 *      value:"on"|"off", options:[{label:"开启",value:"on"},
 *      {label:"关闭",value:"off"}]}` with a description that says the switch is
 *      global. The title arrives as a language dictionary from the bridge; the
 *      label and the option words are picked with this process's `LOCALE` (the
 *      same one that renders the rest of the composer). The option labels are
 *      the plain on/off words — the row's `label` carries the switch's name, and
 *      repeating it in every option was user-visible duplication.
 *   2. **configure sends the right frame.** A composer change of that id — the
 *      select value `"on"`/`"off"`, or a boolean persisted by an agent saved
 *      while the row was still a toggle — must reach the bridge as
 *      `paseo/settings/set {ns, path, value, revision, expectedValue}` — value
 *      boolean, the revision because it is the service's optimistic lock,
 *      `expectedValue` because it is the value the user actually saw.
 *   3. **a changed notification republishes every open session.** The bridge
 *      forwards `settings/document-updated` as `paseo/settings/changed`; the
 *      plugin must re-read and emit a fresh `session.config` for *all* open
 *      conversations (the value is global to the DSH profile), not just the one
 *      whose composer was touched.
 *   4. **no settings service means no rows.** `{available:false, items:[]}`
 *      must leave `settings` without any `dsh:` id, and must not fail the open.
 *      `{available:true, items:[]}` is a different state — a settings service
 *      with no qualifying row — and must also publish no row while staying
 *      quiet about "unavailable" (that line is for a profile that has no
 *      settings service at all).
 *   5. **the filter is the production one.** `dsh-bridge/lib/settings-
 *      discovery.js` is imported directly and asserted against official,
 *      multi-field, non-boolean and dict-shaped forms — the same functions the
 *      bridge server runs, so a filter bug cannot pass by being re-implemented
 *      here. The real wire shape (`{uid, refs}`, schemastery's `toJSON()`) is
 *      covered too: raw selects nothing, `new Schema(wire)` selects the toggle.
 *   6. **a refused write is readable and republishes the runtime value.** The
 *      bridge answers `conflict` / `not_found` / `settings_unavailable` as
 *      values; the plugin must fail the configure with the *user-facing copy* for
 *      that code (not one generic message) and let the provider re-emit the
 *      committed config.
 *   7. **a create-panel pick is deferred to the first prompt.** A fresh open
 *      carries the user's pick in `config.providerOptions` (`"on"`/`"off"`, or a
 *      boolean from an older agent); it must not be written on open (Paseo opens
 *      a throwaway draft session to refresh the create menu), must be written
 *      before the first prompt, and a write failure must produce a timeline
 *      warning without blocking the prompt.
 *   8. **a session that is never prompted writes nothing.** The draft path: open
 *      with a `dsh:` value, close without prompting, zero `paseo/settings/set`.
 *   9. **a resumed session never writes its stored value.** Paseo re-sends the
 *      last value it saw per agent; on a resume the runtime value wins silently —
 *      no write, no timeline notice, one daemon-stderr line.
 *
 * ## Running it
 *
 * Two steps, in this order — the compile goes into `paseo-plugin/.dbg`, the run
 * happens **from the repo root**:
 *
 *   cd paseo-plugin
 *   npx tsc --noEmit false --outDir .dbg --declaration false \
 *     --module commonjs --moduleResolution node
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cd ..
 *   node harness/settings-passthrough-check.cjs
 *
 * Running it *inside* `.dbg` (`cd .dbg && node settings-passthrough-check.cjs`)
 * does not work: this script loads the bridge by walking up from its own
 * directory (`repoRoot = __dirname/..`), which from `.dbg` points at
 * `paseo-plugin/` and then looks for `paseo-plugin/dsh-bridge/lib/…`. The copy
 * of `fake-dsh-bridge.mjs` that step used to require is not needed either — the
 * provider resolves the fake `dsh` from this checkout.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const fakeBridgeCandidates = [
  path.join(__dirname, "fake-dsh-bridge.mjs"),
  path.join(repoRoot, "harness", "fake-dsh-bridge.mjs"),
];
const fakeBridge = fakeBridgeCandidates.find((candidate) => fs.existsSync(candidate));
if (fakeBridge === undefined) {
  console.error("fake-dsh-bridge.mjs not found next to this check or in harness/");
  process.exit(2);
}
fs.chmodSync(fakeBridge, 0o755);
process.env.DSH_BINARY = fakeBridge;
process.env.DSH_FAKE_MODE = "live";
// This process runs the Chinese half of the check. The English half of the
// deferred-write warning is asserted end-to-end in a child process with the
// locale flipped (`SETTINGS_CHECK_EN_WARNING=1`), because `LOCALE` is resolved
// once at module load and cannot change mid-run.
const EN_WARNING_CHILD = process.env.SETTINGS_CHECK_EN_WARNING === "1";
// The composer's locale for this run: the label must be the Chinese dictionary
// entry (or the English one in the child), not the raw dictionary.
process.env.DSH_PASEO_LANG = EN_WARNING_CHILD ? "en" : "zh-CN";

// Never touch the user's live profile: loading the plugin provisions
// `$DSH_HOME/profiles/<name>` from the embedded bridge.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-settings-check-"));

// Keep this machine's Server Browser plugin out of the picture (the provider
// adds `server_browser` whenever it can find the browser plugin's data dir).
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-settings-check-"));
process.env.PASEO_SERVER_BROWSER_DATA = path.join(scratch, "no-browser-plugin");

// Every request frame the plugin sends is appended here.
const frameLog = path.join(scratch, "frames.jsonl");
process.env.DSH_FAKE_LOG = frameLog;

// The scripted settings state. One toggle that qualifies (third-party, one
// boolean); the fake answers whatever the file says, so the production filter is
// exercised where it lives — see the direct pure-function assertions at the end.
const settingsFile = path.join(scratch, "settings.json");
const settingsTrigger = path.join(scratch, "settings-trigger.json");
// Scripted write refusals: the real bridge answers expected failures as
// `{ok:false,error:{code,message}}` values, and the plugin must word each code
// for the user while still republishing the committed config.
const settingsFail = path.join(scratch, "settings-fail.json");
// The fake bridge resolves its mode per request, but reads it from the *child's*
// environment — a shared child inherits the environment once, at spawn. A file
// is the channel for changing it mid-run (the fake's own `currentMode`), and an
// absent file means "live". It starts absent so the first sessions see the plain
// bridge; the preset section below writes it for one open.
const fakeModeFile = path.join(scratch, "fake-mode");
process.env.DSH_FAKE_MODE_FILE = fakeModeFile;
process.env.DSH_FAKE_SETTINGS_FILE = settingsFile;
process.env.DSH_FAKE_SETTINGS_TRIGGER = settingsTrigger;
process.env.DSH_FAKE_SETTINGS_FAIL_FILE = settingsFail;
function writeSettingsFailure(error) {
  if (error === undefined) {
    fs.rmSync(settingsFail, { force: true });
    return;
  }
  fs.writeFileSync(settingsFail, JSON.stringify(error));
}

function writeSettings(items) {
  fs.writeFileSync(settingsFile, JSON.stringify({ available: true, items }));
}

function settingsItem(overrides = {}) {
  return {
    ns: "dsh-unrestricted",
    moduleName: "dsh-unrestricted",
    // The real bridge passes the plugin's inventory title dictionary through
    // untouched; the plugin picks the language.
    title: { en: "Unrestricted mode", zh: "破限模式" },
    field: { path: ["enabled"], value: false, revision: 3 },
    ...overrides,
  };
}

writeSettings([settingsItem()]);

const compiledCandidates = [
  path.join(__dirname, "index.server.js"),
  path.join(repoRoot, "paseo-plugin", ".dbg", "index.server.js"),
];
const compiled = compiledCandidates.find((candidate) => fs.existsSync(candidate));
if (compiled === undefined) {
  console.error("compiled plugin not found. Compile paseo-plugin to .dbg first (see this file's header).");
  process.exit(2);
}
const plugin = require(compiled).default;
const sessionModule = require(path.join(path.dirname(compiled), "server", "session.js"));
const {
  DshSession,
  dshSettingBooleanValue,
  dshSettingFailureCopy,
  dshSettingId,
  dshSettingLabel,
  dshSettingOptionLabel,
  dshSettingSelectValue,
} = sessionModule;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const events = [];
let registration;

plugin({
  handle() {},
  registerProvider(value) {
    registration = value;
  },
  registerSettings() {},
  on() {},
  before() {},
});

async function until(predicate, label, ms = 30000, since = 0) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    // Only frames that arrived after `since`: a matching event from an earlier
    // phase would otherwise satisfy a later wait (the stale-event trap this
    // repository's checks keep re-learning).
    const hit = events.slice(since).find(predicate);
    if (hit) return hit;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  — ${detail}`}`);
};

/** Every request frame the fake bridge has recorded so far. */
function frames() {
  if (!fs.existsSync(frameLog)) return [];
  return fs
    .readFileSync(frameLog, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/** The last `session.config` emitted for one session. */
function lastConfig(sessionId) {
  return [...events].reverse().find((event) => event.type === "session.config" && event.sessionId === sessionId);
}

/**
 * The `dsh:`-prefixed switch rows of a config, read the 0.16 way.
 *
 * Since Paseo 0.16 a `ProviderConfigState` carries the keys that get a control
 * in `controls` and their committed values in `providerOptions`; the deprecated
 * `settings` array held both at once and this plugin no longer reports it. Each
 * row is flattened back into the shape the assertions below read
 * (`id`/`value`/`options` out of `key`/`providerOptions[key]`/`choices`), so a
 * check that fails says which part of the pair is wrong.
 *
 * @param config - one `session.config` event.
 * @returns the `dsh:` rows, in control order.
 */
function dshRows(config) {
  const controls = config?.config?.controls ?? [];
  const values = config?.config?.providerOptions ?? {};
  return controls
    .filter((control) => String(control.key).startsWith("dsh:"))
    .map((control) => ({
      ...control,
      id: control.key,
      value: values[control.key],
      options: control.choices,
    }));
}

/** All `paseo/settings/set` request frames so far. */
function setFrames() {
  return frames().filter((frame) => frame.method === "paseo/settings/set");
}

/**
 * Open a session.
 *
 * @param sessionId - provider session id.
 * @param options - `{providerOptions, persistence}`: the agent's options ride
 *   `config.providerOptions` (the create-panel path); `persistence` marks a resume.
 */
async function open(sessionId, options = {}) {
  await conn.send({
    type: "session.open",
    requestId: `open-${sessionId}`,
    sessionId,
    config: {
      cwd: process.cwd(),
      mode: "build",
      ...(options.providerOptions === undefined ? {} : { providerOptions: options.providerOptions }),
    },
    ...(options.persistence === undefined ? {} : { persistence: options.persistence }),
  });
  await until((event) => event.type === "session.ready" && event.sessionId === sessionId, `${sessionId} ready`);
  const config = lastConfig(sessionId);
  if (config === undefined) throw new Error(`no session.config for ${sessionId}`);
  return config;
}

/** Send one prompt and wait for the plugin's acceptance (not the model answer). */
async function prompt(sessionId, clientMessageId) {
  await conn.send({
    type: "session.prompt",
    sessionId,
    prompt: {
      clientMessageId,
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "hello" }] },
    },
  });
  return until(
    (event) => event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
    `prompt accepted ${clientMessageId}`,
  );
}

/** Capture the daemon-stderr lines written while `run` executes. */
async function captureStderr(run) {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    await run();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

let conn;

process.on("exit", () => {
  for (const dir of [process.env.DSH_HOME, scratch]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

(async () => {
  conn = await registration.connect({
    capabilities: [
      "prompt.message",
      "session.configure",
      "session.persistence",
      "session.subsession",
      "permission",
    ],
  });
  conn.onEvent((event) => events.push(event));

  // The English half of the deferred-write warning, in its own process: the
  // locale is resolved at module load, so the only way to see what an English
  // UI actually receives is to start over with DSH_PASEO_LANG=en.
  if (EN_WARNING_CHILD) {
    // CJK ideographs plus CJK/full-width punctuation: a hardcoded Chinese
    // sentence or a Chinese "：/；" separator both fail this.
    const hasCjk = (text) => /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/.test(text);
    let allPass = true;
    const printCheck = (name, ok, detail) => {
      if (!ok) allPass = false;
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}  — ${JSON.stringify(detail)}`);
    };

    writeSettings([settingsItem({ field: { path: ["enabled"], value: false, revision: 7 } })]);
    writeSettingsFailure({ code: "conflict", message: "scripted conflict" });
    const sessionId = `settings-en-${Date.now()}`;
    const enConfig = await open(sessionId, { providerOptions: { "dsh:dsh-unrestricted:enabled": "on" } });
    const enRow = dshRows(enConfig)[0];
    printCheck(
      "the DSH switch row is a select with fully English option labels",
      enRow?.type === "select"
        && enRow?.value === "off"
        && JSON.stringify(enRow?.options) === JSON.stringify([
          { label: "On", value: "on" },
          { label: "Off", value: "off" },
        ]),
      JSON.stringify(enRow),
    );
    await prompt(sessionId, "prompt-en-warning");
    const warning = await until(
      (event) => event.type === "session.notice"
        && event.sessionId === sessionId
        && event.notice?.title === "DSH global switch was not applied",
      "English pending write failure warning",
    );
    const description = String(warning.notice?.description ?? "");
    printCheck(
      "the deferred-write warning is fully English under DSH_PASEO_LANG=en",
      !hasCjk(description)
        && /could not be written back/.test(description)
        && description.includes("Unrestricted mode")
        && description.includes(": "),
      description,
    );

    // A configure that carries a value the menu cannot have sent (only
    // reachable through a protocol bug) must not leak the Chinese copy either.
    const nonBooleanMark = events.length;
    await conn.send({
      type: "session.configure",
      requestId: "configure-en-non-boolean",
      sessionId,
      changes: { providerOptions: { "dsh:dsh-unrestricted:enabled": "yes" } },
    });
    const nonBooleanFailed = await until(
      (event) => event.type === "request.failed" && event.requestId === "configure-en-non-boolean",
      "English non-boolean configure failure",
      30000,
      nonBooleanMark,
    );
    const nonBooleanMessage = String(nonBooleanFailed.error?.message ?? "");
    printCheck(
      "an unexpected-value configure error is fully English",
      !hasCjk(nonBooleanMessage)
        && /received an unexpected value/.test(nonBooleanMessage)
        && /On\/Off/.test(nonBooleanMessage),
      nonBooleanMessage,
    );

    // A bridge-refused configure uses the same label/separator pair as the
    // pending warning, so it must be English as well.
    const refusedMark = events.length;
    await conn.send({
      type: "session.configure",
      requestId: "configure-en-refused",
      sessionId,
      changes: { providerOptions: { "dsh:dsh-unrestricted:enabled": "on" } },
    });
    const refusedFailed = await until(
      (event) => event.type === "request.failed" && event.requestId === "configure-en-refused",
      "English refused configure failure",
      30000,
      refusedMark,
    );
    const refusedMessage = String(refusedFailed.error?.message ?? "");
    printCheck(
      "a bridge-refused configure error is fully English",
      !hasCjk(refusedMessage)
        && /This switch was changed elsewhere just now/.test(refusedMessage)
        && /Unrestricted mode/.test(refusedMessage),
      refusedMessage,
    );

    await conn.close();
    process.exit(allPass ? 0 : 1);
  }

  // ---- 1. the bridge list becomes a composer select ----------------------
  const sessionA = `settings-a-${Date.now()}`;
  const configA = await open(sessionA);
  const rowsA = dshRows(configA);
  check(
    "paseo/settings/list becomes one dsh: select row in session.config",
    rowsA.length === 1
      && rowsA[0].type === "select"
      && rowsA[0].id === "dsh:dsh-unrestricted:enabled"
      && rowsA[0].label === "破限模式"
      && rowsA[0].value === "off",
    JSON.stringify(rowsA),
  );
  check(
    "the select offers plain on/off option labels (the row's label carries the switch's name)",
    JSON.stringify(rowsA[0]?.options) === JSON.stringify([
      { label: "开启", value: "on" },
      { label: "关闭", value: "off" },
    ]),
    JSON.stringify(rowsA[0]?.options),
  );
  check(
    "the label comes from the plugin's title dictionary using this process's LOCALE",
    // The dictionary also carries English; the row must show the Chinese entry
    // because DSH_PASEO_LANG=zh-CN is set for this run.
    rowsA[0]?.label === "破限模式" && rowsA[0]?.label !== "Unrestricted mode",
    JSON.stringify(rowsA[0]?.label),
  );
  check(
    "the switch description says the value is global (not a per-agent value)",
    typeof rowsA[0]?.description === "string" && /全局生效/.test(rowsA[0].description),
    JSON.stringify(rowsA[0]?.description),
  );
  check(
    "the existing provider options are not displaced by DSH switches",
    (configA.config.controls ?? []).some((control) => control.key === "permission")
      && (configA.config.controls ?? []).every((control) => control.key !== "preset"),
    JSON.stringify((configA.config.controls ?? []).map((control) => control.key)),
  );
  // The 0.16 pair replaces the old `settings` array: a state that still carried
  // it would be a second, unread vocabulary (the host stops sending changes under
  // that name the moment `controls`/`providerOptions` appear).
  check(
    "the state reports controls + providerOptions and no deprecated settings array",
    configA.config.settings === undefined
      && (configA.config.controls ?? []).length > 0
      && configA.config.providerOptions?.["dsh:dsh-unrestricted:enabled"] === "off",
    JSON.stringify({
      settings: configA.config.settings,
      controls: (configA.config.controls ?? []).length,
      providerOptions: configA.config.providerOptions,
    }),
  );
  // The **value** half, not just the existence of a control (V-P2). Dropping
  // `providerOptions[OPTION_PERMISSION] = this.#permission` from `configState()`
  // left every assertion above green: the control was still drawn, but the host
  // reads the committed value from `providerOptions`, so the select would fall
  // back to its (absent) `defaultValue` and render empty while the session really
  // runs under this preset. The fake bridge pins `current: "workspace-write"`.
  check(
    "the committed permission value is published in providerOptions",
    configA.config.providerOptions?.permission === "workspace-write",
    JSON.stringify({ permission: configA.config.providerOptions?.permission }),
  );

  // The preset is the other mirrored option, and its value only exists on a
  // profile that advertises presets. The fake bridge does that in `preset-reject`
  // mode (the mode `open-degrade-check` uses for the refusal notice), selected
  // here through `DSH_FAKE_MODE_FILE` for exactly this one open.
  {
    const presetSession = `settings-preset-${Date.now()}`;
    let presetConfig;
    fs.writeFileSync(fakeModeFile, "preset-reject\n");
    try {
      presetConfig = await open(presetSession);
    } finally {
      fs.rmSync(fakeModeFile, { force: true });
    }
    const presetControl = (presetConfig.config.controls ?? []).find((control) => control.key === "preset");
    check(
      "a profile with presets gets a preset control with its choices",
      presetControl !== undefined
        && (presetControl.choices ?? []).map((choice) => choice.value).join(",") === "default-pet,chosen-pet",
      JSON.stringify(presetControl ?? null),
    );
    check(
      "the committed preset value is published in providerOptions (the runtime's current, not a default)",
      presetConfig.config.providerOptions?.preset === "default-pet",
      JSON.stringify({ preset: presetConfig.config.providerOptions?.preset }),
    );
    check(
      "…and the permission value rides in the same state",
      presetConfig.config.providerOptions?.permission === "workspace-write",
      JSON.stringify(presetConfig.config.providerOptions ?? null),
    );
    await conn.send({ type: "session.close", sessionId: presetSession });
    await until(
      (event) => event.type === "session.closed" && event.sessionId === presetSession,
      "preset session closed",
    );
  }

  check(
    "the plugin asked the bridge for the runtime settings",
    frames().some((frame) => frame.method === "paseo/settings/list"),
    `${String(frames().filter((frame) => frame.method === "paseo/settings/list").length)} list frame(s)`,
  );

  // ---- 2. configure sends the exact write frame --------------------------
  //
  // The composer sends the select value (`"on"`), not a boolean: the daemon
  // passes the feature's option id through unchanged.
  await conn.send({
    type: "session.configure",
    requestId: "configure-settings-1",
    sessionId: sessionA,
    changes: { providerOptions: { "dsh:dsh-unrestricted:enabled": "on" } },
  });
  await until(
    (event) => event.type === "request.completed" && event.requestId === "configure-settings-1",
    "settings configure completed",
  );
  await sleep(100);
  check(
    "configure sends paseo/settings/set with ns, path, value, revision and expectedValue",
    setFrames().length === 1
      && JSON.stringify(setFrames()[0].params) === JSON.stringify({
        ns: "dsh-unrestricted",
        path: ["enabled"],
        value: true,
        revision: 3,
        // The value the composer displayed when the user toggled it: the
        // bridge's value-layer precondition on top of the revision.
        expectedValue: false,
      }),
    JSON.stringify(setFrames().map((frame) => frame.params)),
  );
  const afterConfigure = lastConfig(sessionA);
  check(
    "the committed value is republished as the select value in session.config",
    dshRows(afterConfigure)[0]?.value === "on",
    JSON.stringify(dshRows(afterConfigure)),
  );

  // A no-op configure (the value the runtime already has) must not write.
  await conn.send({
    type: "session.configure",
    requestId: "configure-settings-noop",
    sessionId: sessionA,
    changes: { providerOptions: { "dsh:dsh-unrestricted:enabled": "on" } },
  });
  await until(
    (event) => event.type === "request.completed" && event.requestId === "configure-settings-noop",
    "no-op configure completed",
  );
  await sleep(100);
  check(
    "a configure that requests the committed value writes nothing",
    setFrames().length === 1,
    `${String(setFrames().length)} set frame(s)`,
  );

  // A `null` is upstream's "put the key back to the provider's default". These
  // keys mirror DSH's own state (the preset and permission it reports, the
  // profile's global switch), so there is no default of ours to return to: the
  // request writes nothing, says so on daemon stderr, and the config re-emitted
  // after the call keeps carrying the runtime's value.
  const framesBeforeReset = setFrames().length;
  const resetStderr = await captureStderr(async () => {
    await conn.send({
      type: "session.configure",
      requestId: "configure-settings-reset",
      sessionId: sessionA,
      changes: { providerOptions: { "dsh:dsh-unrestricted:enabled": null } },
    });
    await until(
      (event) => event.type === "request.completed" && event.requestId === "configure-settings-reset",
      "reset configure completed",
    );
  });
  await sleep(100);
  check(
    "a null (back to the provider default) writes nothing and keeps the runtime value",
    setFrames().length === framesBeforeReset
      && dshRows(lastConfig(sessionA))[0]?.value === "on",
    JSON.stringify({
      frames: setFrames().length - framesBeforeReset,
      row: dshRows(lastConfig(sessionA)),
    }),
  );
  check(
    "…and one daemon-stderr line says the runtime value is the only default",
    resetStderr.filter((line) => /ignoring reset request for DSH setting/.test(line)).length === 1,
    JSON.stringify(resetStderr),
  );

  // Legacy shape: Paseo can hand back a boolean persisted while this row was a
  // toggle. It must be normalised before the no-op comparison and before the
  // bridge write — `Boolean("off")` is true, so a naive pass-through would
  // silently flip the switch.
  await conn.send({
    type: "session.configure",
    requestId: "configure-settings-legacy-noop",
    sessionId: sessionA,
    changes: { providerOptions: { "dsh:dsh-unrestricted:enabled": true } },
  });
  await until(
    (event) => event.type === "request.completed" && event.requestId === "configure-settings-legacy-noop",
    "legacy no-op configure completed",
  );
  await sleep(100);
  check(
    "a legacy boolean that matches the committed value writes nothing",
    setFrames().length === 1,
    `${String(setFrames().length)} set frame(s)`,
  );
  await conn.send({
    type: "session.configure",
    requestId: "configure-settings-legacy-write",
    sessionId: sessionA,
    changes: { providerOptions: { "dsh:dsh-unrestricted:enabled": false } },
  });
  await until(
    (event) => event.type === "request.completed" && event.requestId === "configure-settings-legacy-write",
    "legacy write configure completed",
  );
  await sleep(100);
  check(
    "a legacy boolean configure still writes a boolean through the bridge",
    setFrames().length === 2
      && JSON.stringify(setFrames()[1].params) === JSON.stringify({
        ns: "dsh-unrestricted",
        path: ["enabled"],
        value: false,
        revision: 4,
        expectedValue: true,
      }),
    JSON.stringify(setFrames().map((frame) => frame.params)),
  );
  // Back to on, so the failure phase below starts from the committed true.
  await conn.send({
    type: "session.configure",
    requestId: "configure-settings-restore-on",
    sessionId: sessionA,
    changes: { providerOptions: { "dsh:dsh-unrestricted:enabled": "on" } },
  });
  await until(
    (event) => event.type === "request.completed" && event.requestId === "configure-settings-restore-on",
    "restore configure completed",
  );
  await sleep(100);
  check(
    "the select value is accepted after a legacy boolean write",
    setFrames().length === 3 && dshRows(lastConfig(sessionA))[0]?.value === "on",
    JSON.stringify({ frames: setFrames().map((frame) => frame.params), row: dshRows(lastConfig(sessionA)) }),
  );

  // ---- 2b. a refused write is readable and republishes the real value -----
  //
  // The bridge answers expected write failures as values, not thrown JSON-RPC
  // errors. The plugin must turn each code into its own user-facing copy *and*
  // let the provider republish the committed config (the composer had
  // optimistically drawn the new value; a silent snap-back reads as a broken
  // switch). Each phase scripts one bridge code on the shared child.
  const failureCopy = [
    { code: "conflict", copy: /刚被别处改过/ },
    { code: "not_found", copy: /已经不存在/ },
    { code: "settings_unavailable", copy: /没有可用的设置服务/ },
  ];
  for (const failure of failureCopy) {
    writeSettingsFailure({ code: failure.code, message: `scripted ${failure.code}` });
    const requestId = `configure-settings-fail-${failure.code}`;
    const mark = events.length;
    await conn.send({
      type: "session.configure",
      requestId,
      sessionId: sessionA,
      changes: { providerOptions: { "dsh:dsh-unrestricted:enabled": "off" } },
    });
    const failed = await until(
      (event) => event.type === "request.failed" && event.requestId === requestId,
      `configure failure ${failure.code}`,
      30000,
      mark,
    );
    const message = String(failed.error?.message ?? "");
    check(
      `a ${failure.code} write fails with its own user-facing copy`,
      failure.copy.test(message),
      message,
    );
    await sleep(100);
    const republished = [...events.slice(mark)].reverse().find(
      (event) => event.type === "session.config" && event.sessionId === sessionA,
    );
    check(
      `…and the committed value is republished after the ${failure.code} failure`,
      republished !== undefined && dshRows(republished)[0]?.value === "on",
      JSON.stringify(republished === undefined ? null : dshRows(republished)),
    );
    writeSettingsFailure(undefined);
  }

  // ---- 3. a changed notification republishes EVERY open session ----------
  const sessionB = `settings-b-${Date.now()}`;
  await open(sessionB);
  const beforeA = dshRows(lastConfig(sessionA))[0]?.value;
  const beforeB = dshRows(lastConfig(sessionB))[0]?.value;
  // Model the DSH web UI flipping the same profile-wide switch. The event
  // index is captured first so the open-time config (which also carried
  // `"off"`) cannot satisfy the wait. The trigger file carries the bridge's
  // boolean (the fake bridge applies `value === true`); the republished row must
  // project it back to the select value.
  const mark = events.length;
  const listFramesBeforeChange = frames().filter((frame) => frame.method === "paseo/settings/list").length;
  fs.writeFileSync(settingsTrigger, JSON.stringify({ ns: "dsh-unrestricted", value: false }));
  await until(
    (event) => event.type === "session.config"
      && event.sessionId === sessionA
      && dshRows(event)[0]?.value === "off",
    "session A republished after paseo/settings/changed",
    30000,
    mark,
  );
  const afterA = dshRows(lastConfig(sessionA))[0]?.value;
  const afterB = dshRows(lastConfig(sessionB))[0]?.value;
  check(
    "a settings change notification republishes the new value for the touched session",
    beforeA === "on" && afterA === "off",
    `${String(beforeA)} -> ${String(afterA)}`,
  );
  check(
    "…and for every other open session too (the value is global)",
    beforeB === "on" && afterB === "off",
    `${String(beforeB)} -> ${String(afterB)}`,
  );
  check(
    "the refresh re-read the runtime instead of trusting the notification payload",
    frames().filter((frame) => frame.method === "paseo/settings/list").length >= 3,
    `${String(frames().filter((frame) => frame.method === "paseo/settings/list").length)} list frame(s)`,
  );
  // One read for the whole connection, not one per open session: the settings
  // document is the profile's and a read is a real configuration composition.
  // Two sessions are open at this point, so a per-session refresh would be 2.
  await sleep(200);
  const listFramesForChange =
    frames().filter((frame) => frame.method === "paseo/settings/list").length - listFramesBeforeChange;
  check(
    "a settings notification re-reads the runtime once and fans it out to every session",
    listFramesForChange === 1,
    `${String(listFramesForChange)} list frame(s) for ${String(2)} open session(s)`,
  );

  // ---- 3b. one dead reader must not block every other session ------------
  //
  // `#refreshSettings` reads the authoritative list through one open session and
  // fans it out. The first session in insertion order can be mid-close (its
  // shared process already gone); the provider must fall through to the next
  // still-open session instead of dropping the refresh for every conversation.
  // The narrow window cannot be hit deterministically with the fake bridge, so
  // the exact seam the provider uses (`DshSession.readDshSettings`) is patched to
  // throw for one session and restored byte-for-byte afterwards.
  const originalReadDshSettings = DshSession.prototype.readDshSettings;
  const fallbackBefore = dshRows(lastConfig(sessionB))[0]?.value;
  // The trigger file carries the bridge's boolean; the republished row must
  // project it back to the select value.
  const fallbackNextBoolean = fallbackBefore === "on" ? false : true;
  const fallbackNext = fallbackNextBoolean ? "on" : "off";
  let fallbackApplied;
  try {
    DshSession.prototype.readDshSettings = async function patchedRead() {
      if (this.id === sessionA) throw new Error("simulated: session is closing");
      return originalReadDshSettings.call(this);
    };
    const fallbackMark = events.length;
    fs.writeFileSync(settingsTrigger, JSON.stringify({ ns: "dsh-unrestricted", value: fallbackNextBoolean }));
    try {
      fallbackApplied = await until(
        (event) => event.type === "session.config" && event.sessionId === sessionB
          && dshRows(event)[0]?.value === fallbackNext,
        "session B refreshed through a fallback reader",
        8000,
        fallbackMark,
      );
    } catch {
      fallbackApplied = undefined;
    }
  } finally {
    DshSession.prototype.readDshSettings = originalReadDshSettings;
  }
  check(
    "a failing first reader does not stop the other sessions from refreshing",
    fallbackApplied !== undefined
      && dshRows(lastConfig(sessionB))[0]?.value === fallbackNext
      && dshRows(lastConfig(sessionA))[0]?.value === fallbackNext,
    JSON.stringify({
      before: fallbackBefore,
      next: fallbackNext,
      a: dshRows(lastConfig(sessionA))[0]?.value,
      b: dshRows(lastConfig(sessionB))[0]?.value,
    }),
  );

  // ---- 3c. the read failure is logged only when every reader failed --------
  const allFailStderr = [];
  const originalStderrWrite = process.stderr.write;
  try {
    DshSession.prototype.readDshSettings = async function patchedReadAll() {
      throw new Error("simulated: no live reader");
    };
    process.stderr.write = (chunk) => {
      allFailStderr.push(String(chunk));
      return true;
    };
    fs.writeFileSync(settingsTrigger, JSON.stringify({ ns: "dsh-unrestricted", value: fallbackBefore === "on" }));
    const started = Date.now();
    while (Date.now() - started < 5000
      && !allFailStderr.some((line) => /re-reading DSH settings after/.test(line))) {
      await sleep(50);
    }
  } finally {
    process.stderr.write = originalStderrWrite;
    DshSession.prototype.readDshSettings = originalReadDshSettings;
  }
  const readFailureLogs = allFailStderr.filter((line) => /re-reading DSH settings after/.test(line));
  check(
    "the read failure is logged when every open session failed",
    readFailureLogs.length === 1 && /simulated: no live reader/.test(readFailureLogs[0]),
    JSON.stringify(readFailureLogs),
  );

  // ---- 4. no settings service: no rows, open still succeeds, logged once ---
  fs.writeFileSync(settingsFile, JSON.stringify({
    available: false,
    items: [],
    reason: "scripted: this profile composes no settings service",
  }));
  const sessionC = `settings-c-${Date.now()}`;
  const unavailableStderr = await captureStderr(async () => {
    await open(sessionC);
  });
  const configC = lastConfig(sessionC);
  check(
    "a profile with no settings service opens with no DSH rows",
    dshRows(configC).length === 0,
    JSON.stringify(dshRows(configC)),
  );
  const unavailableLogs = unavailableStderr.filter((line) => /DSH settings are unavailable/.test(line));
  check(
    "…and the bridge's reason is logged once, so an empty menu is explained",
    unavailableLogs.length === 1
      && /scripted: this profile composes no settings service/.test(unavailableLogs[0]),
    JSON.stringify(unavailableLogs),
  );
  // The answer is process-wide and latched: a second open on the same child must
  // not repeat the line (that is what buries the log it exists to provide).
  const sessionC2 = `settings-c2-${Date.now()}`;
  const repeatStderr = await captureStderr(async () => {
    await open(sessionC2);
  });
  check(
    "…and a second unavailable open does not repeat the latched line",
    repeatStderr.filter((line) => /DSH settings are unavailable/.test(line)).length === 0,
    JSON.stringify(repeatStderr.filter((line) => /DSH settings are unavailable/.test(line))),
  );
  await conn.send({ type: "session.close", sessionId: sessionC2 });
  await until((event) => event.type === "session.closed" && event.sessionId === sessionC2, "session C2 closed");

  // ---- 4b. available but no qualifying row: no rows, and not "unavailable" --
  //
  // The bridge answers `{available:true, items:[]}` when the profile composes a
  // settings service but exposes no third-party single-boolean form. That must
  // publish no row while staying quiet about "unavailable": the two states have
  // different causes and different fixes, and conflating them buries the real
  // one under the wrong log line.
  writeSettings([]);
  const sessionC3 = `settings-c3-${Date.now()}`;
  const emptyStderr = await captureStderr(async () => {
    await open(sessionC3);
  });
  check(
    "an available settings service with no qualifying row opens with no DSH rows",
    dshRows(lastConfig(sessionC3)).length === 0,
    JSON.stringify(dshRows(lastConfig(sessionC3))),
  );
  check(
    "…and is not reported as unavailable (that line belongs to a profile with no settings service)",
    emptyStderr.every((line) => !/DSH settings are unavailable/.test(line)),
    JSON.stringify(emptyStderr.filter((line) => /DSH settings/.test(line))),
  );
  await conn.send({ type: "session.close", sessionId: sessionC3 });
  await until((event) => event.type === "session.closed" && event.sessionId === sessionC3, "session C3 closed");

  // ---- 5. a create-panel pick is deferred to the first prompt -------------
  //
  // Paseo's create panel puts the user's picks into the new agent's
  // `providerOptions`; the host hands them back as `config.providerOptions` on a fresh
  // open. Writing on open would be wrong (the draft menu refresh is itself an
  // open), so the value is parked until the first prompt.
  writeSettings([settingsItem({ field: { path: ["enabled"], value: false, revision: 7 } })]);
  const sessionD = `settings-d-${Date.now()}`;
  const setMarkD = setFrames().length;
  // The create panel publishes the select value, exactly like the daemon.
  const configD = await open(sessionD, { providerOptions: { "dsh:dsh-unrestricted:enabled": "on" } });
  check(
    "a fresh open carrying a dsh: pick does not write it yet",
    setFrames().length === setMarkD,
    `${String(setFrames().length - setMarkD)} set frame(s) during open`,
  );
  check(
    "…and the open's config shows the runtime value, not the parked pick",
    dshRows(configD)[0]?.value === "off",
    JSON.stringify(dshRows(configD)),
  );
  const markD = events.length;
  await prompt(sessionD, "prompt-pending-ok");
  await until(
    (event) => event.type === "session.config"
      && event.sessionId === sessionD
      && dshRows(event)[0]?.value === "on",
    "pending DSH setting applied before the first prompt",
    30000,
    markD,
  );
  check(
    "the parked pick is written before the first prompt with the displayed value as precondition",
    setFrames().length === setMarkD + 1
      && JSON.stringify(setFrames().at(-1).params) === JSON.stringify({
        ns: "dsh-unrestricted",
        path: ["enabled"],
        value: true,
        revision: 7,
        expectedValue: false,
      }),
    JSON.stringify(setFrames().map((frame) => frame.params)),
  );
  check(
    "…and the applied value is republished as the select value in session.config",
    dshRows(lastConfig(sessionD))[0]?.value === "on",
    JSON.stringify(dshRows(lastConfig(sessionD))),
  );
  const pendingWarnings = events
    .slice(markD)
    .filter((event) => event.type === "session.notice" && event.sessionId === sessionD);
  check(
    "a successful deferred write produces no warning",
    pendingWarnings.length === 0,
    JSON.stringify(pendingWarnings.map((event) => event.notice)),
  );

  // ---- 5a. a legacy boolean pick is still honoured ------------------------
  //
  // An agent saved while this row was a toggle can carry a boolean in its
  // create-panel pick. The parked value must be normalised, not dropped and not
  // passed through (`Boolean("off")` is true, and a string "on" to the bridge
  // would fail its boolean check).
  const sessionD2 = `settings-d2-${Date.now()}`;
  const setMarkD2 = setFrames().length;
  const configD2 = await open(sessionD2, { providerOptions: { "dsh:dsh-unrestricted:enabled": false } });
  check(
    "a fresh open carrying a legacy boolean pick parks it without writing",
    setFrames().length === setMarkD2 && dshRows(configD2)[0]?.value === "on",
    JSON.stringify({ frames: setFrames().length - setMarkD2, row: dshRows(configD2) }),
  );
  const markD2 = events.length;
  await prompt(sessionD2, "prompt-pending-legacy");
  await until(
    (event) => event.type === "session.config"
      && event.sessionId === sessionD2
      && dshRows(event)[0]?.value === "off",
    "legacy boolean pick applied before the first prompt",
    30000,
    markD2,
  );
  check(
    "a legacy boolean pick is normalised and written as a boolean",
    setFrames().length === setMarkD2 + 1
      && JSON.stringify(setFrames().at(-1).params) === JSON.stringify({
        ns: "dsh-unrestricted",
        path: ["enabled"],
        value: false,
        revision: 8,
        expectedValue: true,
      }),
    JSON.stringify(setFrames().map((frame) => frame.params)),
  );
  // Restore the scripted runtime value (true) for the failure/resume phases,
  // without a write frame: the settings file *is* the runtime in this harness.
  writeSettings([settingsItem({ field: { path: ["enabled"], value: true, revision: 12 } })]);

  // ---- 5b. a native subagent session cannot use this channel --------------
  //
  // The composer's DSH rows belong to root sessions; a child view is read-only
  // and must never publish (or accept) one.
  // The child notice is emitted by the bridge asynchronously after the prompt
  // reply; give the frame a moment to land before asserting on the tree.
  await sleep(500);
  const childOpened = [...events].reverse().find(
    (event) => event.type === "session.opened" && /:sub:child-A$/.test(String(event.sessionId)),
  );
  check(
    "a native subagent session is announced (so the read-only path is reachable)",
    childOpened !== undefined,
    JSON.stringify(events.filter((event) => event.type === "session.opened").map((event) => event.sessionId)),
  );
  if (childOpened !== undefined) {
    const childId = childOpened.sessionId;
    const childMark = events.length;
    await conn.send({
      type: "session.configure",
      requestId: "configure-child-settings",
      sessionId: childId,
      changes: { providerOptions: { "dsh:dsh-unrestricted:enabled": true } },
    });
    const childRefused = await until(
      (event) => event.type === "request.failed" && event.requestId === "configure-child-settings",
      "child session configure refused",
      30000,
      childMark,
    );
    check(
      "a child session cannot configure DSH switches (the channel belongs to the root)",
      childRefused !== undefined,
      JSON.stringify(childRefused?.error),
    );
    check(
      "…and no dsh: row is published for a child session",
      events.filter((event) => event.type === "session.config" && event.sessionId === childId).length === 0,
      JSON.stringify(events.filter((event) => event.type === "session.config" && event.sessionId === childId)),
    );
  }

  // ---- 6. a failed deferred write warns, but never blocks the prompt ------
  writeSettingsFailure({ code: "conflict", message: "scripted conflict" });
  const sessionE = `settings-e-${Date.now()}`;
  const markE = events.length;
  await open(sessionE, { providerOptions: { "dsh:dsh-unrestricted:enabled": "off" } });
  await prompt(sessionE, "prompt-pending-fail");
  const warningE = await until(
    (event) => event.type === "session.notice"
      && event.sessionId === sessionE
      && event.notice?.title === "DSH 全局开关未能写回",
    "pending write failure warning",
    30000,
    markE,
  );
  const warningEDescription = String(warningE.notice?.description ?? "");
  check(
    "a failed deferred write produces a timeline warning naming the switch",
    warningE.notice?.severity === "warning"
      && /破限模式/.test(warningEDescription)
      && /创建会话时选择的 DSH 全局开关未能写回/.test(warningEDescription),
    JSON.stringify(warningE.notice),
  );
  check(
    "…and the prompt still went through (the turn was accepted)",
    events.slice(markE).some(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "prompt-pending-fail",
    ),
    JSON.stringify(events.slice(markE).filter((event) => event.type === "session.prompt_result").length),
  );
  check(
    "…and the runtime value is still the committed one",
    dshRows(lastConfig(sessionE))[0]?.value === "on",
    JSON.stringify(dshRows(lastConfig(sessionE))),
  );
  writeSettingsFailure(undefined);

  // ---- 6b. every English error text is fully English in an English process --
  //
  // The check process itself is zh-CN; the copy is resolved once at module load,
  // so the English sentences a real English UI receives can only be observed
  // from a child process with the locale flipped. That child runs the same
  // compiled plugin + fake bridge and asserts four user-visible strings carry
  // no CJK text or punctuation: the select row's option labels, the
  // deferred-write warning, the unexpected-value configure error, and the
  // bridge-refused configure error.
  const enChild = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, DSH_PASEO_LANG: "en", SETTINGS_CHECK_EN_WARNING: "1" },
    encoding: "utf8",
    timeout: 180000,
  });
  const enChildResults = String(enChild.stdout ?? "")
    .split("\n")
    .filter((line) => /^  (PASS|FAIL)  /.test(line));
  const enChildFailures = enChildResults.filter((line) => line.startsWith("  FAIL"));
  check(
    "the select labels, pending warning and both configure errors are fully English under DSH_PASEO_LANG=en",
    enChild.status === 0 && enChildResults.length === 4 && enChildFailures.length === 0,
    enChild.status === 0
      ? enChildResults.join(" | ").trim()
      : `child exit ${String(enChild.status)}: `
        + `${String(enChildFailures.length > 0 ? enChildFailures.join(" | ") : String(enChild.stderr ?? "").slice(-600)).trim()}`,
  );

  // ---- 7. a session that is never prompted writes nothing (draft path) ----
  const sessionF = `settings-f-${Date.now()}`;
  const setMarkF = setFrames().length;
  await open(sessionF, { providerOptions: { "dsh:dsh-unrestricted:enabled": "off" } });
  await conn.send({ type: "session.close", sessionId: sessionF });
  await until((event) => event.type === "session.closed" && event.sessionId === sessionF, "session F closed");
  await sleep(150);
  check(
    "closing a draft session without prompting writes nothing",
    setFrames().length === setMarkF,
    `${String(setFrames().length - setMarkF)} set frame(s) after a never-prompted open`,
  );

  // ---- 8. a resumed session never writes its stored value ----------------
  //
  // Paseo persists the last value it saw per agent and re-sends it on resume.
  // The runtime value wins silently: no write, no timeline notice (a warning on
  // every reopen is noise), one daemon-stderr line for diagnosis.
  const sessionG = `settings-g-${Date.now()}`;
  const resumeId = `settings-resume-${Date.now()}`;
  const setMarkG = setFrames().length;
  const markG = events.length;
  const stderrLines = await captureStderr(async () => {
    await open(sessionG, {
      providerOptions: { "dsh:dsh-unrestricted:enabled": false }, // runtime is true
      persistence: { version: 1, data: { sessionId: resumeId } },
    });
  });
  await sleep(200);
  check(
    "a resumed session does not write Paseo's stale per-agent value",
    setFrames().length === setMarkG,
    `${String(setFrames().length - setMarkG)} set frame(s) during resume`,
  );
  check(
    "…and shows the runtime value",
    dshRows(lastConfig(sessionG))[0]?.value === "on",
    JSON.stringify(dshRows(lastConfig(sessionG))),
  );
  check(
    "…with no timeline notice (the divergence is logged to stderr instead)",
    events.slice(markG).every(
      (event) => !(event.type === "session.notice" && event.sessionId === sessionG),
    ),
    JSON.stringify(events.slice(markG).filter((event) => event.type === "session.notice").map((event) => event.notice)),
  );
  const staleLog = stderrLines.filter((line) => /dsh:dsh-unrestricted:enabled/.test(line));
  check(
    "…and one daemon-stderr line names the stale value and the runtime value",
    staleLog.length === 1 && /stored false, runtime true/.test(staleLog[0]),
    JSON.stringify(staleLog),
  );
  // The same comparison must normalise the select value: a stored `"on"` against
  // a runtime `true` is not a divergence, and printing it as one would put a
  // false line on every reopen.
  const sessionH = `settings-h-${Date.now()}`;
  const matchingStderr = await captureStderr(async () => {
    await open(sessionH, {
      providerOptions: { "dsh:dsh-unrestricted:enabled": "on" }, // runtime is true
      persistence: { version: 1, data: { sessionId: `settings-resume-${Date.now()}` } },
    });
  });
  check(
    "a resumed session whose stored select value matches the runtime logs no divergence",
    matchingStderr.filter((line) => /dsh:dsh-unrestricted:enabled/.test(line)).length === 0,
    JSON.stringify(matchingStderr),
  );

  // ---- 9. label resolution: both languages, fallbacks --------------------
  const item = {
    ns: "unrestricted",
    moduleName: "dsh-unrestricted",
    title: { en: "Unrestricted mode", zh: "破限模式" },
    field: { path: ["enabled"], value: false, revision: 1 },
  };
  check(
    "dshSettingId is stable and recomputable from the item",
    dshSettingId(item) === "dsh:unrestricted:enabled"
      && dshSettingId({ ns: "ns", field: { path: ["a", "b"] } }) === "dsh:ns:a.b",
    JSON.stringify([dshSettingId(item), dshSettingId({ ns: "ns", field: { path: ["a", "b"] } })]),
  );
  check(
    "dshSettingLabel picks zh for zh-CN, en for en, then falls back to the module name",
    dshSettingLabel(item) === "破限模式"
      && dshSettingLabel({ ...item, title: { en: "Unrestricted mode" } }) === "Unrestricted mode"
      && dshSettingLabel({ ...item, title: { zh: "破限模式" } }) === "破限模式"
      && dshSettingLabel({ ...item, title: undefined }) === "dsh-unrestricted"
      && dshSettingLabel({ ...item, title: {}, moduleName: "" }) === "unrestricted",
    JSON.stringify([
      dshSettingLabel(item),
      dshSettingLabel({ ...item, title: { en: "Unrestricted mode" } }),
      dshSettingLabel({ ...item, title: undefined }),
    ]),
  );

  check(
    "dshSettingSelectValue projects the boolean state to the composer's select value",
    dshSettingSelectValue(true) === "on"
      && dshSettingSelectValue(false) === "off",
    JSON.stringify([dshSettingSelectValue(true), dshSettingSelectValue(false)]),
  );
  check(
    "dshSettingBooleanValue accepts on/off and the legacy boolean, rejects everything else",
    dshSettingBooleanValue("on") === true
      && dshSettingBooleanValue("off") === false
      && dshSettingBooleanValue(true) === true
      && dshSettingBooleanValue(false) === false
      && dshSettingBooleanValue("yes") === undefined
      && dshSettingBooleanValue(1) === undefined
      && dshSettingBooleanValue(undefined) === undefined
      && dshSettingBooleanValue(null) === undefined,
    JSON.stringify([
      dshSettingBooleanValue("on"),
      dshSettingBooleanValue("off"),
      dshSettingBooleanValue("yes"),
      dshSettingBooleanValue(1),
    ]),
  );
  check(
    "dshSettingOptionLabel is the plain on/off word, not the switch's name plus a word",
    dshSettingOptionLabel(true) === "开启"
      && dshSettingOptionLabel(false) === "关闭",
    JSON.stringify([dshSettingOptionLabel(true), dshSettingOptionLabel(false)]),
  );

  check(
    "dshSettingFailureCopy keeps the bridge's technical message for an unexpected failure",
    /开关写入失败/.test(dshSettingFailureCopy("failed", "schema refused the write"))
      && /schema refused the write/.test(dshSettingFailureCopy("failed", "schema refused the write"))
      && /开关写入失败/.test(dshSettingFailureCopy("some-new-code", "detail")),
    JSON.stringify([
      dshSettingFailureCopy("failed", "schema refused the write"),
      dshSettingFailureCopy("some-new-code", "detail"),
    ]),
  );

  // ---- 9b. the server-side copy tables carry both languages ---------------
  //
  // The composer's switch description, on/off wording and the per-code failure
  // copy live in
  // `server/locale.ts` (the client's `locale-check` only reads the client
  // tables), so both languages are asserted here: every key non-empty, the
  // global wording present, and the Chinese/English columns genuinely different
  // (a copied English column is indistinguishable from a translated one).
  const { execFileSync } = require("node:child_process");
  const localeModule = path.join(path.dirname(compiled), "server", "locale.js");
  const readToggleCopy = (language) => {
    // `unexpectedValue` is a formatter, and JSON drops functions; render it with
    // a probe id so the copy itself crosses the process boundary as a string.
    const script =
      `process.env.DSH_PASEO_LANG = ${JSON.stringify(language)};`
      + `const { UI } = require(${JSON.stringify(localeModule)});`
      + "const copy = UI.settings.dshToggle;"
      + "process.stdout.write(JSON.stringify({"
      + "  ...copy,"
      + "  unexpectedValue: copy.unexpectedValue('dsh:probe:path'),"
      + "}));";
    return JSON.parse(
      execFileSync(process.execPath, ["-e", script], {
        env: { ...process.env, DSH_PASEO_LANG: language },
      }).toString(),
    );
  };
  const toggleCopyZh = readToggleCopy("zh-CN");
  const toggleCopyEn = readToggleCopy("en");
  const errorCodes = ["conflict", "not_found", "settings_unavailable", "failed"];
  check(
    "the switch description says the value is global in both languages",
    /全局生效/.test(toggleCopyZh.description) && /影响本机所有 DSH 会话/.test(toggleCopyZh.description)
      && /global/i.test(toggleCopyEn.description) && /every DSH session/i.test(toggleCopyEn.description),
    JSON.stringify({ zh: toggleCopyZh.description, en: toggleCopyEn.description }),
  );
  check(
    "every failure code has non-empty, distinct Chinese and English copy",
    errorCodes.every((code) =>
      typeof toggleCopyZh.errors[code] === "string" && toggleCopyZh.errors[code].trim() !== ""
      && typeof toggleCopyEn.errors[code] === "string" && toggleCopyEn.errors[code].trim() !== ""
      && toggleCopyZh.errors[code] !== toggleCopyEn.errors[code]),
    JSON.stringify({ zh: toggleCopyZh.errors, en: toggleCopyEn.errors }),
  );
  check(
    "the deferred-write warning title exists in both languages",
    toggleCopyZh.pendingFailedTitle.trim() !== ""
      && toggleCopyEn.pendingFailedTitle.trim() !== ""
      && toggleCopyZh.pendingFailedTitle !== toggleCopyEn.pendingFailedTitle,
    JSON.stringify([toggleCopyZh.pendingFailedTitle, toggleCopyEn.pendingFailedTitle]),
  );
  check(
    "the on/off option wording exists in both languages (the select needs words, not just a boolean)",
    toggleCopyZh.on === "开启"
      && toggleCopyZh.off === "关闭"
      && toggleCopyEn.on === "On"
      && toggleCopyEn.off === "Off",
    JSON.stringify({ zh: [toggleCopyZh.on, toggleCopyZh.off], en: [toggleCopyEn.on, toggleCopyEn.off] }),
  );
  check(
    "the unexpected-value error copy names the two legal values in both languages",
    /非预期值/.test(toggleCopyZh.unexpectedValue)
      && /开启\/关闭/.test(toggleCopyZh.unexpectedValue)
      && /dsh:probe:path/.test(toggleCopyZh.unexpectedValue)
      && /unexpected value/.test(toggleCopyEn.unexpectedValue)
      && /On\/Off/.test(toggleCopyEn.unexpectedValue)
      && /dsh:probe:path/.test(toggleCopyEn.unexpectedValue),
    JSON.stringify({ zh: toggleCopyZh.unexpectedValue, en: toggleCopyEn.unexpectedValue }),
  );

  // ---- 10. the production filter (pure functions, same code as the bridge) -
  const discovery = await import(
    pathToFileURL(path.join(repoRoot, "dsh-bridge", "lib", "settings-discovery.js")).href
  );
  const booleanForm = { type: "object", dict: { enabled: { type: "boolean" } } };
  const descriptors = [
    { ns: "third", schema: booleanForm, value: { enabled: true }, revision: 1 },
    { ns: "official", schema: booleanForm, value: { enabled: true }, revision: 1 },
    { ns: "two", schema: { type: "object", dict: { a: { type: "boolean" }, b: { type: "boolean" } } }, value: { a: true, b: false }, revision: 1 },
    { ns: "string", schema: { type: "object", dict: { a: { type: "string" } } }, value: { a: "x" }, revision: 1 },
    { ns: "dict", schema: { type: "object", dict: { a: { type: "dict" } } }, value: { a: {} }, revision: 1 },
    { ns: "missing", schema: booleanForm, value: {}, revision: 1 },
  ];
  const moduleNames = { third: "dsh-unrestricted", official: "@deepseek-ai/dsh-web", two: "x-two", string: "x-string", dict: "x-dict", missing: "x-missing" };
  const select = (rows) => discovery.simpleToggleItems({
    descriptors: rows,
    moduleNameOf: (ns) => moduleNames[ns],
    titleOf: () => undefined,
  });
  const selected = select(descriptors);
  check(
    "the production filter selects only the third-party single-boolean form",
    JSON.stringify(selected.map((item) => item.ns)) === JSON.stringify(["third"]),
    JSON.stringify(selected.map((item) => item.ns)),
  );
  check(
    "the selected item keeps the field path, value and revision",
    JSON.stringify(selected[0]?.field) === JSON.stringify({ path: ["enabled"], value: true, revision: 1 }),
    JSON.stringify(selected[0]?.field),
  );

  // The P0 regression fixture: the REAL wire shape is schemastery's reference
  // document. This check imports the same schemastery the bridge rehydrates
  // with (when this machine has a DSH install) and pins both halves: the raw
  // document selects nothing, the rehydrated live node selects the toggle. If
  // the bridge ever stops rehydrating, the menu silently empties again — this is
  // the assertion that would notice.
  let Schema;
  try {
    const dshRoot = process.env.DSH_INSTALL_DIR
      ?? path.join(os.homedir(), ".npm-global", "lib", "node_modules", "@deepseek-ai", "dsh");
    Schema = createRequire(path.join(dshRoot, "package.json"))("@deepseek-ai/schemastery");
  } catch {
    Schema = undefined;
  }
  if (Schema === undefined) {
    console.log("  SKIP  real wire-schema fixture (no DSH install on this machine; set DSH_INSTALL_DIR)");
  } else {
    const wire = Schema.object({ enabled: Schema.boolean().default(false) }).toJSON();
    const wireRow = { ns: "third", schema: wire, value: { enabled: true }, revision: 1 };
    check(
      "the raw schemastery wire document ({uid,refs}) selects nothing (rehydration is the bridge's job)",
      select([wireRow]).length === 0,
      JSON.stringify(select([wireRow])),
    );
    check(
      "the same wire document rehydrated with new Schema() selects the toggle",
      JSON.stringify(select([{ ...wireRow, schema: new Schema(wire) }]).map((item) => item.ns))
        === JSON.stringify(["third"]),
      JSON.stringify(select([{ ...wireRow, schema: new Schema(wire) }]).map((item) => item.ns)),
    );
  }

  const failed = results.filter((result) => !result.pass);
  console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`);
  if (failed.length > 0) {
    console.error(`\n${String(failed.length)} FAILED:`);
    for (const result of failed) console.error(`  - ${result.name}`);
    process.exitCode = 1;
  }
  await conn.close();
})().catch(async (error) => {
  console.error(`\nsettings pass-through check failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
  // Close the connection on the failure path too: the plugin owns a live fake
  // `dsh` child, and leaving it attached makes a failed run hang until the
  // caller's timeout instead of exiting with the assertion failure.
  try {
    await conn?.close();
  } catch {
    /* the failure being reported is the real one */
  }
});
