import { blocksText, contentBlockKind } from "./shared.js";

// A serialized image block's type field, in JSON or Python repr form.
const IMAGE_BLOCK_MARKER = /(["'])type\1\s*:\s*(["'])(?:image|input_image|image_url)\2/;
const DATA_IMAGE_URL = /data:image\/[\w.+-]+;base64,[A-Za-z0-9+/]+=*/g;

/**
 * Some writers store a tool result's content blocks as one string: JSON, or
 * the Python repr of the block list. When such a string holds an image, render
 * it as `blocksText` renders the list itself, so the image becomes `[image]`
 * instead of inline base64. Any other string is returned unchanged.
 */
export function serializedBlocksText(text: string): string {
  const head = text.trimStart()[0];
  if ((head !== "[" && head !== "{") || !IMAGE_BLOCK_MARKER.test(text)) {
    return text;
  }

  const parsed = parseJson(text) ?? parsePythonLiteral(text);
  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  if (
    parsed != null &&
    blocks.length > 0 &&
    blocks.every((block) => contentBlockKind(block) !== undefined) &&
    blocks.some((block) => contentBlockKind(block) === "image")
  ) {
    return blocksText(blocks);
  }
  // Not a pure block list (or cut off by its writer): still drop inline base64.
  return text.replace(DATA_IMAGE_URL, "[image]");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const PYTHON_ESCAPES = new Map([
  ["\\", "\\"],
  ["'", "'"],
  ['"', '"'],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);
const HEX_ESCAPE_LENGTHS = new Map([
  ["x", 2],
  ["u", 4],
  ["U", 8],
]);
const PYTHON_SCALAR = /True|False|None|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const HEX = /^[0-9a-fA-F]+$/;

/**
 * Parses the subset of Python literal syntax that `repr` produces for content
 * blocks: dicts with string keys, lists, tuples, strings, numbers, True,
 * False, and None. Returns undefined for anything else.
 */
function parsePythonLiteral(text: string): unknown {
  let index = 0;
  const fail = (): never => {
    throw new SyntaxError("not a Python literal");
  };
  const skipSpace = (): void => {
    while (index < text.length && /\s/.test(text[index] ?? "")) index += 1;
  };

  const parseString = (): string => {
    const quote = text[index];
    index += 1;
    let out = "";
    let start = index;
    for (;;) {
      const char = text[index];
      if (char === undefined || char === "\n") fail();
      if (char === quote) {
        out += text.slice(start, index);
        index += 1;
        return out;
      }
      if (char !== "\\") {
        index += 1;
        continue;
      }
      out += text.slice(start, index);
      const escape = text[index + 1] ?? fail();
      index += 2;
      const simple = PYTHON_ESCAPES.get(escape);
      const hexLength = HEX_ESCAPE_LENGTHS.get(escape);
      if (simple !== undefined) {
        out += simple;
      } else if (hexLength !== undefined) {
        const hex = text.slice(index, index + hexLength);
        if (hex.length !== hexLength || !HEX.test(hex)) fail();
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        index += hexLength;
      } else {
        out += `\\${escape}`;
      }
      start = index;
    }
  };

  const parseItems = (close: string, parseItem: () => void): void => {
    index += 1;
    skipSpace();
    if (text[index] === close) {
      index += 1;
      return;
    }
    for (;;) {
      parseItem();
      skipSpace();
      const char = text[index];
      index += 1;
      if (char === close) return;
      if (char !== ",") fail();
      skipSpace();
      if (text[index] === close) {
        index += 1;
        return;
      }
    }
  };

  const parseValue = (): unknown => {
    skipSpace();
    const char = text[index];
    if (char === "{") {
      const out: Record<string, unknown> = {};
      parseItems("}", () => {
        skipSpace();
        if (text[index] !== "'" && text[index] !== '"') fail();
        const key = parseString();
        skipSpace();
        if (text[index] !== ":") fail();
        index += 1;
        Object.defineProperty(out, key, {
          value: parseValue(),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      });
      return out;
    }
    if (char === "[" || char === "(") {
      const out: unknown[] = [];
      parseItems(char === "[" ? "]" : ")", () => out.push(parseValue()));
      return out;
    }
    if (char === "'" || char === '"') return parseString();
    PYTHON_SCALAR.lastIndex = index;
    const word = PYTHON_SCALAR.exec(text)?.[0] ?? fail();
    index += word.length;
    if (word === "True") return true;
    if (word === "False") return false;
    if (word === "None") return null;
    return Number(word);
  };

  try {
    const value = parseValue();
    skipSpace();
    return index === text.length ? value : undefined;
  } catch {
    return undefined;
  }
}
