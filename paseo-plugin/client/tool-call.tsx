/**
 * Inline tool-call row for the Paseo timeline.
 *
 * Paseo's stock tool row is a single line that expands on click. This keeps
 * that shape and its icon, and expands downward the way the reasoning row
 * does: the block below the row is a card at full width, not a squeeze beside
 * the icon and label.
 *
 * The row head and the card follow DSH's own metrics (`./tokens`): a fixed
 * 24px line, a 13px UI-font summary, a 2x2 separator square, 16px card radius
 * on a card surface, and a `+A -R` suffix on diff rows. A command row splits
 * into a command banner, a hairline, and an output region; a diff row gives
 * every line a 3px semantic left bar and an 8%/12% wash.
 *
 * `data.kind` is DSH's own block dispatch, computed in `./tool-call-data`:
 * `terminal` (command banner + output), `diff` (hunks + `@@`), `read` (numbered
 * lines), `search` (grep/glob groups), `web` (citations / fetch status) and
 * `generic` (one code surface). Each structured block also carries its payload;
 * when that payload is missing the renderer falls back to the plain text body
 * this row showed before those blocks existed, so an unrecognized meta is a
 * plainer row rather than an empty card.
 *
 * While the tool is running the row pulses (see `./shimmer`), matching the
 * "still working" feel Paseo's own loading rows have.
 *
 * @module dsh-paseo/client/tool-call
 */
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, copyText } from "@getpaseo/plugin/client/react-native";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { shouldPulse, useRowPulse } from "./newest";
import { blockCopy, type ReadBlockData, type SearchBlockData, type ToolCallData, type WebBlockData } from "./tool-call-data";
import { TextShimmer } from "./text-shimmer";
import {
  BODY_INDENT,
  type TokenColors,
  WEB_META_GAP,
  WEB_TRUNCATED_MARGIN_TOP,
  cardHeadActionsStyle,
  cardHeadActionTextStyle,
  cardHeadHeadingStyle,
  cardHeadLangTextStyle,
  cardHeadStatusTextStyle,
  cardHeadStyle,
  cardHeadTitleTextStyle,
  cardStyle,
  codeRegionStyle,
  codeTextStyle,
  commandRegionStyle,
  commandTextStyle,
  DIFF_LINE_PADDING_HORIZONTAL,
  READ_BODY_PADDING_BOTTOM,
  READ_BODY_PADDING_HORIZONTAL,
  READ_BODY_PADDING_TOP,
  SEARCH_BODY_PADDING_BOTTOM,
  SEARCH_BODY_PADDING_RIGHT,
  SEARCH_BODY_PADDING_TOP,
  diffBodyStyle,
  diffBodyTextStyle,
  diffChromeTextStyle,
  diffLineStyle,
  diffMarkerTextStyle,
  diffRowStyle,
  diffStat,
  diffStatTextStyle,
  dividerStyle,
  FOLD_LINES,
  foldWindow,
  isLightSurface,
  outputRegionStyle,
  outputTextStyle,
  readExpandTextStyle,
  readGutterTextStyle,
  readLineStyle,
  readLineTextStyle,
  rowHeadStyle,
  rowIconColor,
  rowLabelTextStyle,
  rowRootStyle,
  searchEmptyTextStyle,
  searchExpandTextStyle,
  searchFileCountTextStyle,
  searchFileHeadStyle,
  searchFilePathTextStyle,
  searchHeadStyle,
  searchLineNumberTextStyle,
  searchLineStyle,
  searchLineTextStyle,
  searchSummaryTextStyle,
  separatorStyle,
  summaryTextStyle,
  webCardBodyStyle,
  webFetchStyle,
  webMetaTextStyle,
  webPublishedTextStyle,
  webSnippetTextStyle,
  webSourceIndexTextStyle,
  webSourceLinkTextStyle,
  webSourceRowStyle,
  webSourcesStyle,
  webTruncatedTextStyle,
  webUrlTextStyle,
} from "./tokens";

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Copy-to-clipboard with DSH's own feedback: the label flips for a second.
 *
 * A refused copy (no clipboard, denied permission) leaves the label alone — the
 * same thing DSH's control does — so the row stays usable instead of claiming a
 * copy that did not happen.
 */
