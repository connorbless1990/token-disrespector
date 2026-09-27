/**
 * A strict, zero-dependency YAML *subset* parser + structural diff.
 *
 * tds performs file surgery on user-owned configuration (DSH's
 * `settings.yaml` / `cordis.patch.yml`) and must never write a file it cannot
 * fully understand. This module parses the block-style YAML that DSH's own
 * yaml emitter produces — plus a little more:
 *
 *   - block mappings and block sequences, nested to any depth
 *   - plain / single-quoted / double-quoted scalars (numbers, bools, nulls
 *     typed; multi-line plain scalars folded)
 *   - single-line flow collections (`{a: 1, b: [x, y]}`)
 *   - comments and blank lines, anywhere
 *   - tagged scalar values (e.g. `!!js …`) as OPAQUE values with raw-text
 *     identity — DSH patch files legitimately carry `!!js` expressions
 *
 * Anything outside the subset — block scalars (`|` / `>`), anchors (`&`),
 * aliases (`*`), multi-line flow, document markers (`---` / `...`),
 * directives (`%`), tab indentation — makes the parse FAIL with a reason and
 * line number. Callers treat a failed parse as "refuse to edit this file"
 * and print the manual recipe instead.
 *
 * The parsed value model keeps map entry ORDER (a deliberate strictness: any
 * reordering shows up in the post-edit structural diff, where it is
 * investigated rather than silently accepted).
 */

export type YamlScalar =
  | { kind: "scalar"; value: string | number | boolean | null }
  | { kind: "opaque"; raw: string };

export type YamlValue =
  | { kind: "map"; entries: [string, YamlValue][] }
  | { kind: "seq"; items: YamlValue[] }
  | YamlScalar;

/** A scalar holding YAML's null — the value of `key:` with no block beneath. */
function nullScalar(): YamlValue {
  return { kind: "scalar", value: null };
}

export type YamlParse =
  | { ok: true; value: YamlValue | null }
  | { ok: false; reason: string; line: number };

interface Line {
  num: number; // 1-based
  raw: string;
  indent: number; // leading spaces (tabs rejected earlier)
  content: string; // raw with leading spaces removed
  blank: boolean;
  comment: boolean; // content starts with '#'
}

class ParseSubsetError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(message);
    this.line = line;
  }
}

