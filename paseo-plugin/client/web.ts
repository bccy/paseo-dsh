import { Platform } from "react-native";

/**
 * Where the completed-turn footer is, measured instead of guessed.
 *
 * Paseo reserves a fixed strip under that footer (`turnFooterSlot` carries
 * `paddingBottom: SPACING[8]`, 32px) and the stats row is an ordinary timeline
 * item placed after it, so the row floats in that strip with the gap the host
 * happens to give it. The strip is not ours to change, and it is not stable
 * either: a theme plugin restyles the footer, and the same turn is laid out
 * differently once a newer turn pushes it down. Any constant offset therefore
 * fits one combination and overlaps the answer in another.
 *
 * So the row measures the footer actually painted above it. All DOM access
 * lives in this file: Paseo also runs plugin client code on iOS and Android,
 * where these globals do not exist, and the renderer only ever sees the numbers
 * returned here (or null, meaning "leave the host's layout alone").
 */

/** The DOM shape read here; `tsconfig` ships no DOM typings. */
interface MeasuredNode {
  parentElement: MeasuredNode | null;
  previousElementSibling: MeasuredNode | null;
  children: ArrayLike<MeasuredNode>;
  childNodes: ArrayLike<MeasuredNode>;
  nodeType: number;
  nodeValue: string | null;
  textContent: string | null;
  getBoundingClientRect(): { top: number; bottom: number; height: number };
  querySelectorAll(selector: string): ArrayLike<MeasuredNode>;
  ownerDocument: TextDocument | null;
}

interface TextRect {
  top: number;
  bottom: number;
  height: number;
}

interface TextRange {
  selectNodeContents(node: unknown): void;
  getBoundingClientRect(): TextRect;
}

interface TextDocument {
  createRange(): TextRange;
}

interface ComputedStyle {
  fontSize?: string;
}

type ResizeObserverConstructor = new (callback: () => void) => {
  observe(target: unknown): void;
  disconnect(): void;
};

type MutationObserverConstructor = new (callback: () => void) => {
  observe(target: unknown, options: { childList: boolean; subtree: boolean }): void;
  disconnect(): void;
};

/**
 * The footer is one short metadata line (copy, model, time, elapsed). An answer
 * or a whole pushed-down turn is much longer; using one of those as the anchor
 * is exactly how the row ends up on top of the text.
 */
const MAX_FOOTER_TEXT = 120;
/** The footer's first line is its copy control; prose that mentions the word is not. */
const FOOTER_PREFIX = /^(复制|copy)/i;
/** Wrapper levels to step over before giving up: item frame, list cell, row. */
const MAX_WRAPPER_DEPTH = 6;
/** Ancestors watched for layout changes: row, wrappers, turn block, list. */
const WATCH_DEPTH = 6;
/**
 * Largest plausible distance, in footer line heights, between the footer's last
 * line and the row the host laid out under it. A wrong anchor lands far outside
 * this; a themed footer that adds padding still lands inside it.
 */
const MAX_GAP_LINES = 4;

/** Whether the row is actually laid out (an inactive tab renders zero-height). */
export function rowIsLaidOut(row: unknown): boolean {
  const node = webRow(row);
  if (node === null) return false;
  return node.getBoundingClientRect().height > 0;
}

export interface FooterGeometry {
  /** Margin that puts the row's top `gapEm` under the footer's last line. */
  lift: number;
  /** Text size the footer is painted at, so the row can match it. */
  fontSize: number;
}

function webRow(row: unknown): MeasuredNode | null {
  if (Platform.OS !== "web" || row === null || row === undefined) return null;
  return row as MeasuredNode;
}

function lineHeightFor(fontSize: number): number {
  // Paseo sets the footer's 13px text in an 18px line box.
  return fontSize * (18 / 13);
}

const TEXT_NODE = 3;

/**
 * Elements that directly hold a piece of visible text. Reading text nodes
 * rather than leaf elements means inline text (a bare string child, which a
 * theme plugin can produce) is measured too.
 */
function textRuns(node: MeasuredNode, depth = 0): MeasuredNode[] {
  const runs: MeasuredNode[] = [];
  if (depth > 12) return runs;
  for (let index = 0; index < node.childNodes.length; index += 1) {
    const child = node.childNodes[index];
    if (child === undefined) continue;
    if (child.nodeType === TEXT_NODE) {
      const text = child.nodeValue?.trim() ?? "";
      if (text !== "" && node.getBoundingClientRect().height > 0) runs.push(node);
      continue;
    }
    runs.push(...textRuns(child, depth + 1));
  }
  return runs;
}