function useCopy(text: string): { copied: boolean; onCopy: () => void } {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    if (copied) return;
    copyText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1000);
      },
      () => {},
    );
  }, [copied, text]);
  return { copied, onCopy };
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
      onPress={(event) => {
        // The whole row is a Pressable too; without this a copy would also
        // collapse the card it was clicked in (RN Web bubbles the click).
        event.stopPropagation();
        onCopy();
      }}
    >
      <Text style={style}>{label}</Text>
    </Pressable>
  );
}

/**
 * The one fold control every capped block shares.
 *
 * DSH has no separate "expand all" button: the same control reads
 * `… 其余 N 行` while folded and `收起` once open.
 */
function FoldToggle({
  hidden,
  expanded,
  onToggle,
  textStyle,
  accessibilityLabel,
}: {
  hidden: number;
  expanded: boolean;
  onToggle: () => void;
  textStyle: StyleProp<TextStyle>;
  accessibilityLabel: string;
}) {
  const copy = blockCopy();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <Text style={textStyle}>{expanded ? copy.collapse : copy.expandRest(hidden)}</Text>
    </Pressable>
  );
}

/** DSH's `CodeToolbar`: language tag, title, status, copy. */
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
 * rows live in one. The diff and terminal surfaces keep wrapping — that is what
 * the row already did before these blocks existed.
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
      contentContainerStyle={contentStyle}
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