function fail(reason: string, line: number): YamlParse {
  return { ok: false, reason, line };
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

const NULL_WORDS = new Set(["~", "null", "Null", "NULL", ""]);
const TRUE_WORDS = new Set(["true", "True", "TRUE"]);
const FALSE_WORDS = new Set(["false", "False", "FALSE"]);
const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Type a plain (unquoted) scalar; returns a YamlScalar. */
export function typePlainScalar(text: string): YamlScalar {
  const t = text.trim();
  if (NULL_WORDS.has(t)) return { kind: "scalar", value: null };
  if (TRUE_WORDS.has(t)) return { kind: "scalar", value: true };
  if (FALSE_WORDS.has(t)) return { kind: "scalar", value: false };
  if (t === ".inf" || t === ".Inf" || t === ".INF") return { kind: "scalar", value: Infinity };
  if (t === "-.inf" || t === "-.Inf" || t === "-.INF") return { kind: "scalar", value: -Infinity };
  if (t === ".nan" || t === ".NaN" || t === ".NAN") return { kind: "scalar", value: NaN };
  if (NUMBER_RE.test(t)) return { kind: "scalar", value: Number(t) };
  return { kind: "scalar", value: t };
}

/** End index of the quoted string starting at `i` (raw[i] is the quote), or null. */
function quotedEnd(s: string, i: number): number | null {
  const q = s[i];
  i++;
  while (i < s.length) {
    const c = s[i];
    if (q === '"') {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') return i + 1;
    } else {
      // single-quoted: '' is an escaped quote
      if (c === "'") {
        if (s[i + 1] === "'") {
          i += 2;
          continue;
        }
        return i + 1;
      }
    }
    i++;
  }
  return null; // unterminated
}

function decodeDoubleQuoted(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = s[++i];
    switch (n) {
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case "r": out += "\r"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case '"': out += '"'; break;
      case "\\": out += "\\"; break;
      case "/": out += "/"; break;
      case "0": out += "\0"; break;
      case "u": {
        const hex = s.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad \\u escape`);
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        break;
      }
      default:
        throw new Error(`unsupported escape \\${String(n)}`);
    }
  }
  return out;
}

function decodeSingleQuoted(s: string): string {
  return s.replace(/''/g, "'");
}

/** Strip a trailing `# …` comment (a # preceded by whitespace or at start). */
function stripComment(s: string, line: number): string {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "#" && (i === 0 || s[i - 1] === " " || s[i - 1] === "\t")) {
      return s.slice(0, i);
    }
    if (s[i] === '"' || s[i] === "'") {
      const end = quotedEnd(s, i);
      if (end === null) throw new ParseSubsetError(`unterminated quote on line ${line}`, line);
      i = end - 1;
    }
  }
  return s;
}

/**
 * Parse an inline (same-line) value: a flow collection or a quoted/plain
 * scalar. Throws ParseSubsetError on bad input. Returns the value plus the
 * index just past the value's end.
 */
export function parseInline(s: string, line: number): { value: YamlValue; end: number } {
  let i = 0;
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  if (i >= s.length) throw new ParseSubsetError("empty value", line);
  const c = s[i]!;
  if (c === "&" || c === "*") throw new ParseSubsetError("anchors/aliases are not supported", line);
  if (c === "|" || c === ">") throw new ParseSubsetError("block scalars are not supported", line);
  if (c === "!") throw new ParseSubsetError("tagged values are only supported as whole-line scalar values", line);
  if (c === "{" || c === "[") {
    const { value, end } = parseFlow(s, i, line);
    // Only trailing whitespace may follow a balanced flow value on the line.
    const rest = s.slice(end);
    if (rest.trim() !== "") throw new ParseSubsetError("content after a flow collection", line);
    return { value, end };
  }
  if (c === '"' || c === "'") {
    const end = quotedEnd(s, i);
    if (end === null) throw new ParseSubsetError(`unterminated quote on line ${line}`, line);
    const body = s.slice(i + 1, end - 1);
    const text = c === '"' ? decodeDoubleQuoted(body) : decodeSingleQuoted(body);
    return { value: { kind: "scalar", value: text }, end };
  }
  const rest = s.slice(i);
  return { value: typePlainScalar(rest), end: s.length };
}

// ---------------------------------------------------------------------------
// Flow collections (single-line, string-aware)
// ---------------------------------------------------------------------------

function parseFlow(s: string, i: number, line: number): { value: YamlValue; end: number } {
  const c = s[i]!;
  if (c === "{") return parseFlowMap(s, i, line);
  if (c === "[") return parseFlowSeq(s, i, line);
  throw new ParseSubsetError("not a flow collection", line);
}

function skipFlowWs(s: string, i: number): number {
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  return i;
}

function parseFlowValue(s: string, i: number, line: number): { value: YamlValue; end: number } {
  i = skipFlowWs(s, i);
  if (i >= s.length) throw new ParseSubsetError("unterminated flow collection", line);
  const c = s[i]!;
  if (c === "}" || c === "]") throw new ParseSubsetError(`unexpected "${c}" in flow collection`, line);
  if (c === "{" || c === "[") return parseFlow(s, i, line);
  if (c === '"' || c === "'") {
    const end = quotedEnd(s, i);
    if (end === null) throw new ParseSubsetError(`unterminated quote on line ${line}`, line);
    const body = s.slice(i + 1, end - 1);
    const text = c === '"' ? decodeDoubleQuoted(body) : decodeSingleQuoted(body);
    return { value: { kind: "scalar", value: text }, end };
  }
  if (c === "&" || c === "*" || c === "!") throw new ParseSubsetError("anchors/aliases/tags are not supported in flow", line);
  let j = i;
  while (j < s.length && !",}]".includes(s[j]!)) j++;
  const text = s.slice(i, j).trim();
  if (text === "") throw new ParseSubsetError("empty flow value", line);
  return { value: typePlainScalar(text), end: j };
}

function parseFlowMap(s: string, i: number, line: number): { value: YamlValue; end: number } {
  const entries: [string, YamlValue][] = [];
  i++; // past '{'
  for (;;) {
    i = skipFlowWs(s, i);
    if (i >= s.length) throw new ParseSubsetError("unterminated flow map", line);
    if (s[i] === "}") return { value: { kind: "map", entries }, end: i + 1 };
    let key: string;
    if (s[i] === '"' || s[i] === "'") {
      const end = quotedEnd(s, i);
      if (end === null) throw new ParseSubsetError(`unterminated quote on line ${line}`, line);
      const body = s.slice(i + 1, end - 1);
      key = s[i] === '"' ? decodeDoubleQuoted(body) : decodeSingleQuoted(body);
      i = end;
    } else {
      let j = i;
      while (j < s.length && s[j] !== ":" && !",}".includes(s[j]!)) j++;
      if (j >= s.length || s[j] !== ":") throw new ParseSubsetError("bad flow map key", line);
      const text = s.slice(i, j).trim();
      if (text === "") throw new ParseSubsetError("empty flow map key", line);
      if (entries.some(([k]) => k === text)) throw new ParseSubsetError(`duplicate key "${text}"`, line);
      key = text;
      i = j;
    }
    if (s[i] !== ":") throw new ParseSubsetError(`expected ":" after key in flow map`, line);
    i++;
    const { value, end } = parseFlowValue(s, i, line);
    entries.push([key, value]);
    i = skipFlowWs(s, end);
    if (s[i] === ",") {
      i++;
      continue;
    }
    if (s[i] === "}") return { value: { kind: "map", entries }, end: i + 1 };
    throw new ParseSubsetError(`expected "," or "}" in flow map`, line);
  }
}

function parseFlowSeq(s: string, i: number, line: number): { value: YamlValue; end: number } {
  const items: YamlValue[] = [];
  i++; // past '['
  i = skipFlowWs(s, i);
  if (i < s.length && s[i] === "]") return { value: { kind: "seq", items }, end: i + 1 };
  for (;;) {
    const { value, end } = parseFlowValue(s, i, line);
    items.push(value);
    i = skipFlowWs(s, end);
    if (s[i] === ",") {
      i++;
      i = skipFlowWs(s, i);
      if (i < s.length && s[i] === "]") return { value: { kind: "seq", items }, end: i + 1 };
      continue;
    }
    if (s[i] === "]") return { value: { kind: "seq", items }, end: i + 1 };
    throw new ParseSubsetError(`expected "," or "]" in flow sequence`, line);
  }
}

// ---------------------------------------------------------------------------
// Block structures
// ---------------------------------------------------------------------------

function isDashLine(content: string): boolean {
  return content === "-" || content.startsWith("- ");
}

/**
 * Split a `key: value` line. A colon terminates the key only when followed
 * by whitespace or end-of-line. Returns the key (unquoted) and the trimmed
 * remainder, or null when the line is not a mapping entry.
 */
function splitKey(content: string, line: number): { key: string; rest: string } | null {
  if (content.startsWith('"') || content.startsWith("'")) {
    const end = quotedEnd(content, 0);
    if (end === null) throw new ParseSubsetError(`unterminated quoted key on line ${line}`, line);
    const body = content.slice(1, end - 1);
    const key = content[0] === '"' ? decodeDoubleQuoted(body) : decodeSingleQuoted(body);
    const after = content.slice(end);
    if (after === "") return { key, rest: "" };
    if (after[0] !== ":") return null;
    if (after.length > 1 && after[1] !== " " && after[1] !== "\t") return null;
    return { key, rest: after.slice(1).replace(/^[ \t]/, "") };
  }
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== ":") continue;
    if (i + 1 >= content.length) return { key: content.slice(0, i).trim(), rest: "" };
    if (content[i + 1] === " " || content[i + 1] === "\t") {
      return { key: content.slice(0, i).trim(), rest: content.slice(i + 1).replace(/^[ \t]/, "") };
    }
  }
  return null;
}

