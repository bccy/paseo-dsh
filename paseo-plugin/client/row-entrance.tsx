/**
 * Subtle one-shot entrance motion for live timeline rows, plus the shared
 * `overscroll-behavior: contain` hook for expanded scroll regions on Web.
 *
 * Live rows fade and lift in (`opacity: 0 -> 1`, `translateY: 5px -> 0`,
 * 220ms ease-out). Replayed history and virtual-list scroll-backs render
 * immediately with no animation (`shouldEnterLive` in `./newest`).
 *
 * Platform split:
 * - **Web**: injects one `<style id="dsh-paseo-row-entrance">` sheet using
 *   `[data-testid]` selectors (matching `./shimmer-css`), honoring
 *   `prefers-reduced-motion: reduce`.
 * - **Native**: runs a single `Animated.parallel` timing on the native driver
 *   and stops it on unmount.
 * - **Offline harnesses**: safely guards `Platform` / `Animated` / `Easing`
 *   with optional chaining so minimal `react-native` stubs never throw.
 *
 * @module dsh-paseo/client/row-entrance
 */
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Animated, Easing, Platform, Text, View } from "react-native";
import {
  commitMountEntrance,
  markRowAnimated,
  normalizeRowTimestamp,
  noteMountCandidate,
} from "./newest";
import { claimCascadeDelay } from "./row-cascade";
import {
  STREAM_FRAME_INTERVAL_MS,
  STREAM_LEAD_DELAY_MS,
  STREAM_MAX_VISIBLE_CHARS,
  STREAM_TAIL_SETTLE_MS,
  STREAM_TRAIL_WIDTH,
  buildInkTrailSegments,
  calcStreamDurationMs,
  splitRowStreamProgress,
  streamCursorAt,
} from "./stream-reveal";
import { withAlpha } from "./tokens";

/**
 * Commit-phase effect hook: uses `useLayoutEffect` in real React so live
 * entrance / reveal transitions start before paint, falling back safely to
 * `useEffect` in minimal offline test stubs that only mock `useEffect`.
 */
const useCommitEffect =
  typeof useLayoutEffect === "function" ? useLayoutEffect : useEffect;

/** `testID` hook that triggers the CSS entrance animation on Web. */
export const ROW_ENTER_TEST_ID = "dsh-row-enter";
/** `testID` hook that triggers smooth whole-paragraph float-in on Web. */
export const BODY_PARA_ENTER_TEST_ID = "dsh-body-para-enter";
/** `testID` hook that enables `overscroll-behavior-y: contain` on overflowing Web scroll boxes. */
export const SCROLL_BOX_TEST_ID = "dsh-scroll-box";
/** DOM attribute toggled on Web scroll boxes only while content actually overflows vertically. */
export const SCROLL_OVERFLOW_Y_ATTR = "data-dsh-overflow-y";

/**
 * Whether a tap inside an expanded scroll/body region should collapse the row.
 *
 * Skips collapsing on Web when the user just finished dragging a text selection
 * or clicked an interactive anchor/button (`<a>` / `<button>`). On Native,
 * scroll drags and long-press selection do not fire `onPress`, and child
 * controls stop propagation, so short taps collapse cleanly.
 */
export function shouldCollapseOnBodyPress(event?: unknown): boolean {
  const win = (globalThis as {
    window?: { getSelection?: () => { toString(): string } | null };
  }).window;
  if (typeof win?.getSelection === "function") {
    const selected = win.getSelection()?.toString() ?? "";
    if (selected.length > 0) return false;
  }
  const target = (event as {
    target?: { closest?: (selector: string) => unknown };
  } | null | undefined)?.target;
  if (typeof target?.closest === "function" && target.closest("a, button") !== null) {
    return false;
  }
  return true;
}

const STYLE_ID = "dsh-paseo-row-entrance";
const SCROLL_BOX_SELECTOR = `[data-testid="${SCROLL_BOX_TEST_ID}"]`;
const ENTRANCE_DURATION_MS = 300;

