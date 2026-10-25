import { MAX_BLOCK_TEXT } from "./shapes";

/**
 * A block's text in parts of at most `max` characters, split never cut (decision 2): each part ends at the last whitespace
 * inside the limit where there is one, else at the limit itself (never between the two halves of a surrogate pair), and the
 * parts join back to the text exactly. Empty text is one empty part.
 */
export function splitText(text: string, max = MAX_BLOCK_TEXT): string[] {
  if (!Number.isInteger(max) || max < 2) throw new RangeError("max");
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let end = max;
    const space = Math.max(rest.lastIndexOf(" ", max - 1), rest.lastIndexOf("\n", max - 1), rest.lastIndexOf("\t", max - 1));
    if (space > 0) end = space + 1;
    else if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end -= 1;
    parts.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  parts.push(rest);
  return parts;
}