interface Block {
  value: YamlValue | null;
  next: number; // index of the first line past the block
}

/**
 * Parse the block nested under a key/item: the first content line with
 * indent > `minIndent` defines the block; `minIndent`-indent lines end it
 * (value null). Throws ParseSubsetError on malformations.
 */
function parseBlock(lines: Line[], i: number, minIndent: number): Block {
  let j = i;
  let blockIndent = -1;
  let kind: "map" | "seq" | null = null;
  for (; j < lines.length; j++) {
    const L = lines[j]!;
    if (L.blank || L.comment) continue;
    if (L.indent <= minIndent) return { value: null, next: i };
    blockIndent = L.indent;
    kind = isDashLine(L.content) ? "seq" : splitKey(L.content, L.num) ? "map" : null;
    if (kind === null) throw new ParseSubsetError(`expected a mapping entry or sequence item`, L.num);
    break;
  }
  if (kind === null) return { value: null, next: i };
  return kind === "map" ? parseMapBlock(lines, j, blockIndent) : parseSeqBlock(lines, j, blockIndent);
}

function parseMapBlock(lines: Line[], i: number, indent: number): Block {
  const entries: [string, YamlValue][] = [];
  const seen = new Set<string>();
  let j = i;
  while (j < lines.length) {
    const L = lines[j]!;
    if (L.blank || L.comment) {
      j++;
      continue;
    }
    if (L.indent < indent) break;
    if (L.indent > indent) throw new ParseSubsetError("unexpected indentation inside a mapping", L.num);
    const kv = splitKey(L.content, L.num);
    if (!kv) {
      if (isDashLine(L.content)) throw new ParseSubsetError("sequence item inside a mapping", L.num);
      throw new ParseSubsetError(`expected "key: value"`, L.num);
    }
    if (seen.has(kv.key)) throw new ParseSubsetError(`duplicate key "${kv.key}"`, L.num);
    seen.add(kv.key);

    const rest = stripComment(kv.rest, L.num);
    if (rest === "") {
      const nested = parseBlock(lines, j + 1, indent);
      entries.push([kv.key, nested.value ?? nullScalar()]);
      // The entry spans j..nested.next-1; the loop's trailing j++ lands on
      // the line past the block.
      if (nested.value !== null) j = nested.next - 1;
    } else if (rest[0] === "|" || rest[0] === ">") {
      throw new ParseSubsetError("block scalars are not supported", L.num);
    } else if (rest[0] === "&" || rest[0] === "*") {
      throw new ParseSubsetError("anchors/aliases are not supported", L.num);
    } else if (rest[0] === "!") {
      // Tagged scalar value: opaque, same line only. (A tagged BLOCK would
      // be a deeper line — invalid here, and rejected below.)
      let k = j + 1;
      while (k < lines.length && lines[k]!.indent > indent && !lines[k]!.blank && !lines[k]!.comment) k++;
      if (k < lines.length && lines[k]!.indent > indent) {
        throw new ParseSubsetError("content after a tagged scalar is not supported", lines[k]!.num);
      }
      entries.push([kv.key, { kind: "opaque", raw: rest }]);
      j = k - 1;
    } else {
      const { value: v } = parseInline(rest, L.num);
      let value = v;
      const first = rest.trimStart()[0]!;
      const isQuotedOrFlow = first === '"' || first === "'" || first === "{" || first === "[";
      let k = j + 1;
      while (k < lines.length && lines[k]!.indent > indent && !lines[k]!.blank && !lines[k]!.comment) {
        const C = lines[k]!;
        if (isQuotedOrFlow || isDashLine(C.content) || splitKey(C.content, C.num)) {
          throw new ParseSubsetError("nested content after a scalar value is not valid here", C.num);
        }
        // Multi-line plain scalar: fold with a single space.
        const sv = value as { kind: "scalar"; value: string | number | boolean | null };
        sv.value = `${String(sv.value)} ${stripComment(C.content, C.num)}`.trim();
        k++;
      }
      entries.push([kv.key, value]);
      j = k - 1; // the trailing j++ lands past the consumed lines
    }
    j++;
  }
  return { value: { kind: "map", entries }, next: j };
}

