/**
 * Structural readers for the few checks that must look at `.tsx` source.
 *
 * This repo's rule is that assertions belong at the data layer, and almost all
 * of them are. A handful are not: a React component cannot be `require`d by
 * plain `node` (it imports the host runtime), so the wiring that only exists
 * inside JSX — "this element measures its own layout", "the icon takes its
 * colour from status and edit-ness" — has no compiled artefact to assert.
 *
 * Those checks used to be written as regexes over the raw text, e.g.
 *
 *     /style=\{styles\.row\}\s*\n\s*onLayout=\{/
 *
 * which is not an assertion about the wiring at all: it is an assertion about
 * *formatting*. Reordering the props, letting prettier wrap the line, or moving
 * the element to a single line all keep the component correct and turn the
 * check red. That is a false alarm, and a false alarm on a formatting change is
 * how a real regression later gets waved through.
 *
 * So the readers here parse the small subset of TSX that the checks actually
 * talk about: **JSX opening elements and their attributes**. Given
 *
 *     <Animated.View
 *       style={styles.row}
 *       onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}
 *     >
 *
 * `jsxElements(source)` yields `{ tag, attributes }` where each attribute is
 * `{ name, value }` with `value` the raw expression source between the braces
 * (or the string literal contents). Attribute order, line breaks, trailing
 * commas and self-closing vs. paired elements do not affect the result, which
 * is the whole point.
 *
 * Deliberately not a general parser: no nested-element tree (only a flat list,
 * which is all the checks need), no comments inside tags, no template literals
 * containing `>` outside an attribute expression. It fails closed — an element
 * whose attributes cannot be read is skipped rather than guessed at.
 */

"use strict";

/**
 * Remove comments so that a doc comment mentioning a prop name is not mistaken
 * for the prop being used. Mirrors what the existing checks did by hand.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "").replace(/([^:"'`])\/\/[^\n]*/g, "$1");
}

/**
 * Find the index just past the `}` that closes the `{` at `open`.
 * Returns -1 when unbalanced.
 */
function matchBrace(source, open) {
  if (source[open] !== "{") return -1;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      // Skip the string/template literal wholesale; braces inside are data.
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) break;
        i += 1;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Read one attribute value starting at `index`. Handles `{expr}`, `"str"` and
 * `'str'`. Returns `{ value, end }`, or `undefined` when unreadable.
 */
function readAttributeValue(source, index) {
  const ch = source[index];
  if (ch === "{") {
    const end = matchBrace(source, index);
    if (end < 0) return undefined;
    return { value: source.slice(index + 1, end - 1), end };
  }
  if (ch === '"' || ch === "'") {
    const close = source.indexOf(ch, index + 1);
    if (close < 0) return undefined;
    return { value: source.slice(index + 1, close), end: close + 1 };
  }
  // A bare identifier (boolean prop such as `disabled` or `scrollEnabled`).
  const bare = /^[A-Za-z_$][\w$]*/.exec(source.slice(index));
  if (bare === null) return undefined;
  return { value: bare[0], end: index + bare[0].length, bare: true };
}

/**
 * Parse the attributes of a single JSX opening element whose tag starts at
 * `tagStart` (the `<` is at `tagStart`, the name begins right after).
 *
 * @returns {{ tag: string, attributes: Array<{name: string, value: string}>, selfClosing: boolean, end: number } | undefined}
 */
function readOpeningElement(source, tagStart) {
  if (source[tagStart] !== "<") return undefined;
  const nameMatch = /^[A-Za-z_$][\w$.:-]*/.exec(source.slice(tagStart + 1));
  if (nameMatch === null) return undefined;
  const tag = nameMatch[0];
  let i = tagStart + 1 + tag.length;
  const attributes = [];
  while (i < source.length) {
    // Skip whitespace and stray commas/line breaks.
    while (i < source.length && /[\s,]/.test(source[i])) i += 1;
    if (i >= source.length) return undefined;
    if (source[i] === "/" && source[i + 1] === ">") {
      return { tag, attributes, selfClosing: true, end: i + 2 };
    }
    if (source[i] === ">") {
      return { tag, attributes, selfClosing: false, end: i + 1 };
    }
    if (source[i] === "{") {
      // A spread attribute: `{...props}`. Recorded so callers can see it, but
      // it cannot be resolved statically.
      const end = matchBrace(source, i);
      if (end < 0) return undefined;
      attributes.push({ name: "{...spread}", value: source.slice(i + 1, end - 1) });
      i = end;
      continue;
    }
    const attrName = /^[A-Za-z_$][\w$:.-]*/.exec(source.slice(i));
    if (attrName === null) return undefined;
    const name = attrName[0];
    i += name.length;
    while (i < source.length && /\s/.test(source[i])) i += 1;
    if (source[i] !== "=") {
      // Boolean shorthand prop.
      attributes.push({ name, value: "" });
      continue;
    }
    i += 1;
    while (i < source.length && /\s/.test(source[i])) i += 1;
    const read = readAttributeValue(source, i);
    if (read === undefined) return undefined;
    attributes.push({ name, value: read.value });
    i = read.end;
  }
  return undefined;
}