/** Minimal DOM surface to inject one stylesheet & observe scroll overflow without DOM lib. */
interface WebStyleElement {
  id: string;
  textContent: string;
}
interface WebScrollElement {
  scrollHeight?: number;
  clientHeight?: number;
  firstElementChild?: WebScrollElement | null;
  parentElement?: WebScrollElement | null;
  isConnected?: boolean;
  matches?: (selector: string) => boolean;
  closest?: (selector: string) => WebScrollElement | null;
  querySelectorAll?: (selector: string) => Iterable<WebScrollElement> | ArrayLike<WebScrollElement>;
  getAttribute?: (name: string) => string | null;
  setAttribute?: (name: string, value: string) => void;
  removeAttribute?: (name: string) => void;
}
interface WebDocument {
  getElementById(id: string): unknown;
  createElement(tag: string): WebStyleElement;
  head: { appendChild(node: WebStyleElement): void } | null;
  body?: WebScrollElement | null;
  documentElement?: WebScrollElement | null;
  querySelectorAll?: (selector: string) => Iterable<WebScrollElement> | ArrayLike<WebScrollElement>;
}
interface WebResizeEntry {
  target?: unknown;
}
interface WebResizeObserver {
  observe(target: unknown): void;
  unobserve(target: unknown): void;
  disconnect?: () => void;
}
interface WebMutationRecord {
  type?: string;
  target?: unknown;
  addedNodes?: Iterable<unknown> | ArrayLike<unknown>;
  removedNodes?: Iterable<unknown> | ArrayLike<unknown>;
}
interface WebMutationObserver {
  observe(
    target: unknown,
    options: {
      childList?: boolean;
      subtree?: boolean;
      characterData?: boolean;
      attributes?: boolean;
      attributeFilter?: string[];
    },
  ): void;
  disconnect?: () => void;
}

const ROW_ENTRANCE_CSS = `
[data-testid="${ROW_ENTER_TEST_ID}"] {
  animation: dsh-row-enter ${ENTRANCE_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1) both;
  will-change: opacity;
}

@keyframes dsh-row-enter {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

[data-testid="${BODY_PARA_ENTER_TEST_ID}"] {
  animation: dsh-body-para-enter 480ms cubic-bezier(0.22, 1, 0.36, 1) both;
  will-change: opacity;
}

@keyframes dsh-body-para-enter {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

[data-testid="${SCROLL_BOX_TEST_ID}"][${SCROLL_OVERFLOW_Y_ATTR}="true"] {
  overscroll-behavior-y: contain;
}

@media (prefers-reduced-motion: reduce) {
  [data-testid="${ROW_ENTER_TEST_ID}"],
  [data-testid="${BODY_PARA_ENTER_TEST_ID}"] {
    animation: none !important;
    will-change: auto !important;
  }
}
`;

function isWebPlatform(): boolean {
  return Platform?.OS === "web";
}

function webDocument(): WebDocument | null {
  return (globalThis as { document?: WebDocument }).document ?? null;
}

/** Document-level symbol storing the active scroll-overflow observer handle across bundle reloads and hosts. */
const OVERFLOW_OBSERVER_SYMBOL = Symbol.for("dsh.paseo.scrollOverflowObserver.v1");
/** Protocol version for shared multi-host observer handles on the document. */
const OVERFLOW_OBSERVER_VERSION = 2;
interface OverflowObserverHandle {
  version?: number;
  owner: object;
  installs?: Set<symbol>;
  implicitOwner?: object | null;
  disposePhysical?: () => void;
  dispose: () => void;
  releaseInstall?: (token: symbol) => void;
  releaseImplicit?: (owner: object) => void;
}
type WebDocumentWithObserver = WebDocument & {
  [OVERFLOW_OBSERVER_SYMBOL]?: OverflowObserverHandle;
};
const MODULE_OWNER = {};
const activeModuleInstalls = new Set<symbol>();
const activeModuleDocs = new Set<WebDocument>();

type ObserverAcquireMode = { kind: "install"; token: symbol } | { kind: "implicit" };

function releaseTokenFromDocs(token: symbol): void {
  const currentDoc = webDocument();
  if (currentDoc !== null) activeModuleDocs.add(currentDoc);
  for (const doc of Array.from(activeModuleDocs)) {
    const targetDoc = doc as WebDocumentWithObserver;
    const handle = targetDoc[OVERFLOW_OBSERVER_SYMBOL];
    if (handle !== undefined) {
      if (typeof handle.releaseInstall === "function") {
        handle.releaseInstall(token);
      } else if (handle.owner === MODULE_OWNER) {
        handle.dispose();
      }
    }
    if (targetDoc[OVERFLOW_OBSERVER_SYMBOL] === undefined) {
      activeModuleDocs.delete(doc);
    }
  }
}

/**
 * Retain the document-level Web scroll-overflow observer for one plugin
 * installation (host). Multiple hosts share a single observer pair on the
 * document; disconnecting only happens once the last active installation
 * releases its handle.
 */
