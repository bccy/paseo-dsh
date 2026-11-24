/**
 * Offline assertions for Plan A timeline row status icons:
 * - Pure status mapping, pop-transition predicate, and badge geometry (`client/row-status-icon-data.ts`)
 * - Rasterized 48x48 PNG badge assets (`CHECK_BADGE_ICON`, `ERROR_BADGE_ICON`)
 * - Real compiled component execution (`client/row-status-icon.tsx`) across Web,
 *   Native (`Animated` start/stop cleanup), and minimal RN stub environments
 * - Source wiring in `client/tool-call.tsx` and `client/inline-thinking.tsx`
 *
 * Run via `node harness/offline-checks.cjs`, or standalone from a compiled build dir:
 *   cd paseo-plugin/.dbg-offline-checks && node row-status-icon-check.cjs
 */
"use strict";

const { existsSync, readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const Module = require("node:module");

let passed = 0;
let failed = 0;
function check(name, pass, detail) {
  if (pass) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function requireHarnessModule(name) {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, "harness", name);
    if (existsSync(candidate)) return require(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find harness/${name} above ${__dirname}`);
}

function findRepoFile(relative, levels = 5) {
  let dir = __dirname;
  for (let i = 0; i < levels; i += 1) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const { attributeOf, callArguments, codeOnly, elementsWithAttributes, functionBody, mentions } =
  requireHarnessModule("source-shape.cjs");

const dataPath = join(__dirname, "client", "row-status-icon-data.js");
const componentPath = join(__dirname, "client", "row-status-icon.js");
if (!existsSync(dataPath) || !existsSync(componentPath)) {
  console.error(`missing compiled client/row-status-icon*.js under ${__dirname}`);
  process.exit(1);
}

const {
  CHECK_BADGE_ICON,
  ERROR_BADGE_ICON,
  ROW_BADGE_POP_MS,
  ROW_ICON_PULSE_MS,
  ROW_ICON_SPIN_MS,
  cornerBadgeMetrics,
  resolveRowIconStatus,
  resolveThinkingIconStatus,
  shouldPopRowBadge,
} = require(dataPath);

console.log("pure status & geometry logic");
{
  check("running + active -> running", resolveRowIconStatus("running", true) === "running");
  check("stale running + !active -> idle (never spins forever)", resolveRowIconStatus("running", false) === "idle");
  check("completed + active -> completed (bare green check immediately)", resolveRowIconStatus("completed", true) === "completed");
  check("completed + !active -> completed", resolveRowIconStatus("completed", false) === "completed");
  check("failed + active -> failed", resolveRowIconStatus("failed", true) === "failed");
  check("failed + !active -> failed", resolveRowIconStatus("failed", false) === "failed");
  check("canceled + active -> idle", resolveRowIconStatus("canceled", true) === "idle");
  check("canceled + !active -> idle", resolveRowIconStatus("canceled", false) === "idle");
  check("unknown status -> idle", resolveRowIconStatus("queued", true) === "idle");

  check("thinking growing=true -> running", resolveThinkingIconStatus(true) === "running");
  check("thinking growing=false -> completed (thinking also gets bare green check)", resolveThinkingIconStatus(false) === "completed");

  check("pop only on running -> completed", shouldPopRowBadge("running", "completed") === true);
  check("pop only on running -> failed", shouldPopRowBadge("running", "failed") === true);
  check("no pop on completed -> completed", shouldPopRowBadge("completed", "completed") === false);
  check("no pop on failed -> failed", shouldPopRowBadge("failed", "failed") === false);
  check("no pop on idle -> completed", shouldPopRowBadge("idle", "completed") === false);
  check("no pop on running -> idle", shouldPopRowBadge("running", "idle") === false);
  check("no pop on running -> running", shouldPopRowBadge("running", "running") === false);

  const m16 = cornerBadgeMetrics(16);
  check(
    "16px metrics match Plan A geometry",
    m16.frame === 10 && m16.offset === -2 && m16.ring === 7 && m16.checkGlyph === 8.5 && m16.errorDisk === 8.5 && m16.errorGlyph === 6.5,
    JSON.stringify(m16),
  );
  const m14 = cornerBadgeMetrics(14);
  check(
    "14px compact metrics scale down cleanly",
    m14.frame === 9 && m14.offset === -1.5 && m14.ring === 6 && m14.checkGlyph === 7.5 && m14.errorDisk === 7.5 && m14.errorGlyph === 5.5,
    JSON.stringify(m14),
  );
  check(
    "motion durations are positive and bounded",
    ROW_ICON_SPIN_MS === 3600 && ROW_ICON_PULSE_MS === 1600 && ROW_BADGE_POP_MS === 260,
  );
}

console.log("rasterized PNG badge assets");
{
  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  for (const [label, uri] of [
    ["CHECK_BADGE_ICON", CHECK_BADGE_ICON],
    ["ERROR_BADGE_ICON", ERROR_BADGE_ICON],
  ]) {
    const prefix = "data:image/png;base64,";
    const okPrefix = typeof uri === "string" && uri.startsWith(prefix);
    const bytes = okPrefix ? Buffer.from(uri.slice(prefix.length), "base64") : Buffer.alloc(0);
    const sigOk = bytes.length >= 26 && bytes.subarray(0, 8).equals(PNG_SIG);
    const w = sigOk ? bytes.readUInt32BE(16) : 0;
    const h = sigOk ? bytes.readUInt32BE(20) : 0;
    const bitDepth = sigOk ? bytes[24] : 0;
    const colorType = sigOk ? bytes[25] : 0;
    check(
      `${label} is a valid 48x48 8-bit RGBA PNG`,
      okPrefix && sigOk && w === 48 && h === 48 && bitDepth === 8 && colorType === 6,
      `len=${bytes.length}, ${w}x${h}, depth=${bitDepth}, type=${colorType}`,
    );
  }
}

/**
 * Tiny synchronous React renderer with per-instance hooks, subtree unmount
 * cleanup, and host ref attachment (function refs and object refs) for
 * component execution tests.
 */
function createHooksHarness(options = {}) {
  const createHostNode =
    typeof options.createHostNode === "function" ? options.createHostNode : () => null;
  const instances = new Map();
  const attachedRefs = new Map();
  let activeKey = "root";
  let activeSlot = 0;
  let pendingEffects = [];
  let pendingRefs = [];
  let seenInstances = new Set();
  let seenHostRefs = new Set();
  let changed = false;

  const sameDeps = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

  function storeOf(key) {
    let s = instances.get(key);
    if (!s) {
      s = [];
      instances.set(key, s);
    }
    return s;
  }

  function applyRef(ref, value) {
    if (typeof ref === "function") {
      ref(value);
    } else if (ref && typeof ref === "object" && "current" in ref) {
      ref.current = value;
    }
  }

  function cleanupInstance(key) {
    const slots = instances.get(key);
    if (!slots) return;
    for (const slot of slots) {
      if (slot && typeof slot === "object" && typeof slot.cleanup === "function") {
        slot.cleanup();
        slot.cleanup = undefined;
      }
    }
    instances.delete(key);
  }

  const hooks = {
    useState(initial) {
      const slots = storeOf(activeKey);
      const i = activeSlot++;
      if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      const keyCapture = activeKey;
      return [
        slots[i],
        (next) => {
          const s = storeOf(keyCapture);
          const value = typeof next === "function" ? next(s[i]) : next;
          if (!Object.is(value, s[i])) {
            s[i] = value;
            changed = true;
          }
        },
      ];
    },
    useRef(initial) {
      const slots = storeOf(activeKey);
      const i = activeSlot++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i];
    },
    useEffect(effect, deps) {
      const slots = storeOf(activeKey);
      const i = activeSlot++;
      const slot = slots[i];
      if (slot !== undefined && sameDeps(slot.deps, deps)) return;
      slots[i] = { deps, cleanup: slot === undefined ? undefined : slot.cleanup };
      pendingEffects.push({ key: activeKey, index: i, effect });
    },
    useLayoutEffect(effect, deps) {
      hooks.useEffect(effect, deps);
    },
  };

  function expand(node, path) {
    if (node === null || node === undefined || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((child, idx) => expand(child, `${path}[${idx}]`));
    if (typeof node.type === "function") {
      const instKey = `${path}:${node.type.name || "fn"}:${node.key ?? ""}`;
      seenInstances.add(instKey);
      const prevKey = activeKey;
      const prevSlot = activeSlot;
      activeKey = instKey;
      activeSlot = 0;
      const rendered = node.type(node.props);
      activeKey = prevKey;
      activeSlot = prevSlot;
      return expand(rendered, instKey);
    }
    const hostPath = `${path}/${String(node.type)}:${node.key ?? ""}`;
    if (node.props && node.props.ref !== undefined && node.props.ref !== null) {
      seenHostRefs.add(hostPath);
      pendingRefs.push({ hostPath, type: node.type, props: node.props, ref: node.props.ref });
    }
    if (node.props && node.props.children !== undefined) {
      return {
        ...node,
        props: {
          ...node.props,
          children: expand(node.props.children, hostPath),
        },
      };
    }
    return node;
  }

  function render(Component, props) {
    let tree;
    let passes = 0;
    do {
      changed = false;
      pendingEffects = [];
      pendingRefs = [];
      seenInstances = new Set();
      seenHostRefs = new Set();
      tree = expand({ type: Component, props }, "root");

      // Unmount component instances that disappeared from the tree.
      for (const key of Array.from(instances.keys())) {
        if (!seenInstances.has(key)) cleanupInstance(key);
      }

      // Detach host refs that disappeared from the tree.
      for (const [hostPath, entry] of Array.from(attachedRefs.entries())) {
        if (!seenHostRefs.has(hostPath)) {
          applyRef(entry.ref, null);
          attachedRefs.delete(hostPath);
        }
      }

      // Attach active host refs BEFORE layout/passive effects run (matching React).
      const refsNow = pendingRefs;
      pendingRefs = [];
      for (const { hostPath, type, props: hostProps, ref } of refsNow) {
        const existing = attachedRefs.get(hostPath);
        const domNode = existing ? existing.node : createHostNode(type, hostProps);
        if (existing && existing.ref !== ref) {
          applyRef(existing.ref, null);
        }
        attachedRefs.set(hostPath, { ref, node: domNode });
        applyRef(ref, domNode);
      }

      const effectsNow = pendingEffects;
      pendingEffects = [];
      for (const { key, index, effect } of effectsNow) {
        if (!instances.has(key)) continue;
        const slot = storeOf(key)[index];
        if (typeof slot.cleanup === "function") slot.cleanup();
        const cleanup = effect();
        slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      }
      passes += 1;
    } while (changed && passes < 6);
    return tree;
  }

  function unmountAll() {
    for (const key of Array.from(instances.keys())) {
      cleanupInstance(key);
    }
    for (const entry of attachedRefs.values()) {
      applyRef(entry.ref, null);
    }
    attachedRefs.clear();
  }

  return { hooks, render, unmountAll };
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  if (node.props && node.props.children !== undefined) {
    findAll(node.props.children, predicate, out);
  }
  return out;
}

function loadComponentWithRnStub(rnStub, hooks) {
  const originalLoad = Module._load;
  // Clear cached compiled modules so each platform test binds its own RN stub.
  for (const key of Object.keys(require.cache)) {
    if (key.endsWith("row-status-icon.js") || key.endsWith("status-ring.js")) {
      delete require.cache[key];
    }
  }
  Module._load = function load(request, parent, isMain) {
    if (request === "react") return hooks;
    if (request === "react/jsx-runtime") {
      return {
        jsx: (type, props, key) => ({ type, props, key }),
        jsxs: (type, props, key) => ({ type, props, key }),
        Fragment: "Fragment",
      };
    }
    if (request === "react-native") return rnStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(componentPath);
  } finally {
    Module._load = originalLoad;
  }
}

const COLORS = {
  surface0: "#09090b",
  statusSuccess: "#4ade80",
  statusDanger: "#f87171",
};

console.log("component execution — Web platform");
{
  const webAnimations = [];
  const createWebHostNode = (type) => ({
    tagName: String(type),
    animate(keyframes, timing) {
      const handle = {
        keyframes,
        timing,
        startTime: null,
        cancelCalls: 0,
        cancel() {
          this.cancelCalls += 1;
        },
      };
      webAnimations.push(handle);
      return handle;
    },
  });
  const harness = createHooksHarness({ createHostNode: createWebHostNode });
  const injected = new Map();
  const prevDoc = global.document;
  global.document = {
    getElementById: (id) => injected.get(id) ?? null,
    createElement: (tag) => ({ tag, id: "", textContent: "" }),
    head: { appendChild: (el) => injected.set(el.id, el) },
  };
  try {
    const mod = loadComponentWithRnStub(
      { Platform: { OS: "web" }, View: "View", Image: "Image" },
      harness.hooks,
    );
    const {
      RowStatusIcon,
      ROW_ICON_SPIN_TEST_ID,
      ROW_ICON_PULSE_TEST_ID,
      ROW_BADGE_RUNNING_TEST_ID,
      ROW_BADGE_COMPLETED_TEST_ID,
      ROW_BADGE_FAILED_TEST_ID,
      ROW_BADGE_POP_TEST_ID,
    } = mod;

    // 0. Sanity: harness attaches both function refs and object refs with spyable animate().
    {
      const objRef = { current: null };
      let fnRefNode = null;
      function RefProbe() {
        return {
          type: "View",
          props: {
            children: [
              { type: "View", props: { ref: objRef } },
              {
                type: "View",
                props: {
                  ref: (node) => {
                    fnRefNode = node;
                  },
                },
              },
            ],
          },
        };
      }
      harness.render(RefProbe, {});
      const attachedOk =
        objRef.current !== null &&
        typeof objRef.current.animate === "function" &&
        fnRefNode !== null &&
        typeof fnRefNode.animate === "function";
      harness.unmountAll();
      check(
        "test renderer binds spyable DOM nodes to both object refs and function refs and detaches on unmount",
        attachedOk && objRef.current === null && fnRefNode === null,
      );
    }

    // 1. Historic completed row: bare green check, NO pop animation, NO Web ring animate().
    const historic = harness.render(RowStatusIcon, {
      status: "completed",
      size: 16,
      colors: COLORS,
      children: { type: "BaseGlyph", props: {} },
    });
    const compBadges = findAll(historic, (n) => n.props?.testID === ROW_BADGE_COMPLETED_TEST_ID);
    const popNodes = findAll(historic, (n) => n.props?.testID === ROW_BADGE_POP_TEST_ID);
    const checkImgs = findAll(historic, (n) => n.type === "Image" && n.props?.source?.uri === CHECK_BADGE_ICON);
    check("historic completed renders bare green checkmark badge", compBadges.length === 1 && checkImgs.length === 1);
    check("bare green checkmark is tinted with colors.statusSuccess", checkImgs[0]?.props?.tintColor === COLORS.statusSuccess);
    check("historic completed does NOT trigger pop animation", popNodes.length === 0);
    check("historic completed does NOT call Web element.animate()", webAnimations.length === 0);
    harness.unmountAll();

    // 2. Running thinking row (spinBase=true) -> settles to completed -> pops once & cancels ring animation.
    const runningThink = harness.render(RowStatusIcon, {
      status: "running",
      size: 16,
      colors: COLORS,
      spinBase: true,
      children: { type: "BaseGlyph", props: {} },
    });
    check(
      "running thinking row applies spin testID and running corner ring badge",
      findAll(runningThink, (n) => n.props?.testID === ROW_ICON_SPIN_TEST_ID).length === 1 &&
        findAll(runningThink, (n) => n.props?.testID === ROW_BADGE_RUNNING_TEST_ID).length === 1,
    );
    const thinkRingAnim = webAnimations[webAnimations.length - 1];
    check(
      "Web running status invokes StatusRingMark element.animate() with shared startTime=0",
      webAnimations.length === 1 &&
        thinkRingAnim?.startTime === 0 &&
        thinkRingAnim?.timing?.duration === 900 &&
        thinkRingAnim?.timing?.iterations === Number.POSITIVE_INFINITY &&
        thinkRingAnim?.cancelCalls === 0,
      JSON.stringify(thinkRingAnim),
    );
    const sheet = injected.get("dsh-paseo-row-status-icon");
    check(
      "Web injects keyframes stylesheet honoring prefers-reduced-motion",
      sheet !== undefined &&
        sheet.textContent.includes("dsh-row-icon-spin") &&
        sheet.textContent.includes("dsh-row-badge-pop") &&
        sheet.textContent.includes("prefers-reduced-motion: reduce"),
    );

    const settledThink = harness.render(RowStatusIcon, {
      status: "completed",
      size: 16,
      colors: COLORS,
      spinBase: true,
      children: { type: "BaseGlyph", props: {} },
    });
    check(
      "running -> completed settles to bare green check WITH pop animation",
      findAll(settledThink, (n) => n.props?.testID === ROW_BADGE_COMPLETED_TEST_ID).length === 1 &&
        findAll(settledThink, (n) => n.props?.testID === ROW_BADGE_POP_TEST_ID).length === 1 &&
        findAll(settledThink, (n) => n.props?.testID === ROW_ICON_SPIN_TEST_ID).length === 0,
    );
    check(
      "exiting running -> completed cancels Web ring animation immediately (before unmount)",
      thinkRingAnim?.cancelCalls === 1 && webAnimations.length === 1,
      `cancelCalls=${thinkRingAnim?.cancelCalls}, total=${webAnimations.length}`,
    );
    harness.unmountAll();

    // 3. Running tool row (spinBase=false) -> fails -> failed badge pops & cancels ring animation.
    const runningTool = harness.render(RowStatusIcon, {
      status: "running",
      size: 14,
      colors: COLORS,
      spinBase: false,
      children: { type: "BaseGlyph", props: {} },
    });
    const toolRingAnim = webAnimations[webAnimations.length - 1];
    check(
      "running tool row applies pulse testID (not spin) and running badge",
      findAll(runningTool, (n) => n.props?.testID === ROW_ICON_PULSE_TEST_ID).length === 1 &&
        findAll(runningTool, (n) => n.props?.testID === ROW_ICON_SPIN_TEST_ID).length === 0 &&
        findAll(runningTool, (n) => n.props?.testID === ROW_BADGE_RUNNING_TEST_ID).length === 1 &&
        webAnimations.length === 2 &&
        toolRingAnim?.cancelCalls === 0,
    );
    const failedTool = harness.render(RowStatusIcon, {
      status: "failed",
      size: 14,
      colors: COLORS,
      spinBase: false,
      children: { type: "BaseGlyph", props: {} },
    });
    const errorImgs = findAll(failedTool, (n) => n.type === "Image" && n.props?.source?.uri === ERROR_BADGE_ICON);
    check(
      "running -> failed renders failed badge + error glyph WITH pop animation",
      findAll(failedTool, (n) => n.props?.testID === ROW_BADGE_FAILED_TEST_ID).length === 1 &&
        findAll(failedTool, (n) => n.props?.testID === ROW_BADGE_POP_TEST_ID).length === 1 &&
        errorImgs.length === 1 &&
        errorImgs[0]?.props?.tintColor === COLORS.surface0,
    );
    check(
      "exiting running -> failed cancels Web ring animation immediately",
      toolRingAnim?.cancelCalls === 1,
      `cancelCalls=${toolRingAnim?.cancelCalls}`,
    );
    harness.unmountAll();

    // 4. Unmounting while still running cancels the active Web ring animation.
    harness.render(RowStatusIcon, {
      status: "running",
      size: 16,
      colors: COLORS,
      spinBase: false,
      children: { type: "BaseGlyph", props: {} },
    });
    const unmountRingAnim = webAnimations[webAnimations.length - 1];
    check(
      "running mount starts a third Web ring animation",
      webAnimations.length === 3 && unmountRingAnim?.cancelCalls === 0,
      `total=${webAnimations.length}, cancelCalls=${unmountRingAnim?.cancelCalls}`,
    );
    harness.unmountAll();
    check(
      "unmounting while running cancels Web ring animation cleanly",
      unmountRingAnim?.cancelCalls === 1,
      `cancelCalls=${unmountRingAnim?.cancelCalls}`,
    );

    // 5. Idle row renders base glyph with zero badges and zero Web animations.
    const idleRow = harness.render(RowStatusIcon, {
      status: "idle",
      size: 16,
      colors: COLORS,
      children: { type: "BaseGlyph", props: {} },
    });
    check(
      "idle row renders base glyph and no badge",
      findAll(idleRow, (n) => n.type === "BaseGlyph").length === 1 &&
        findAll(idleRow, (n) => n.props?.testID === ROW_BADGE_RUNNING_TEST_ID).length === 0 &&
        findAll(idleRow, (n) => n.props?.testID === ROW_BADGE_COMPLETED_TEST_ID).length === 0 &&
        findAll(idleRow, (n) => n.props?.testID === ROW_BADGE_FAILED_TEST_ID).length === 0 &&
        webAnimations.length === 3,
    );
    harness.unmountAll();
  } finally {
    global.document = prevDoc;
  }
}

console.log("component execution — Native Animated lifecycle & minimal stub safety");
{
  let starts = 0;
  let stops = 0;
  class FakeAnimatedValue {
    constructor(v) { this.value = v; }
    setValue(v) { this.value = v; }
    interpolate(cfg) { return { interpolated: cfg }; }
  }
  const makeAnim = () => ({
    start: () => { starts += 1; },
    stop: () => { stops += 1; },
  });
  const nativeStub = {
    Platform: { OS: "ios" },
    View: "View",
    Image: "Image",
    Easing: {
      linear: "linear",
      ease: "ease",
      cubic: "cubic",
      back: (s) => `back(${s})`,
      inOut: (e) => `inOut(${e})`,
      out: (e) => `out(${e})`,
    },
    Animated: {
      View: "Animated.View",
      Value: FakeAnimatedValue,
      timing: () => makeAnim(),
      sequence: () => makeAnim(),
      loop: () => makeAnim(),
    },
  };
  const harness = createHooksHarness();
  const { RowStatusIcon } = loadComponentWithRnStub(nativeStub, harness.hooks);
  const runningTree = harness.render(RowStatusIcon, {
    status: "running",
    size: 16,
    colors: COLORS,
    spinBase: true,
    children: { type: "BaseGlyph", props: {} },
  });
  check(
    "Native running mounts Animated.View and starts loops (base + StatusRingMark)",
    findAll(runningTree, (n) => n.type === "Animated.View").length >= 2 && starts >= 2,
    `starts=${starts}`,
  );
  harness.render(RowStatusIcon, {
    status: "completed",
    size: 16,
    colors: COLORS,
    spinBase: true,
    children: { type: "BaseGlyph", props: {} },
  });
  const startsAfterPop = starts;
  harness.unmountAll();
  check(
    "Native running -> completed starts pop animation and stops all animations cleanly on unmount",
    startsAfterPop >= 3 && stops === starts,
    `starts=${starts}, stops=${stops}`,
  );

  // Minimal stub (no Platform, Animated, Easing, statusSuccess, statusDanger) must never throw.
  const stubHarness = createHooksHarness();
  const { RowStatusIcon: StubIcon } = loadComponentWithRnStub(
    { View: "View", Image: "Image" },
    stubHarness.hooks,
  );
  let stubOk = true;
  try {
    for (const st of ["running", "completed", "failed", "idle"]) {
      stubHarness.render(StubIcon, {
        status: st,
        size: 16,
        colors: { surface0: "#000000" },
        spinBase: true,
        children: { type: "BaseGlyph", props: {} },
      });
    }
    stubHarness.unmountAll();
  } catch (err) {
    stubOk = false;
    console.error(err);
  }
  check("renders every status cleanly under minimal RN stub without Platform/Animated", stubOk);
}

console.log("source wiring in tool-call.tsx and inline-thinking.tsx");
{
  const toolPath = findRepoFile("client/tool-call.tsx") ?? findRepoFile("paseo-plugin/client/tool-call.tsx");
  const thinkPath = findRepoFile("client/inline-thinking.tsx") ?? findRepoFile("paseo-plugin/client/inline-thinking.tsx");
  check("found client/tool-call.tsx and client/inline-thinking.tsx", toolPath !== undefined && thinkPath !== undefined);

  if (toolPath) {
    const toolSrc = codeOnly(readFileSync(toolPath, "utf8"));
    const body = functionBody(toolSrc, "InlineToolCall") ?? "";
    const statusCalls = callArguments(body, "resolveRowIconStatus");
    const wrappers = elementsWithAttributes(body, ["status", "size", "colors"]).filter(
      (el) => el.tag === "RowStatusIcon",
    );
    check(
      "InlineToolCall computes iconStatus via resolveRowIconStatus(data.status, running)",
      statusCalls.some((a) => mentions(a, "status") && mentions(a, "running")),
      statusCalls.join(" | ") || "no call",
    );
    check(
      "InlineToolCall wraps its head icon in <RowStatusIcon status={iconStatus} size={iconSize} colors={colors}>",
      wrappers.length === 1 &&
        mentions(attributeOf(wrappers[0], "status").value, "iconStatus") &&
        mentions(attributeOf(wrappers[0], "size").value, "iconSize") &&
        mentions(attributeOf(wrappers[0], "colors").value, "colors"),
      `${wrappers.length} wrapper(s)`,
    );
  }

  if (thinkPath) {
    const thinkSrc = codeOnly(readFileSync(thinkPath, "utf8"));
    const body = functionBody(thinkSrc, "InlineThinking") ?? "";
    const wrappers = elementsWithAttributes(body, ["status", "size", "colors"]).filter(
      (el) => el.tag === "RowStatusIcon",
    );
    check(
      "InlineThinking wraps its thinking glyph in <RowStatusIcon spinBase> with resolveThinkingIconStatus(growing)",
      wrappers.length === 1 &&
        mentions(attributeOf(wrappers[0], "status").value, "resolveThinkingIconStatus") &&
        mentions(attributeOf(wrappers[0], "status").value, "growing") &&
        mentions(attributeOf(wrappers[0], "size").value, "THINK_ICON_SIZE") &&
        mentions(attributeOf(wrappers[0], "colors").value, "colors") &&
        attributeOf(wrappers[0], "spinBase") !== undefined,
      `${wrappers.length} wrapper(s)`,
    );
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