/**
 * Every JSX opening element in the file, in source order.
 *
 * Fragments (`<>`) and closers (`</tag>`) are skipped. Comments should already
 * be stripped by the caller via {@link stripComments}; both are tolerated here.
 *
 * @param {string} source
 * @returns {Array<{tag: string, attributes: Array<{name: string, value: string}>, selfClosing: boolean, start: number}>}
 */
function jsxElements(source) {
  const elements = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== "<") continue;
    // Closing tag or fragment: not an opening element.
    if (source[i + 1] === "/" || source[i + 1] === ">") continue;
    const element = readOpeningElement(source, i);
    if (element === undefined) continue;
    elements.push({ ...element, start: i });
    // Continue scanning inside: nested elements are wanted too, and the outer
    // element's `end` is where its attributes finish, not where its children do.
  }
  return elements;
}

/** The attribute with this name on an element, or `undefined`. */
function attributeOf(element, name) {
  return element.attributes.find((attribute) => attribute.name === name);
}

/** Whether the element carries an attribute with this name (any value). */
function hasAttribute(element, name) {
  return attributeOf(element, name) !== undefined;
}

/**
 * Whether a JSX expression mentions this identifier as a whole word.
 *
 * Used for "the expression reads `text`" style claims, where the check cares
 * that the identifier is used rather than how it is spelled out. A property
 * access counts (`styles.row` mentions `row`, `item.data.text` mentions `text`)
 * because reading a field *is* using it; only an occurrence inside a longer
 * identifier is rejected (`setRowWidth` does not mention `row`).
 */