export function retainRowEntranceObservers(): () => void {
  const token = Symbol("dsh.paseo.rowEntrance.install");
  activeModuleInstalls.add(token);
  if (isWebPlatform()) {
    const doc = webDocument();
    if (doc !== null) {
      activeModuleDocs.add(doc);
      installScrollOverflowObserver(doc, { kind: "install", token });
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeModuleInstalls.delete(token);
    releaseTokenFromDocs(token);
  };
}

/**
 * Release all scroll-overflow observer retainers owned by this module instance.
 * If another host installation still retains the shared document observer, it
 * stays active; otherwise the physical observers are disconnected and cleaned.
 */
export function disposeRowEntranceObservers(): void {
  const tokens = Array.from(activeModuleInstalls);
  activeModuleInstalls.clear();
  for (const token of tokens) {
    releaseTokenFromDocs(token);
  }
  const currentDoc = webDocument();
  if (currentDoc !== null) activeModuleDocs.add(currentDoc);
  for (const doc of Array.from(activeModuleDocs)) {
    const targetDoc = doc as WebDocumentWithObserver;
    const handle = targetDoc[OVERFLOW_OBSERVER_SYMBOL];
    if (handle !== undefined) {
      if (typeof handle.releaseImplicit === "function") {
        handle.releaseImplicit(MODULE_OWNER);
      } else if (handle.owner === MODULE_OWNER) {
        handle.dispose();
      }
    }
    if (targetDoc[OVERFLOW_OBSERVER_SYMBOL] === undefined) {
      activeModuleDocs.delete(doc);
    }
  }
}

function isWebScrollElement(value: unknown): value is WebScrollElement {
  return typeof value === "object" && value !== null;
}

function isScrollBoxElement(el: WebScrollElement): boolean {
  if (typeof el.matches === "function") {
    try {
      return el.matches(SCROLL_BOX_SELECTOR);
    } catch {
      // Fall through to attribute check for minimal stubs.
    }
  }
  return typeof el.getAttribute === "function" && el.getAttribute("data-testid") === SCROLL_BOX_TEST_ID;
}

function collectScrollBoxes(node: unknown, out: WebScrollElement[]): void {
  if (!isWebScrollElement(node)) return;
  if (isScrollBoxElement(node)) out.push(node);
  if (typeof node.querySelectorAll === "function") {
    for (const child of Array.from(node.querySelectorAll(SCROLL_BOX_SELECTOR))) {
      if (isWebScrollElement(child)) out.push(child);
    }
  }
}

function syncScrollBoxOverflow(el: WebScrollElement): void {
  const scrollHeight = typeof el.scrollHeight === "number" ? el.scrollHeight : 0;
  const clientHeight = typeof el.clientHeight === "number" ? el.clientHeight : 0;
  if (scrollHeight > clientHeight + 1) {
    el.setAttribute?.(SCROLL_OVERFLOW_Y_ATTR, "true");
  } else {
    el.removeAttribute?.(SCROLL_OVERFLOW_Y_ATTR);
  }
}

function installScrollOverflowObserver(doc: WebDocument, mode: ObserverAcquireMode): void {
  const targetDoc = doc as WebDocumentWithObserver;
  activeModuleDocs.add(doc);
  const existingHandle = targetDoc[OVERFLOW_OBSERVER_SYMBOL];
  if (existingHandle !== undefined && existingHandle.owner === MODULE_OWNER) {
    if (existingHandle.installs !== undefined) {
      for (const t of activeModuleInstalls) existingHandle.installs.add(t);
      if (mode.kind === "install") {
        existingHandle.installs.add(mode.token);
        existingHandle.implicitOwner = null;
      } else if (existingHandle.installs.size === 0) {
        existingHandle.implicitOwner = MODULE_OWNER;
      }
    }
    return;
  }
  // When another coexisting host bundle already installed a current-version
  // observer with active explicit retainers, an implicit render-time style check
  // (`ensureRowEntranceStyles`) must share it instead of ping-ponging observers.
  if (
    mode.kind === "implicit" &&
    existingHandle !== undefined &&
    existingHandle.version === OVERFLOW_OBSERVER_VERSION &&
    (existingHandle.installs?.size ?? 0) > 0
  ) {
    return;
  }

  const migratedInstalls = new Set<symbol>(existingHandle?.installs ?? []);
  if (existingHandle !== undefined) {
    try {
      if (typeof existingHandle.disposePhysical === "function") {
        existingHandle.disposePhysical();
      } else {
        existingHandle.dispose();
      }
    } catch {
      // Never let a stale bundle's disposer block installing the replacement observer.
    }
  }
  for (const t of activeModuleInstalls) migratedInstalls.add(t);
  if (mode.kind === "install") migratedInstalls.add(mode.token);
  const initialImplicitOwner =
    mode.kind === "implicit" && migratedInstalls.size === 0 ? MODULE_OWNER : null;

  const tracked = new Map<WebScrollElement, WebScrollElement | null>();
  const childToBox = new Map<WebScrollElement, WebScrollElement>();

  let resizeObserver: WebResizeObserver | null = null;
  let mutationObserver: WebMutationObserver | null = null;
  let disposed = false;

  const untrack = (box: WebScrollElement): void => {
    if (!tracked.has(box)) return;
    const prevChild = tracked.get(box) ?? null;
    tracked.delete(box);
    resizeObserver?.unobserve(box);
    if (prevChild !== null) {
      resizeObserver?.unobserve(prevChild);
      childToBox.delete(prevChild);
    }
  };

  const track = (box: WebScrollElement): void => {
    const nextChild = isWebScrollElement(box.firstElementChild) ? box.firstElementChild : null;
    if (tracked.has(box)) {
      const prevChild = tracked.get(box) ?? null;
      if (prevChild !== nextChild) {
        if (prevChild !== null) {
          resizeObserver?.unobserve(prevChild);
          childToBox.delete(prevChild);
        }
        if (nextChild !== null) {
          resizeObserver?.observe(nextChild);
          childToBox.set(nextChild, box);
        }
        tracked.set(box, nextChild);
      }
      syncScrollBoxOverflow(box);
      return;
    }
    tracked.set(box, nextChild);
    resizeObserver?.observe(box);
    if (nextChild !== null) {
      resizeObserver?.observe(nextChild);
      childToBox.set(nextChild, box);
    }
    syncScrollBoxOverflow(box);
  };

  const ResizeObserverCtor = (globalThis as {
    ResizeObserver?: new (cb: (entries: Iterable<WebResizeEntry> | ArrayLike<WebResizeEntry>) => void) => WebResizeObserver;
  }).ResizeObserver;
  if (typeof ResizeObserverCtor === "function") {
    resizeObserver = new ResizeObserverCtor((entries) => {
      if (disposed) return;
      for (const entry of Array.from(entries)) {
        const target = entry?.target;
        if (!isWebScrollElement(target)) continue;
        const box = tracked.has(target) ? target : childToBox.get(target);
        if (box === undefined) continue;
        if (box.isConnected === false) {
          untrack(box);
        } else {
          track(box);
        }
      }
    });
  }

  // Immediately synchronize already-mounted scroll boxes.
  if (typeof doc.querySelectorAll === "function") {
    for (const el of Array.from(doc.querySelectorAll(SCROLL_BOX_SELECTOR))) {
      if (isWebScrollElement(el)) track(el);
    }
  }

  const MutationObserverCtor = (globalThis as {
    MutationObserver?: new (cb: (records: Iterable<WebMutationRecord> | ArrayLike<WebMutationRecord>) => void) => WebMutationObserver;
  }).MutationObserver;
  const root = doc.body ?? doc.documentElement ?? null;
  if (typeof MutationObserverCtor === "function" && root !== null) {
    mutationObserver = new MutationObserverCtor((records) => {
      if (disposed) return;
      let sawUnscannableRemoval = false;
      for (const record of Array.from(records)) {
        if (record.removedNodes !== undefined) {
          for (const node of Array.from(record.removedNodes)) {
            if (!isWebScrollElement(node)) continue;
            const nodeType = (node as { nodeType?: number }).nodeType;
            // Text (3) and Comment (8) nodes cannot be or contain scroll boxes.
            if (nodeType === 3 || nodeType === 8) continue;
            if (tracked.has(node)) {
              untrack(node);
            } else if (typeof node.querySelectorAll === "function") {
              const removedBoxes: WebScrollElement[] = [];
              collectScrollBoxes(node, removedBoxes);
              for (const box of removedBoxes) untrack(box);
            } else {
              // Minimal non-DOM stub without querySelectorAll: fall back to isConnected check.
              sawUnscannableRemoval = true;
            }
          }
        }

        if (record.addedNodes !== undefined) {
          const addedBoxes: WebScrollElement[] = [];
          for (const node of Array.from(record.addedNodes)) {
            if (!isWebScrollElement(node)) continue;
            const nodeType = (node as { nodeType?: number }).nodeType;
            if (nodeType === 3 || nodeType === 8) continue;
            collectScrollBoxes(node, addedBoxes);
          }
          for (const box of addedBoxes) track(box);
        }

        const target = record.target;
        if (!isWebScrollElement(target)) continue;
        if (record.type === "attributes") {
          if (isScrollBoxElement(target)) {
            track(target);
          } else if (tracked.has(target)) {
            untrack(target);
          }
          continue;
        }
        const hostBox =
          (typeof target.closest === "function" ? target.closest(SCROLL_BOX_SELECTOR) : null) ??
          (isWebScrollElement(target.parentElement) && typeof target.parentElement.closest === "function"
            ? target.parentElement.closest(SCROLL_BOX_SELECTOR)
            : null) ??
          (tracked.has(target) ? target : null);
        if (hostBox !== null) {
          track(hostBox);
        }
      }

      // Prune disconnected boxes only for unscannable non-DOM mocks — real DOM
      // removals are already handled subtree-locally via `removedNodes`.
      if (sawUnscannableRemoval) {
        for (const box of Array.from(tracked.keys())) {
          if (box.isConnected === false) {
            untrack(box);
          }
        }
      }
    });
    mutationObserver.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-testid"],
    });
  }

  let handle: OverflowObserverHandle;
  const disposePhysical = (): void => {
    if (disposed) return;
    disposed = true;
    mutationObserver?.disconnect?.();
    resizeObserver?.disconnect?.();
    tracked.clear();
    childToBox.clear();
    if (targetDoc[OVERFLOW_OBSERVER_SYMBOL] === handle) {
      delete targetDoc[OVERFLOW_OBSERVER_SYMBOL];
    }
  };
  const dispose = (): void => {
    if (disposed) return;
    for (const box of Array.from(tracked.keys())) {
      box.removeAttribute?.(SCROLL_OVERFLOW_Y_ATTR);
    }
    handle.installs?.clear();
    handle.implicitOwner = null;
    disposePhysical();
  };
  const releaseInstall = (token: symbol): void => {
    handle.installs?.delete(token);
    if ((handle.installs?.size ?? 0) === 0 && (handle.implicitOwner ?? null) === null) {
      dispose();
    }
  };
  const releaseImplicit = (owner: object): void => {
    if (handle.implicitOwner === owner) {
      handle.implicitOwner = null;
    }
    if ((handle.installs?.size ?? 0) === 0 && (handle.implicitOwner ?? null) === null) {
      dispose();
    }
  };
  handle = {
    version: OVERFLOW_OBSERVER_VERSION,
    owner: MODULE_OWNER,
    installs: migratedInstalls,
    implicitOwner: initialImplicitOwner,
    disposePhysical,
    dispose,
    releaseInstall,
    releaseImplicit,
  };
  targetDoc[OVERFLOW_OBSERVER_SYMBOL] = handle;
}

