/**
 * The join sheet's words and rules (docs/redesign/inventory.md § 8.3–8.5): Particl is invite-only, so a visitor who
 * tries to make, ask, upload, download or open anything is shown the sheet, with two ways in: an invite code, or a
 * request for access. Pure (tests/unit/v12-join-model.spec.ts).
 */

/** Why the sheet opened (the prototype's `join=` reasons). */
export const JOIN_REASONS = ["start", "make", "upload", "ask", "download", "plus", "library", "price", "approve", "request"] as const;
export type JoinReason = (typeof JOIN_REASONS)[number];

export const isJoinReason = (value: unknown): value is JoinReason => typeof value === "string" && (JOIN_REASONS as readonly string[]).includes(value);

/**
 * The sheet's title for a reason. `detail` is what the action was, with its price as the quote gave it ("4 stills ·
 * 8 cr"); it is appended after " · " and never written here.
 */
export function joinTitle(reason: JoinReason, detail?: string | null): string {
  const base: Record<JoinReason, string> = {
    start: "To start a board you need a Particl account",
    make: "To make this you need a Particl account",
    upload: "To upload or attach files you need a Particl account",
    ask: "To ask Atomik you need a Particl account",
    download: "To download originals you need a Particl account",
    plus: "To open a new board you need a Particl account",
    library: "To add to a Library you need a Particl account",
    price: "To run this you need a Particl account",
    /* Approve, Lock and other free actions on the sample (the prototype left them ungated; § 8.1). */
    approve: "To change the sample you need a Particl account",
    request: "Request access to Particl",
  };
  const extra = detail?.trim();
  return extra && (reason === "make" || reason === "price") ? `${base[reason]} · ${extra}` : base[reason];
}

export const ROLES = ["Production house", "Agency", "Brand", "Creator", "Other"] as const;
export const COMPANY_SIZES = ["1–10", "11–50", "51–200", "200+"] as const;

export type RequestFields = { name: string; email: string; company: string; role: string; size: string; want: string };

export const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(s.trim()) && s.trim().length <= 200;

/** What is missing before a request can go, in the product's words; null when it can go. */
export function requestProblem(fields: RequestFields): string | null {
  if (!fields.name.trim()) return "Tell us your name.";
  if (!looksLikeEmail(fields.email)) return "Enter your work email.";
  return null;
}

/**
 * The body for today's POST /api/access-request. The company goes as `organisation`: `company` is that route's
 * honeypot, which only a bot fills. Company, role and size ride in the request's note, as the brief already does.
 */
export function requestBody(fields: RequestFields, reason: JoinReason): Record<string, string> {
  const body: Record<string, string> = {
    name: fields.name.trim(),
    email: fields.email.trim(),
    note: `From the join sheet (${reason})`,
  };
  if (fields.company.trim()) body.organisation = fields.company.trim();
  if ((ROLES as readonly string[]).includes(fields.role)) body.role = fields.role;
  if ((COMPANY_SIZES as readonly string[]).includes(fields.size)) body.size = fields.size;
  if (fields.want.trim()) body.brief = fields.want.trim();
  return body;
}

/* ── Invite codes ──────────────────────────────────────────────────────────── */

/**
 * What an invite code is, as today's routes answer for it: a team invite (GET /api/auth/accept?code=, a
 * workspace_invites row) joins a workspace; a new-workspace invite (GET /api/auth/signup?code=, a signup_invites row)
 * creates one. A used or expired code of either kind is "expired".
 */
export type InviteKind =
  | { kind: "team"; code: string; workspace: string; email: string; name: string }
  | { kind: "new"; code: string; email: string; name: string }
  | { kind: "expired"; code: string; why: string }
  | { kind: "invalid"; code: string };

export const cleanCode = (raw: string) => raw.trim().replace(/\s+/g, "").slice(0, 120);

/** Reads the two routes' answers (status and body) into one kind. */
export function inviteKind(code: string, team: { status: number; body: Record<string, unknown> }, signup: { status: number; body: Record<string, unknown> } | null): InviteKind {
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  if (team.status === 200 && team.body.ok) return { kind: "team", code, workspace: text(team.body.workspace), email: text(team.body.email), name: text(team.body.name) };
  if (team.status === 409 || team.status === 410) return { kind: "expired", code, why: text(team.body.error) || "This invite has expired or been used." };
  if (!signup) return { kind: "invalid", code };
  if (signup.status === 200 && !signup.body.error) return { kind: "new", code, email: text(signup.body.email), name: text(signup.body.name) };
  if (signup.status === 409 || signup.status === 410) return { kind: "expired", code, why: text(signup.body.error) || "This invite has expired or been used." };
  return { kind: "invalid", code };
}

/** Where "Continue with email" goes for a code: today's pages, which verify exactly what they verify today. */
export function emailPath(invite: InviteKind): string | null {
  if (invite.kind === "team") return `/invite/${encodeURIComponent(invite.code)}`;
  if (invite.kind === "new") return `/signup?invite=${encodeURIComponent(invite.code)}`;
  return null;
}

/** "Log in", coming back to where the visitor was. */
export const loginPath = (back: string) => `/login?next=${encodeURIComponent(back.startsWith("/") ? back : "/")}`;
