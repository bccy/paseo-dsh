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
  querySelector(selector: string): MeasuredNode | null;
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

/**
 * The footer is one short metadata line (copy, model, time, elapsed). An answer
 * or a whole pushed-down turn is much longer; using one of those as the anchor
 * is exactly how the row ends up on top of the text.
 */
const MAX_FOOTER_TEXT = 120;
/** The footer leads with its copy control; prose that mentions the word does not. */
const FOOTER_PREFIX = /^(复制|copy)/i;
/** Same affordance found through its accessible name, for icon-only layouts. */
const COPY_LABEL = '[aria-label*="复制"], [aria-label*="Copy"], [aria-label*="copy"]';
/** Wrapper levels to step over before giving up: item frame, list cell, row. */
const MAX_WRAPPER_DEPTH = 6;
/**
 * Largest plausible distance, in footer line heights, between the footer's last
 * line and the row the host laid out under it. A wrong anchor lands far outside
 * this; a themed footer that adds padding still lands inside it.
 */
const MAX_GAP_LINES = 4;

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
 * A short block that leads with the copy control. Answers can mention "copy"
 * too, so containing the word is not enough.
 */
function looksLikeFooter(node: MeasuredNode): boolean {
  const text = node.textContent?.trim() ?? "";
  if (text === "" || text.length > MAX_FOOTER_TEXT) return false;
  if (FOOTER_PREFIX.test(text)) return true;
  return node.querySelector(COPY_LABEL) !== null;
}

/**
 * The frame this item was laid out in and the footer above it.
 *
 * The row is rendered inside one or more wrappers that hold nothing but it, so
 * empty predecessors are stepped over until a sibling with height appears. That
 * sibling has to look like the footer; anything else means this row is not
 * tucked under one, and moving it would land on the answer.
 */
function locateFooter(row: MeasuredNode): { frame: MeasuredNode; footer: MeasuredNode } | null {
  let frame: MeasuredNode | null = row;
  for (let depth = 0; depth < MAX_WRAPPER_DEPTH && frame !== null; depth += 1) {
    const above = frame.previousElementSibling;
    if (above !== null && above.getBoundingClientRect().height > 0) {
      if (!looksLikeFooter(above)) return null;
      return { frame, footer: above };
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
  const naturalTop = anchor.frame.getBoundingClientRect().top - options.appliedLift;
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
 * Calls `onResize` when the row's neighbourhood changes size — a theme
 * switching, a font loading, the footer mounting a frame after `final` arrives,
 * or the turn being pushed down by a newer one.
 *
 * The footer itself is not required: it may not exist yet when the row first
 * renders, and observing only it would then never wake up. The container around
 * this item is watched too, which covers the footer being inserted or removed.
 * Returns a cleanup, or null off web.
 */
export function watchRow(row: unknown, onResize: () => void): (() => void) | null {
  const node = webRow(row);
  if (node === null) return null;
  const Observer = (globalThis as { ResizeObserver?: ResizeObserverConstructor }).ResizeObserver;
  if (Observer === undefined) return null;
  const observer = new Observer(onResize);
  let frame: MeasuredNode | null = node;
  for (let depth = 0; depth < MAX_WRAPPER_DEPTH && frame !== null; depth += 1) {
    if (frame.getBoundingClientRect().height > 0) observer.observe(frame);
    if (frame.parentElement !== null) observer.observe(frame.parentElement);
    frame = frame.parentElement;
    if (depth >= 2) break;
  }
  return () => observer.disconnect();
}
