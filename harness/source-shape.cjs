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
 */
function functionBody(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?function\\s+${escaped}\\s*\\(`, "g"),
    new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:const|let)\\s+${escaped}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>\\s*\\{`, "g"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match === null) continue;
    const braceAt = source.indexOf("{", match.index + match[0].length - 1);
    if (braceAt < 0) continue;
    const end = matchBrace(source, braceAt);
    if (end < 0) continue;
    return source.slice(braceAt, end);
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
  if (source[open] !== "(") return -1;
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
    if (ch === "(") depth += 1;
    else if (ch === ")") {
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
