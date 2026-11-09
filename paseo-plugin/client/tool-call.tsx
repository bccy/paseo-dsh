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
 * While the tool is running the row pulses (see `./text-shimmer` for the sweep
 * and `./newest` for the position rule that decides *which* row runs it),
 * matching the "still working" feel Paseo's own loading rows have.
 *
 * @module dsh-paseo/client/tool-call
 */
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, copyText } from "@getpaseo/plugin/client/react-native";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { shouldPulse, useRowPulse } from "./newest";
import { PASEO_MARK_ICON } from "./paseo-mark";
import { blockCopy, type GoalBlockData, type ReadBlockData, type SearchBlockData, type ToolCallData, type ToolFieldEntry, type ToolFieldsData, type WebBlockData } from "./tool-call-data";
import { localeText } from "./locale";
import { TextShimmer } from "./text-shimmer";
import { TeamBlockView } from "./team-card";
import { ringColorFor } from "./jobs-popover-layout";
import {
  BODY_INDENT,
  type TokenColors,
  CARD_HEAD_GAP,
  ROW_FONT_SIZE,
  ROW_GAP,
  ROW_LINE_HEIGHT,
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
  CODE_FONT_FAMILY,
  CODE_FONT_SIZE,
  CODE_MAX_HEIGHT,
  GOAL_CARD_LINE_HEIGHT,
  GOAL_CARD_PADDING_HORIZONTAL,
  GOAL_CARD_PADDING_VERTICAL,
  GOAL_FIELD_COLUMN_GAP,
  GOAL_FIELD_LABEL_WIDTH,
  GOAL_FIELD_ROW_GAP,
  GOAL_FIELDS_MARGIN_TOP,
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
  rowLabelTextStyle,
  rowRootStyle,
  rowIconColor,
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
  terminalOutputScrollStyle,
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
}: {
  data: SearchBlockData;
  styles: BlockStyles;
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
              {/* `parseWeb` returns a fetch card only when its meta carried a
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

function buildStyles(colors: TokenColors, hairline: number) {
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
    summary: summaryTextStyle(colors),
    // A failed row puts its reason where the summary sits (DSH's
    // `.errorSummary` does the same), so the reason reads before expanding.
    summaryError: { color: colors.statusDanger },
    statAdded: diffStatTextStyle(colors, "added"),
    statRemoved: diffStatTextStyle(colors, "removed"),
    body: { marginLeft: BODY_INDENT, gap: ROW_GAP },
    // The whole failure reason inside the expansion, selectable and red.
    errorText: {
      color: colors.statusDanger,
      fontSize: ROW_FONT_SIZE,
      lineHeight: ROW_LINE_HEIGHT,
    },
    // The plain-language reason above a known refusal, and DSH's code beside it.
    hintText: { color: colors.foregroundMuted, fontSize: ROW_FONT_SIZE, lineHeight: GOAL_CARD_LINE_HEIGHT },
    hintCode: { color: colors.foregroundMuted, fontSize: CODE_FONT_SIZE, fontFamily: CODE_FONT_FAMILY },
    // DSH's goal details card (see `GOAL_CARD_*` in `./tokens`).
    goalItem: { paddingVertical: GOAL_CARD_PADDING_VERTICAL, paddingHorizontal: GOAL_CARD_PADDING_HORIZONTAL },
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
    // The generic fields card (see `ToolFieldsView`): the goal card's geometry,
    // plus the gap between its entries. Facts share one wrapping row; a phone is
    // 390px wide, so the row has to fold rather than push a value off the card.
    fieldsItem: {
      paddingVertical: GOAL_CARD_PADDING_VERTICAL,
      paddingHorizontal: GOAL_CARD_PADDING_HORIZONTAL,
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
    // The L2 receipt line: a summary of the card, so it reads quieter than the
    // values above it.
    fieldReceipt: { color: colors.foregroundMuted, fontSize: ROW_FONT_SIZE, lineHeight: GOAL_CARD_LINE_HEIGHT },
    // The same 260px window the generic code surface uses: a long prose value
    // and a nested object both scroll in place instead of pushing the timeline
    // down.
    fieldBodyScroll: { maxHeight: CODE_MAX_HEIGHT },
    // RN has no hairline in a plain object; `StyleSheet.hairlineWidth` is the
    // device's own (0.5 at 1x/2x), which is what DSH's `.5px` means here.
    card: cardStyle(colors, hairline),
    divider: dividerStyle(colors, hairline),
    command: commandRegionStyle(),
    // The command and its copy control share the banner line; the command
    // takes the remaining width so the control never wraps off the card.
    commandRow: {
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      gap: CARD_HEAD_GAP,
    },
    commandText: { ...commandTextStyle(colors), flex: 1, minWidth: 0 },
    output: outputRegionStyle(),
    outputText: outputTextStyle(colors),
    // DSH's TerminalBlock output window (`.output` inside `.terminalBody`).
    terminalOutput: terminalOutputScrollStyle(),
    code: codeRegionStyle(),
    codeText: codeTextStyle(colors),
    // DSH's `.bodyScroll { max-height: 260px; overflow-y: auto }` around the
    // code-tool card's body: the generic surface renders the whole text and
    // scrolls it in place instead of being cut at 6000 characters. This is the
    // one consumer of `CODE_MAX_HEIGHT`.
    codeScroll: { maxHeight: CODE_MAX_HEIGHT },
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

/**
 * The goal tools' result card: DSH's `DetailsRow` for `create_goal` / `get_goal`
 * / `update_goal` — the objective, then 状态 / 执行轮次 (/ 受阻原因) as a
 * label | value list. `{goal: null}` is DSH's 「没有目标」 line.
 */
function GoalBlockView({ data, summary, styles }: { data: GoalBlockData; summary: string; styles: BlockStyles }) {
  return (
    <View style={styles.card}>
      <View style={styles.goalItem}>
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
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Generic fields (rows with no detail shape)                                 */
/* -------------------------------------------------------------------------- */

/**
 * The generic card for a tool Paseo has no detail shape for (every MCP call):
 * the call's arguments, then a structured result, split into facts rows, prose
 * blocks and JSON code blocks (see `ToolFieldsData`).
 *
 * The goal card's geometry, value for value, like `./team-card` — this is not a
 * new visual language, only the same label | value rows and the same code
 * surface. Facts wrap because a phone is 390px wide and a call can carry five of
 * them; a long value wraps inside its own row instead of pushing the card.
 */
function ToolFieldsView({ data, styles }: { data: ToolFieldsData; styles: BlockStyles }) {
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
          {/* Both entry kinds sit in the same 260px window the generic code
              surface uses: a value can be 30KB (a `send_message` body), and the
              timeline must stay bounded — scrolling, never truncating. Prose is
              still drawn as prose: the wire's own newlines are the content, and
              re-serializing the string is what produced the literal `\n` rows. */}
          {entry.kind === "text" ? (
            <ScrollView style={styles.fieldBodyScroll} nestedScrollEnabled>
              <Text style={styles.fieldText} selectable>
                {entry.value}
              </Text>
            </ScrollView>
          ) : (
            <ScrollView
              style={styles.fieldBodyScroll}
              contentContainerStyle={styles.code}
              nestedScrollEnabled
            >
              <Text style={styles.codeText} selectable>
                {entry.value}
              </Text>
            </ScrollView>
          )}
        </View>,
      );
    }
    flush();
  };
  push(data.args, "args");
  if (data.result.length > 0) {
    // The caption separates the two halves: without it a card of facts does not
    // say which ones the tool was called with and which it answered. A card
    // whose entries all come from the result half (`data.hideResultCaption`)
    // gains nothing from it — there the caption is a heading over the whole card
    // (the `skill` row: name, location, then the instructions).
    if (data.hideResultCaption !== true) {
      blocks.push(
        <Text key="result-caption" style={styles.fieldCaption}>
          {localeText().bodyLabels.result}
        </Text>,
      );
    }
    push(data.result, "result");
  }
  if (data.receipt !== "") {
    // L2's one-line compression of the result (「已发送」/「超时」). Muted like a
    // caption: it summarizes the card, it is not another value in it.
    blocks.push(
      <Text key="receipt" style={styles.fieldReceipt} selectable>
        {data.receipt}
      </Text>,
    );
  }
  return (
    <View style={styles.card}>
      {/* The complete result JSON, not the card's flattened display: the copy
          control is what keeps a structured result from losing information when
          the card turns it into rows. */}
      {data.copyText === "" ? null : <CardHead lang="" title="" text={data.copyText} styles={styles} />}
      <View style={styles.fieldsItem}>{blocks}</View>
    </View>
  );
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
  const hasBody = data.body !== "";
  // Expanding is only worth offering when the block below actually has
  // something in it — `hasDetail` is that answer, computed in the data layer.
  // The row is a Pressable, so promising an expansion that never renders left a
  // button which did nothing when pressed.
  const canExpand = data.hasDetail;
  // A failure's reason, in the head's second half: DSH shows it there
  // (`.errorSummary`) instead of the normal summary, because the block below
  // may carry what was *requested* (a write's content, an edit's diff) rather
  // than what went wrong. The head is one line, so only the first line of the
  // reason fits; the expansion carries the whole text.
  const errorLine = data.error === "" ? "" : data.error.split("\n")[0];
  const errorHeadline = data.failed && errorLine !== "";
  // A refusal DSH gave a known code for reads in words (`goalCard.refusals`);
  // DSH's verbatim text is still the first thing in the expanded block below.
  const headSummary = errorHeadline ? (data.errorShort !== "" ? data.errorShort : errorLine) : data.summary;
  // Once expanded the block carries the subject in full, so a row whose title
  // *is* that subject does not repeat a compact copy of it above.
  const showSummary = headSummary !== "" && !(expanded && !data.titled && data.headline !== "");
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
  // The expanded reason, unless the body already says it: a failed shell's body
  // *is* the failing output (`error.message` is built from the same string), so
  // repeating it in the card would read as two separate failures.
  const errorBlock = data.error !== "" && !data.body.includes(data.error) ? data.error : "";
  const colors = theme.colors;
  // The leading icon is the row's only state signal: red when the call failed,
  // green when an edit completed, muted otherwise. The label and the summary stay
  // muted on every state (`client/tokens.ts`).
  const iconColor = rowIconColor(colors, data.status, data.diff);

  const styles = useMemo(() => buildStyles(colors, StyleSheet.hairlineWidth), [colors]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${data.label} ${headSummary}`}
      onPress={() => {
        if (canExpand) setExpanded((value) => !value);
      }}
      style={styles.root}
    >
      <View style={styles.head}>
        {/* The glyph carries the state: red for a failure, green for a completed
            edit. DSH leaves it muted and reddens the summary instead; see
            `docs/RENDER-PLAN.md` for why this row inverts that. A Paseo-owned
            tool with no glyph of its own draws Paseo's mark, tinted the same —
            Paseo's own UI gives every one of its tools that mark and none of them
            a per-tool glyph. */}
        {data.paseoMark ? (
          <Image
            source={{ uri: PASEO_MARK_ICON }}
            style={{ width: iconSize, height: iconSize }}
            tintColor={iconColor}
          />
        ) : (
          <Icon name={data.icon} size={iconSize} color={iconColor} />
        )}
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
                    style={[
                      styles.summary,
                      errorHeadline ? styles.summaryError : null,
                      color === null ? null : { color },
                    ]}
                    numberOfLines={1}
                  >
                    {headSummary}
                  </Text>
                </>
              ) : null}
              {stat !== null ? (
                <>
                  {/* Semantic colours rather than the row's tone: the counts
                      describe the diff, so `+` is green and `-` is red whatever
                      the row itself is doing. The separating space lives inside
                      the `-` run, so the pair stays exactly as far apart as the
                      single grey run it replaced. */}
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
      </View>
      {expanded && canExpand ? (
        <View style={styles.body}>
          {/* The whole failure reason first, selectable: a failed `write` or
              `edit` keeps only what it *would* have written in its block, so
              this is where the error text itself is readable. It is skipped
              when the block already prints the same text (see `errorBlock`). */}
          {/* A known refusal opens with one plain sentence and DSH's code; the
              verbatim reason follows, unchanged, so nothing DSH said is lost. */}
          {data.errorHint !== "" ? (
            <Text style={styles.hintText}>
              {data.errorHint}
              <Text style={styles.hintCode}>{`  ${data.errorCode}`}</Text>
            </Text>
          ) : null}
          {errorBlock !== "" ? (
            <Text style={styles.errorText} selectable>
              {errorBlock}
            </Text>
          ) : null}
          {data.goal !== null ? <GoalBlockView data={data.goal} summary={data.summary} styles={styles} /> : null}
          {data.team !== null ? (
            <TeamBlockView
              data={data.team}
              hairline={StyleSheet.hairlineWidth}
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
          {/* The generic card for a row with no detail shape (every MCP call).
              A plain-text result keeps its own code surface below this card; a
              structured one is drawn by the card alone. */}
          {data.fields !== null ? <ToolFieldsView data={data.fields} styles={styles} /> : null}
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
                <View style={styles.commandRow}>
                  <Text style={styles.commandText} selectable>
                    {data.headline}
                  </Text>
                  {/* DSH's TerminalBlock copies the whole output — not the
                      visible window — and hides the control while the command
                      is still printing or has produced nothing but blank lines
                      (`!running && !empty`). */}
                  {hasBody && data.status !== "running" && data.body.trim() !== "" ? (
                    <CopyControl text={data.body} style={styles.cardHeadAction} />
                  ) : null}
                </View>
              </View>
              {hasBody ? <View style={styles.divider} /> : null}
              {hasBody ? (
                // DSH renders every line inside a capped scroll region
                // (`.output` with `max-height: var(--dsl-terminal-output-max-height)`
                // and `overflow-y: auto`), so a long log scrolls in place
                // instead of being cut off or pushing the timeline down.
                <ScrollView
                  style={styles.terminalOutput}
                  contentContainerStyle={styles.output}
                  nestedScrollEnabled
                >
                  <Text style={styles.outputText} selectable>
                    {data.body}
                  </Text>
                </ScrollView>
              ) : null}
            </View>
          ) : data.search !== null ? (
            <SearchBlockView data={data.search} styles={styles} />
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
              {/* DSH's code-card toolbar, with the copy control as its only
                  action: it hands over the whole body, not the part inside the
                  scroll window. That is the recovery path for a body too long
                  to read in place, and it is what makes the 260px window safe —
                  nothing is dropped, only scrolled. No language tag: DSH
                  hardcodes `typescript` there, a wart this repo deliberately
                  does not copy. */}
              {hasBody && data.body.trim() !== "" ? (
                <CardHead lang="" title="" text={data.body} styles={styles} />
              ) : null}
              {/* DSH's `.bodyScroll { max-height: 260px; overflow-y: auto }`
                  around the code surface: the whole body is rendered and this
                  is the only thing keeping a long one from pushing the timeline
                  down (the same shape as the terminal card's 224px window). */}
              <ScrollView
                style={styles.codeScroll}
                contentContainerStyle={styles.code}
                nestedScrollEnabled
              >
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
              </ScrollView>
            </View>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}
