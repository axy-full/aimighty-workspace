/**
 * @names in prose. A mention is `@` followed by a name; a name is one word
 * unless the cast already knows a longer one — "@Coast road" is one place
 * because the cast says so, and "@Cass comes in" is one person because it
 * doesn't. Case-insensitive, deduplicated, in order of first appearance.
 */
export function mentionsIn(text: string, known: string[] = []): string[] {
  const out: string[] = [];
  const names = known.slice().sort((a, b) => b.length - a.length);
  const at = /@(?=[A-Za-z])/g;
  let m: RegExpExecArray | null;
  while ((m = at.exec(text))) {
    const rest = text.slice(m.index + 1);
    const hit = names.find((n) => rest.toLowerCase().startsWith(n.toLowerCase()) && !/\w/.test(rest.charAt(n.length)));
    const word = hit ?? (rest.match(/^[A-Za-z][\w'-]*/)?.[0] ?? "");
    if (word && !out.some((o) => o.toLowerCase() === word.toLowerCase())) out.push(word);
  }
  return out;
}

/** The prose split into plain runs and mention runs, for highlighting. */
export function splitMentions(text: string, known: string[] = []): { text: string; mention: boolean }[] {
  const names = known.slice().sort((a, b) => b.length - a.length);
  const parts: { text: string; mention: boolean }[] = [];
  let i = 0;
  const at = /@(?=[A-Za-z])/g;
  let m: RegExpExecArray | null;
  while ((m = at.exec(text))) {
    const rest = text.slice(m.index + 1);
    const hit = names.find((n) => rest.toLowerCase().startsWith(n.toLowerCase()) && !/\w/.test(rest.charAt(n.length)));
    const word = hit ?? (rest.match(/^[A-Za-z][\w'-]*/)?.[0] ?? "");
    if (!word) continue;
    if (m.index > i) parts.push({ text: text.slice(i, m.index), mention: false });
    parts.push({ text: `@${text.substr(m.index + 1, word.length)}`, mention: true });
    i = m.index + 1 + word.length;
    at.lastIndex = i;
  }
  if (i < text.length) parts.push({ text: text.slice(i), mention: false });
  return parts;
}
