/**
 * Plugin-level check: drive the Paseo plugin directly and assert on the events
 * it emits, with no Paseo daemon involved.
 *
 * `harness/probe.mjs` talks to the bridge underneath; this talks to the plugin
 * above it. The plugin is the layer that owns capabilities and event shapes, so
 * this is where a regression in "declared capability vs actual behaviour" shows
 * up — the class of bug that is invisible in the UI because nothing errors.
 *
 * It covers four things that were each once silently wrong:
 *   1. `session.usage` is emitted with real token numbers and a turn id
 *   2. a non-text content block reaches DSH instead of being collapsed away
 *   3. an unsupported input type reports `request.failed`, not `request.completed`
 *   4. a real third-party DSH boolean switch round-trips through the bridge's
 *      `paseo/settings/list|set` into `session.config` (the offline bridge check
 *      fakes the settings service; this is the only check that proves the real
 *      profile composes one)
 *
 * Profile isolation: `ensurePaseoProfile()` rewrites the profile's embedded
 * bridge whenever this script loads the plugin. The script therefore clones the
 * profile named by DSH_PASEO_PROFILE (default `paseo`) into a throwaway DSH_HOME
 * by default, so the live `~/.dsh` is never written. Pass `--allow-real-profile`
 * to use the live home instead; an explicit `DSH_HOME=<dir>` is used as-is. The
 * first output line names the mode.
 *
 * The DSH settings pass-through segment (0d) checks the real profile's settings
 * service. What counts as an expected toggle is **opt-in**, because this
 * repository is used by other people and a check must not assume a particular
 * third-party plugin is installed: set `PASEO_EXPECT_DSH_TOGGLE=<ns>[,<ns>]`
 * (settings namespaces, e.g. `unrestricted`) and every named namespace must
 * appear in the bridge's list — a missing one fails the check. Leave it unset
 * and the segment exercises a qualifying toggle when the profile happens to
 * expose one, printing the reason when it skips.
 *
 * The plugin is TypeScript, so it has to be compiled before it can be required:
 *
 *   cd paseo-plugin
 *   npx tsc --noEmit false --outDir .dbg --declaration false \
 *     --module commonjs --moduleResolution node
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/plugin-check.cjs .dbg/
 *   cd .dbg && node plugin-check.cjs
 *   rm -rf ../.dbg          # afterwards
 *
 * The type errors tsc prints under `--moduleResolution node` are expected; the
 * emitted JavaScript is what runs.
 *
 * `--self-test` runs only the offline half (compiled module loads + the
 * image-block translation the real-model checks below assert on), so the
 * translation can be pinned without a profile or a model turn.
 */
const path = require("node:path");
const { announceDshHome, prepareDshHome } = require(path.join(__dirname, "..", "..", "harness", "isolated-dsh-home.cjs"));
const gates = require(path.join(__dirname, "..", "..", "harness", "harness-gates.cjs"));

if (process.argv.includes("--self-test")) {
  const failures = [];
  const selfCheck = (name, pass, detail) => {
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  — ${detail}`}`);
    if (!pass) failures.push(name);
  };
  const pluginModule = require("./index.server.js");
  const { toDshContent: translate } = require("./server/session.js");
  selfCheck("compiled plugin module loads", typeof pluginModule?.default === "function");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const imageBlock = translate({ type: "image", data: png, mimeType: "image/png" });
  selfCheck(
    "image content translates to a DSH image block",
    imageBlock?.type === "image" && imageBlock.data === png && imageBlock.mimeType === "image/png",
    JSON.stringify(imageBlock),
  );
  selfCheck(
    "the structural predicate accepts the translated image block",
    gates.contentBlocksIncludeImage([imageBlock], png, "image/png"),
  );
  selfCheck(
    "a text placeholder never satisfies the structural predicate",
    gates.contentBlocksIncludeImage([translate({ type: "text", text: "IMAGE-SEEN" })], png, "image/png") === false,
  );
  const failed = failures.length;
  console.log(`\n  ${failed === 0 ? "self-test passed" : `${failed} self-test failure(s)`}`);
  process.exit(failed === 0 ? 0 : 1);
}

let runMode;
try {
  runMode = prepareDshHome({ script: "plugin-check", profile: process.env.DSH_PASEO_PROFILE ?? "paseo" });
} catch (error) {
  console.error(`plugin-check: ${error.message}`);
  process.exit(2);
}
announceDshHome(runMode);

const plugin = require("./index.server.js").default;
const { DshProcess } = require("./server/dsh-process.js");
const { toDshContent } = require("./server/session.js");
// Same module the plugin resolves its copy from, so the option labels are
// compared against this run's actual locale instead of a hardcoded language.
const { UI: SERVER_UI } = require("./server/locale.js");

