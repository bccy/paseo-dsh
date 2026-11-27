/**
 * Inline tool-call row for the Paseo timeline.
 *
 * Renders a compact frameless disclosure row aligned with `InlineThinking`:
 * a fixed 24px head row (state-tinted glyph, label, 2x2 separator square,
 * summary, and optional `+A -R` diff stat) that toggles an indented,
 * borderless expanded flow marked only by a 2px left rail (`framelessBlockStyle`
 * in `./tokens`).
 *
 * Interaction & layout invariants:
 * - **Head/body separation**: only the head line is a `<Pressable>`; the
 *   expanded body is its sibling `<View>` so scrolling, selecting, or copying
 *   inside an expanded block never collapses the row.
 * - **Uniform scroll cap**: every expanded surface renders its full payload
 *   inside a height-capped `<ScrollView>` bound to `style.expandedMaxHeight`
 *   (and tagged with `SCROLL_BOX_TEST_ID` for Web `overscroll-behavior: contain`),
 *   replacing the old head+tail line folding.
 * - **Semantic syntax highlighting**: shell commands, read files, diffs, JSON
 *   fields, and inferred generic code blocks use `HighlightedCode` /
 *   `HighlightedLine` strictly over Paseo's 11 semantic theme colours.
 * - **Live entrance motion**: wrapped in `<RowEntrance>` so newly arrived rows
 *   lift and fade in once while replayed history renders statically.
 *
 * @module dsh-paseo/client/tool-call
 */
import { useSettings, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, copyText } from "@getpaseo/plugin/client/react-native";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import {
  EXPANDED_MAX_HEIGHT_DEFAULT,
  TIMELINE_STYLE_DEFAULTS,
  resolveCommandMaxHeight,
  timelineStyleSettings,
  type TimelineStyleValues,
} from "../shared/settings";
import { useAntigravityCommandSummary } from "./antigravity/tool-summaries";
import { highlightModeFor, tokenizeCodeLines, type CodeToken, type HighlightMode } from "./code-highlight";
import { HighlightedCode, HighlightedLine } from "./highlighted-code";
import { ringColorFor } from "./jobs-popover-layout";
import { shouldPulse, useRowPulse } from "./newest";
import { PASEO_MARK_ICON } from "./paseo-mark";
import {
  RowEntrance,
  SCROLL_BOX_TEST_ID,
  renderInkTrailText,
  shouldCollapseOnBodyPress,
  useInkStreamReveal,
} from "./row-entrance";
import { RowStatusIcon, resolveRowIconStatus } from "./row-status-icon";
import { SubagentCard, SubagentStatusChips } from "./subagent-card";
import { TeamBlockView } from "./team-card";
import { TextShimmer } from "./text-shimmer";
import {
  agyFastToolLabel,
  blockCopy,
  paseoMcpLabel,
  type GoalBlockData,
  type ReadBlockData,
  type SearchBlockData,
  type ToolCallData,
  type ToolFieldEntry,
  type ToolFieldsData,
  type WebBlockData,
} from "./tool-call-data";
import {
  BODY_INDENT,
  CARD_HEAD_GAP,
  CODE_FONT_FAMILY,
  CODE_FONT_SIZE,
  GOAL_CARD_LINE_HEIGHT,
  GOAL_FIELD_COLUMN_GAP,
  GOAL_FIELD_LABEL_WIDTH,
  GOAL_FIELD_ROW_GAP,
  GOAL_FIELDS_MARGIN_TOP,
  ROW_FONT_SIZE,
  ROW_GAP,
  ROW_LINE_HEIGHT,
  WEB_META_GAP,
  WEB_TRUNCATED_MARGIN_TOP,
  cardHeadActionTextStyle,
  cardHeadActionsStyle,
  cardHeadHeadingStyle,
  cardHeadLangTextStyle,
  cardHeadStatusTextStyle,
  cardHeadTitleTextStyle,
  codeTextStyle,
  commandTextStyle,
  diffBodyTextStyle,
  diffChromeTextStyle,
  diffLineStyle,
  diffMarkerTextStyle,
  diffStat,
  diffStatTextStyle,
  dividerStyle,
  expandedScrollStyle,
  framelessBlockStyle,
  framelessHeadStyle,
  isLightSurface,
  outputTextStyle,
  readGutterTextStyle,
  readLineStyle,
  readLineTextStyle,
  rowHeadStyle,
  rowIconColor,
  rowLabelTextStyle,
  rowRootStyle,
  searchEmptyTextStyle,
  searchFileCountTextStyle,
  searchFileHeadStyle,
  searchFilePathTextStyle,
  searchLineNumberTextStyle,
  searchLineStyle,
  searchLineTextStyle,
  searchSummaryTextStyle,
  separatorStyle,
  summaryTextStyle,
  webFetchStyle,
  webMetaTextStyle,
  webPublishedTextStyle,
  webSnippetTextStyle,
  webSourceIndexTextStyle,
  webSourceLinkTextStyle,
  webSourceRowStyle,
  webTruncatedTextStyle,
  webUrlTextStyle,
  type TokenColors,
} from "./tokens";
import { useLocaleText } from "./use-locale";

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Extract a file extension or well-known filename token from a path/headline. */
function extensionOf(path: string): string | undefined {
  const trimmed = path.trim();
  if (trimmed === "") return undefined;
  const base = trimmed.split(/[\\/]/).pop() ?? "";
  if (base === "") return undefined;
  const lower = base.toLowerCase();
  if (lower === "dockerfile" || lower === "makefile") return lower;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return undefined;
  const ext = base.slice(dot + 1);
  return /^[a-z0-9_+-]+$/i.test(ext) ? ext.toLowerCase() : undefined;
}

/**
 * Infer a highlight language for a generic code block: prefer a recognizable
 * file extension from `headline`, otherwise detect JSON objects/arrays in `body`.
 */
function inferLang(headline: string, body: string): string | undefined {
  const fromHeadline = extensionOf(headline);
  if (fromHeadline !== undefined && highlightModeFor(fromHeadline) !== "plain") {
    return fromHeadline;
  }
  const trimmed = body.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return "json";
  }
  return undefined;
}

/**
 * Copy-to-clipboard with DSH's own feedback: the label flips for a second.
 *
 * A refused copy (no clipboard, denied permission) leaves the label alone — the
 * same thing DSH's control does — so the row stays usable instead of claiming a
 * copy that did not happen.
 */
function useCopy(text: string): { copied: boolean; onCopy: () => void } {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);
  const onCopy = useCallback(() => {
    if (copied) return;
    copyText(text).then(
      () => {
        if (!mountedRef.current) return;
        setCopied(true);
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          if (mountedRef.current) setCopied(false);
        }, 1000);
      },
      () => {},
    );
  }, [copied, text]);
  return { copied, onCopy };
}

/** Normalize a timeline item timestamp into finite epoch milliseconds, or 0. */
function normalizeTimestampMs(timestamp: unknown): number {
  if (timestamp instanceof Date) {
    const ms = timestamp.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof timestamp === "number") {
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** The copy control: text, not an icon, so it needs no host icon name. */
function CopyControl({ text, style }: { text: string; style: StyleProp<TextStyle> }) {
  const copy = blockCopy();
  const { copied, onCopy } = useCopy(text);
  const label = copied ? copy.copied : copy.copy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ flexShrink: 0 }}
      onPress={(event) => {
        event?.stopPropagation?.();
        onCopy();
      }}
    >
      <Text style={style}>{label}</Text>
    </Pressable>
  );
}

