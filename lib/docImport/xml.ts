import { MAX_XML_DEPTH, MAX_XML_EVENTS } from "./limits";
import { DocImportError, type Deadline } from "./types";

/**
 * A small streaming XML reader for untrusted documents.
 *
 * It exists so no import depends on a general XML parser's defaults. It has
 * no DTD support at all: no external entities, no parameter entities, no
 * entity declarations, nothing fetched, nothing read from disk. The only
 * references it expands are the five predefined entities (&amp; &lt; &gt;
 * &quot; &apos;) and numeric character references. Any other `&name;` is
 * left in the text exactly as written and counted, so a billion-laughs or
 * XXE payload can only ever appear as its own literal characters.
 *
 * A `<!DOCTYPE` is either refused (`doctype: "refuse"`, for Office parts and
 * Final Draft files, which never carry one) or stepped over unread
 * (`doctype: "skip"`, for SVG, where editors often write one). It runs in
 * linear time with indexOf scans, an explicit element stack (no recursion),
 * and limits on depth and events.
 */

export type XmlAttributes = Record<string, string>;

export type XmlEvent =
  | { type: "open"; name: string; attrs: XmlAttributes; selfClosing: boolean }
  | { type: "close"; name: string }
  | { type: "text"; text: string };

export type XmlOptions = {
  doctype: "refuse" | "skip";
  /** What the refusal names ("This slide", "This Final Draft file"). */
  label?: string;
  maxDepth?: number;
  maxEvents?: number;
  /** Shared across several parts: every event of every part draws from it. */
  eventBudget?: { remaining: number };
  deadline?: Deadline;
};

export type XmlScanResult = {
  /** The root element's name, as written (with its prefix). */
  root: string;
  /** Entity references other than the predefined five, left unexpanded. */
  unknownEntities: number;
  /** True when a DOCTYPE was stepped over unread. */
  skippedDoctype: boolean;
};

/** The element name without its namespace prefix: `a:t` → `t`. */
export const localName = (name: string) => {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
};

/** An attribute by local name, whatever its prefix (`r:id`, `id`). */
export function attr(attrs: XmlAttributes, name: string): string | undefined {
  if (name in attrs) return attrs[name];
  for (const key of Object.keys(attrs)) if (localName(key) === name) return attrs[key];
  return undefined;
}

const PREDEFINED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(raw: string, counter: { unknown: number }): string {
  if (raw.indexOf("&") === -1) return raw;
  let out = "";
  let at = 0;
  while (at < raw.length) {
    const amp = raw.indexOf("&", at);
    if (amp === -1) {
      out += raw.slice(at);
      break;
    }
    out += raw.slice(at, amp);
    // A reference is short: look for its ";" in the next few characters only,
    // so text full of bare "&" stays linear. A lone "&" is kept as written.
    const near = raw.slice(amp + 1, amp + 13).indexOf(";");
    const semi = near === -1 ? -1 : amp + 1 + near;
    if (semi === -1) {
      out += "&";
      at = amp + 1;
      continue;
    }
    const body = raw.slice(amp + 1, semi);
    let decoded: string | null = null;
    if (Object.prototype.hasOwnProperty.call(PREDEFINED, body)) decoded = PREDEFINED[body];
    else if (/^#x[0-9a-fA-F]{1,6}$/.test(body) || /^#[0-9]{1,7}$/.test(body)) {
      const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      const allowed =
        code === 0x9 || code === 0xa || code === 0xd ||
        (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
      if (allowed) decoded = String.fromCodePoint(code);
    }
    if (decoded === null) {
      // Not expanded, ever: an undeclared or custom entity stays literal text.
      counter.unknown++;
      out += raw.slice(amp, semi + 1);
    } else out += decoded;
    at = semi + 1;
  }
  return out;
}

const NAME = /^[A-Za-z_:][-A-Za-z0-9_:.·À-￿]*$/;

function malformed(label: string): never {
  throw new DocImportError("damaged", `${label} is damaged or incomplete. Nothing was imported.`);
}

/** Step over a DOCTYPE without reading it, internal subset included. Returns the index after it. */
function skipDoctype(source: string, start: number, label: string): number {
  let depth = 0;
  let quote = "";
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === ">" && depth === 0) return i + 1;
    else if (ch === "<" && source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      if (end === -1) malformed(label);
      i = end + 2;
    }
  }
  return malformed(label);
}

function parseTag(body: string, label: string): { name: string; attrs: XmlAttributes } {
  let i = 0;
  while (i < body.length && !/[\s]/.test(body[i])) i++;
  const name = body.slice(0, i);
  if (!NAME.test(name)) malformed(label);
  // A null-prototype map: an attribute named "__proto__" is only ever data.
  const attrs: XmlAttributes = Object.create(null);
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;
    const eq = body.indexOf("=", i);
    if (eq === -1) malformed(label);
    const key = body.slice(i, eq).trim();
    if (!NAME.test(key)) malformed(label);
    let q = eq + 1;
    while (q < body.length && /\s/.test(body[q])) q++;
    const quote = body[q];
    if (quote !== '"' && quote !== "'") malformed(label);
    const close = body.indexOf(quote, q + 1);
    if (close === -1) malformed(label);
    attrs[key] = body.slice(q + 1, close);
    i = close + 1;
  }
  return { name, attrs };
}