/**
 * Inject the entrance & scroll-containment stylesheet once (updating stale CSS
 * from an older hot-swapped bundle in place) and install the Web vertical-overflow
 * observer. Idempotent; no-op off Web.
 */
export function ensureRowEntranceStyles(): void {
  if (!isWebPlatform()) return;
  const doc = webDocument();
  if (doc === null) return;
  if (doc.head !== null) {
    const existing = doc.getElementById(STYLE_ID) as WebStyleElement | null | undefined;
    if (existing === null || existing === undefined) {
      const style = doc.createElement("style");
      style.id = STYLE_ID;
      style.textContent = ROW_ENTRANCE_CSS;
      doc.head.appendChild(style);
    } else if (existing.textContent !== ROW_ENTRANCE_CSS) {
      existing.textContent = ROW_ENTRANCE_CSS;
    }
  }
  installScrollOverflowObserver(doc, { kind: "implicit" });
}

export interface RowEntranceProps {
  agentId?: string;
  timestamp?: Date | string | number;
  rowKey?: string;
  liveHint?: boolean;
  /** Optional fade-in duration override (ms). Defaults to `300`. */
  durationMs?: number;
  /** Optional handoff wait ceiling (ms) when waiting on an upstream reply bloom. */
  maxHandoffDelayMs?: number;
  children: ReactNode;
}

