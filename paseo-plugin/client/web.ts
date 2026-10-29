import { Platform } from "react-native";

/**
 * The one client file that reads the DOM.
 *
 * Paseo runs plugin client code on iOS and Android too, where none of these
 * globals exist, so off web every helper reports nothing and the caller keeps
 * the host's layout.
 */

/** The DOM shape read here; `tsconfig` ships no DOM typings. */
interface MeasuredNode {
  parentElement: MeasuredNode | null;
  previousElementSibling: MeasuredNode | null;
  nextElementSibling: MeasuredNode | null;
  children: ArrayLike<MeasuredNode>;
  textContent: string | null;
  querySelector(selector: string): MeasuredNode | null;
  getBoundingClientRect(): { top: number; bottom: number; height: number };
  querySelectorAll(selector: string): ArrayLike<MeasuredNode>;
}

type ResizeObserverConstructor = new (callback: () => void) => {
  observe(target: unknown): void;
  disconnect(): void;
};

export interface FooterGap {
  /** Whether the footer sits above or below the stats row. */
  side: "above" | "below";
  /** Natural distance between the row's frame and the footer, in px. */
  gap: number;
}

function webRow(row: unknown): MeasuredNode | null {
  if (Platform.OS !== "web" || row === null || row === undefined) return null;
  return row as MeasuredNode;
}

/** A small, height-bounded block carrying the footer's copy affordance. */
function looksLikeFooter(node: MeasuredNode): boolean {
  if (node.getBoundingClientRect().height > 120) return false;
  if (node.querySelector('[aria-label*="复制"], [aria-label*="Copy"], [aria-label*="copy"]') !== null) {
    return true;
  }
  return /复制|copy/i.test(node.textContent ?? "");
}

/** Bottom edge of the last visible line of text inside `node`. */
function lastTextBottom(node: MeasuredNode): number | null {
  let bottom: number | null = null;
  const lines = node.querySelectorAll("*");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.children.length > 0) continue;
    if (line.textContent === null || line.textContent.trim() === "") continue;
    const rect = line.getBoundingClientRect();
    if (rect.height <= 0) continue;
    bottom = bottom === null ? rect.bottom : Math.max(bottom, rect.bottom);
  }
  return bottom;
}

/**
 * Find the completed-turn footer next to this item and measure the gap to it.
 *
 * The footer is appended at the end of a turn, so the stats row is sometimes
 * above it and sometimes below it. Looking on both sides means the row can be
 * pulled toward whichever side the footer actually is, instead of assuming one
 * and overlapping the answer.
 *
 * `appliedTop`/`appliedBottom` are the margins this row currently carries: the
 * measured positions already include them, so they are taken back out first.
 */
export function measureFooterGap(
  row: unknown,
  applied: { top: number; bottom: number },
): FooterGap | null {
  const node = webRow(row);
  if (node === null) return null;
  let frame: MeasuredNode | null = node;
  for (let depth = 0; depth < 8 && frame !== null; depth += 1) {
    const above = frame.previousElementSibling;
    if (above !== null && above.getBoundingClientRect().height > 0 && looksLikeFooter(above)) {
      const bottom = lastTextBottom(above);
      if (bottom === null) return null;
      const naturalTop = frame.getBoundingClientRect().top - applied.top;
      return { side: "above", gap: naturalTop - bottom };
    }
    const below = frame.nextElementSibling;
    if (below !== null && below.getBoundingClientRect().height > 0 && looksLikeFooter(below)) {
      const naturalFooterTop = below.getBoundingClientRect().top - applied.bottom;
      return { side: "below", gap: naturalFooterTop - frame.getBoundingClientRect().bottom };
    }
    frame = frame.parentElement;
  }
  return null;
}

/** Re-run `onResize` when the footer above or below, or the container, changes size. */
export function watchFooter(row: unknown, onResize: () => void): (() => void) | null {
  const node = webRow(row);
  if (node === null) return null;
  const Observer = (globalThis as { ResizeObserver?: ResizeObserverConstructor }).ResizeObserver;
  if (Observer === undefined) return null;
  const observer = new Observer(onResize);
  let frame: MeasuredNode | null = node;
  for (let depth = 0; depth < 8 && frame !== null; depth += 1) {
    const above = frame.previousElementSibling;
    const below = frame.nextElementSibling;
    if (above !== null && above.getBoundingClientRect().height > 0 && looksLikeFooter(above)) {
      observer.observe(above);
      break;
    }
    if (below !== null && below.getBoundingClientRect().height > 0 && looksLikeFooter(below)) {
      observer.observe(below);
      break;
    }
    frame = frame.parentElement;
  }
  if (frame?.parentElement != null) observer.observe(frame.parentElement);
  return () => observer.disconnect();
}
