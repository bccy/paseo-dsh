import { Platform } from "react-native";

/**
 * The one client file that reads the DOM.
 *
 * Paseo runs plugin client code on iOS and Android too, where none of these
 * globals exist, so every export here is a no-op off web and the shared
 * renderers only ever see numbers (or null). Keeping `getBoundingClientRect`,
 * `querySelectorAll` and `ResizeObserver` in this file means a host change to
 * its own layout costs one file to fix, and an SSR build has one place to
 * stub out.
 */

/** The DOM shape read here; `tsconfig` ships no DOM typings. */
interface MeasuredNode {
  parentElement: MeasuredNode | null;
  previousElementSibling: MeasuredNode | null;
  children: ArrayLike<MeasuredNode>;
  textContent: string | null;
  getBoundingClientRect(): { top: number; bottom: number; height: number };
  querySelectorAll(selector: string): ArrayLike<MeasuredNode>;
}

type ResizeObserverConstructor = new (callback: () => void) => {
  observe(target: unknown): void;
  disconnect(): void;
};

/** Where the footer above an item ends and where the item's own frame starts. */
interface FooterAnchor {
  frame: MeasuredNode;
  above: MeasuredNode;
}

/**
 * The frame this item was laid out in, found from the row rendered inside it:
 * wrapper frames that hold nothing but this row are stepped over until a
 * sibling with height appears above.
 */
function locate(row: MeasuredNode): FooterAnchor | null {
  let frame: MeasuredNode | null = row;
  for (let depth = 0; depth < 8 && frame !== null; depth += 1) {
    const above = frame.previousElementSibling;
    if (above !== null && above.getBoundingClientRect().height > 0) return { frame, above };
    frame = frame.parentElement;
  }
  return null;
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

function webRow(row: unknown): MeasuredNode | null {
  if (Platform.OS !== "web" || row === null || row === undefined) return null;
  return row as MeasuredNode;
}

/**
 * How far `row` has to pull itself up so its frame sits `gap` px under the last
 * line of text drawn above it — the completed-turn footer, or the answer's own
 * last line when a theme draws no footer.
 *
 * `appliedLift` is the margin the row is carrying right now: the frame has
 * already moved by it, so it is taken back out before measuring. Without that,
 * the row would measure the position it just moved itself to and bounce between
 * two places.
 *
 * Returns null when there is nothing to measure — native, a row that is not in
 * the DOM yet, no sibling above — and the caller falls back to its own layout.
 */
export function measureFooterLift(
  row: unknown,
  options: { appliedLift: number; gap: number; maxLift: number },
): number | null {
  const node = webRow(row);
  if (node === null) return null;
  const anchor = locate(node);
  if (anchor === null) return null;
  // Paseo appends the completed-turn footer at the end of the turn, so the
  // stats row is sometimes *above* it rather than below. Only the footer
  // carries the copy affordance; if the sibling above is the answer instead,
  // there is nothing to tuck under and moving the row would overlap the text.
  if (!/复制|copy/i.test(anchor.above.textContent ?? "")) return null;
  const footerBottom = lastTextBottom(anchor.above);
  if (footerBottom === null) return null;
  const naturalTop = anchor.frame.getBoundingClientRect().top - options.appliedLift;
  // A row already above the footer has a negative gap here; leave it alone.
  if (naturalTop < footerBottom) return null;
  const lift = options.gap - (naturalTop - footerBottom);
  return Math.max(options.maxLift, Math.min(0, Math.round(lift)));
}

/**
 * Calls `onResize` whenever the footer above `row` changes size — a theme
 * switching, a font loading, the turn being pushed down by a newer one.
 * Returns a cleanup, or null off web or when there is nothing to watch.
 */
export function watchFooter(row: unknown, onResize: () => void): (() => void) | null {
  const node = webRow(row);
  if (node === null) return null;
  const anchor = locate(node);
  if (anchor === null) return null;
  const Observer = (globalThis as { ResizeObserver?: ResizeObserverConstructor }).ResizeObserver;
  if (Observer === undefined) return null;
  const observer = new Observer(onResize);
  observer.observe(anchor.above);
  // The 12px between "latest turn" and "pushed down by a newer turn" can come
  // from the container around this item rather than from the footer's own box.
  // Watching the parent catches both without polling.
  if (anchor.frame.parentElement !== null) observer.observe(anchor.frame.parentElement);
  return () => observer.disconnect();
}