/**
 * Wrap a timeline row so live arrivals enter smoothly once, while replayed or
 * recycled rows render statically.
 */
export function RowEntrance({
  agentId,
  timestamp,
  rowKey,
  liveHint,
  durationMs = ENTRANCE_DURATION_MS,
  maxHandoffDelayMs,
  children,
}: RowEntranceProps): ReactElement {
  const at = normalizeRowTimestamp(timestamp);
  const live = liveHint === true;
  const cascadeKey = rowKey !== undefined && rowKey !== "" ? rowKey : String(at);
  const committedRef = useRef(false);
  // Register this mounting row in the current render pass so commit-phase
  // evaluation can suppress multi-row history/bulk mounts on the very first
  // frame with zero flicker, while still recognizing live parallel bursts.
  if (!committedRef.current && agentId !== undefined && agentId !== "") {
    noteMountCandidate(agentId, at, rowKey, undefined, live);
  }

  // Start statically so batch-mounted historical rows render full-opacity on
  // frame 0; genuine live arrivals flip `animate` to true synchronously in
  // `useCommitEffect` before paint with their coordinated cascade delay.
  const [animate, setAnimate] = useState(false);
  const [delayMs, setDelayMs] = useState(0);

  useCommitEffect(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    if (agentId === undefined || agentId === "") return;
    if (commitMountEntrance(agentId, at, live, rowKey, undefined, live) && !prefersReducedMotion()) {
      const slotDelay = claimCascadeDelay(agentId, cascadeKey, undefined, maxHandoffDelayMs);
      setDelayMs(slotDelay);
      setAnimate(true);
    }
  }, []);

  // Keep `animatedKeys` updated if the row's key/timestamp shifts later
  // (e.g. host timestamp merge) so scroll-back remounts never replay motion.
  useEffect(() => {
    if (agentId !== undefined && agentId !== "") {
      markRowAnimated(agentId, at, rowKey);
    }
  }, [agentId, at, rowKey]);

  const web = isWebPlatform();
  const canNativeAnimate =
    !web &&
    animate &&
    typeof Animated?.View !== "undefined" &&
    typeof Animated?.Value === "function" &&
    typeof Animated?.timing === "function";

  const opacityRef = useRef<InstanceType<typeof Animated.Value> | null>(null);

  if (canNativeAnimate && opacityRef.current === null) {
    opacityRef.current = new Animated.Value(0);
  }

  useEffect(() => {
    if (web) ensureRowEntranceStyles();
  }, [web]);

  useEffect(() => {
    if (!canNativeAnimate || opacityRef.current === null) return;
    const opacity = opacityRef.current;
    const easing =
      typeof Easing?.out === "function" && Easing?.cubic ? Easing.out(Easing.cubic) : undefined;
    const fade = Animated.timing(opacity, {
      toValue: 1,
      duration: durationMs,
      useNativeDriver: true,
      ...(easing !== undefined ? { easing } : {}),
    });
    const anim =
      delayMs > 0 &&
      typeof Animated.sequence === "function" &&
      typeof Animated.delay === "function"
        ? Animated.sequence([Animated.delay(delayMs), fade])
        : fade;
    anim.start();
    return () => {
      anim.stop();
    };
  }, [canNativeAnimate, delayMs, durationMs]);

  if (web) {
    if (!animate) return <View>{children}</View>;
    const webStyle: Record<string, string> = {};
    if (delayMs > 0) webStyle.animationDelay = `${delayMs}ms`;
    if (durationMs !== ENTRANCE_DURATION_MS) webStyle.animationDuration = `${durationMs}ms`;
    return (
      <View
        testID={ROW_ENTER_TEST_ID}
        style={Object.keys(webStyle).length > 0 ? (webStyle as never) : undefined}
      >
        {children}
      </View>
    );
  }

  if (canNativeAnimate && opacityRef.current !== null) {
    const AnimatedView = Animated.View;
    return <AnimatedView style={{ opacity: opacityRef.current }}>{children}</AnimatedView>;
  }

  return <View>{children}</View>;
}