/** Flatten a search card into rows, dropping a collapsed group's matches. */
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
  colors,
}: {
  data: SearchBlockData;
  styles: BlockStyles;
  colors: TokenColors;
}) {
  const copy = blockCopy();
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set<number>());
  const rows = useMemo(() => searchRows(data, collapsed), [data, collapsed]);
  const folded = foldWindow(rows.length, FOLD_LINES.search, expanded);
  const head = folded.capped ? rows.slice(0, folded.headLines) : rows;
  let tail: SearchRow[] = folded.capped ? rows.slice(rows.length - folded.tailLines) : [];
  // DSH re-draws a group's header when the fold drops it and the tail starts
  // mid-group: a bare match row with no path above it reads as a different
  // file's result. The header takes the leading match's slot, so the tail keeps
  // the same number of rows.
  if (folded.capped && tail.length > 0) {
    const lead = tail[0];
    if (
      lead.type === "match" &&
      !head.some((row) => row.type === "file" && row.index === lead.fileIndex)
    ) {
      const header = rows.find((row) => row.type === "file" && row.index === lead.fileIndex);
      if (header !== undefined) tail = [header, ...tail.slice(1)];
    }
  }
  const summary =
    data.shape === "paths"
      ? copy.pathsSummary(data.shown, data.total, data.truncated)
      : copy.matchesSummary(data.shown, data.total, data.files.length, data.truncated);

  const renderRow = (row: SearchRow, key: string) => {
    if (row.type === "path") {
      return (
        <View key={key} style={styles.searchLine}>
          <Text style={styles.searchLineText}>{row.path}</Text>
        </View>
      );
    }
    if (row.type === "match") {
      return (
        <View key={key} style={styles.searchLine}>
          {/* The number is DSH's `<span class="lineNumber">`, dimmed so the
              match text stays salient. Nothing highlights the matched
              substring — DSH does not, and inventing it would make our rows
              disagree with the tool the model saw. */}
          <Text style={styles.searchLineNumber}>{`${row.lineNumber}: `}</Text>
          <Text style={styles.searchLineText}>{row.line}</Text>
        </View>
      );
    }
    return (
      <Pressable
        key={key}
        accessibilityRole="button"
        accessibilityLabel={`${row.path} ${row.count}`}
        onPress={(event) => {
          event.stopPropagation();
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
    <View style={styles.card}>
      <View style={styles.searchHead}>
        <Text style={styles.searchSummary} numberOfLines={1} ellipsizeMode="tail">
          {summary}
        </Text>
        <CopyControl text={data.text} style={styles.cardHeadAction} />
      </View>
      {rows.length === 0 ? (
        <Text style={styles.searchEmpty}>{copy.noResults}</Text>
      ) : (
        <CodeScroller style={styles.searchScroll} contentStyle={styles.searchBody}>
          <View>
            {head.map((row, index) => renderRow(row, `head:${index}`))}
            {folded.hidden > 0 ? (
              <FoldToggle
                hidden={folded.hidden}
                expanded={expanded}
                onToggle={() => setExpanded((value) => !value)}
                textStyle={styles.searchExpand}
                accessibilityLabel={expanded ? copy.collapseAria : copy.expandAria(folded.hidden)}
              />
            ) : null}
            {tail.map((row, index) => renderRow(row, `tail:${index}`))}
          </View>
        </CodeScroller>
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
}: {
  data: ReadBlockData;
  styles: BlockStyles;
  colors: TokenColors;
}) {
  const copy = blockCopy();
  const [expanded, setExpanded] = useState(false);
  const digits = data.lines.reduce((max, line) => Math.max(max, String(line.number).length), 0);
  const gutter = useMemo(() => readGutterTextStyle(colors, digits), [colors, digits]);
  const expand = useMemo(() => readExpandTextStyle(colors, digits), [colors, digits]);
  const folded = foldWindow(data.lines.length, FOLD_LINES.read, expanded);
  const head = folded.capped ? data.lines.slice(0, folded.headLines) : data.lines;
  const tail = folded.capped ? data.lines.slice(data.lines.length - folded.tailLines) : [];
  // DSH says so when the tool returned a window of a longer file.
  const windowed = data.lines.length < data.totalLines;
  const renderLine = (line: { number: number; text: string }) => (
    <View key={line.number} style={styles.readLine}>
      {/* `aria-hidden` mirrors DSH's `user-select: none` gutter: the number is
          chrome, and copying the block should not drag it along. `selectable` is
          left off for the same reason. */}
      <Text style={gutter} aria-hidden>
        {line.number}
      </Text>
      <Text style={styles.readLineText} selectable>
        {line.text}
      </Text>
    </View>
  );
  return (
    <View style={styles.card}>
      <CardHead
        lang={data.lang}
        title={data.path}
        status={windowed ? copy.window(data.lines.length, data.totalLines) : undefined}
        text={data.text}
        styles={styles}
      />
      <CodeScroller style={styles.readScroll} contentStyle={styles.readBody}>
        <View>
          {head.map(renderLine)}
          {folded.hidden > 0 ? (
            <FoldToggle
              hidden={folded.hidden}
              expanded={expanded}
              onToggle={() => setExpanded((value) => !value)}
              textStyle={expand}
              accessibilityLabel={expanded ? copy.collapseAria : copy.expandAria(folded.hidden)}
            />
          ) : null}
          {tail.map(renderLine)}
        </View>
      </CodeScroller>
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
}: {
  rows: readonly { kind: string; text: string }[];
  styles: BlockStyles;
  keyPrefix: string;
}) {
  return (
    <>
      {rows.map((row, index) => {
        const key = `${keyPrefix}:${index}`;
        if (row.kind === "add" || row.kind === "del" || row.kind === "context") {
          const marker = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
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
              <Text
                style={
                  row.kind === "add"
                    ? styles.diffTextAdd
                    : row.kind === "del"
                      ? styles.diffTextDel
                      : styles.diffTextContext
                }
              >
                {row.text === "" ? " " : row.text}
              </Text>
            </View>
          );
        }
        // A path, `⋯` gap or `@@` hunk header: no marker column, no wash, but
        // the same 3px left border so it lines up with the changed rows.
        return (
          <View key={key} style={[styles.diffLine, styles.diffContext]}>
            <Text style={styles.diffChrome}>{row.text}</Text>
          </View>
        );
      })}
    </>
  );
}

function DiffBlockView({ data, styles }: { data: NonNullable<ToolCallData["diffBlock"]>; styles: BlockStyles }) {
  const copy = blockCopy();
  const [expanded, setExpanded] = useState(false);
  const folded = foldWindow(data.rows.length, FOLD_LINES.diff, expanded);
  const head = folded.capped ? data.rows.slice(0, folded.headLines) : data.rows;
  const tail = folded.capped ? data.rows.slice(data.rows.length - folded.tailLines) : [];
  const status =
    data.operation === "create" ? copy.create : data.operation === "update" ? copy.update : undefined;
  return (
    <View style={styles.card}>
      <CardHead
        // DSH prints the file's language here. We have no language map (and
        // DSH's own fallback is a hardcoded `typescript`, a wart the plan says
        // not to copy), so the tag says what the surface is.
        lang="diff"
        title={data.path}
        status={status}
        text={data.rows.map(diffRowText).join("\n")}
        styles={styles}
      />
      <View style={styles.diffBody}>
        <DiffRows rows={head} styles={styles} keyPrefix="head" />
        {folded.hidden > 0 ? (
          <FoldToggle
            hidden={folded.hidden}
            expanded={expanded}
            onToggle={() => setExpanded((value) => !value)}
            textStyle={styles.diffExpand}
            accessibilityLabel={expanded ? copy.collapseAria : copy.expandAria(folded.hidden)}
          />
        ) : null}
        <DiffRows rows={tail} styles={styles} keyPrefix="tail" />
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Web                                                                        */
/* -------------------------------------------------------------------------- */

function WebBlockView({ data, styles }: { data: WebBlockData; styles: BlockStyles }) {
  const copy = blockCopy();
  if (data.shape === "fetch") {
    return (
      <View style={styles.card}>
        <View style={styles.webBody}>
          <View style={styles.webFetch}>
            <Link href={data.url} style={styles.webUrl}>
              {data.url}
            </Link>
            <View style={styles.webMetaRow}>
              {data.statusCode === null ? null : (
                <Text style={styles.webMeta}>{`${copy.http} ${data.statusCode}`}</Text>
              )}
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
    <View style={styles.card}>
      <View style={styles.webBody}>
        {data.answer === "" ? null : <Text style={styles.webSnippet}>{data.answer}</Text>}
        {data.sources.length === 0 ? (
          <Text style={styles.webMeta}>{copy.webNoResults}</Text>
        ) : (
          // DSH caps the citation list at 320px and scrolls it in place; the
          // whole list stays rendered, so scrolling never hides a source.
          <ScrollView style={styles.webSources} nestedScrollEnabled>
            {data.sources.map((source, index) => (
              <View key={`${index}:${source.url}`} style={styles.webSourceRow}>
                {/* RN has no `<ol>` and no `value` attribute, so the
                    reference number is a column of its own. */}
                <Text style={styles.webSourceIndex}>{`${index + 1}.`}</Text>
                <View style={styles.webSourceBody}>
                  <Link href={source.url} style={styles.webSourceLink}>
                    {source.label}
                  </Link>
                  {source.snippet === "" ? null : (
                    <Text style={styles.webSnippet}>{source.snippet}</Text>
                  )}
                  {source.publishedAt === "" ? null : (
                    <Text style={styles.webPublished}>{source.publishedAt}</Text>
                  )}
                </View>
              </View>
            ))}
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

function buildStyles(colors: TokenColors, hairline: number, status: string) {
  // The wash is 8% on a light card and 12% on a dark one; the card's own
  // surface is what the diff lines are painted on.
  const light = isLightSurface(colors.surface1);
  return {
    root: rowRootStyle(),
    head: rowHeadStyle(),
    // The text run, and the flex row the shimmer's copy re-lays-out. No gap:
    // the separator carries its own margins, the way DSH's `.sep` does.
    text: { flexDirection: "row" as const, alignItems: "center" as const, flex: 1, minWidth: 0 },
    label: rowLabelTextStyle(colors),
    sep: separatorStyle(colors),
    summary: summaryTextStyle(colors, status),
    stat: diffStatTextStyle(colors),
    body: { marginLeft: BODY_INDENT },
    // RN has no hairline in a plain object; `StyleSheet.hairlineWidth` is the
    // device's own (0.5 at 1x/2x), which is what DSH's `.5px` means here.
    card: cardStyle(colors, hairline),
    divider: dividerStyle(colors, hairline),
    command: commandRegionStyle(),
    commandText: commandTextStyle(colors),
    output: outputRegionStyle(),
    outputText: outputTextStyle(colors),
    code: codeRegionStyle(),
    codeText: codeTextStyle(colors),
    diffLine: diffRowStyle(),
    diffBody: diffBodyStyle(),
    diffAdd: diffLineStyle(colors, "add", light),
    diffDel: diffLineStyle(colors, "del", light),
    diffContext: diffLineStyle(colors, "context", light),
    markerAdd: diffMarkerTextStyle(colors, "add"),
    markerDel: diffMarkerTextStyle(colors, "del"),
    markerContext: diffMarkerTextStyle(colors, "context"),
    diffTextAdd: diffBodyTextStyle(colors, "add"),
    diffTextDel: diffBodyTextStyle(colors, "del"),
    diffTextContext: diffBodyTextStyle(colors, "context"),
    diffChrome: diffChromeTextStyle(colors),
    diffExpand: {
      ...diffChromeTextStyle(colors),
      paddingHorizontal: DIFF_LINE_PADDING_HORIZONTAL,
      flexShrink: 0,
    },
    cardHead: cardHeadStyle(),
    cardHeadHeading: cardHeadHeadingStyle(),
    cardHeadActions: cardHeadActionsStyle(),
    cardHeadLang: cardHeadLangTextStyle(colors),
    cardHeadTitle: cardHeadTitleTextStyle(colors),
    cardHeadStatus: cardHeadStatusTextStyle(colors),
    cardHeadAction: cardHeadActionTextStyle(colors),
    searchHead: searchHeadStyle(colors),
    searchSummary: searchSummaryTextStyle(colors),
    searchBody: {
      paddingTop: SEARCH_BODY_PADDING_TOP,
      paddingBottom: SEARCH_BODY_PADDING_BOTTOM,
      paddingRight: SEARCH_BODY_PADDING_RIGHT,
    },
    searchScroll: { flexGrow: 0 },
    searchLine: searchLineStyle(),
    searchFileHead: searchFileHeadStyle(),
    searchLineNumber: searchLineNumberTextStyle(colors),
    searchLineText: searchLineTextStyle(colors),
    searchFilePath: searchFilePathTextStyle(colors),
    searchFileCount: searchFileCountTextStyle(colors),
    searchExpand: searchExpandTextStyle(colors),
    searchEmpty: searchEmptyTextStyle(colors),
    readBody: {
      paddingTop: READ_BODY_PADDING_TOP,
      paddingBottom: READ_BODY_PADDING_BOTTOM,
      paddingHorizontal: READ_BODY_PADDING_HORIZONTAL,
    },
    readScroll: { flexGrow: 0 },
    readLine: readLineStyle(),
    readLineText: readLineTextStyle(colors),
    webBody: webCardBodyStyle(),
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
    webSources: webSourcesStyle(),
    webSourceRow: webSourceRowStyle(),
    webSourceBody: { flex: 1, minWidth: 0 },
    webSourceIndex: webSourceIndexTextStyle(colors),
    webSourceLink: webSourceLinkTextStyle(colors),
    webSnippet: webSnippetTextStyle(colors),
    webPublished: webPublishedTextStyle(colors),
  };
}

type BlockStyles = ReturnType<typeof buildStyles>;

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
  const hasBody = data.body !== "";
  // Expanding is only worth offering when the block below actually has
  // something in it — `hasDetail` is that answer, computed in the data layer.
  // The row is a Pressable, so promising an expansion that never renders left a
  // button which did nothing when pressed.
  const canExpand = data.hasDetail;
  // Once expanded the block carries the subject in full, so a row whose title
  // *is* that subject does not repeat a compact copy of it above.
  const showSummary = data.summary !== "" && !(expanded && !data.titled && data.headline !== "");
  const compact = layout.compact;
  // Icon size is Paseo's own (and was settled in an earlier round); everything
  // else in the row now comes from the shared token table.
  const iconSize = compact ? 14 : 16;
  // Only the newest row is "running": while it runs, and for a window after it
  // commits (the only way a short command — call and result in the same tick —
  // ever shows a signal). Gating on the newest row also keeps an interrupted
  // tool, stuck `running` forever, from blinking for the rest of the session.
  const running = shouldPulse(data.status, useRowPulse(agentId, timestamp));
  // `+A -R` beside the summary, for a row whose body is a real diff and which
  // did not settle with a cue (DSH hides the stat on error/stopped rows).
  const stat = diffStat(data);
  // A shell block: command banner, hairline, output region. This is the field
  // the data layer computes from the detail's own type — the old guess (no diff
  // and no code flag and an "output" caption) only worked by accident.
  const terminal = data.kind === "terminal";
  const colors = theme.colors;

  const styles = useMemo(
    () => buildStyles(colors, StyleSheet.hairlineWidth, data.status),
    [colors, data.status],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${data.label} ${data.summary}`}
      onPress={() => {
        if (canExpand) setExpanded((value) => !value);
      }}
      style={styles.root}
    >
      <View style={styles.head}>
        {/* DSH never recolours the icon: a failure shows up in the summary
            text, not in the glyph beside it. */}
        <Icon name={data.icon} size={iconSize} color={rowIconColor(colors)} />
        <TextShimmer
          active={running}
          contentStyle={styles.text}
          highlightColor={colors.foreground}
          surfaceColor={colors.surface0}
        >
          {(color) => (
            <>
              <Text style={[styles.label, color === null ? null : { color }]}>{data.label}</Text>
              {/* The row stays one line, label and summary together: moving the
                  summary onto its own line just pushed it away from the row it
                  names. It is only dropped once the block below carries the same
                  subject in full, so a description-less row does not print its
                  arguments twice. `numberOfLines` stays 1 for the same reason —
                  an unbounded line beside a long label wrapped one character per
                  line, which is what "并行显示" was. */}
              {showSummary ? (
                <>
                  {/* A 2x2 square with 1px corners, not a dot — DSH's separator
                      between the title and its summary. */}
                  <View style={styles.sep} />
                  <Text
                    style={[styles.summary, color === null ? null : { color }]}
                    numberOfLines={1}
                  >
                    {data.summary}
                  </Text>
                </>
              ) : null}
              {stat !== null ? (
                <Text style={[styles.stat, color === null ? null : { color }]}>
                  {`+${stat.added} -${stat.removed}`}
                </Text>
              ) : null}
            </>
          )}
        </TextShimmer>
      </View>
      {expanded && canExpand ? (
        <View style={styles.body}>
          {/* One card per expanded block, the way DSH's TerminalBlock, DiffBlock
              and ReadBlock all are: same radius, same hairline, same surface.
              `data.kind` picks it; a block whose meta did not parse has no
              payload and falls through to the plain code surface below, so a
              row never opens onto nothing. */}
          {terminal ? (
            <View style={styles.card}>
              {/* The command the row ran, at full contrast and on its own
                  line, then a hairline, then what it printed. A running
                  command that has printed nothing yet draws no divider, the
                  same as DSH's banner-only terminal card. */}
              <View style={styles.command}>
                <Text style={styles.commandText} selectable>
                  {data.headline}
                </Text>
              </View>
              {hasBody ? <View style={styles.divider} /> : null}
              {hasBody ? (
                <View style={styles.output}>
                  <Text style={styles.outputText} selectable>
                    {data.body}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : data.search !== null ? (
            <SearchBlockView data={data.search} styles={styles} colors={colors} />
          ) : data.read !== null ? (
            <ReadBlockView data={data.read} styles={styles} colors={colors} />
          ) : data.diffBlock !== null ? (
            <DiffBlockView data={data.diffBlock} styles={styles} />
          ) : data.web !== null ? (
            <WebBlockView data={data.web} styles={styles} />
          ) : data.diff ? (
            <View style={styles.card}>
              {data.headline !== "" ? (
                <View style={styles.code}>
                  <Text style={styles.codeText} selectable>
                    {data.headline}
                  </Text>
                </View>
              ) : null}
              {hasBody ? (
                <View style={styles.diffBody}>
                  <DiffRows
                    rows={data.body.split("\n").map((line) => {
                      const added = line.startsWith("+");
                      const removed = line.startsWith("-");
                      return {
                        kind: added ? "add" : removed ? "del" : "context",
                        text: added || removed ? line.slice(1) : line,
                      };
                    })}
                    styles={styles}
                    keyPrefix="plain"
                  />
                </View>
              ) : null}
            </View>
          ) : data.headline !== "" || hasBody ? (
            <View style={styles.card}>
              <View style={styles.code}>
                {data.headline !== "" ? (
                  <Text style={styles.codeText} selectable>
                    {data.headline}
                  </Text>
                ) : null}
                {hasBody ? (
                  <Text style={styles.codeText} selectable>
                    {data.body}
                  </Text>
                ) : null}
              </View>
            </View>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}
