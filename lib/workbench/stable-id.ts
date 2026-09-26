/**
 * An id made from what a thing is rather than from chance: two windows that
 * make the same thing — a shot's first direction note, a sound lane, the
 * places one agent run built, a variant bound to a node — give it the same id,
 * so the merge of their saves (lib/workbench/merge.ts, which keys records by
 * id) holds it once instead of twice.
 *
 * `prefix-` then 16 hex characters: fits every id pattern a draft uses.
 */
export function stableId(prefix: string, ...parts: (string | number)[]): string {
  const text = JSON.stringify(parts);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${prefix}-${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
}