/**
 * Gently fades in a newly arrived block (`opacity` only — zero vertical
 * jumping) on iOS/Android CoreAnimation (`useNativeDriver: true`) and Web CSS,
 * with zero JS animation ticks and safe fallback in headless Node.
 */
export function AnimatedBodyParagraph({
  animate,
  fromOpacity = 0,
  durationMs = 480,
  children,
}: {
  animate: boolean;
  fromOpacity?: number;
  durationMs?: number;
  children: ReactNode;
}): ReactElement {
  const web = isWebPlatform();
  const canNative =
    !web &&
    animate &&
    typeof Animated?.View !== "undefined" &&
    typeof Animated?.Value === "function" &&
    typeof Animated?.timing === "function";

  const opacityRef = useRef<InstanceType<typeof Animated.Value> | null>(null);
  if (canNative && opacityRef.current === null) {
    opacityRef.current = new Animated.Value(fromOpacity);
  }

  useEffect(() => {
    if (web && animate) ensureRowEntranceStyles();
  }, [web, animate]);

  useEffect(() => {
    if (!canNative || opacityRef.current === null) return;
    const easing =
      typeof Easing?.out === "function" && Easing?.cubic
        ? Easing.out(Easing.cubic)
        : undefined;
    const anim = Animated.timing(opacityRef.current, {
      toValue: 1,
      duration: durationMs,
      useNativeDriver: true,
      ...(easing !== undefined ? { easing } : {}),
    });
    anim.start();
    return () => {
      anim.stop();
    };
  }, [canNative, durationMs]);

  if (web && animate) {
    return <View testID={BODY_PARA_ENTER_TEST_ID}>{children}</View>;
  }

  if (canNative && opacityRef.current !== null) {
    const AnimatedView = Animated.View;
    return (
      <AnimatedView style={{ opacity: opacityRef.current }}>
        {children}
      </AnimatedView>
    );
  }

  return <>{children}</>;
}

/* -------------------------------------------------------------------------- */
/* Ink-trail character streaming (Plan A: soft trailing fade)                 */
/* -------------------------------------------------------------------------- */