/** Minimal transparent toolbar above a frameless block: language, title, status, copy. */
function CardHead({
  lang,
  title,
  status,
  text,
  styles,
}: {
  lang: string;
  title: string;
  status?: string;
  text: string;
  styles: BlockStyles;
}) {
  return (
    <View style={styles.cardHead}>
      <View style={styles.cardHeadHeading}>
        {lang === "" ? null : <Text style={styles.cardHeadLang}>{lang}</Text>}
        {title === "" ? null : (
          <Text style={styles.cardHeadTitle} numberOfLines={1}>
            {title}
          </Text>
        )}
      </View>
      <View style={styles.cardHeadActions}>
        {status === undefined || status === "" ? null : (
          <Text style={styles.cardHeadStatus}>{status}</Text>
        )}
        <CopyControl text={text} style={styles.cardHeadAction} />
      </View>
    </View>
  );
}

/**
 * A link when the host can open it, plain text otherwise.
 *
 * DSH's `SafeLink` does the same: a non-http(s) URL keeps its text and loses
 * the affordance, instead of handing the host something it cannot open.
 */
function Link({
  href,
  style,
  children,
}: {
  href: string;
  style: StyleProp<TextStyle>;
  children: string;
}) {
  if (!/^https?:/i.test(href)) return <Text style={style}>{children}</Text>;
  return (
    <ExternalLink href={href}>
      <Text style={style}>{children}</Text>
    </ExternalLink>
  );
}

/**
 * A block that keeps DSH's `white-space: pre` by scrolling sideways.
 *
 * RN has no `pre` and no "do not wrap but stay scrollable" text mode:
 * `numberOfLines={1}` would truncate the content and a plain `Text` wraps it.
 * A horizontal scroll view is the one faithful option, so the search and read
 * rows live in one. The diff and terminal surfaces keep wrapping.
 */
function CodeScroller({
  style,
  contentStyle,
  children,
}: {
  style: StyleProp<ViewStyle>;
  contentStyle: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      nestedScrollEnabled
      style={style}
      contentContainerStyle={[contentStyle, { flexGrow: 1 }]}
    >
      {children}
    </ScrollView>
  );
}

/* -------------------------------------------------------------------------- */
/* Search (grep / glob)                                                       */
/* -------------------------------------------------------------------------- */

type SearchRow =
  | { readonly type: "file"; readonly path: string; readonly count: number; readonly index: number }
  | {
      readonly type: "match";
      readonly lineNumber: number;
      readonly line: string;
      readonly fileIndex: number;
    }
  | { readonly type: "path"; readonly path: string };

/** Flatten a search block into rows, dropping a collapsed group's matches. */
function searchRows(data: SearchBlockData, collapsed: ReadonlySet<number>): SearchRow[] {
  if (data.shape === "paths") return data.paths.map((path) => ({ type: "path", path }));
  const rows: SearchRow[] = [];
  data.files.forEach((file, index) => {
    rows.push({ type: "file", path: file.path, count: file.count, index });
    if (collapsed.has(index)) return;
    for (const match of file.matches) {
      rows.push({
        type: "match",
        lineNumber: match.lineNumber,
        line: match.line,
        fileIndex: index,
      });
    }
  });
  return rows;
}

