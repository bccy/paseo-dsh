/**
 * Lightweight React Native syntax-highlighted code renderers.
 *
 * Uses a single outer `<Text>` with inline `<Text>` spans only for non-plain
 * tokens so multi-line selection / copy stays continuous and node count stays
 * minimal. Colours come strictly from {@link tokenColor} over Paseo's semantic
 * {@link TokenColors} — zero hardcoded colour literals.
 *
 * @module dsh-paseo/client/highlighted-code
 */
import { useMemo, type ReactElement, type ReactNode } from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";
import {
  tokenColor,
  tokenizeCode,
  tokenizeLine,
  type CodeToken,
  type HighlightMode,
} from "./code-highlight";
import type { TokenColors } from "./tokens";

export interface HighlightedLineProps {
  readonly line: string;
  readonly mode: HighlightMode;
  readonly colors: TokenColors;
  readonly baseStyle: StyleProp<TextStyle>;
  readonly selectable?: boolean;
  readonly tokens?: readonly CodeToken[];
}

export interface HighlightedCodeProps {
  readonly text: string;
  readonly lang?: string;
  readonly colors: TokenColors;
  readonly baseStyle: StyleProp<TextStyle>;
  readonly selectable?: boolean;
}

function appendTokenNodes(
  target: ReactNode[],
  tokens: readonly CodeToken[],
  colors: TokenColors,
  keyPrefix: string,
): void {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind === "plain") {
      target.push(token.text);
    } else {
      target.push(
        <Text key={`${keyPrefix}-${i}`} style={{ color: tokenColor(token.kind, colors) }}>
          {token.text}
        </Text>,
      );
    }
  }
}

function tokensMatchLine(tokens: readonly CodeToken[], line: string): boolean {
  let offset = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const text = tokens[i].text;
    if (text.length === 0) continue;
    if (!line.startsWith(text, offset)) return false;
    offset += text.length;
  }
  return offset === line.length;
}

export function HighlightedLine({
  line,
  mode,
  colors,
  baseStyle,
  selectable,
  tokens,
}: HighlightedLineProps): ReactElement {
  const resolvedTokens = useMemo(
    () => (tokens !== undefined && tokensMatchLine(tokens, line) ? tokens : tokenizeLine(line, mode)),
    [tokens, line, mode],
  );
  const children: ReactNode[] = [];
  appendTokenNodes(children, resolvedTokens, colors, "l");
  return (
    <Text style={baseStyle} selectable={selectable}>
      {children}
    </Text>
  );
}

export function HighlightedCode({
  text,
  lang,
  colors,
  baseStyle,
  selectable,
}: HighlightedCodeProps): ReactElement {
  const rows = useMemo(() => tokenizeCode(text, lang), [text, lang]);
  const children: ReactNode[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if (rowIndex > 0) children.push("\n");
    appendTokenNodes(children, rows[rowIndex], colors, `r${rowIndex}`);
  }
  return (
    <Text style={baseStyle} selectable={selectable}>
      {children}
    </Text>
  );
}