function parseSeqBlock(lines: Line[], i: number, indent: number): Block {
  const items: YamlValue[] = [];
  let j = i;
  while (j < lines.length) {
    const L = lines[j]!;
    if (L.blank || L.comment) {
      j++;
      continue;
    }
    if (L.indent < indent) break;
    if (L.indent > indent) throw new ParseSubsetError("unexpected indentation inside a sequence", L.num);
    if (!isDashLine(L.content)) throw new ParseSubsetError(`expected a sequence item`, L.num);

    const afterRaw = L.content.slice(1).replace(/^[ \t]+/, "");
    const pad = L.content.slice(1).length - afterRaw.length; // spaces after the dash
    if (afterRaw === "") {
      // Bare dash: the item is a nested block (or null).
      const nested = parseBlock(lines, j + 1, L.indent);
      items.push(nested.value ?? nullScalar());
      if (nested.value !== null) j = nested.next - 1;
    } else if (splitKey(afterRaw, L.num)) {
      // Compact mapping: the dash line carries the first entry at its key
      // column (dash + padding). Re-express it as a virtual key line.
      const itemIndent = L.indent + 1 + pad;
      const virtual: Line = {
        num: L.num,
        raw: " ".repeat(itemIndent) + afterRaw,
        indent: itemIndent,
        content: afterRaw,
        blank: false,
        comment: false,
      };
      const map = parseMapBlock([virtual, ...lines.slice(j + 1)], 0, itemIndent);
      items.push(map.value ?? nullScalar());
      j = j + (map.next - 1); // virtual line 0 is the original line j
    } else {
      const rest = stripComment(afterRaw, L.num);
      let value: YamlValue;
      if (rest[0] === "|" || rest[0] === ">") throw new ParseSubsetError("block scalars are not supported", L.num);
      if (rest[0] === "&" || rest[0] === "*") throw new ParseSubsetError("anchors/aliases are not supported", L.num);
      if (rest[0] === "!") {
        let k = j + 1;
        while (k < lines.length && lines[k]!.indent > L.indent && !lines[k]!.blank && !lines[k]!.comment) k++;
        if (k < lines.length && lines[k]!.indent > L.indent) {
          throw new ParseSubsetError("content after a tagged scalar is not supported", lines[k]!.num);
        }
        value = { kind: "opaque", raw: rest };
        j = k;
        items.push(value);
        continue;
      }
      const { value: v } = parseInline(rest, L.num);
      value = v;
      const first = rest.trimStart()[0]!;
      const isQuotedOrFlow = first === '"' || first === "'" || first === "{" || first === "[";
      let k = j + 1;
      while (k < lines.length && lines[k]!.indent > L.indent && !lines[k]!.blank && !lines[k]!.comment) {
        const C = lines[k]!;
        if (isQuotedOrFlow || isDashLine(C.content) || splitKey(C.content, C.num)) {
          throw new ParseSubsetError("nested content after a scalar item is not valid here", C.num);
        }
        const sv = value as { kind: "scalar"; value: string | number | boolean | null };
        sv.value = `${String(sv.value)} ${stripComment(C.content, C.num)}`.trim();
        k++;
      }
      j = k - 1; // the trailing j++ lands past the consumed lines
      items.push(value);
    }
    j++;
  }
  return { value: { kind: "seq", items }, next: j };
}