/**
 * The box the glyphs of a text node actually occupy. A range is used because
 * the element around the text may carry padding (a themed footer that sets its
 * text directly), and the element box would then report the padding as text.
 */
function textRect(node: MeasuredNode): TextRect {
  const document = node.ownerDocument;
  if (document !== null) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.height > 0) return rect;
  }
  return node.getBoundingClientRect();
}

/**
 * The font size the footer is painted at: read from a text leaf rather than the
 * footer box, because the box inherits the content size and only adds padding.
 */
function footerFontSize(node: MeasuredNode, fallback: number): number {
  const read = (globalThis as { getComputedStyle?: (element: unknown) => ComputedStyle })
    .getComputedStyle;
  if (read === undefined) return fallback;
  let largest = 0;
  for (const leaf of textRuns(node)) {
    const parsed = Number.parseFloat(read(leaf).fontSize ?? "");
    if (Number.isFinite(parsed) && parsed > largest) largest = parsed;
  }
  return largest > 0 ? largest : fallback;
}

/**
 * A short block whose visible text starts with the copy control. Answers can
 * mention "copy" too, and a message block can contain a copy button of its own,
 * so neither containing the word nor owning a copy control is enough: the text
 * itself has to start with it.
 */
function looksLikeFooter(node: MeasuredNode): boolean {
  const text = node.textContent?.trim() ?? "";
  return text !== "" && text.length <= MAX_FOOTER_TEXT && FOOTER_PREFIX.test(text);
}

/** Elements that paint text, used to find the copy line without scanning every box. */
function textBearing(node: MeasuredNode): MeasuredNode[] {
  const out: MeasuredNode[] = [];
  const all = node.querySelectorAll("*");
  for (let index = 0; index < all.length; index += 1) {
    const element = all[index];
    if (element === undefined || element.children.length > 0) continue;
    const text = element.textContent?.trim() ?? "";
    if (text !== "" && element.getBoundingClientRect().height > 0) out.push(element);
  }
  return out;
}

/**
 * The footer inside `block`, if one is painted there.
 *
 * Paseo does not always put the footer in a sibling row: for a completed turn it
 * is drawn at the end of the answer block, so the row's previous sibling is the
 * whole answer. Look at the sibling first and then inside it, and take the last
 * copy line found — the footer is the last thing in that block, never the first
 * line of the answer.
 */
function findFooter(block: MeasuredNode): MeasuredNode | null {
  if (looksLikeFooter(block)) return block;
  let found: MeasuredNode | null = null;
  let lowest = Number.NEGATIVE_INFINITY;
  for (const element of textBearing(block)) {
    if (!FOOTER_PREFIX.test(element.textContent?.trim() ?? "")) continue;
    // A message block can carry copy affordances of its own (the hover
    // toolbar). The footer is the one painted lowest, right above this row.
    const bottom = element.getBoundingClientRect().bottom;
    if (bottom > lowest) {
      lowest = bottom;
      found = element;
    }
  }
  if (found === null) return null;
  // And it has to be the last text in the block: a copy control floating in
  // the middle of an answer is not the footer, and measuring it would tuck the
  // row under the wrong line.
  const lowestText = lastTextBottom(block);
  if (lowestText !== null && lowest < lowestText - 2) return null;
  return found;
}

/**
 * The frame this item was laid out in and the footer above it.
 *
 * The row is rendered inside one or more wrappers that hold nothing but it, so
 * empty predecessors are stepped over until a sibling with height appears. That
 * sibling has to contain the footer; anything else means this row is not tucked
 * under one, and moving it would land on the answer.
 */
function locateFooter(row: MeasuredNode): { frame: MeasuredNode; footer: MeasuredNode } | null {
  let frame: MeasuredNode | null = row;
  for (let depth = 0; depth < MAX_WRAPPER_DEPTH && frame !== null; depth += 1) {
    const above = frame.previousElementSibling;
    if (above !== null && above.getBoundingClientRect().height > 0) {
      const footer = findFooter(above);
      return footer === null ? null : { frame, footer };
    }
    frame = frame.parentElement;
  }
  return null;
}