/**
 * Read `source` and call `onEvent` for each element and text run. Throws a
 * DocImportError for a refused DOCTYPE, a malformed or truncated document,
 * or a limit; returns what the caller needs to warn about.
 */
export function scanXml(source: string, onEvent: (event: XmlEvent) => void, options: XmlOptions): XmlScanResult {
  const label = options.label ?? "This file";
  const maxDepth = options.maxDepth ?? MAX_XML_DEPTH;
  const maxEvents = options.maxEvents ?? MAX_XML_EVENTS;
  const counter = { unknown: 0 };
  const stack: string[] = [];
  let root = "";
  let rootClosed = false;
  let skippedDoctype = false;
  let events = 0;
  const count = () => {
    if (++events > maxEvents || (options.eventBudget && --options.eventBudget.remaining < 0))
      throw new DocImportError("limit", `${label} has more structure than the importer reads. Nothing was imported.`);
    if (events % 4096 === 0) options.deadline?.check();
  };
  const emit = (event: XmlEvent) => {
    count();
    onEvent(event);
  };
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    const textEnd = lt === -1 ? source.length : lt;
    if (textEnd > i) {
      const raw = source.slice(i, textEnd);
      if (stack.length) emit({ type: "text", text: decodeEntities(raw, counter) });
      else if (raw.trim()) malformed(label);
    }
    if (lt === -1) break;
    if (source.startsWith("<?", lt)) {
      const end = source.indexOf("?>", lt + 2);
      if (end === -1) malformed(label);
      // Comments and processing instructions emit nothing, but a DOM keeps a
      // node for each: they count against the limits like any event.
      count();
      i = end + 2;
    } else if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      if (end === -1) malformed(label);
      count();
      i = end + 3;
    } else if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      if (end === -1 || !stack.length) malformed(label);
      emit({ type: "text", text: source.slice(lt + 9, end) });
      i = end + 3;
    } else if (/^<!doctype/i.test(source.slice(lt, lt + 9))) {
      if (options.doctype === "refuse" || root)
        throw new DocImportError(
          "unsafe",
          `${label} declares a document type, which the importer does not read. Nothing was imported.`,
        );
      skippedDoctype = true;
      i = skipDoctype(source, lt + 9, label);
    } else if (source[lt + 1] === "!") {
      // <!ENTITY, <!ELEMENT and friends are only legal inside a DOCTYPE.
      throw new DocImportError("unsafe", `${label} contains declarations the importer does not read. Nothing was imported.`);
    } else if (source[lt + 1] === "/") {
      const end = source.indexOf(">", lt + 2);
      if (end === -1) malformed(label);
      const name = source.slice(lt + 2, end).trim();
      if (stack.pop() !== name) malformed(label);
      emit({ type: "close", name });
      if (!stack.length) rootClosed = true;
      i = end + 1;
    } else {
      // Find the tag's end outside quoted attribute values.
      let end = lt + 1;
      let quote = "";
      for (; end < source.length; end++) {
        const ch = source[end];
        if (quote) {
          if (ch === quote) quote = "";
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === ">") break;
        else if (ch === "<") malformed(label);
      }
      if (end >= source.length) malformed(label);
      const selfClosing = source[end - 1] === "/";
      const { name, attrs: raw } = parseTag(source.slice(lt + 1, selfClosing ? end - 1 : end), label);
      if (rootClosed) malformed(label);
      if (!root) root = name;
      const attrs: XmlAttributes = Object.create(null);
      for (const key of Object.keys(raw)) attrs[key] = decodeEntities(raw[key], counter);
      if (!selfClosing) {
        stack.push(name);
        if (stack.length > maxDepth)
          throw new DocImportError("limit", `${label} is nested deeper than the importer reads. Nothing was imported.`);
      }
      emit({ type: "open", name, attrs, selfClosing });
      if (selfClosing) {
        emit({ type: "close", name });
        if (!stack.length) rootClosed = true;
      }
      i = end + 1;
    }
  }
  if (!root || stack.length) malformed(label);
  return { root, unknownEntities: counter.unknown, skippedDoctype };
}

/** The first element's name, without reading the rest; null when the text is not XML-shaped. */
export function rootElementName(source: string): string | null {
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (let guard = 0; guard < 64; guard++) {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] !== "<") return null;
    if (source.startsWith("<?", i)) {
      const end = source.indexOf("?>", i);
      if (end === -1) return null;
      i = end + 2;
    } else if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i);
      if (end === -1) return null;
      i = end + 3;
    } else if (/^<!doctype/i.test(source.slice(i, i + 9))) {
      try {
        i = skipDoctype(source, i + 9, "This file");
      } catch {
        return null;
      }
    } else {
      const match = /^<([A-Za-z_:][-A-Za-z0-9_:.]*)/.exec(source.slice(i, i + 256));
      return match ? match[1] : null;
    }
  }
  return null;
}

/** Decode bytes as UTF-8 (BOM allowed), or UTF-16 with a BOM; refuse anything that does not decode. */
export function decodeXmlBytes(bytes: Uint8Array, label: string): string {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DocImportError("damaged", `${label} is not readable text. Nothing was imported.`);
  }
}