// ---------------------------------------------------------------------------
// Public parse
// ---------------------------------------------------------------------------

/**
 * Parse a whole YAML document (single root: a mapping, a sequence, or
 * empty). Fails — with a reason and line — on any construct outside the
 * subset or on document markers / directives / tabs.
 */
export function parseYaml(text: string): YamlParse {
  const lines = text.split("\n");
  const parsed: Line[] = [];
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n]!.replace(/\r$/, "");
    const lead = raw.match(/^[ \t]*/)?.[0] ?? "";
    if (lead.includes("\t")) return fail("tab indentation is not supported", n + 1);
    const indent = lead.length;
    const content = raw.slice(indent);
    const blank = content.trim() === "";
    const comment = content.startsWith("#");
    if (!blank && /^(?:---|\.\.\.)\s*(?:#.*)?$/.test(content)) {
      return fail("document markers (---/…) are not supported", n + 1);
    }
    if (!blank && content.startsWith("%")) {
      return fail("directives are not supported", n + 1);
    }
    parsed.push({ num: n + 1, raw, indent, content, blank, comment });
  }
  const first = parsed.find((L) => !L.blank && !L.comment);
  if (!first) return { ok: true, value: null };
  if (first.indent !== 0) {
    return fail(`the document root must start at column 0 (line ${first.num} does not)`, first.num);
  }
  const isSeq = isDashLine(first.content);
  const isMap = !isSeq && splitKey(first.content, first.num) !== null;
  if (!isSeq && !isMap) {
    return fail(`the document root must be a mapping or a sequence`, first.num);
  }
  try {
    const block = isSeq ? parseSeqBlock(parsed, 0, 0) : parseMapBlock(parsed, 0, 0);
    for (let k = block.next; k < parsed.length; k++) {
      const L = parsed[k]!;
      if (!L.blank && !L.comment) {
        return fail(`content after the document root`, L.num);
      }
    }
    return { ok: true, value: block.value };
  } catch (e) {
    if (e instanceof ParseSubsetError) return fail(e.message, e.line);
    return fail(`unexpected parser failure: ${String(e)}`, first.num);
  }
}