function mentions(expression, identifier) {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w$])${escaped}([^\\w$]|$)`).test(expression);
}

/**
 * Find the JSX element that carries **all** of the given attribute names, and
 * return the first match. This is the shape most of the converted checks want:
 * "some element both measures itself and styles itself", independent of order.
 */
function elementWithAttributes(source, names) {
  return jsxElements(stripComments(source)).find((element) =>
    names.every((name) => hasAttribute(element, name)),
  );
}

/** Every element carrying all of the given attribute names. */
function elementsWithAttributes(source, names) {
  return jsxElements(stripComments(source)).filter((element) =>
    names.every((name) => hasAttribute(element, name)),
  );
}

/**
 * Whether some element carries all `required` attributes and its `attribute`
 * value mentions `identifier`. Encodes "the icon takes its colour from
 * `iconColor`" without pinning prop order.
 */
function hasElementAttributeMentioning(source, required, attribute, identifier) {
  return elementsWithAttributes(source, required).some((element) => {
    const value = attributeOf(element, attribute);
    return value !== undefined && mentions(value.value, identifier);
  });
}

/**
 * Find a top-level `function <name>(...)` or `const <name> = (...) =>` body and
 * return its source text, using brace matching so nested braces are handled.
 *
 * Used where a check needs the *body* of one function (to assert a value does
 * not take part in a computation) rather than the whole file, which would also
 * match an unrelated mention elsewhere.
 *
 * **The parameter list has to be skipped, not searched for a `{`.** An earlier
 * version took "the first `{` after the matched prefix" as the body, which is
 * right only for a plain identifier parameter. For the destructuring signature
 * every React component in this repo uses —
 *
 *     function SettledHeader({ count, expanded }: { count: number }) {
 *
 * — that first `{` is the *parameter object*, so the reader returned
 * `"{ count, expanded }"` and every assertion made against it was about the
 * parameter list instead of the body. Those assertions could not fail: a check
 * like "`JobRow` does not contain `Pressable`" stayed green with a `Pressable`
 * injected straight into `JobRow`, because the returned text never reached the
 * body. So the parameter parens are matched and skipped first (`matchParen`
 * skips nested `()`, `{}` and string literals inside them), and only then is the
 * body's `{` looked for.
 *
 * **What it walks through**, all of it before the body's `{`:
 * a generic list (`<T extends { x: number }>`), a return type annotation
 * (`: void`, `: { ok: boolean } | null`, `: Promise<T>`), and `=>` for arrows.
 * Each is skipped by matching brackets, not by scanning for the next `{` — the
 * braces inside a type are why "next `{`" cannot work.
 *
 * **Fails closed.** A function with no block body (`const f = () => value`), a
 * signature whose brackets cannot be matched, and a name that is not declared as
 * a function or arrow all return `undefined` rather than a guess. A caller that
 * needs a body must be told there is none — returning the wrong text silently is
 * the exact failure this reader exists to prevent.
 *
 * **The name needs a right boundary.** `function\s+<name>\s*\(` without a
 * `(?![\w$])` also matches a longer name that starts with it: looking up
 * `diffStat` in `client/tokens.ts` found `diffStatTextStyle` first and returned
 * *its* text. Every pattern below carries the boundary for that reason.
 */
function functionBody(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** Skip whitespace from `index`; returns the next index. */
  const skipSpace = (index) => {
    let i = index;
    while (i < source.length && /\s/.test(source[i])) i += 1;
    return i;
  };

  /** Index just past the `>` matching the `<` at `open`, or -1. */
  const matchAngle = (open) => {
    if (source[open] !== "<") return -1;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        const quote = ch;
        i += 1;
        while (i < source.length) {
          if (source[i] === "\\") {
            i += 2;
            continue;
          }
          if (source[i] === quote) break;
          i += 1;
        }
        continue;
      }
      if (ch === "<") depth += 1;
      else if (ch === ">") {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  };

  /**
   * Skip a type expression starting at `index`, stopping at the `{` that opens a
   * block body. Returns the index of that `{`, or -1.
   *
   * A type is a sequence of identifiers, brackets and separators; the one thing
   * it never contains at this position is a *block*. So the walk is: skip balanced
   * `{}`/`()`/`[]`/`<>` groups (they are part of the type), and stop at the first
   * `{` that is not inside one of those and is not the start of an object type —
   * which is distinguished by what follows its matching `}`: a type continues with
   * `|`, `&`, `[`, `.`, `<`, `(`, `,`, `;`, `)` or `=>`, while a body does not.
   *
   * `stopAtArrow` is for the arrow form, where `=>` terminates the type: without
   * it a `:` return type would swallow the arrow and report "no body".
   */
  const skipTypeToBody = (index, stopAtArrow) => {
    let i = index;
    while (i < source.length) {
      const ch = source[i];
      if (ch === ";") return -1;
      if (ch === "=") {
        // `=>` ends an arrow's return type; any other `=` means no body here.
        if (stopAtArrow === true && source[i + 1] === ">") return i;
        return -1;
      }
      if (ch === "\n") {
        // A declaration starting here means this signature had no body.
        if (/^\s*(?:export\s+)?(?:function|const|let|class|interface|type)\s/.test(source.slice(i))) return -1;
        i += 1;
        continue;
      }
      if (ch === "(" || ch === "[") {
        const end = ch === "(" ? matchParen(source, i) : matchSquare(source, i);
        if (end < 0) return -1;
        i = end;
        continue;
      }
      if (ch === "<") {
        const end = matchAngle(i);
        if (end < 0) return -1;
        i = end;
        continue;
      }
      if (ch === "{") {
        const end = matchBrace(source, i);
        if (end < 0) return -1;
        const after = skipSpace(end);
        const next = source[after];
        // Still the type: an object type followed by a type continuation.
        const continuesType = next !== undefined && /[|&[.<(,;)]/.test(next);
        const arrowType = next === "=" && source[after + 1] === ">";
        // A `{` right after this one is the *body*: `): { a: string } {` is an
        // object return type followed by a block. Without this, an object return
        // type was returned as if it were the body — `diffStatTextStyle` in
        // `client/tokens.ts` was read as its own return type.
        const bodyFollows = next === "{";
        if (!continuesType && !arrowType && !bodyFollows) return i;
        if (bodyFollows) return after;
        i = end;
        continue;
      }
      i += 1;
    }
    return -1;
  };

  /** The body starting at `braceAt`, or `undefined` when it is unreadable. */
  const bodyAt = (braceAt) => {
    if (braceAt < 0 || source[braceAt] !== "{") return undefined;
    const end = matchBrace(source, braceAt);
    return end < 0 ? undefined : source.slice(braceAt, end);
  };

  /** The block body of a signature whose parameter list ends at `parenEnd`. */
  const bodyAfterParams = (parenEnd) => {
    let cursor = skipSpace(parenEnd);
    // A generic list can follow the params in a call signature; skip it too.
    if (source[cursor] === "<") {
      const end = matchAngle(cursor);
      if (end < 0) return undefined;
      cursor = skipSpace(end);
    }
    if (source[cursor] === ":") return bodyAt(skipTypeToBody(cursor));
    return bodyAt(cursor);
  };

  // `function name(...)` — and `export function`, `async function`.
  const declaration = new RegExp(
    // The `(?![\\w$])` is load-bearing: without it `diffStat` matched
    // `diffStatTextStyle` (same prefix) and returned the wrong function.
    `(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}(?![\\w$])\\s*(<)?`,
    "g",
  ).exec(source);
  if (declaration !== null) {
    let cursor;
    if (declaration[1] === "<") {
      // `function f<T>(...)`: skip the generic list, then the parameter list.
      const angleEnd = matchAngle(declaration.index + declaration[0].length - 1);
      if (angleEnd >= 0) {
        cursor = skipSpace(angleEnd);
        if (source[cursor] === "(") {
          const parenEnd = matchParen(source, cursor);
          if (parenEnd >= 0) {
            const body = bodyAfterParams(parenEnd);
            if (body !== undefined) return body;
          }
        }
      }
    } else {
      cursor = skipSpace(declaration.index + declaration[0].length);
      if (source[cursor] === "(") {
        const parenEnd = matchParen(source, cursor);
        if (parenEnd >= 0) {
          const body = bodyAfterParams(parenEnd);
          if (body !== undefined) return body;
        }
      }
    }
  }

  // `const name = (...) => {` / `const name = x => {` / with a return type.
  const arrowHead = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:const|let)\\s+${escaped}(?![\\w$])\\s*=\\s*(?:async\\s*)?`,
    "g",
  ).exec(source);
  if (arrowHead !== null) {
    let cursor = skipSpace(arrowHead.index + arrowHead[0].length);
    if (source[cursor] === "<") {
      const angleEnd = matchAngle(cursor);
      if (angleEnd >= 0) cursor = skipSpace(angleEnd);
    }
    if (source[cursor] === "(") {
      const parenEnd = matchParen(source, cursor);
      if (parenEnd < 0) return undefined;
      cursor = skipSpace(parenEnd);
    } else {
      // A bare identifier parameter.
      const bare = /^[A-Za-z_$][\w$]*/.exec(source.slice(cursor));
      if (bare === null) return undefined;
      cursor = skipSpace(cursor + bare[0].length);
    }
    // An optional return type sits between the params and the `=>`. It stops at
    // the arrow, so `: { ok: true } => {` is a type followed by an arrow and not
    // a body — `stopAtArrow` is what tells `skipTypeToBody` that.
    if (source[cursor] === ":") {
      const arrowAt = skipTypeToBody(cursor, true);
      if (arrowAt < 0) return undefined;
      return bodyAt(skipSpace(arrowAt + 2));
    }
    if (source[cursor] !== "=" || source[cursor + 1] !== ">") return undefined;
    return bodyAt(skipSpace(cursor + 2));
  }

  return undefined;
}

/** Strip comments for callers that want to assert on code only. */
function codeOnly(source) {
  return stripComments(source);
}

/**
 * The argument text of every call to `name` in `source`, one entry per call.
 *
 * `f(\n  a,\n  b,\n)` yields `["\n  a,\n  b,\n"]`. This is what lets a check say
 * "some call passes `text`" without pinning whitespace: the old regexes
 * `reasoningPreview\(\s*text\s*,` failed as soon as the call was wrapped.
 *
 * Only the argument list is returned (not the whole call), and arguments are
 * split on top-level commas so a caller can inspect them individually. A call
 * whose parentheses cannot be matched is skipped rather than guessed at.
 *
 * @param {string} source
 * @param {string} name
 * @returns {string[]}
 */
function callArguments(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `name(` where `name` is not the tail of a longer identifier. The preceding
  // character may be anything else — including `.`, which is load-bearing here:
  // a spread call (`{ ...toolCallData(item, phase) }`) has a dot right before
  // the name, and an earlier version of this reader rejected it, making the
  // check report "no call found" for a call that was plainly there.
  // A method call (`obj.name(...)`) also counts: the callers here pass a plain
  // function name, and a match that turns out not to be the intended call is
  // filtered by the argument assertions downstream.
  const pattern = new RegExp(`(^|[^\\w$])${escaped}\\s*\\(`, "g");
  const results = [];
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const open = match.index + match[0].length - 1;
    const end = matchParen(source, open);
    if (end < 0) continue;
    results.push(source.slice(open + 1, end - 1));
    pattern.lastIndex = end;
  }
  return results;
}

/**
 * Split an argument list on top-level commas.
 *
 * @param {string} args
 * @returns {string[]}
 */
function splitArguments(args) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      current += ch;
      i += 1;
      while (i < args.length) {
        current += args[i];
        if (args[i] === "\\") {
          i += 1;
          if (i < args.length) current += args[i];
          i += 1;
          continue;
        }
        if (args[i] === quote) break;
        i += 1;
      }
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}

/** Index just past the `)` that closes the `(` at `open`, or -1. */
function matchParen(source, open) {
  return matchPaired(source, open, "(", ")");
}

/**
 * Index just past the `]` that closes the `[` at `open`, or -1.
 *
 * Needed by {@link functionBody} for a return type like
 * `: readonly { rotate: string }[] | undefined` — the tuple/array suffix is part
 * of the type, so the `[` has to be stepped over rather than walked into.
 */
function matchSquare(source, open) {
  return matchPaired(source, open, "[", "]");
}

/**
 * The shared bracket matcher: index just past the `close` that balances `open`,
 * or -1.
 *
 * String literals are skipped wholesale so a bracket inside one is data, not
 * nesting. Only the two characters in question are counted, so this is safe for
 * the kinds of text the readers here see (it is not a general TS parser).
 */
function matchPaired(source, open, openChar, closeChar) {
  if (source[open] !== openChar) return -1;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) break;
        i += 1;
      }
      continue;
    }
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Every `if (condition) { body }` statement in `source`, with the condition and
 * body as separate text.
 *
 * A guard clause is two claims at once — *what* it tests and *what* it does —
 * and a single regex over the whole statement couples them to formatting: a
 * reflowed `if (` or a multi-line condition broke the old check while the guard
 * still returned `undefined`. Reading the two halves apart lets a caller assert
 * each on its own terms.
 *
 * Only braced bodies are captured; an unbraced `if (x) return;` is skipped
 * (a caller that needs it should read the condition, which is still matched).
 *
 * @param {string} source
 * @returns {Array<{condition: string, body: string, end: number}>}
 */
function ifStatements(source) {
  const statements = [];
  const pattern = /\bif\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const openParen = match.index + match[0].length - 1;
    const closeParen = matchParen(source, openParen);
    if (closeParen < 0) continue;
    const condition = source.slice(openParen + 1, closeParen - 1);
    // Find the body: the next `{` after the condition (skipping whitespace).
    let cursor = closeParen;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    if (source[cursor] !== "{") continue;
    const bodyEnd = matchBrace(source, cursor);
    if (bodyEnd < 0) continue;
    statements.push({
      condition,
      body: source.slice(cursor + 1, bodyEnd - 1),
      end: bodyEnd,
    });
    // Do not skip past the body: a nested `if` inside it is a separate statement
    // and callers filter by content anyway.
  }
  return statements;
}

/**
 * The parameter list of a class method or plain function named `name`.
 *
 * Returns `{ params: string[] }` (each entry the raw parameter source, including
 * any default value and type annotation) or `undefined` when no such method is
 * found. Parameter *count* is deliberately not part of the result: the
 * one-process rewrite added a per-session parameter to several methods, and a
 * check that pinned the whole signature as one literal string went red on that
 * — the subject (which arguments exist and what they mean) had not changed.
 *
 * @param {string} source
 * @param {string} name
 * @returns {{params: string[]} | undefined}
 */
function methodSignature(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `async name(` / `name(` / `#name(` at a method position, and `function name(`.
  const patterns = [
    new RegExp(`(?:^|[\\s;{}])(?:async\\s+)?#?${escaped}\\s*\\(`, "m"),
    new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`, "m"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match === null) continue;
    const openParen = match.index + match[0].length - 1;
    const closeParen = matchParen(source, openParen);
    if (closeParen < 0) continue;
    const raw = source.slice(openParen + 1, closeParen - 1);
    return { params: splitArguments(raw) };
  }
  return undefined;
}

module.exports = {
  attributeOf,
  callArguments,
  codeOnly,
  elementWithAttributes,
  elementsWithAttributes,
  functionBody,
  hasAttribute,
  hasElementAttributeMentioning,
  ifStatements,
  jsxElements,
  mentions,
  methodSignature,
  splitArguments,
  stripComments,
};