function prefersReducedMotion(): boolean {
  const win = (globalThis as {
    window?: { matchMedia?: (query: string) => { matches?: boolean } | null };
  }).window;
  try {
    return win?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

function nowMs(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === "function" ? perf.now() : Date.now();
}

export interface InkStreamOptions {
  agentId?: string;
  timestamp?: Date | string | number;
  rowKey?: string;
  liveHint?: boolean;
  label: string;
  summary: string;
  /** When false, only the left action label streams while summary renders live as-is. */
  streamSummary?: boolean;
  /**
   * When true (default), transitioning `liveHint` from `true -> false` snaps
   * immediately to full text. Set false on normal tool completions so fast
   * 10–50ms tools finish their gentle bloom instead of teleporting in.
   */
  snapOnSettle?: boolean;
  /** Force an immediate snap to full text (e.g. when a tool fails or is canceled). */
  snapNow?: boolean;
  /** Soft trailing fade width in code points (defaults to `STREAM_TRAIL_WIDTH`). */
  trailWidth?: number;
  /** Lead-in delay (ms) after the cascade slot opens (defaults to `STREAM_LEAD_DELAY_MS`). */
  leadDelayMs?: number;
}

export interface InkStreamState {
  readonly active: boolean;
  readonly labelProgress: number;
  readonly summaryProgress: number;
  readonly showSeparator: boolean;
  readonly showStat: boolean;
}

/**
 * One-shot character-by-character "ink fade trail" stream for live timeline rows.
 *
 * Replayed history, bulk-load bursts, scroll-back remounts, and reduced-motion
 * sessions immediately return settled progress (`Infinity`) and schedule zero
 * timers or animation frames.
 */
export function useInkStreamReveal({
  agentId,
  timestamp,
  rowKey,
  liveHint,
  label,
  summary,
  streamSummary = true,
  snapOnSettle = true,
  snapNow = false,
  trailWidth = STREAM_TRAIL_WIDTH,
  leadDelayMs = STREAM_LEAD_DELAY_MS,
}: InkStreamOptions): InkStreamState {
  const at = normalizeRowTimestamp(timestamp);
  const live = liveHint === true;
  const cascadeKey = rowKey !== undefined && rowKey !== "" ? rowKey : String(at);
  const committedRef = useRef(false);
  if (!committedRef.current && agentId !== undefined && agentId !== "") {
    noteMountCandidate(agentId, at, rowKey, undefined, live);
  }

  // Start settled (`Infinity`) so multi-row history mounts display full titles
  // immediately on frame 0 without flashing empty; genuine live rows activate
  // at `cursor = 0` synchronously in `useCommitEffect` before paint.
  const [animate, setAnimate] = useState(false);
  const [delayMs, setDelayMs] = useState(0);
  const [cursor, setCursor] = useState<number>(Number.POSITIVE_INFINITY);
  const prevLiveHintRef = useRef<boolean>(live);
  const prevSnapNowRef = useRef<boolean>(snapNow);
  const cancelPendingRef = useRef<(() => void) | null>(null);
  const targetRef = useRef({ label, summary, streamSummary, trailWidth, leadDelayMs });
  targetRef.current = { label, summary, streamSummary, trailWidth, leadDelayMs };

  useCommitEffect(() => {
    if (committedRef.current) return;
    committedRef.current = true;
    if (agentId === undefined || agentId === "") return;
    const allowed = commitMountEntrance(agentId, at, live, rowKey, undefined, live);
    if (allowed && !prefersReducedMotion()) {
      const slotDelay = claimCascadeDelay(agentId, cascadeKey);
      setDelayMs(slotDelay);
      setAnimate(true);
      setCursor(0);
    }
  }, []);

  // Immediately snap to `Infinity` when required (error/cancel via `snapNow`,
  // or terminal transition when `snapOnSettle` is enabled). Normal fast tool
  // completions with `snapOnSettle: false` keep gliding smoothly to the end.
  useCommitEffect(() => {
    const wasLive = prevLiveHintRef.current;
    const wasSnapNow = prevSnapNowRef.current;
    prevLiveHintRef.current = live;
    prevSnapNowRef.current = snapNow;
    const shouldSnap = (snapOnSettle && wasLive && !live) || (!wasSnapNow && snapNow);
    if (shouldSnap) {
      cancelPendingRef.current?.();
      cancelPendingRef.current = null;
      setAnimate(false);
      setCursor(Number.POSITIVE_INFINITY);
    }
  }, [live, snapOnSettle, snapNow]);

  useEffect(() => {
    if (!animate) return;
    let cancelled = false;
    let rafId: number | null = null;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const startAt = nowMs() + delayMs + targetRef.current.leadDelayMs;
    let lastEmitAt = 0;

    const raf = (globalThis as {
      requestAnimationFrame?: (cb: (t: number) => void) => number;
    }).requestAnimationFrame;
    const cancelRaf = (globalThis as {
      cancelAnimationFrame?: (id: number) => void;
    }).cancelAnimationFrame;

    const cancelScheduled = (): void => {
      cancelled = true;
      if (rafId !== null && typeof cancelRaf === "function") cancelRaf(rafId);
      rafId = null;
      if (timerId !== null) clearTimeout(timerId);
      timerId = null;
    };
    cancelPendingRef.current = cancelScheduled;

    const scheduleNext = (fn: () => void): void => {
      if (cancelled) return;
      if (typeof raf === "function") {
        rafId = raf(fn);
      } else {
        timerId = setTimeout(fn, STREAM_FRAME_INTERVAL_MS);
      }
    };

    const tick = (): void => {
      rafId = null;
      timerId = null;
      if (cancelled) return;
      const now = nowMs();
      const elapsed = now - startAt;
      if (elapsed < 0) {
        scheduleNext(tick);
        return;
      }

      const current = targetRef.current;
      const labelChars = Array.from(current.label);
      const summaryChars = current.streamSummary
        ? Array.from(current.summary).slice(0, STREAM_MAX_VISIBLE_CHARS)
        : [];
      const totalChars = labelChars.length + summaryChars.length;
      if (totalChars === 0) {
        setCursor(Number.POSITIVE_INFINITY);
        return;
      }

      const streamMs = calcStreamDurationMs(
        labelChars.join("") + summaryChars.join(""),
      );
      if (elapsed >= streamMs + STREAM_TAIL_SETTLE_MS) {
        setCursor(Number.POSITIVE_INFINITY);
        return;
      }

      if (lastEmitAt === 0 || now - lastEmitAt >= STREAM_FRAME_INTERVAL_MS) {
        lastEmitAt = now;
        setCursor(
          streamCursorAt(
            elapsed,
            streamMs,
            totalChars,
            STREAM_TAIL_SETTLE_MS,
            current.trailWidth,
          ),
        );
      }
      scheduleNext(tick);
    };

    scheduleNext(tick);

    return () => {
      cancelScheduled();
      if (cancelPendingRef.current === cancelScheduled) {
        cancelPendingRef.current = null;
      }
    };
  }, [animate, delayMs]);

  const snapped =
    (snapOnSettle && prevLiveHintRef.current && !live) || (!prevSnapNowRef.current && snapNow);
  const effectiveCursor = snapped ? Number.POSITIVE_INFINITY : cursor;
  const split = splitRowStreamProgress(
    label,
    summary,
    effectiveCursor,
    streamSummary,
    STREAM_MAX_VISIBLE_CHARS,
    trailWidth,
  );
  return {
    active: Number.isFinite(effectiveCursor),
    labelProgress: split.labelProgress,
    summaryProgress: split.summaryProgress,
    showSeparator: split.showSeparator,
    showStat: split.showStat,
  };
}

/**
 * Multiply a color's existing alpha (if `rgba(...)`) by `alpha`, or apply
 * `withAlpha` to solid `#hex`/`rgb(...)` colors so nested `<Text>` spans fade
 * natively on iOS `NSAttributedString` (where `style.opacity` is ignored).
 */
function tintWithAlpha(color: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  const rgbaMatch =
    /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)$/i.exec(color.trim());
  if (rgbaMatch !== null) {
    const baseA = Number.parseFloat(rgbaMatch[4]);
    const nextA = Number.isFinite(baseA) ? Math.max(0, Math.min(1, baseA * clamped)) : clamped;
    return `rgba(${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]}, ${Number(nextA.toFixed(3))})`;
  }
  return withAlpha(color, Number(clamped.toFixed(3)));
}

/**
 * Render `text` with a soft fade-in trail while `progress` is finite, or
 * return the plain `text` string once settled.
 *
 * Uses true `rgba(...)` color alpha whenever `baseColor`, `highlightColor`, or
 * `overrideColor` is parseable so nested `<Text>` fades smoothly on iOS UIKit
 * (`NSAttributedString` ignores `opacity` on virtual `<Text>` spans), falling
 * back to `opacity` only when no color can be resolved.
 */
export function renderInkTrailText(
  text: string,
  progress: number,
  highlightColor: string,
  overrideColor: string | null,
  settledFloor = 0,
  baseColor?: string,
  trailWidth = STREAM_TRAIL_WIDTH,
): ReactNode {
  if (!Number.isFinite(progress)) return text;
  const segments = buildInkTrailSegments(text, progress, trailWidth, settledFloor);
  if (segments.length === 0) return "";
  if (
    segments.length === 1 &&
    segments[0].opacity >= 1 &&
    segments[0].highlight === 0
  ) {
    return segments[0].text;
  }
  return segments.map((seg, idx) => {
    if (seg.opacity >= 1 && seg.highlight === 0) {
      return seg.text;
    }
    // Remap [0.14, 1] -> [0.04, 1] so leading glyphs dissolve gently out of
    // mist instead of starting visibly bright on iOS rgba text.
    const visualAlpha =
      seg.opacity >= 1
        ? 1
        : Math.max(0.04, Math.min(1, (seg.opacity - 0.14) / 0.86));
    const segAlpha =
      seg.highlight === 1
        ? Number((visualAlpha * 0.92).toFixed(3))
        : Number(visualAlpha.toFixed(3));
    const rawColor =
      overrideColor !== null
        ? overrideColor
        : seg.highlight > 0
          ? highlightColor
          : baseColor;
    const tinted = rawColor !== undefined ? tintWithAlpha(rawColor, segAlpha) : "transparent";
    return (
      <Text
        key={idx}
        style={
          tinted !== "transparent"
            ? { color: tinted }
            : rawColor !== undefined
              ? { opacity: segAlpha, color: rawColor }
              : { opacity: segAlpha }
        }
      >
        {seg.text}
      </Text>
    );
  });
}