// Record the prompt frames the plugin hands to its DSH process. This is the
// protocol boundary the "non-text block reached DSH" check asserts on: a
// placeholder the model was told to repeat can never satisfy it, and a text
// label produced by collapsing the block is visible as a missing image block.
const promptFrames = [];
const originalPrompt = DshProcess.prototype.prompt;
DshProcess.prototype.prompt = async function prompt(sessionId, text, contentBlocks, delivery) {
  promptFrames.push({
    sessionId,
    text,
    contentBlocks: contentBlocks === undefined ? undefined : JSON.parse(JSON.stringify(contentBlocks)),
  });
  return originalPrompt.call(this, sessionId, text, contentBlocks, delivery);
};

// Record the `paseo/settings/list` receipts the plugin reads while opening a
// session, and keep the process they came from. The DSH settings pass-through
// check below needs to talk to the bridge directly (it is the only way to prove
// the real profile composes a settings service, not just that the composer has
// no rows); `DshProcess` is the public seam the provider itself uses.
const settingsReads = [];
const originalSettingsList = DshProcess.prototype.settingsList;
DshProcess.prototype.settingsList = async function settingsList() {
  const result = await originalSettingsList.call(this);
  settingsReads.push({ process: this, result });
  return result;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
let registration;

plugin({
  handle() {},
  registerProvider(r) {
    registration = r;
  },
  registerSettings() {},
  on() {},
  before() {},
});

async function until(predicate, label, ms = 120000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = events.find(predicate);
    if (hit) return hit;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Like `until`, but ignores events recorded before `start` (stale matches). */
async function untilSince(start, predicate, label, ms = 120000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = events.slice(start).find(predicate);
    if (hit) return hit;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Like `untilSince`, but returns undefined instead of throwing on timeout. */
async function maybeSince(start, predicate, ms = 30000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = events.slice(start).find(predicate);
    if (hit) return hit;
    await sleep(120);
  }
  return undefined;
}

/**
 * One composer option row of a `session.config`, read the Paseo 0.16 way.
 *
 * The state names the keys that get a control in `controls` and carries their
 * committed values in `providerOptions`; the deprecated `settings` array this
 * check used to read is no longer reported (reporting both would be a second,
 * unread vocabulary — the host stops sending changes under that name the moment
 * the new pair appears). Each row is flattened to the shape the assertions
 * read: `id` from `key`, `value` from `providerOptions[key]`, `options` from
 * `choices`.
 *
 * @param configEvent - one `session.config` event.
 * @param key - the option key, e.g. `preset` or `dsh:<ns>:<path>`.
 * @returns the row, or undefined when this state has no control for the key.
 */
function optionRow(configEvent, key) {
  const control = (configEvent?.config?.controls ?? []).find((candidate) => candidate.key === key);
  if (control === undefined) return undefined;
  return {
    ...control,
    id: control.key,
    value: configEvent.config.providerOptions?.[key],
    options: control.choices,
  };
}

/** The first `session.config` that carries a control for `key`, across all events. */
function firstOptionRow(key) {
  for (const event of events) {
    if (event.type !== "session.config") continue;
    const row = optionRow(event, key);
    if (row !== undefined) return row;
  }
  return undefined;
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

(async () => {
  // Offer every capability the plugin could support. `prompt.image` is asserted
  // below: it is the switch that lets Paseo send an attached picture at all, and
  // a missing one fails the send outright rather than degrading.
  const conn = await registration.connect({
    capabilities: [
      "prompt.message",
      "prompt.image",
      "prompt.command",
      "prompt.steer",
      "session.configure",
      "session.persistence",
      "session.list",
      "permission",
    ],
  });
  conn.onEvent((event) => events.push(event));

  check(
    "provider declares prompt.image",
    Array.isArray(conn.capabilities) && conn.capabilities.includes("prompt.image"),
    `capabilities=[${(conn.capabilities ?? []).join(", ")}]`,
  );
  check(
    "provider declares prompt.command",
    Array.isArray(conn.capabilities) && conn.capabilities.includes("prompt.command"),
    `capabilities=[${(conn.capabilities ?? []).join(", ")}]`,
  );
  check(
    "provider declares session.persistence (reload recovery)",
    Array.isArray(conn.capabilities) && conn.capabilities.includes("session.persistence"),
    `capabilities=[${(conn.capabilities ?? []).join(", ")}]`,
  );

  // The catalog must list models even though the probe skips `initialize`:
  // DSH 0.2.1 materializes model catalogs asynchronously, so a bare read used
  // to return zero and Paseo's model picker was empty.
  await conn.send({ type: "catalog", requestId: "cat-early" });
  const catalogEvent = await until((e) => e.type === "catalog" && e.requestId === "cat-early", "catalog");
  check(
    "catalog lists models without initialize (0.2.1 readiness)",
    Array.isArray(catalogEvent.catalog?.models) && catalogEvent.catalog.models.length > 0,
    `${catalogEvent.catalog?.models?.length ?? 0} model(s)`,
  );

  await conn.send({
    type: "session.open",
    sessionId: `check-${Date.now()}`,
    config: { cwd: process.cwd(), mode: "build" },
  });
  const ready = await until((e) => e.type === "session.ready", "session.ready");
  const sessionId = ready.sessionId;
  console.log(`  session ready: ${sessionId}\n`);

  // 0. `session.opened` must carry a persistence handle, or Paseo stores a raw
  // session id its decoder rejects on reopen ("Invalid plugin provider
  // persistence handle"), leaving a reload-orphaned session unrecoverable.
  const opened = events.find((e) => e.type === "session.opened");
  check(
    "session.opened carries a persistence handle",
    opened !== undefined && typeof opened.persistence?.version === "number",
    opened?.persistence ? JSON.stringify(opened.persistence).slice(0, 120) : "(no persistence on session.opened)",
  );

  // 0. the slash menu: DSH's registered commands and user-invocable skills.
  const commandEvent = await until((e) => e.type === "session.commands", "session.commands");
  const advertised = Array.isArray(commandEvent.commands) ? commandEvent.commands : [];
  check(
    "→ slash menu advertised",
    advertised.length > 0,
    advertised.length > 0
      ? `${advertised.length} entries, e.g. ${advertised.slice(0, 5).map((c) => `/${c.name}`).join(", ")}`
      : "(empty command list)",
  );

  // 0b. the agent-preset select is advertised when the profile declares presets.
  const presetSetting = firstOptionRow("preset");
  if (presetSetting !== undefined) {
    check(
      "→ preset setting advertised",
      (presetSetting.options ?? []).length > 0,
      `options=[${(presetSetting.options ?? []).map((o) => o.value).join(", ")}]`,
    );
  } else {
    console.log("  (no agent-preset registry in this profile — preset select not expected)");
  }

  // 0c. the permission setting is advertised and switching it moves the DSH preset.
  const permissionSetting = firstOptionRow("permission");
  const permissionOptions = permissionSetting?.options ?? [];
  check(
    "→ permission setting advertised",
    permissionSetting !== undefined &&
      permissionOptions.some((o) => o.value === "danger-full-access"),
    permissionSetting
      ? `options=[${permissionOptions.map((o) => `${o.label}=${o.value}`).join(", ")}]`
      : "(no permission setting)",
  );
  // The bridge must forward DSH's per-preset display name, not just the table
  // key: a deployment that renames its presets — including into another
  // language — would otherwise be shown raw keys, and nothing would fail. Every
  // option therefore carries a non-empty `label` beside its switchable `value`.
  check(
    "→ permission options carry a display label beside the key",
    permissionOptions.length > 0 &&
      permissionOptions.every(
        (o) =>
          typeof o.label === "string" && o.label !== "" &&
          typeof o.value === "string" && o.value !== "",
      ),
    permissionOptions.length > 0
      ? permissionOptions.map((o) => `${o.label}=${o.value}`).join(", ")
      : "(no options)",
  );
  await conn.send({
    type: "session.configure",
    sessionId,
    requestId: "cfg-permission",
    changes: { providerOptions: { permission: "danger-full-access" } },
  });
  const permissionApplied = await until(
    (e) =>
      e.type === "session.config" &&
      optionRow(e, "permission")?.value === "danger-full-access",
    "permission applied",
  );
  check("permission setting switches the preset", permissionApplied !== undefined, "value=danger-full-access");

  // 0d. DSH settings pass-through against the REAL profile.
  //
  // The offline bridge check (`harness/settings-bridge-check.mjs`) uses a fake
  // settings service; this is the only check that proves the profile actually
  // composes one, that a real third-party volatile boolean projects to a
  // two-option `select` (on/off, so the desktop toolbar has text and state), and
  // that a switch round-trips through `settings.mutate` into `session.config`
  // for every open conversation. The composer sends the select value; the
  // bridge still receives a boolean. It writes only inside the isolated DSH_HOME
  // clone (prepareDshHome), never the live profile.
  const settingsProcess = settingsReads.at(-1)?.process;
  const settingsReceipt = settingsProcess === undefined
    ? undefined
    : await settingsProcess.settingsList();
  check(
    "→ DSH settings service is available on a real profile",
    settingsReceipt?.available === true,
    JSON.stringify(settingsReceipt === undefined
      ? "no settings read was recorded during the open"
      : { available: settingsReceipt.available, reason: settingsReceipt.reason }),
  );
  // What counts as "expected" is the caller's choice, never a plugin name
  // hardcoded here: this repository is used by other people. When
  // `PASEO_EXPECT_DSH_TOGGLE` names one or more settings namespaces
  // (comma-separated, e.g. `unrestricted`), each must be in the bridge's list —
  // a missing row is the "silent empty menu" defect and fails the check. When
  // unset, a qualifying toggle is exercised if the profile happens to expose
  // one, and the reason for skipping is printed otherwise.
  const items = settingsReceipt?.available === true ? settingsReceipt.items ?? [] : [];
  const expectedToggles = (process.env.PASEO_EXPECT_DSH_TOGGLE ?? "")
    .split(",")
    .map((ns) => ns.trim())
    .filter((ns) => ns !== "");
  const firstToggle = items[0];
  const dshToggleId = firstToggle === undefined
    ? undefined
    : `dsh:${firstToggle.ns}:${firstToggle.field.path.join(".")}`;
  const toggleIn = (configEvent) => optionRow(configEvent, dshToggleId);
  if (settingsReceipt?.available !== true) {
    console.log("  (this profile composes no settings service — the DSH settings pass-through cannot be verified here)");
  } else {
    if (expectedToggles.length > 0) {
      const listed = new Set(items.map((item) => item.ns));
      const missing = expectedToggles.filter((ns) => !listed.has(ns));
      check(
        "→ paseo/settings/list exposes the toggles this run expects (PASEO_EXPECT_DSH_TOGGLE)",
        missing.length === 0,
        missing.length === 0
          ? `expected=[${expectedToggles.join(", ")}]`
          : `missing=[${missing.join(", ")}] listed=[${[...listed].join(", ")}]`,
      );
    }
    if (firstToggle === undefined) {
      console.log(
        "  (skip: this profile exposes no simple third-party DSH switch — "
          + "set PASEO_EXPECT_DSH_TOGGLE=<ns>[,<ns>] to make a missing row fail)",
      );
    } else {
      const originalValue = firstToggle.field.value;
      const targetValue = !originalValue;
      // The composer publishes `"on"`/`"off"` for this row (see
      // `session.ts`'s `dshSettingSelectValue`); the bridge still gets a boolean.
      const selectValue = (value) => (value ? "on" : "off");
      const toggleMark = events.length;
      await conn.send({
        type: "session.configure",
        sessionId,
        requestId: "cfg-dsh-toggle",
        changes: { providerOptions: { [dshToggleId]: selectValue(targetValue) } },
      });
      const toggleApplied = await untilSince(
        toggleMark,
        (e) => e.type === "session.config" && toggleIn(e)?.value === selectValue(targetValue),
        "DSH toggle applied",
      );
      const afterWrite = await settingsProcess.settingsList();
      const receiptToggle = afterWrite.items?.find(
        (item) => `dsh:${item.ns}:${item.field.path.join(".")}` === dshToggleId,
      );
      // The label must be the plugin's own name from its title dictionary (this
      // process's LOCALE picks one entry), not a module specifier invented here.
      // The option labels are the plain on/off words of the same locale (the
      // switch's name lives on the row's label; repeating it in every option was
      // user-visible duplication), so they are compared exactly.
      const appliedRow = toggleIn(toggleApplied);
      const appliedLabel = appliedRow?.label;
      const expectedOptionLabels = [SERVER_UI.settings.dshToggle.on, SERVER_UI.settings.dshToggle.off];
      const titleDict = firstToggle.title;
      const titleChoices = titleDict !== undefined && titleDict !== null && typeof titleDict === "object"
        ? Object.values(titleDict)
        : [firstToggle.moduleName];
      check(
        "→ a third-party DSH switch projects to an on/off select and is republished",
        toggleApplied !== undefined
          && appliedRow?.type === "select"
          && JSON.stringify((appliedRow?.options ?? []).map((option) => option.value))
            === JSON.stringify(["on", "off"])
          && JSON.stringify((appliedRow?.options ?? []).map((option) => option.label))
            === JSON.stringify(expectedOptionLabels)
          && receiptToggle?.field.value === targetValue
          && typeof appliedLabel === "string"
          && appliedLabel !== ""
          && titleChoices.includes(appliedLabel),
        JSON.stringify({
          id: dshToggleId,
          target: targetValue,
          receipt: receiptToggle?.field,
          label: appliedLabel,
          expectedOptionLabels,
          row: appliedRow,
        }),
      );

      // The value is global: a second open session must show the same state.
      const secondSessionId = `check-settings-${Date.now()}`;
      const secondMark = events.length;
      await conn.send({
        type: "session.open",
        requestId: "open-settings-second",
        sessionId: secondSessionId,
        config: { cwd: process.cwd(), mode: "build" },
      });
      const secondReady = await untilSince(
        secondMark,
        (e) => e.type === "session.ready" && e.sessionId === secondSessionId,
        "second session ready",
      );
      const secondConfig = [...events]
        .slice(secondMark)
        .reverse()
        .find((e) => e.type === "session.config" && e.sessionId === secondSessionId);
      check(
        "→ a second open session shows the same global value",
        secondReady !== undefined && toggleIn(secondConfig)?.value === selectValue(targetValue),
        JSON.stringify(toggleIn(secondConfig) ?? null),
      );
      await conn.send({ type: "session.close", sessionId: secondSessionId });
      await untilSince(secondMark, (e) => e.type === "session.closed" && e.sessionId === secondSessionId, "second session closed");

      // Write the value back so the isolated clone is left as it was found.
      const restoreMark = events.length;
      await conn.send({
        type: "session.configure",
        sessionId,
        requestId: "cfg-dsh-toggle-restore",
        changes: { providerOptions: { [dshToggleId]: selectValue(originalValue) } },
      });
      const restored = await untilSince(
        restoreMark,
        (e) => e.type === "session.config" && toggleIn(e)?.value === selectValue(originalValue),
        "DSH toggle restored",
      );
      const afterRestore = await settingsProcess.settingsList();
      const restoredToggle = afterRestore.items?.find(
        (item) => `dsh:${item.ns}:${item.field.path.join(".")}` === dshToggleId,
      );
      check(
        "→ the switch is written back to its original value (isolated clone left clean)",
        restored !== undefined && restoredToggle?.field.value === originalValue,
        JSON.stringify({ restored: toggleIn(restored)?.value, receipt: restoredToggle?.field }),
      );
    }
  }

  // 0c. a registered command executes in the runtime instead of being sent to the
  // model as literal text. `/goal` with no argument only reads state, so it is
  // safe to run here and must settle as `completed`, not `failed`.
  const commandMsgId = `cmd-${Date.now()}`;
  const beforeCommand = events.length;
  await conn.send({
    type: "session.prompt",
    sessionId,
    prompt: {
      clientMessageId: commandMsgId,
      // `ProviderPrompt` requires both fields; a prompt without them is not a
      // shape the daemon ever sends, and the plugin's turn id falls back to
      // `turn:${undefined}` when `clientMessageId` is missing.
      delivery: "auto",
      input: { type: "command", name: "goal", arguments: "" },
    },
  });
  const commandResult = await until(
    (e) => e.type === "session.prompt_result" && e.clientMessageId === commandMsgId,
    "command prompt_result",
  );
  check(
    "registered command runs in the runtime (no model turn)",
    commandResult.result?.type === "completed",
    JSON.stringify(commandResult.result),
  );

  // 0c-bis. and the answer must reach the timeline. DSH records the command's
  // lifecycle in the session log (`command/run` -> `command/done`), and a row
  // whose output was dropped looks exactly like a command that did nothing.
  const commandRow = await maybeSince(
    beforeCommand,
    (e) =>
      e.type === "timeline.item" &&
      e.item?.type === "tool_call" &&
      e.item?.name === "/goal" &&
      typeof e.item?.detail?.text === "string" &&
      e.item.detail.text.length > 0,
  );
  check(
    "a command's output lands in the timeline",
    commandRow !== undefined,
    `row=${JSON.stringify(commandRow?.item?.detail?.text ?? null).slice(0, 80)}`,
  );

  // 0d. the menu name *is* the command: Paseo's command contract carries one
  // name for both display and dispatch, so the catalog must advertise the name
  // DSH registered and the transcript must echo the line that actually ran. A
  // menu name DSH's ASCII-only slash parser cannot read would come back as
  // `unknown command`, so `completed` here is the assertion.
  const goalEntry = advertised.find((c) => c.name === "goal");
  if (goalEntry === undefined) {
    console.log("  (no goal command advertised — menu-name dispatch check skipped)");
  } else {
    const menuMsgId = `cmd-menu-${Date.now()}`;
    const beforeMenu = events.length;
    await conn.send({
      type: "session.prompt",
      sessionId,
      prompt: {
        clientMessageId: menuMsgId,
        delivery: "auto",
        input: { type: "command", name: goalEntry.name, arguments: "" },
      },
    });
    const menuResult = await untilSince(
      beforeMenu,
      (e) => e.type === "session.prompt_result" && e.clientMessageId === menuMsgId,
      "menu-name command prompt_result",
    );
    check(
      "the advertised menu name runs the registered command",
      menuResult.result?.type === "completed",
      `menu=/${goalEntry.name} -> ${JSON.stringify(menuResult.result)}`,
    );
    const menuEcho = events
      .slice(beforeMenu)
      .find(
        (e) =>
          e.type === "timeline.item" &&
          e.item?.type === "user_message" &&
          e.item?.clientMessageId === menuMsgId,
      );
    check(
      "the transcript echoes the line the runtime ran",
      menuEcho?.item?.text === "/goal",
      `echo=${JSON.stringify(menuEcho?.item?.text)}`,
    );
  }

  // A 1x1 PNG: tiny, valid, and unmistakably an image to anything downstream.
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  // `clientMessageId` is what the plugin turns into the turn id
  // (`turn:${clientMessageId}`), so the assertion below can name the exact id
  // the daemon would have bound. Both fields are required by `ProviderPrompt`.
  const imageMsgId = "check-image-1";
  const imageStart = events.length;
  await conn.send({
    type: "session.prompt",
    sessionId,
    prompt: {
      clientMessageId: imageMsgId,
      delivery: "auto",
      input: {
        type: "message",
        content: [
          { type: "text", text: "Describe what you can see in the attached image." },
          { type: "image", data: png, mimeType: "image/png" },
        ],
      },
    },
  });

  await until(
    (e) => e.type === "session.turn" && e.state === "completed" && e.turnId === `turn:${imageMsgId}`,
    "image turn completed",
  );
  await sleep(1500);

  // 1. usage
  const usage = events.filter((e) => e.type === "session.usage");
  const withNumbers = usage.filter(
    (e) => typeof e.usage?.inputTokens === "number" && typeof e.usage?.outputTokens === "number",
  );
  check(
    "session.usage emitted with real numbers",
    withNumbers.length > 0,
    withNumbers.length > 0
      ? `${withNumbers.length} event(s), e.g. ${JSON.stringify(withNumbers[0].usage)}`
      : `${usage.length} usage event(s) but none carried numbers`,
  );
  if (withNumbers[0]) {
    check(
      "usage carries the turn id the prompt opened",
      withNumbers[0].turnId === `turn:${imageMsgId}`,
      `turnId=${withNumbers[0].turnId} expected=turn:${imageMsgId}`,
    );
  }

  // 1b. context occupancy. The composer's window readout reads
  // `contextWindowUsedTokens`/`contextWindowMaxTokens` off the same usage record
  // DSH's own token meter feeds. A missing window is a silent regression — the
  // meter simply never appears — so assert the fields travel on `session.usage`
  // and that the occupancy is prompt-anchored rather than a running sum.
  const withContext = usage.filter(
    (e) =>
      typeof e.usage?.contextWindowMaxTokens === "number" &&
      typeof e.usage?.contextWindowUsedTokens === "number",
  );
  check(
    "session.usage carries context occupancy (window + used)",
    withContext.length > 0,
    withContext.length > 0
      ? JSON.stringify(withContext[withContext.length - 1].usage)
      : `${usage.length} usage event(s), none carried a context window`,
  );
  if (withContext.length > 0) {
    const latest = withContext[withContext.length - 1].usage;
    check(
      "context occupancy is bounded by the resolved window",
      latest.contextWindowMaxTokens > 0 &&
        latest.contextWindowUsedTokens >= 0 &&
        latest.contextWindowUsedTokens <= latest.contextWindowMaxTokens,
      `used=${latest.contextWindowUsedTokens} max=${latest.contextWindowMaxTokens}`,
    );
    check(
      "occupancy covers the prompt instead of summing the log",
      typeof latest.inputTokens !== "number" ||
        latest.contextWindowUsedTokens >= latest.inputTokens,
      `used=${latest.contextWindowUsedTokens} inputTokens=${latest.inputTokens}`,
    );
  }

  // 1c. streamed stats: the row under an answer reports first-token latency and
  // throughput measured from live frames, not from the finished step.
  const stats = events.slice(imageStart).filter(
    (e) => e.sessionId === sessionId && e.type === "timeline.item" && e.item?.type === "plugin" && e.item.kind === "dsh-stream-stats",
  );
  // A tool-only step can have durable token timing without any transient text
  // frame, so its stats legitimately omit firstTokenMs. Require an actual timed
  // row from this prompt instead of assuming the first step produced text.
  const timedStats = stats.find((e) => typeof e.item.data?.firstTokenMs === "number"
    && Number.isFinite(e.item.data.firstTokenMs) && e.item.data.firstTokenMs >= 0);
  check(
    "live frames produce a stream-stats row",
    timedStats !== undefined,
    timedStats ? JSON.stringify(timedStats.item.data) : "no timed dsh-stream-stats item from this prompt",
  );

  const lastStats = stats[stats.length - 1];
  check(
    "stats row carries route, tokens and context",
    lastStats !== undefined &&
      typeof lastStats.item.data?.provider === "string" &&
      typeof lastStats.item.data?.model === "string" &&
      typeof lastStats.item.data?.inputTokens === "number" &&
      typeof lastStats.item.data?.contextUsed === "number",
    lastStats === undefined ? "no stats row" : JSON.stringify(lastStats.item.data),
  );

  // 2. the image block reached the DSH boundary
  //
  // The old predicate matched `/image|…/i` in the model's answer after asking it
  // to reply with `IMAGE-SEEN`: the prompt supplied the very word the assertion
  // looked for, so zero image blocks could pass. The evidence is now structural —
  // the prompt frame the plugin hands to `DshProcess` must carry the exact image
  // bytes and media type, and the product's own translator must produce an image
  // block. Model output is no longer part of this check.
  console.log("\n  timeline:");
  for (const e of events.filter((x) => x.type === "timeline.item")) {
    const item = e.item;
    const body =
      item.text ?? (item.content ?? []).map((b) => b.text ?? `<${b.type}>`).join("") ?? "";
    console.log(`    [${item.type}] ${String(body).slice(0, 140).replace(/\n/g, " ")}`);
  }

  // 2a. live streaming must not fragment the answer. A step streams as several
  // same-id snapshots; Paseo folds them into one row only while they stay
  // adjacent and share a `messageId`. Reasoning, a tool row or stream stats
  // emitted between assistant snapshots would split the answer into two bubbles,
  // which is exactly the regression a "looks fine in the log" check misses. The
  // **complete** item sequence is folded — pre-filtering to assistant rows (the
  // old bug) deletes the interruption before the check can see it.
  const imageTurnItems = gates
    .timelineItemsWithTurns(events.filter((e) => e.sessionId === sessionId))
    .filter((item) => item.turnId === `turn:${imageMsgId}`);
  const { assistantIds, fragmented } = gates.assistantFragmentation(imageTurnItems);
  check(
    "live streaming does not fragment an assistant step across rows",
    assistantIds.length > 0 && fragmented.length === 0,
    assistantIds.length === 0
      ? "(no streamed assistant items)"
      : fragmented.length === 0
        ? `${assistantIds.length} step(s), each one row`
        : `fragmented: ${fragmented.join(", ")}`,
  );

  const translatedImage = toDshContent({ type: "image", data: png, mimeType: "image/png" });
  check(
    "image content translates to a DSH image block (not a collapsed text label)",
    translatedImage?.type === "image" &&
      translatedImage.data === png &&
      translatedImage.mimeType === "image/png",
    JSON.stringify({
      type: translatedImage?.type,
      dataLength: translatedImage?.data?.length,
      mimeType: translatedImage?.mimeType,
    }),
  );

  const imageFrames = gates.countPromptFramesWithImage(promptFrames, { data: png, mimeType: "image/png" });
  check(
    "the image block is present in the prompt frame handed to DSH",
    imageFrames > 0,
    `${imageFrames} matching prompt frame(s) of ${promptFrames.length} recorded`,
  );
  // Negative control: a payload that was never sent must not match. Without it a
  // recorder bug that marks every frame as carrying the image would pass.
  const differentBytes = `${png.slice(0, -4)}AAAA`;
  check(
    "control: a different image payload does not match the recorded frames",
    gates.countPromptFramesWithImage(promptFrames, { data: differentBytes, mimeType: "image/png" }) === 0,
    `${promptFrames.length} prompt frame(s) recorded`,
  );

  const failed = events.filter((e) => e.type === "request.failed" || e.type === "session.runtime_failed");
  check("turn produced no failure event", failed.length === 0, failed.length ? JSON.stringify(failed[0]).slice(0, 140) : "");

  // 2b. a mislabeled image is accepted from its bytes, not its declared type
  //
  // Paseo derives an upload's media type from its filename extension, so a JPEG
  // saved as `foo.png` arrives as `image/png` over JPEG bytes. DSH verifies the
  // declared type against the decoded bytes and refuses a mismatch, so the
  // bridge must read the type from the bytes it actually holds.
  const mark = events.length;
  // A 2x2 JPEG (FFD8FF...) deliberately declared as PNG.
  const jpegDeclaredPng =
    "/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIADEVf/2Q==";
  await conn.send({
    type: "session.prompt",
    sessionId,
    prompt: {
      clientMessageId: "check-mislabel-1",
      delivery: "auto",
      input: {
        type: "message",
        content: [
          { type: "text", text: "Reply with exactly: MISLABEL-OK" },
          { type: "image", data: jpegDeclaredPng, mimeType: "image/png" },
        ],
      },
    },
  });

  const mislabelStarted = Date.now();
  let mislabelTurnCompleted = false;
  // Slice from `mark`: a stale `turn completed` from the first prompt would
  // otherwise satisfy this wait the instant it starts.
  while (Date.now() - mislabelStarted < 150000) {
    if (events.slice(mark).some((e) => e.type === "session.turn" && e.state === "completed")) {
      mislabelTurnCompleted = true;
      break;
    }
    await sleep(200);
  }
  await sleep(1200);
  const mislabelFailed = events
    .slice(mark)
    .filter((e) => e.type === "request.failed" || e.type === "session.runtime_failed");
  check(
    "mislabeled image type is corrected from its bytes",
    mislabelTurnCompleted && mislabelFailed.length === 0,
    mislabelFailed.length
      ? mislabelFailed[0].error?.message
      : `turn completed=${mislabelTurnCompleted}`,
  );

  // 3. an unsupported input must fail loudly
  const bogusId = "req-unknown-type";
  await conn.send({ type: "definitely.not.a.real.input", requestId: bogusId });
  await sleep(1200);
  const bogusFailed = events.find((e) => e.type === "request.failed" && e.requestId === bogusId);
  const bogusCompleted = events.find((e) => e.type === "request.completed" && e.requestId === bogusId);
  check(
    "unsupported input -> request.failed naming the type",
    bogusFailed !== undefined && /unsupported/i.test(bogusFailed.error?.message ?? ""),
    bogusFailed ? bogusFailed.error.message : "(no request.failed)",
  );
  check("unsupported input did not report request.completed", bogusCompleted === undefined);

  // 4. session.list is advertised and the `sessions` input answers it.
  check(
    "provider declares session.list (import)",
    Array.isArray(conn.capabilities) && conn.capabilities.includes("session.list"),
    `capabilities=[${(conn.capabilities ?? []).join(", ")}]`,
  );
  await conn.send({ type: "sessions", requestId: "list-sessions", cwd: process.cwd() });
  const sessionsEvent = await until((e) => e.type === "sessions" && e.requestId === "list-sessions", "sessions list");
  check(
    "sessions input returns a list (import source)",
    Array.isArray(sessionsEvent.sessions),
    `${(sessionsEvent.sessions ?? []).length} session(s), first has persistence=${sessionsEvent.sessions?.[0]?.persistence !== undefined}`,
  );

  // 5. reopening with history:"replay" replays the conversation. Close first so
  // the native session has no live owner, exactly like a restart/import reopen.
  await conn.send({ type: "session.close", sessionId });
  await until((e) => e.type === "session.closed" && e.sessionId === sessionId, "session.closed");
  const replayMark = events.length;
  const replayStartWallClock = Date.now();
  await conn.send({
    type: "session.open",
    requestId: "reopen",
    sessionId,
    config: { cwd: process.cwd(), mode: "build" },
    persistence: { version: 1, data: { sessionId } },
    history: "replay",
  });
  await untilSince(replayMark, (e) => e.type === "session.ready" && e.sessionId === sessionId, "reopened ready");
  const replayed = events
    .slice(replayMark)
    .filter((e) => e.type === "timeline.item" && (e.item?.type === "user_message" || e.item?.type === "assistant_message"));
  check("reopen replays conversation history", replayed.length > 0, `${replayed.length} replayed item(s)`);

  // Paseo stamps replayed rows with their arrival time when the provider omits
  // `timestamp`, and the client derives each turn's "worked for" duration from
  // its rows' timestamps (last item minus the turn's user message). Without the
  // stored event times, every earlier turn's duration collapses to ~0 after a
  // reload/rewind reopen. The reopen itself is the clock: replayed rows must
  // carry timestamps from *before* it, and in the log's order.
  const replayStartedAt = replayStartWallClock;
  const replayedItems = events.slice(replayMark).filter((e) => e.type === "timeline.item");
  const replayedTimes = replayedItems.map((e) => (typeof e.timestamp === "string" ? Date.parse(e.timestamp) : Number.NaN));
  check(
    "every replayed row carries a stored event time",
    replayedItems.length > 0 && replayedTimes.every((time) => Number.isFinite(time)),
    `${replayedTimes.filter((time) => Number.isFinite(time)).length}/${replayedItems.length} stamped`,
  );
  check(
    "replayed event times predate the reopen (not the arrival clock)",
    replayedTimes.every((time) => time < replayStartedAt - 500),
    `replay at ${new Date(replayStartedAt).toISOString()}, newest row ${new Date(Math.max(...replayedTimes)).toISOString()}`,
  );
  check(
    "replayed event times keep the log order",
    replayedTimes.every((time, index) => index === 0 || time >= replayedTimes[index - 1]),
    `${replayedItems.length} row(s)`,
  );

  // 5b. A resumed session already carries DSH's stored context, so its
  // occupancy must appear without waiting for a new turn — otherwise the
  // readout stays blank on every reopen and after every daemon restart.
  const reopenedUsage = await maybeSince(
    replayMark,
    (e) => e.type === "session.usage" &&
      typeof e.usage?.contextWindowMaxTokens === "number" &&
      typeof e.usage?.contextWindowUsedTokens === "number" &&
      e.usage.contextWindowUsedTokens > 0,
  );
  check(
    "reopen restores occupancy without a new turn",
    reopenedUsage !== undefined,
    JSON.stringify(reopenedUsage?.usage ?? {}),
  );

  await conn.close();

  const failedCount = results.filter((r) => !r.pass).length;
  console.log(`\n  ${results.length - failedCount}/${results.length} passed`);
  process.exit(failedCount === 0 ? 0 : 1);
})().catch((error) => {
  console.error(`\n  threw: ${error.message}`);
  console.error("  event types seen:", [...new Set(events.map((e) => e.type))].join(", ") || "(none)");
  process.exit(1);
});