function SearchBlockView({
  data,
  styles,
  onCollapse,
}: {
  data: SearchBlockData;
  styles: BlockStyles;
  onCollapse: (event?: unknown) => void;
}) {
  const copy = blockCopy();
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set<number>());
  const rows = useMemo(() => searchRows(data, collapsed), [data, collapsed]);
  const summary =
    data.shape === "paths"
      ? copy.pathsSummary(data.shown, data.total, data.truncated)
      : copy.matchesSummary(data.shown, data.total, data.files.length, data.truncated);

  const renderRow = (row: SearchRow, key: string) => {
    if (row.type === "path") {
      return (
        <View key={key} style={styles.searchLine}>
          <Text style={styles.searchLineText} selectable>
            {row.path}
          </Text>
        </View>
      );
    }
    if (row.type === "match") {
      return (
        <View key={key} style={styles.searchLine}>
          {/* The number is DSH's `<span class="lineNumber">`, dimmed so the
              match text stays salient. */}
          <Text style={styles.searchLineNumber}>{`${row.lineNumber}: `}</Text>
          <Text style={styles.searchLineText} selectable>
            {row.line}
          </Text>
        </View>
      );
    }
    return (
      <Pressable
        key={key}
        accessibilityRole="button"
        accessibilityLabel={`${row.path} ${row.count}`}
        onPress={(event) => {
          event?.stopPropagation?.();
          setCollapsed((previous) => {
            const next = new Set(previous);
            if (next.has(row.index)) next.delete(row.index);
            else next.add(row.index);
            return next;
          });
        }}
      >
        <View style={styles.searchFileHead}>
          <Text style={styles.searchFilePath}>{row.path}</Text>
          <Text style={styles.searchFileCount}>{row.count}</Text>
        </View>
      </Pressable>
    );
  };

  return (
    <View style={styles.block}>
      <View style={styles.searchHead}>
        <Text style={styles.searchSummary} numberOfLines={1} ellipsizeMode="tail">
          {summary}
        </Text>
        <CopyControl text={data.text} style={styles.cardHeadAction} />
      </View>
      {rows.length === 0 ? (
        <Text style={styles.searchEmpty}>{copy.noResults}</Text>
      ) : (
        <ScrollView
          style={styles.expandedScroll}
          nestedScrollEnabled
          testID={SCROLL_BOX_TEST_ID}
        >
          <CodeScroller style={styles.searchScroll} contentStyle={styles.searchBody}>
            <Pressable onPress={onCollapse} style={{ flex: 1 }}>
              <View>
                {rows.map((row, index) => renderRow(row, `row:${index}`))}
              </View>
            </Pressable>
          </CodeScroller>
        </ScrollView>
      )}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

function ReadBlockView({
  data,
  styles,
  colors,
  onCollapse,
}: {
  data: ReadBlockData;
  styles: BlockStyles;
  colors: TokenColors;
  onCollapse: (event?: unknown) => void;
}) {
  const copy = blockCopy();
  const digits = data.lines.reduce((max, line) => Math.max(max, String(line.number).length), 0);
  const gutter = useMemo(() => readGutterTextStyle(colors, digits), [colors, digits]);
  const lang = data.lang !== "" ? data.lang : extensionOf(data.path);
  const mode = highlightModeFor(lang);
  const tokenLines: readonly (readonly CodeToken[])[] = useMemo(
    () => tokenizeCodeLines(data.lines.map((line) => line.text), lang),
    [data.lines, lang],
  );
  // DSH says so when the tool returned a window of a longer file.
  const windowed = data.lines.length < data.totalLines;
  const renderLine = (line: { number: number; text: string }, index: number) => (
    <View key={line.number} style={styles.readLine}>
      {/* `aria-hidden` mirrors DSH's `user-select: none` gutter: the number is
          chrome, and copying the block should not drag it along. `selectable` is
          left off for the same reason. */}
      <Text style={gutter} aria-hidden>
        {line.number}
      </Text>
      <HighlightedLine
        line={line.text}
        mode={mode}
        tokens={tokenLines[index]}
        colors={colors}
        baseStyle={styles.readLineText}
        selectable
      />
    </View>
  );
  return (
    <View style={styles.block}>
      <CardHead
        lang={data.lang}
        title={data.path}
        status={windowed ? copy.window(data.lines.length, data.totalLines) : undefined}
        text={data.text}
        styles={styles}
      />
      <ScrollView
        style={styles.expandedScroll}
        nestedScrollEnabled
        testID={SCROLL_BOX_TEST_ID}
      >
        <CodeScroller style={styles.readScroll} contentStyle={styles.readBody}>
          <Pressable onPress={onCollapse} style={{ flex: 1 }}>
            <View>{data.lines.map(renderLine)}</View>
          </Pressable>
        </CodeScroller>
      </ScrollView>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Diff                                                                       */
/* -------------------------------------------------------------------------- */

/** One diff row's copyable form, matching DSH's `copyText`. */
function diffRowText(row: { kind: string; text: string }): string {
  if (row.kind === "add") return `+ ${row.text}`;
  if (row.kind === "del") return `- ${row.text}`;
  if (row.kind === "context") return `  ${row.text}`;
  return row.text;
}

function DiffRows({
  rows,
  styles,
  keyPrefix,
  mode,
  lang,
  colors,
}: {
  rows: readonly { kind: string; text: string }[];
  styles: BlockStyles;
  keyPrefix: string;
  mode: HighlightMode;
  lang?: string;
  colors: TokenColors;
}) {
  const tokenLines: readonly (readonly CodeToken[])[] | null = useMemo(
    () => (mode === "plain" ? null : tokenizeCodeLines(rows.map((row) => row.text), lang)),
    [rows, mode, lang],
  );
  return (
    <>
      {rows.map((row, index) => {
        const key = `${keyPrefix}:${index}`;
        if (row.kind === "add" || row.kind === "del" || row.kind === "context") {
          const marker = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
          const baseTextStyle =
            mode === "plain"
              ? row.kind === "add"
                ? styles.diffTextAdd
                : row.kind === "del"
                  ? styles.diffTextDel
                  : styles.diffTextContext
              : styles.diffBodyText;
          return (
            <View
              key={key}
              style={[
                styles.diffLine,
                row.kind === "add"
                  ? styles.diffAdd
                  : row.kind === "del"
                    ? styles.diffDel
                    : styles.diffContext,
              ]}
            >
              {/* The marker column stays a separate Text so the code starts at
                  the same x on every row, and the `+ `/`- ` prefix keeps DSH's
                  meaning: the sign is the marker, the text is the line without
                  it. An empty line still draws its space so the bar is unbroken. */}
              <Text
                style={
                  row.kind === "add"
                    ? styles.markerAdd
                    : row.kind === "del"
                      ? styles.markerDel
                      : styles.markerContext
                }
              >
                {marker}
              </Text>
              <HighlightedLine
                line={row.text === "" ? " " : row.text}
                mode={mode}
                tokens={row.text === "" ? undefined : tokenLines?.[index]}
                colors={colors}
                baseStyle={baseTextStyle}
                selectable
              />
            </View>
          );
        }
        // A path, `⋯` gap or `@@` hunk header: no marker column, no wash, but
        // the same 3px left border so it lines up with the changed rows.
        return (
          <View key={key} style={[styles.diffLine, styles.diffContext]}>
            <Text style={styles.diffChrome} selectable>
              {row.text}
            </Text>
          </View>
        );
      })}
    </>
  );
}

function DiffBlockView({
  data,
  styles,
  colors,
  onCollapse,
}: {
  data: NonNullable<ToolCallData["diffBlock"]>;
  styles: BlockStyles;
  colors: TokenColors;
  onCollapse: (event?: unknown) => void;
}) {
  const copy = blockCopy();
  const lang = extensionOf(data.path);
  const mode = highlightModeFor(lang);
  const status =
    data.operation === "create" ? copy.create : data.operation === "update" ? copy.update : undefined;
  return (
    <View style={styles.block}>
      <CardHead
        // DSH prints the file's language here. We have no hardcoded `typescript`
        // fallback; keep `"diff"` so the toolbar names the surface honestly.
        lang="diff"
        title={data.path}
        status={status}
        text={data.rows.map(diffRowText).join("\n")}
        styles={styles}
      />
      <ScrollView
        style={styles.expandedScroll}
        contentContainerStyle={styles.diffBody}
        nestedScrollEnabled
        testID={SCROLL_BOX_TEST_ID}
      >
        <Pressable onPress={onCollapse}>
          <DiffRows rows={data.rows} styles={styles} keyPrefix="diff" mode={mode} lang={lang} colors={colors} />
        </Pressable>
      </ScrollView>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Web                                                                        */
/* -------------------------------------------------------------------------- */

function WebBlockView({
  data,
  styles,
  onCollapse,
}: {
  data: WebBlockData;
  styles: BlockStyles;
  onCollapse: (event?: unknown) => void;
}) {
  const copy = blockCopy();
  if (data.shape === "fetch") {
    return (
      <View style={styles.block}>
        <View style={styles.webBody}>
          <View style={styles.webFetch}>
            <Link href={data.url} style={styles.webUrl}>
              {data.url}
            </Link>
            <View style={styles.webMetaRow}>
              {/* `parseWeb` returns a fetch block only when its meta carried a
                  numeric status code, so this is never null on this shape. */}
              <Text style={styles.webMeta}>{`${copy.http} ${data.statusCode}`}</Text>
              {data.truncated ? (
                <Text style={styles.webTruncated}>{copy.contentTruncated}</Text>
              ) : null}
            </View>
          </View>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.block}>
      <View style={styles.webBody}>
        {data.answer === "" && data.sources.length === 0 ? (
          <Text style={styles.webMeta}>{copy.webNoResults}</Text>
        ) : (
          <ScrollView
            style={styles.webSources}
            nestedScrollEnabled
            testID={SCROLL_BOX_TEST_ID}
          >
            <Pressable onPress={onCollapse}>
              {data.answer === "" ? null : (
                <Text style={styles.webSnippet} selectable>
                  {data.answer}
                </Text>
              )}
              {data.sources.length === 0 ? (
                <Text style={styles.webMeta}>{copy.webNoResults}</Text>
              ) : (
                data.sources.map((source, index) => (
                  <View key={`${index}:${source.url}`} style={styles.webSourceRow}>
                    {/* RN has no `<ol>` and no `value` attribute, so the
                        reference number is a column of its own. */}
                    <Text style={styles.webSourceIndex}>{`${index + 1}.`}</Text>
                    <View style={styles.webSourceBody}>
                      <Link href={source.url} style={styles.webSourceLink}>
                        {source.label}
                      </Link>
                      {source.snippet === "" ? null : (
                        <Text style={styles.webSnippet} selectable>
                          {source.snippet}
                        </Text>
                      )}
                      {source.publishedAt === "" ? null : (
                        <Text style={styles.webPublished}>{source.publishedAt}</Text>
                      )}
                    </View>
                  </View>
                ))
              )}
            </Pressable>
          </ScrollView>
        )}
        {data.truncated ? (
          <Text style={styles.webTruncatedSearch}>{copy.sourcesTruncated}</Text>
        ) : null}
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                     */
/* -------------------------------------------------------------------------- */

function buildStyles(
  colors: TokenColors,
  hairline: number,
  style: TimelineStyleValues,
  commandMaxHeight: number,
  expandedMaxHeight: number,
) {
  // Without an enclosing card surface, diff washes paint directly over the
  // timeline surface (`surface0`): 8% on light themes, 12% on dark themes.
  const light = isLightSurface(colors.surface0);
  // Drop `rowHeadStyle()`'s fixed `height` so `minHeight: style.toolRowMinHeight`
  // governs both shrinking and growing (still 24px at defaults). Cap row-head
  // text `lineHeight` to `toolRowMinHeight` so shrinking below 24px takes effect.
  const { height: _unusedHeight, ...baseRowHead } = rowHeadStyle();
  const rowLineHeight = Math.min(ROW_LINE_HEIGHT, style.toolRowMinHeight);
  const scrollCap = expandedScrollStyle(expandedMaxHeight);
  return {
    root: {
      ...rowRootStyle(),
      marginVertical: style.rowMarginY,
      paddingVertical: style.toolRowPaddingY,
    },
    head: {
      ...baseRowHead,
      gap: style.toolRowGap,
      minHeight: style.toolRowMinHeight,
    },
    // The text run, and the flex row the shimmer's copy re-lays-out. No gap:
    // the separator carries its own margins, the way DSH's `.sep` does.
    text: { flexDirection: "row" as const, alignItems: "center" as const, flex: 1, minWidth: 0 },
    label: { ...rowLabelTextStyle(colors), lineHeight: rowLineHeight },
    sep: separatorStyle(colors),
    summary: { ...summaryTextStyle(colors), lineHeight: rowLineHeight },
    // A failed row puts its reason where the summary sits (DSH's
    // `.errorSummary` does the same), so the reason reads before expanding.
    summaryError: { color: colors.statusDanger },
    statAdded: { ...diffStatTextStyle(colors, "added"), lineHeight: rowLineHeight },
    statRemoved: { ...diffStatTextStyle(colors, "removed"), lineHeight: rowLineHeight },
    body: { marginLeft: BODY_INDENT, gap: ROW_GAP },
    bodyInner: { gap: ROW_GAP },
    // Frameless expanded flow (Scheme A): transparent, no border radius or outer
    // card box — just a subtle 2px left rail tying the expanded content to its head.
    block: framelessBlockStyle(colors),
    expandedScroll: scrollCap,
    // The whole failure reason inside the expansion, selectable and red.
    errorText: {
      color: colors.statusDanger,
      fontSize: ROW_FONT_SIZE,
      lineHeight: ROW_LINE_HEIGHT,
    },
    // The plain-language reason above a known refusal, and DSH's code beside it.
    hintText: { color: colors.foregroundMuted, fontSize: ROW_FONT_SIZE, lineHeight: GOAL_CARD_LINE_HEIGHT },
    hintCode: { color: colors.foregroundMuted, fontSize: CODE_FONT_SIZE, fontFamily: CODE_FONT_FAMILY },
    // Goal details inside the frameless flow (tight horizontal padding for 390pt screens).
    goalItem: { paddingVertical: 4 },
    goalTitle: { color: colors.foreground, fontSize: ROW_FONT_SIZE, lineHeight: GOAL_CARD_LINE_HEIGHT },
    goalFields: { marginTop: GOAL_FIELDS_MARGIN_TOP, gap: GOAL_FIELD_ROW_GAP },
    goalField: { flexDirection: "row" as const, gap: GOAL_FIELD_COLUMN_GAP },
    goalLabel: {
      color: colors.foregroundMuted,
      fontSize: ROW_FONT_SIZE,
      lineHeight: GOAL_CARD_LINE_HEIGHT,
      width: GOAL_FIELD_LABEL_WIDTH,
    },
    goalValue: { color: colors.foreground, fontSize: ROW_FONT_SIZE, lineHeight: GOAL_CARD_LINE_HEIGHT, flex: 1, minWidth: 0 },
    // Generic fields (see `ToolFieldsView`): wrapping facts rows plus bounded
    // scroll regions for long prose and JSON entries.
    fieldsItem: {
      paddingVertical: 4,
      gap: GOAL_FIELD_ROW_GAP,
    },
    fieldsInner: {
      gap: GOAL_FIELD_ROW_GAP,
    },
    fieldFacts: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: GOAL_FIELD_COLUMN_GAP,
    },
    fieldFact: {
      flexDirection: "row" as const,
      gap: GOAL_FIELD_COLUMN_GAP,
      maxWidth: "100%" as const,
      flexShrink: 1,
    },
    fieldFactLabel: {
      color: colors.foregroundMuted,
      fontSize: ROW_FONT_SIZE,
      lineHeight: GOAL_CARD_LINE_HEIGHT,
      flexShrink: 0,
    },
    fieldFactValue: {
      color: colors.foreground,
      fontSize: ROW_FONT_SIZE,
      lineHeight: GOAL_CARD_LINE_HEIGHT,
      flexShrink: 1,
      minWidth: 0,
    },
    fieldBlock: { gap: GOAL_FIELD_ROW_GAP },
    fieldLabel: { color: colors.foregroundMuted, fontSize: ROW_FONT_SIZE, lineHeight: GOAL_CARD_LINE_HEIGHT },
    fieldText: { color: colors.foreground, fontSize: ROW_FONT_SIZE, lineHeight: GOAL_CARD_LINE_HEIGHT },
    fieldCaption: { color: colors.foregroundMuted, fontSize: ROW_FONT_SIZE, lineHeight: GOAL_CARD_LINE_HEIGHT },
    // The L2 receipt line: a summary of the block, quieter than the values above it.
    fieldReceipt: { color: colors.foregroundMuted, fontSize: ROW_FONT_SIZE, lineHeight: GOAL_CARD_LINE_HEIGHT },
    divider: dividerStyle(colors, hairline),
    command: { paddingVertical: 4 },
    // Bounded scroll window around the terminal command banner, sized from
    // timeline style settings (`commandMaxHeightRatio` / `commandMinHeight`).
    commandScroll: { maxHeight: commandMaxHeight },
    // The command and its copy control share the banner line; the command
    // takes the remaining width so the control never wraps off the block.
    commandRow: {
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      gap: CARD_HEAD_GAP,
    },
    commandText: { ...commandTextStyle(colors), flex: 1, minWidth: 0 },
    output: { paddingVertical: 4 },
    outputText: outputTextStyle(colors),
    terminalOutput: scrollCap,
    code: { paddingVertical: 4 },
    codeText: codeTextStyle(colors),
    codeScroll: scrollCap,
    diffLine: { flexDirection: "row" as const, paddingHorizontal: 8 },
    diffBody: { paddingVertical: 4 },
    diffAdd: diffLineStyle(colors, "add", light),
    diffDel: diffLineStyle(colors, "del", light),
    diffContext: diffLineStyle(colors, "context", light),
    markerAdd: diffMarkerTextStyle(colors, "add"),
    markerDel: diffMarkerTextStyle(colors, "del"),
    markerContext: diffMarkerTextStyle(colors, "context"),
    diffBodyText: diffBodyTextStyle(colors, "context"),
    diffTextAdd: diffBodyTextStyle(colors, "add"),
    diffTextDel: diffBodyTextStyle(colors, "del"),
    diffTextContext: diffBodyTextStyle(colors, "context"),
    diffChrome: diffChromeTextStyle(colors),
    cardHead: framelessHeadStyle(colors, hairline),
    cardHeadHeading: cardHeadHeadingStyle(),
    cardHeadActions: cardHeadActionsStyle(),
    cardHeadLang: cardHeadLangTextStyle(colors),
    cardHeadTitle: cardHeadTitleTextStyle(colors),
    cardHeadStatus: cardHeadStatusTextStyle(colors),
    cardHeadAction: cardHeadActionTextStyle(colors),
    searchHead: framelessHeadStyle(colors, hairline),
    searchSummary: searchSummaryTextStyle(colors),
    searchBody: { paddingVertical: 4, paddingRight: 4 },
    searchScroll: { flexGrow: 0 },
    searchLine: { ...searchLineStyle(), paddingLeft: 0 },
    searchFileHead: { ...searchFileHeadStyle(), paddingHorizontal: 0 },
    searchLineNumber: searchLineNumberTextStyle(colors),
    searchLineText: searchLineTextStyle(colors),
    searchFilePath: searchFilePathTextStyle(colors),
    searchFileCount: searchFileCountTextStyle(colors),
    searchEmpty: { ...searchEmptyTextStyle(colors), paddingVertical: 4, paddingHorizontal: 0 },
    readBody: { paddingVertical: 4 },
    readScroll: { flexGrow: 0 },
    readLine: readLineStyle(),
    readLineText: readLineTextStyle(colors),
    webBody: { paddingVertical: 4 },
    webFetch: webFetchStyle(),
    webUrl: webUrlTextStyle(colors),
    webMeta: webMetaTextStyle(colors),
    webMetaRow: {
      flexDirection: "row" as const,
      alignItems: "baseline" as const,
      gap: WEB_META_GAP,
    },
    webTruncated: webTruncatedTextStyle(colors),
    webTruncatedSearch: webTruncatedTextStyle(colors, WEB_TRUNCATED_MARGIN_TOP),
    webSources: scrollCap,
    webSourceRow: webSourceRowStyle(),
    webSourceBody: { flex: 1, minWidth: 0 },
    webSourceIndex: webSourceIndexTextStyle(colors),
    webSourceLink: webSourceLinkTextStyle(colors),
    webSnippet: webSnippetTextStyle(colors),
    webPublished: webPublishedTextStyle(colors),
  };
}

type BlockStyles = ReturnType<typeof buildStyles>;

/**
 * The goal tools' result block: DSH's `DetailsRow` for `create_goal` / `get_goal`
 * / `update_goal` — the objective, then 状态 / 执行轮次 (/ 受阻原因) as a
 * label | value list. `{goal: null}` is DSH's 「没有目标」 line.
 */
function GoalBlockView({
  data,
  summary,
  styles,
  onCollapse,
}: {
  data: GoalBlockData;
  summary: string;
  styles: BlockStyles;
  onCollapse: (event?: unknown) => void;
}) {
  return (
    <View style={styles.block}>
      <ScrollView
        style={styles.expandedScroll}
        contentContainerStyle={styles.goalItem}
        nestedScrollEnabled
        testID={SCROLL_BOX_TEST_ID}
      >
        <Pressable onPress={onCollapse}>
          {data.empty ? (
            <Text style={styles.goalValue}>{summary}</Text>
          ) : (
            <>
              <Text style={styles.goalTitle} selectable>
                {data.objective}
              </Text>
              <View style={styles.goalFields}>
                {data.fields.map((field) => (
                  <View key={field.label} style={styles.goalField}>
                    <Text style={styles.goalLabel}>{field.label}</Text>
                    <Text style={styles.goalValue} selectable>
                      {field.value}
                    </Text>
                  </View>
                ))}
              </View>
            </>
          )}
        </Pressable>
      </ScrollView>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Generic fields (rows with no detail shape)                                 */
/* -------------------------------------------------------------------------- */

/**
 * The generic block for a tool Paseo has no detail shape for (every MCP call):
 * the call's arguments, then a structured result, split into facts rows, prose
 * blocks and JSON code blocks (see `ToolFieldsData`).
 */
function ToolFieldsView({
  data,
  styles,
  colors,
  resultCaption,
  onCollapse,
}: {
  data: ToolFieldsData;
  styles: BlockStyles;
  colors: TokenColors;
  resultCaption: string;
  onCollapse: (event?: unknown) => void;
}) {
  const blocks: ReactNode[] = [];
  // Consecutive facts share one wrapping row (`键: 值` ×N); a prose or JSON entry
  // ends the run, so the payload's own key order survives the grouping.
  const push = (entries: ToolFieldEntry[], section: string) => {
    let facts: ToolFieldEntry[] = [];
    let run = 0;
    const flush = () => {
      if (facts.length === 0) return;
      const key = `${section}-facts-${String(run)}`;
      blocks.push(
        <View key={key} style={styles.fieldFacts}>
          {facts.map((entry, index) => (
            <View key={`${entry.label}-${String(index)}`} style={styles.fieldFact}>
              <Text style={styles.fieldFactLabel}>{entry.label}</Text>
              <Text style={styles.fieldFactValue} selectable>
                {entry.value}
              </Text>
            </View>
          ))}
        </View>,
      );
      facts = [];
      run += 1;
    };
    for (const entry of entries) {
      if (entry.kind === "fact") {
        facts.push(entry);
        continue;
      }
      flush();
      blocks.push(
        <View key={`${section}-${entry.kind}-${String(blocks.length)}`} style={styles.fieldBlock}>
          {entry.label === "" ? null : <Text style={styles.fieldLabel}>{entry.label}</Text>}
          {/* Prose stays prose (never re-serialized), JSON gets semantic highlighting;
              both live inside the single outer expanded ScrollView so vertical
              scrolling is never nested. */}
          {entry.kind === "text" ? (
            <Text style={styles.fieldText} selectable>
              {entry.value}
            </Text>
          ) : (
            <View style={styles.code}>
              <HighlightedCode
                text={entry.value}
                lang="json"
                colors={colors}
                baseStyle={styles.codeText}
                selectable
              />
            </View>
          )}
        </View>,
      );
    }
    flush();
  };
  push(data.args, "args");
  if (data.result.length > 0) {
    // The caption separates the two halves unless every entry belongs to the
    // result half (`data.hideResultCaption`).
    if (data.hideResultCaption !== true) {
      blocks.push(
        <Text key="result-caption" style={styles.fieldCaption}>
          {resultCaption}
        </Text>,
      );
    }
    push(data.result, "result");
  }
  if (data.receipt !== "") {
    // L2's one-line compression of the result (「已发送」/「超时」).
    blocks.push(
      <Text key="receipt" style={styles.fieldReceipt} selectable>
        {data.receipt}
      </Text>,
    );
  }
  return (
    <View style={styles.block}>
      {/* The complete result JSON, not the flattened display: the copy control
          keeps a structured result from losing information when laid out as rows. */}
      {data.copyText === "" ? null : <CardHead lang="" title="" text={data.copyText} styles={styles} />}
      <ScrollView
        style={styles.expandedScroll}
        contentContainerStyle={styles.fieldsItem}
        nestedScrollEnabled
        testID={SCROLL_BOX_TEST_ID}
      >
        <Pressable onPress={onCollapse} style={styles.fieldsInner}>
          {blocks}
        </Pressable>
      </ScrollView>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Cross-turn callId generation tracking                                      */
/* -------------------------------------------------------------------------- */

interface ToolCallSignature {
  name: string;
  kind: ToolCallData["kind"];
  detailSig: string;
  /** True when summary/args can legitimately change between running and terminal (`goal`/`team`/mapped `generic`). */
  flexibleDetail: boolean;
}

interface CallGenEntry {
  gen: number;
  /** Mounted React instance token currently owning this generation, or null when unmounted. */
  liveToken: symbol | null;
  status: ToolCallData["status"];
  firstTs: number;
  lastTs: number;
  terminalTs: number;
  signature: ToolCallSignature;
}

interface CallIdTrack {
  entries: CallGenEntry[];
  renderClaims: Map<symbol, number>;
  nextGen: number;
}

interface BoundToolRow {
  agentId: string;
  callId: string;
  gen: number;
  rowKey: string;
}

const MAX_AGENTS = 200;
const MAX_CALL_TRACK = 500;
const MAX_GENS_PER_CALL = 32;

const callTrackByAgent = new Map<string, Map<string, CallIdTrack>>();
let claimCleanupScheduled = false;

/** Reset module-level callId generation tracking state. Intended for offline tests. */
export function resetToolRowIdentityForTests(): void {
  callTrackByAgent.clear();
  claimCleanupScheduled = false;
}

function scheduleRenderClaimCleanup(): void {
  if (claimCleanupScheduled) return;
  claimCleanupScheduled = true;
  Promise.resolve().then(() => {
    claimCleanupScheduled = false;
    for (const [agentId, agentTracks] of callTrackByAgent) {
      for (const [callId, track] of agentTracks) {
        track.renderClaims.clear();
        if (track.entries.length === 0 && track.nextGen === 0) {
          agentTracks.delete(callId);
        }
      }
      if (agentTracks.size === 0) {
        callTrackByAgent.delete(agentId);
      }
    }
  });
}

function toolCallSignature(data: ToolCallData): ToolCallSignature {
  // Typed tools (terminal/diff/read/search/web) expose their invariant request
  // subject (`command` / `filePath` / `query` / `url`) via `headline || summary`
  // even when `metadata.description` only arrives on the completed snapshot.
  const subject = data.headline || data.summary;
  if (data.kind !== "generic") {
    return {
      name: data.name,
      kind: data.kind,
      detailSig: subject,
      flexibleDetail: false,
    };
  }
  // Generic cards whose summary/fields can be replaced by result mappers
  // (`goal`, `team`, `subagent`, or `fields`-backed MCP/mapped tools) match on `(name, kind)`.
  if (
    data.goal !== null ||
    data.team !== null ||
    data.fields !== null ||
    data.subagent !== null ||
    data.failed
  ) {
    return {
      name: data.name,
      kind: data.kind,
      detailSig: "",
      flexibleDetail: true,
    };
  }
  return {
    name: data.name,
    kind: data.kind,
    detailSig: subject,
    flexibleDetail: false,
  };
}

function signaturesCompatible(a: ToolCallSignature, b: ToolCallSignature): boolean {
  if (a.name !== b.name || a.kind !== b.kind) return false;
  if (a.flexibleDetail || b.flexibleDetail) return true;
  return a.detailSig === b.detailSig;
}

function getOrCreateAgentTracks(agentId: string): Map<string, CallIdTrack> {
  let agentTracks = callTrackByAgent.get(agentId);
  if (agentTracks !== undefined) return agentTracks;
  if (callTrackByAgent.size >= MAX_AGENTS) {
    const oldestAgent = callTrackByAgent.keys().next().value;
    if (oldestAgent !== undefined) callTrackByAgent.delete(oldestAgent);
  }
  agentTracks = new Map<string, CallIdTrack>();
  callTrackByAgent.set(agentId, agentTracks);
  return agentTracks;
}

function getOrCreateCallTrack(agentId: string, callId: string): CallIdTrack {
  const agentTracks = getOrCreateAgentTracks(agentId);
  let track = agentTracks.get(callId);
  if (track !== undefined) return track;
  if (agentTracks.size >= MAX_CALL_TRACK) {
    const oldestCallId = agentTracks.keys().next().value;
    if (oldestCallId !== undefined) agentTracks.delete(oldestCallId);
  }
  track = {
    entries: [],
    renderClaims: new Map<symbol, number>(),
    nextGen: 0,
  };
  agentTracks.set(callId, track);
  return track;
}

function isGenBusy(track: CallIdTrack, gen: number, selfToken: symbol): boolean {
  for (const entry of track.entries) {
    if (entry.gen === gen && entry.liveToken !== null && entry.liveToken !== selfToken) {
      return true;
    }
  }
  for (const [claimToken, claimGen] of track.renderClaims) {
    if (claimToken !== selfToken && claimGen === gen) {
      return true;
    }
  }
  return false;
}

function getOrCreateGenEntry(
  track: CallIdTrack,
  gen: number,
  status: ToolCallData["status"],
  tsMs: number,
  signature: ToolCallSignature,
): CallGenEntry {
  const existing = track.entries.find((entry) => entry.gen === gen);
  if (existing !== undefined) return existing;
  if (track.entries.length >= MAX_GENS_PER_CALL) {
    const evictIndex = track.entries.findIndex((entry) => entry.liveToken === null);
    track.entries.splice(evictIndex >= 0 ? evictIndex : 0, 1);
  }
  const entry: CallGenEntry = {
    gen,
    liveToken: null,
    status,
    firstTs: tsMs,
    lastTs: tsMs,
    terminalTs: status !== "running" && tsMs > 0 ? tsMs : 0,
    signature,
  };
  track.entries.push(entry);
  return entry;
}

function formatToolRowKey(callId: string, gen: number): string {
  return gen === 0 ? `tool:${callId}` : `tool:${callId}#${gen}`;
}

function resolveToolCallGen(
  agentId: string,
  callId: string,
  data: ToolCallData,
  tsMs: number,
  token: symbol,
): number {
  const existing = callTrackByAgent.get(agentId)?.get(callId);
  const incomingSig = toolCallSignature(data);
  const isTerminal = data.status !== "running";
  let gen: number;

  if (existing === undefined) {
    gen = 0;
  } else {
    const claimed = existing.renderClaims.get(token);
    if (claimed !== undefined) return claimed;

    let maxClaimedGen = -1;
    for (const claimGen of existing.renderClaims.values()) {
      if (claimGen > maxClaimedGen) maxClaimedGen = claimGen;
    }
    const freshGen = Math.max(existing.nextGen, maxClaimedGen + 1);

    let matchedGen: number | null = null;

    // 1. Exact terminal-timestamp match on a free terminal generation: scrolling an
    //    earlier completed row back into view keeps its original key even while a
    //    newer turn reusing the same callId is still mounted.
    if (isTerminal && tsMs > 0) {
      for (let i = existing.entries.length - 1; i >= 0; i -= 1) {
        const entry = existing.entries[i]!;
        if (
          entry.status !== "running" &&
          entry.terminalTs === tsMs &&
          !isGenBusy(existing, entry.gen, token) &&
          signaturesCompatible(entry.signature, incomingSig)
        ) {
          matchedGen = entry.gen;
          break;
        }
      }
    }

    // 2. Unmounted running generation with a compatible call signature: matches an
    //    off-screen row that either returns still running or returns after completing/
    //    failing off-screen — even when an older turn's row with the same callId is
    //    still mounted. Incompatible signatures (a different call reusing callId)
    //    fall through and get a fresh generation.
    if (matchedGen === null) {
      for (let i = existing.entries.length - 1; i >= 0; i -= 1) {
        const entry = existing.entries[i]!;
        const tsOrderOk = tsMs === 0 || entry.firstTs === 0 || tsMs >= entry.firstTs;
        if (
          entry.status === "running" &&
          tsOrderOk &&
          !isGenBusy(existing, entry.gen, token) &&
          signaturesCompatible(entry.signature, incomingSig)
        ) {
          matchedGen = entry.gen;
          break;
        }
      }
    }

    // 3. Fallback when timestamps are unavailable (`tsMs === 0`): reuse a free
    //    timestampless terminal entry with a compatible signature.
    if (matchedGen === null && isTerminal && tsMs === 0) {
      for (let i = existing.entries.length - 1; i >= 0; i -= 1) {
        const entry = existing.entries[i]!;
        if (
          entry.status !== "running" &&
          entry.terminalTs === 0 &&
          !isGenBusy(existing, entry.gen, token) &&
          signaturesCompatible(entry.signature, incomingSig)
        ) {
          matchedGen = entry.gen;
          break;
        }
      }
    }

    gen = matchedGen !== null ? matchedGen : freshGen;
  }

  const track = existing ?? getOrCreateCallTrack(agentId, callId);
  track.renderClaims.set(token, gen);
  scheduleRenderClaimCleanup();
  return gen;
}

/* -------------------------------------------------------------------------- */
/* Row                                                                        */
/* -------------------------------------------------------------------------- */

export function InlineToolCall({
  theme,
  layout,
  item,
  agentId,
  timestamp,
}: PluginTimelineItemProps<ToolCallData>) {
  const data = item.data;
  const [expanded, setExpanded] = useState(false);
  const collapseBody = useCallback((event?: unknown) => {
    if (shouldCollapseOnBodyPress(event)) setExpanded(false);
  }, []);

  const tsMs = normalizeTimestampMs(timestamp);
  const tokenRef = useRef<symbol | null>(null);
  if (tokenRef.current === null) tokenRef.current = Symbol("tool-row");
  const token = tokenRef.current;
  const boundRef = useRef<BoundToolRow | null>(null);

  const incomingSig = toolCallSignature(data);
  let boundGen: number | null = null;
  let rowKey: string;
  if (data.callId !== "" && agentId !== "") {
    const bound = boundRef.current;
    if (bound !== null && bound.agentId === agentId && bound.callId === data.callId) {
      boundGen = bound.gen;
      rowKey = bound.rowKey;
    } else {
      boundGen = resolveToolCallGen(agentId, data.callId, data, tsMs, token);
      rowKey = formatToolRowKey(data.callId, boundGen);
    }
  } else {
    rowKey = `tool:${String(tsMs)}:${data.name}:${data.summary}:${data.headline.slice(0, 64)}`;
  }

  useEffect(() => {
    if (data.callId === "" || agentId === "" || boundGen === null) {
      boundRef.current = null;
      return;
    }
    const gen = boundGen;
    boundRef.current = { agentId, callId: data.callId, gen, rowKey };
    const track = getOrCreateCallTrack(agentId, data.callId);
    const entry = getOrCreateGenEntry(track, gen, data.status, tsMs, incomingSig);
    entry.liveToken = token;
    track.renderClaims.delete(token);
    track.nextGen = Math.max(track.nextGen, gen + 1);
    return () => {
      if (entry.liveToken === token) {
        entry.liveToken = null;
      }
      track.renderClaims.delete(token);
    };
  }, [agentId, data.callId]);

  const sigKey = `${incomingSig.name}\0${incomingSig.kind}\0${incomingSig.flexibleDetail ? "1" : "0"}\0${incomingSig.detailSig}`;
  useEffect(() => {
    if (data.callId === "" || agentId === "" || boundGen === null) return;
    const track = getOrCreateCallTrack(agentId, data.callId);
    const gen =
      boundRef.current !== null &&
      boundRef.current.agentId === agentId &&
      boundRef.current.callId === data.callId
        ? boundRef.current.gen
        : boundGen;
    const entry = getOrCreateGenEntry(track, gen, data.status, tsMs, incomingSig);
    entry.status = data.status;
    if (tsMs > 0) {
      if (entry.firstTs === 0 || tsMs < entry.firstTs) entry.firstTs = tsMs;
      if (tsMs > entry.lastTs) entry.lastTs = tsMs;
      if (data.status !== "running") {
        entry.terminalTs = tsMs;
      }
    }
    if (!incomingSig.flexibleDetail || entry.signature.flexibleDetail) {
      entry.signature = incomingSig;
    }
  }, [agentId, data.callId, data.status, tsMs, sigKey]);

  const hasBody = data.body !== "";
  // Expanding is only worth offering when the block below actually has
  // something in it — `hasDetail` is computed in the data layer.
  const canExpand = data.hasDetail;
  // A failure's reason, in the head's second half: DSH shows it there
  // (`.errorSummary`) instead of the normal summary, because the block below
  // may carry what was *requested* rather than what went wrong.
  const errorLine = data.error === "" ? "" : data.error.split("\n")[0];
  const errorHeadline = data.failed && errorLine !== "";
  const normalizedName = data.name.trim().toLowerCase();
  const needsAgSummary =
    normalizedName === "run_command" &&
    !data.titled &&
    !errorHeadline &&
    data.headline !== "" &&
    typeof agentId === "string" &&
    agentId !== "";
  const agSummary = useAntigravityCommandSummary(
    agentId,
    data.headline,
    data.status,
    rowKey,
    needsAgSummary,
  );

  const effectiveSummary = agSummary !== "" ? agSummary : data.summary;
  const effectiveTitled = data.titled || agSummary !== "";
  const headSummary = errorHeadline ? (data.errorShort !== "" ? data.errorShort : errorLine) : effectiveSummary;
  // Once expanded the block carries the subject in full, so a row whose title
  // *is* that subject does not repeat a compact copy of it above.
  const showSummary = headSummary !== "" && !(expanded && !effectiveTitled && data.headline !== "");
  const compact = layout.compact;
  const iconSize = compact ? 14 : 16;
  const running = shouldPulse(data.status, useRowPulse(agentId, timestamp, rowKey));
  const iconStatus = resolveRowIconStatus(data.status, running);
  const stat = diffStat(data);
  const terminal = data.kind === "terminal";
  const errorBlock = data.error !== "" && !data.body.includes(data.error) ? data.error : "";
  const colors = theme.colors;
  // The leading icon is the row's only state signal: red when the call failed,
  // green when an edit completed, muted otherwise. The label and the summary stay
  // muted on every state (`client/tokens.ts`).
  const iconColor = rowIconColor(colors, data.status, data.diff);
  const styleState = useSettings(timelineStyleSettings);
  const style = styleState.status === "ready" ? styleState.values : TIMELINE_STYLE_DEFAULTS;
  const { height: windowHeight } = useWindowDimensions();
  const commandMaxHeight = resolveCommandMaxHeight(style, windowHeight);
  const expandedMaxHeight = style.expandedMaxHeight ?? EXPANDED_MAX_HEIGHT_DEFAULT;
  // Subscribe via `useLocaleText()` so language changes immediately re-render
  // this row (including tool labels and all nested block views reading `blockCopy()`).
  const text = useLocaleText();
  const displayLabel =
    normalizedName === "mcp_call_tool" || normalizedName === "agent_message"
      ? data.label
      : Object.prototype.hasOwnProperty.call(text.toolLabels, data.name)
        ? text.toolLabels[data.name]
        : Object.prototype.hasOwnProperty.call(text.toolLabels, normalizedName)
          ? text.toolLabels[normalizedName]
          : (paseoMcpLabel(data.name) ?? agyFastToolLabel(data.name) ?? data.label);

  const TOOL_BLOOM_TRAIL_WIDTH = 9;
  const stream = useInkStreamReveal({
    agentId,
    timestamp,
    rowKey,
    liveHint: data.status === "running",
    label: displayLabel,
    summary: showSummary ? headSummary : "",
    // Let fast completed tools finish their gentle rgba bloom instead of
    // teleporting to 100% after 10ms; only snap immediately on failure/cancel.
    snapOnSettle: false,
    snapNow: data.failed || data.status === "canceled",
    trailWidth: TOOL_BLOOM_TRAIL_WIDTH,
    leadDelayMs: 25,
  });

  const styles = useMemo(
    () => buildStyles(colors, StyleSheet.hairlineWidth, style, commandMaxHeight, expandedMaxHeight),
    [colors, style, commandMaxHeight, expandedMaxHeight],
  );

  const plainDiffLang = data.diff ? extensionOf(data.headline) : undefined;
  const plainDiffMode = data.diff ? highlightModeFor(plainDiffLang) : "plain";
  const plainDiffRows = useMemo(
    () =>
      data.diff && hasBody
        ? data.body.split("\n").map((line) => {
            const added = line.startsWith("+");
            const removed = line.startsWith("-");
            return {
              kind: added ? "add" : removed ? "del" : "context",
              text: added || removed ? line.slice(1) : line,
            };
          })
        : [],
    [data.diff, hasBody, data.body],
  );
  const genericLang =
    !terminal &&
    data.search === null &&
    data.read === null &&
    data.diffBlock === null &&
    data.web === null &&
    !data.diff &&
    hasBody
      ? inferLang(data.headline, data.body)
      : undefined;

  const statusLabel = iconStatus === "idle" ? "" : text.rowStatus[iconStatus];
  const headAccessibilityLabel = [displayLabel, headSummary, statusLabel].filter(Boolean).join(" ");

  return (
    <RowEntrance
      agentId={agentId}
      timestamp={timestamp}
      rowKey={rowKey}
      liveHint={data.status === "running" || data.subagent?.status === "running"}
    >
      {data.subagent !== null ? (
        <View style={styles.root}>
          <SubagentCard
            subagent={data.subagent}
            agentId={agentId}
            callId={data.callId}
            colors={colors}
            hairline={StyleSheet.hairlineWidth}
            expandedMaxHeight={expandedMaxHeight}
            compact={compact}
            expanded={expanded}
            onToggle={() => setExpanded((value) => !value)}
            error={data.error}
            errorShort={data.errorShort}
            errorHint={data.errorHint}
            errorCode={data.errorCode}
            errorName={data.errorName}
            fallbackBody={data.body}
          />
        </View>
      ) : (
        <View style={styles.root}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={headAccessibilityLabel}
            onPress={() => {
              if (canExpand) setExpanded((value) => !value);
            }}
            style={styles.head}
          >
            {/* The glyph carries the state: red for a failure, green for a completed
                edit, plus a bottom-right corner badge (blue ring while running, bare
                green checkmark when completed, red cross on failure). A Paseo-owned
                tool with no glyph of its own draws Paseo's mark, tinted the same. */}
            <RowStatusIcon
              status={iconStatus}
              size={iconSize}
              colors={colors}
              accessibilityLabel={statusLabel || undefined}
            >
              {data.paseoMark ? (
                <Image
                  source={{ uri: PASEO_MARK_ICON }}
                  style={{ width: iconSize, height: iconSize }}
                  tintColor={iconColor}
                />
              ) : (
                <Icon name={data.icon} size={iconSize} color={iconColor} />
              )}
            </RowStatusIcon>
            <TextShimmer
              active={running}
              contentStyle={styles.text}
              highlightColor={colors.foreground}
              surfaceColor={colors.surface0}
            >
              {(color) => (
                <>
                  <Text style={[styles.label, color === null ? null : { color }]}>
                    {renderInkTrailText(
                      displayLabel,
                      stream.labelProgress,
                      colors.foreground,
                      color,
                      0,
                      colors.foregroundMuted,
                      TOOL_BLOOM_TRAIL_WIDTH,
                    )}
                  </Text>
                  {showSummary && stream.showSeparator ? (
                    <>
                      {/* A 2x2 square with 1px corners, not a dot — DSH's separator
                          between the title and its summary. */}
                      <View style={styles.sep} />
                      <Text
                        style={[
                          styles.summary,
                          errorHeadline ? styles.summaryError : null,
                          color === null ? null : { color },
                        ]}
                        numberOfLines={1}
                      >
                        {renderInkTrailText(
                          headSummary,
                          stream.summaryProgress,
                          colors.foreground,
                          color,
                          0,
                          errorHeadline ? colors.statusDanger : colors.foregroundMuted,
                          TOOL_BLOOM_TRAIL_WIDTH,
                        )}
                      </Text>
                    </>
                  ) : null}
                  {stat !== null && stream.showStat ? (
                    <>
                      <Text style={[styles.statAdded, color === null ? null : { color }]}>
                        {`+${stat.added}`}
                      </Text>
                      <Text style={[styles.statRemoved, color === null ? null : { color }]}>
                        {` -${stat.removed}`}
                      </Text>
                    </>
                  ) : null}
                </>
              )}
            </TextShimmer>
            {data.subagentChips !== null ? (
              <SubagentStatusChips
                chips={data.subagentChips}
                colors={colors}
                hasSummary={showSummary}
                compact={compact}
              />
            ) : null}
          </Pressable>
          {expanded && canExpand ? (
            <View style={styles.body}>
              <Pressable style={styles.bodyInner} onPress={collapseBody}>
                {/* The whole failure reason first, selectable. */}
                {data.errorHint !== "" ? (
                  <Text style={styles.hintText} selectable>
                    {data.errorHint}
                    <Text style={styles.hintCode}>{`  ${data.errorCode}${data.errorName === undefined ? "" : `（${data.errorName}）`}`}</Text>
                  </Text>
                ) : null}
                {data.errorHint === "" && data.errorCode !== "" && data.errorName !== undefined ? (
                  <Text style={styles.hintText} selectable>
                    <Text style={styles.hintCode}>{`${data.errorCode}（${data.errorName}）`}</Text>
                  </Text>
                ) : null}
                {errorBlock !== "" ? (
                  <ScrollView
                    style={styles.expandedScroll}
                    nestedScrollEnabled
                    testID={SCROLL_BOX_TEST_ID}
                  >
                    <Pressable onPress={collapseBody}>
                      <Text style={styles.errorText} selectable>
                        {errorBlock}
                      </Text>
                    </Pressable>
                  </ScrollView>
                ) : null}
                {data.goal !== null ? (
                  <GoalBlockView data={data.goal} summary={data.summary} styles={styles} onCollapse={collapseBody} />
                ) : null}
                {data.team !== null ? (
                  <TeamBlockView
                    data={data.team}
                    hairline={StyleSheet.hairlineWidth}
                    maxHeight={expandedMaxHeight}
                    onCollapse={collapseBody}
                    colors={{
                      ...colors,
                      foregroundMuted: colors.foregroundMuted,
                      extraMuted: (colors as unknown as Record<string, string | undefined>).foregroundExtraMuted ?? colors.foregroundMuted,
                      running: ringColorFor(colors.surface0),
                      warning: colors.statusWarning,
                      border: colors.border,
                    }}
                  />
                ) : null}
                {data.fields !== null ? (
                  <ToolFieldsView
                    data={data.fields}
                    styles={styles}
                    colors={colors}
                    resultCaption={text.bodyLabels.result}
                    onCollapse={collapseBody}
                  />
                ) : null}
                {terminal ? (
                  <View style={styles.block}>
                    <View style={styles.commandRow}>
                      <ScrollView
                        style={[styles.commandScroll, { flex: 1, minWidth: 0 }]}
                        contentContainerStyle={styles.command}
                        nestedScrollEnabled
                        testID={SCROLL_BOX_TEST_ID}
                      >
                        <Pressable onPress={collapseBody}>
                          <HighlightedCode
                            text={data.headline}
                            lang="shell"
                            colors={colors}
                            baseStyle={styles.commandText}
                            selectable
                          />
                        </Pressable>
                      </ScrollView>
                      {hasBody && data.status !== "running" && data.body.trim() !== "" ? (
                        <CopyControl text={data.body} style={styles.cardHeadAction} />
                      ) : null}
                    </View>
                    {hasBody ? <View style={styles.divider} /> : null}
                    {hasBody ? (
                      <ScrollView
                        style={styles.terminalOutput}
                        contentContainerStyle={styles.output}
                        nestedScrollEnabled
                        testID={SCROLL_BOX_TEST_ID}
                      >
                        <Pressable onPress={collapseBody}>
                          <Text style={styles.outputText} selectable>
                            {data.body}
                          </Text>
                        </Pressable>
                      </ScrollView>
                    ) : null}
                  </View>
                ) : data.search !== null ? (
                  <SearchBlockView data={data.search} styles={styles} onCollapse={collapseBody} />
                ) : data.read !== null ? (
                  <ReadBlockView data={data.read} styles={styles} colors={colors} onCollapse={collapseBody} />
                ) : data.diffBlock !== null ? (
                  <DiffBlockView data={data.diffBlock} styles={styles} colors={colors} onCollapse={collapseBody} />
                ) : data.web !== null ? (
                  <WebBlockView data={data.web} styles={styles} onCollapse={collapseBody} />
                ) : data.diff ? (
                  <View style={styles.block}>
                    {data.headline !== "" ? (
                      <View style={styles.code}>
                        <Text style={styles.codeText} selectable>
                          {data.headline}
                        </Text>
                      </View>
                    ) : null}
                    {hasBody ? (
                      <ScrollView
                        style={styles.expandedScroll}
                        contentContainerStyle={styles.diffBody}
                        nestedScrollEnabled
                        testID={SCROLL_BOX_TEST_ID}
                      >
                        <Pressable onPress={collapseBody}>
                          <DiffRows
                            rows={plainDiffRows}
                            styles={styles}
                            keyPrefix="plain"
                            mode={plainDiffMode}
                            lang={plainDiffLang}
                            colors={colors}
                          />
                        </Pressable>
                      </ScrollView>
                    ) : null}
                  </View>
                ) : data.headline !== "" || hasBody ? (
                  <View style={styles.block}>
                    {hasBody && data.body.trim() !== "" ? (
                      <CardHead lang="" title="" text={data.body} styles={styles} />
                    ) : null}
                    <ScrollView
                      style={styles.codeScroll}
                      contentContainerStyle={styles.code}
                      nestedScrollEnabled
                      testID={SCROLL_BOX_TEST_ID}
                    >
                      <Pressable onPress={collapseBody}>
                        {data.headline !== "" ? (
                          <Text style={styles.codeText} selectable>
                            {data.headline}
                          </Text>
                        ) : null}
                        {hasBody ? (
                          <HighlightedCode
                            text={data.body}
                            lang={genericLang}
                            colors={colors}
                            baseStyle={styles.codeText}
                            selectable
                          />
                        ) : null}
                      </Pressable>
                    </ScrollView>
                  </View>
                ) : null}
              </Pressable>
            </View>
          ) : null}
        </View>
      )}
    </RowEntrance>
  );
}
