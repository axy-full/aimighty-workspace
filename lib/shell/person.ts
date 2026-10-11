/**
 * Who the avatar menu names (design/particl-graphite/README.md § 1, the master's account menu): the person's name, then
 * "workspace · role". A name that is really an id (an account id, a workspace slug, the placeholder a browser sign-in
 * leaves) is never shown as one: the next honest thing is.
 */

/** An id, not a name: one long token with no space (`y_AD14WC77…`, a UUID), an id's own prefix, or a "Browser …" placeholder. */
export function looksLikeId(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^browser\b/i.test(t)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return true;
  if (/^(ws|acct|account|usr|user|workspace|w|a|u)[_-][A-Za-z0-9_-]{4,}$/i.test(t)) return true;
  return !/\s/.test(t) && !t.includes("@") && t.length >= 16 && /[0-9]/.test(t) && /[A-Za-z]/.test(t);
}

/** The text when it reads as a name, else null. */
export function readableName(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  return t && !looksLikeId(t) ? t : null;
}

/** The menu's first line: the person's name; with none, their address; never an id. */
export function personLine(person: { name: string | null; email: string | null }): string {
  return readableName(person.name) ?? ((person.email ?? "").trim() || "Your account");
}

/** The menu's second line: "workspace · role", with "Your workspace" where the workspace has no name that reads as one. */
export function workspaceLine(workspace: string | null | undefined, role: string | null | undefined): string {
  return [readableName(workspace) ?? "Your workspace", role].filter(Boolean).join(" · ");
}

/** The avatar's letters: the person's initials ("AP"); with no readable name, the workspace's; else "P". */
export function avatarInitials(person: { name: string | null }, workspace: string | null | undefined): string {
  const of = (text: string | null) => (text ?? "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
  return of(readableName(person.name)) || of(readableName(workspace)) || "P";
}