/** parseYaml that throws — for callers that have already validated. */
export function parseYamlOrThrow(text: string): YamlValue | null {
  const r = parseYaml(text);
  if (!r.ok) throw new Error(`YAML: ${r.reason} (line ${r.line})`);
  return r.value;
}

// ---------------------------------------------------------------------------
// Structural comparison
// ---------------------------------------------------------------------------

export function deepEqualYaml(a: YamlValue | null, b: YamlValue | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "map" && b.kind === "map") {
    if (a.entries.length !== b.entries.length) return false;
    for (let i = 0; i < a.entries.length; i++) {
      const [ak, av] = a.entries[i]!;
      const [bk, bv] = b.entries[i]!;
      if (ak !== bk || !deepEqualYaml(av, bv)) return false;
    }
    return true;
  }
  if (a.kind === "seq" && b.kind === "seq") {
    if (a.items.length !== b.items.length) return false;
    for (let i = 0; i < a.items.length; i++) {
      if (!deepEqualYaml(a.items[i]!, b.items[i]!)) return false;
    }
    return true;
  }
  if (a.kind === "scalar" && b.kind === "scalar") {
    if (Number.isNaN(a.value as number) && Number.isNaN(b.value as number)) return true;
    return a.value === b.value;
  }
  if (a.kind === "opaque" && b.kind === "opaque") {
    return a.raw === b.raw;
  }
  return false;
}

/**
 * Paths (dotted, root-relative; `[i]` for sequence positions) whose values
 * differ between two parsed documents. Missing-on-one-side counts as a diff.
 */
export function diffPaths(a: YamlValue | null, b: YamlValue | null): string[] {
  const out: string[] = [];
  const walk = (x: YamlValue | null, y: YamlValue | null, path: string) => {
    if (deepEqualYaml(x, y)) return;
    if ((x === null) !== (y === null)) {
      // One side absent: descend into the present container so the diff
      // reports its children (prefix-ignore lists can then match them).
      const present = (x ?? y)!;
      if (present.kind === "map") {
        for (const [k, v] of present.entries) walk(null, v, path ? `${path}.${k}` : k);
        return;
      }
      if (present.kind === "seq") {
        present.items.forEach((v, i) => walk(null, v, `${path}[${i}]`));
        return;
      }
      out.push(path || "(root)");
      return;
    }
    // (both-null is unreachable: deepEqualYaml above would have returned)
    if (x === null || y === null) {
      out.push(path || "(root)");
      return;
    }
    if (x.kind !== y.kind) {
      out.push(path || "(root)");
      return;
    }
    if (x.kind === "map" && y.kind === "map") {
      const max = Math.max(x.entries.length, y.entries.length);
      for (let i = 0; i < max; i++) {
        // Unequal entry counts: the shorter side has no entry at i.
        const xe = x.entries[i];
        const ye = y.entries[i];
        const key = xe?.[0] ?? ye?.[0] ?? `#${i}`;
        walk(xe ? xe[1] : null, ye ? ye[1] : null, path ? `${path}.${key}` : key);
      }
      return;
    }
    if (x.kind === "seq" && y.kind === "seq") {
      const max = Math.max(x.items.length, y.items.length);
      for (let i = 0; i < max; i++) {
        walk(x.items[i] ?? null, y.items[i] ?? null, path ? `${path}[${i}]` : `[${i}]`);
      }
      return;
    }
    out.push(path || "(root)");
  };
  walk(a, b, "");
  return out;
}

/** Navigate a parsed document along `path` (keys and 0-based indexes). */
export function getIn(value: YamlValue | null, path: (string | number)[]): YamlValue | null {
  let v: YamlValue | null = value;
  for (const p of path) {
    if (v === null) return null;
    if (typeof p === "number") {
      if (v.kind !== "seq") return null;
      v = v.items[p] ?? null;
    } else {
      if (v.kind !== "map") return null;
      v = v.entries.find(([k]) => k === p)?.[1] ?? null;
    }
  }
  return v;
}

/** True when `path` is `ignore` itself or extends it (dot or bracket). */
export function pathIgnored(path: string, ignore: string[]): boolean {
  return ignore.some((p) => path === p || path.startsWith(`${p}.`) || path.startsWith(`${p}[`));
}