/** Bottom edge of the last painted line of text inside `node`. */
function lastTextBottom(node: MeasuredNode): number | null {
  let bottom: number | null = null;
  for (const leaf of textRuns(node)) {
    const rect = textRect(leaf);
    bottom = bottom === null ? rect.bottom : Math.max(bottom, rect.bottom);
  }
  return bottom;
}

/**
 * How far `row` pulls itself up so its top sits `gapEm` under the footer's last
 * line, plus the size that footer is painted at.
 *
 * `appliedLift` is the margin the row carries right now. The frame has already
 * moved by it, so it is subtracted before measuring; otherwise the row measures
 * the position it just moved itself to and oscillates between two places.
 *
 * Returns null when there is nothing safe to measure: native, no footer above,
 * a sibling that only looks like a footer, or a gap too large to be the footer.
 * The caller then keeps the host's spacing rather than guessing.
 */
export function measureFooterGeometry(
  row: unknown,
  options: { appliedLift: number; gapEm: number; fallbackFontSize: number },
): FooterGeometry | null {
  const node = webRow(row);
  if (node === null) return null;
  const anchor = locateFooter(node);
  if (anchor === null) return null;

  const footerBottom = lastTextBottom(anchor.footer);
  if (footerBottom === null) return null;

  const fontSize = footerFontSize(anchor.footer, options.fallbackFontSize);
  // The margin is applied to the row itself, not to the wrapper the sibling is
  // found through: the wrapper keeps its top while the row is pulled up inside
  // it. Take the lift back out of the row's own box.
  const naturalTop = node.getBoundingClientRect().top - options.appliedLift;
  const gapNow = naturalTop - footerBottom;
  // Level with or above the footer text already: this layout is not the one the
  // lift is for, and moving further up would cover the answer.
  if (gapNow <= 0) return null;
  // Too far for a footer to be the element above: it is some other block.
  if (gapNow > lineHeightFor(fontSize) * MAX_GAP_LINES) return null;

  const gap = Math.round(fontSize * options.gapEm);
  const lift = Math.max(-Math.round(lineHeightFor(fontSize) * MAX_GAP_LINES), gap - gapNow);
  return { lift: Math.min(0, lift), fontSize };
}

/**
 * Calls `onResize` when the row's neighbourhood changes — a theme switching, a
 * font loading, the footer mounting a frame late, or the turn being pushed down
 * by a newer one.
 *
 * Resizing is only half of it: when a new turn is appended the row's own box and
 * its ancestors keep their size and only move, so a ResizeObserver never fires.
 * A MutationObserver on the same ancestors catches the insertion, and the two
 * are coalesced so a burst of changes costs one measurement, taken after the
 * layout has settled.
 *
 * Returns a cleanup, or null off web.
 */
export function watchRow(row: unknown, onResize: () => void): (() => void) | null {
  const node = webRow(row);
  if (node === null) return null;
  const Resize = (globalThis as { ResizeObserver?: ResizeObserverConstructor }).ResizeObserver;
  const Mutation = (globalThis as { MutationObserver?: MutationObserverConstructor })
    .MutationObserver;
  if (Resize === undefined && Mutation === undefined) return null;

  let pending: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      onResize();
    }, 60);
  };

  const stop: Array<() => void> = [];
  if (Resize !== undefined) {
    const observer = new Resize(schedule);
    if (Mutation !== undefined) {
      const mutations = new Mutation(schedule);
      let frame: MeasuredNode | null = node;
      for (let depth = 0; depth < WATCH_DEPTH && frame !== null; depth += 1) {
        observer.observe(frame);
        // Child insertions are where a new turn shows up; character data
        // (streaming text) is deliberately not watched.
        mutations.observe(frame, { childList: true, subtree: true });
        frame = frame.parentElement;
      }
      stop.push(() => mutations.disconnect());
    } else {
      let frame: MeasuredNode | null = node;
      for (let depth = 0; depth < WATCH_DEPTH && frame !== null; depth += 1) {
        observer.observe(frame);
        frame = frame.parentElement;
      }
    }
    stop.push(() => observer.disconnect());
  } else if (Mutation !== undefined) {
    const mutations = new Mutation(schedule);
    mutations.observe(node.parentElement ?? node, { childList: true, subtree: true });
    stop.push(() => mutations.disconnect());
  }

  return () => {
    if (pending !== null) clearTimeout(pending);
    for (const dispose of stop) dispose();
  };
}
