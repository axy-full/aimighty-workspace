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

/**
 * The names a prompt cites that nobody has made yet (the composer's "@Maya
 * needs a reference"). Read the way `mentionsIn` reads them — one word unless
 * a known name is longer — so "@Maya walks in" asks about Maya, never about
 * "Maya Walks". An `@` inside a word is an address ("studio@acme.com"), not a
 * citation, and the engines' own `@Image1` / `@Video2` are theirs to read.
 */
export function unknownMentions(text: string, known: string[]): string[] {
  const names = new Set(known.map((n) => n.toLowerCase()));
  return mentionsIn(text.replace(/(?<=\w)@/g, " "), known)
    .filter((n) => !names.has(n.toLowerCase()) && !/^(image|video|audio)\d+$/i.test(n));
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

/** Someone on the team, as a note may name them. */
export type Person = { id: string; name: string };

/** The names a person answers to in a note: their full name, and their first when it is theirs alone. */
export function nicknames(people: Person[]): { name: string; id: string }[] {
  const firsts = new Map<string, number>();
  for (const p of people) {
    const first = p.name.trim().split(/\s+/)[0] ?? "";
    if (first) firsts.set(first.toLowerCase(), (firsts.get(first.toLowerCase()) ?? 0) + 1);
  }
  const out: { name: string; id: string }[] = [];
  for (const p of people) {
    const full = p.name.trim();
    if (full) out.push({ name: full, id: p.id });
    const first = full.split(/\s+/)[0] ?? "";
    if (first && first !== full && (firsts.get(first.toLowerCase()) ?? 0) === 1) out.push({ name: first, id: p.id });
  }
  return out;
}

/** Who a note names, once each. A name nobody answers to is left alone. */
export function peopleIn(text: string, people: Person[]): Person[] {
  const names = nicknames(people);
  const said = mentionsIn(text, names.map((n) => n.name));
  const ids = new Set<string>();
  const out: Person[] = [];
  for (const word of said) {
    const hit = names.find((n) => n.name.toLowerCase() === word.toLowerCase());
    if (!hit || ids.has(hit.id)) continue;
    ids.add(hit.id);
    const person = people.find((p) => p.id === hit.id);
    if (person) out.push(person);
  }
  return out;
}


/** Only a name the note actually resolved reads as a mention; an address in the text does not. */
export function isNamed(part: { text: string; mention: boolean }, names: string[]): boolean {
  if (!part.mention) return false;
  const word = part.text.replace(/^@/, "").toLowerCase();
  return names.some((n) => n.toLowerCase() === word);
}
