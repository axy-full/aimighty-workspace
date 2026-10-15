import { createHash } from "node:crypto";
import { isHouseWorkspace } from "./houseWorkspace";
import { currentTenant, type TenantWorkspace } from "./tenant";

/**
 * The platform owner is seen only in the house workspace.
 *
 * Owner's rule: the platform owner's address and name never appear in any
 * other workspace — not on the Team page, in @mentions, activity, approvals,
 * comments, audit lines a client can see, or in email. Where something they
 * did has to show in a client workspace, it shows as "Particl support" (a
 * person's action) or "Particl" (a system line).
 *
 * Who the platform owner is stays where it was decided (`isPlatformOwner` in
 * lib/auth.ts): the deployment's SUPER_ADMIN_EMAIL, or the owner of the
 * house (legacy) workspace. Nothing here names a person.
 *
 * Applied at the data boundary, for everything written from now on:
 * - a client workspace's own `users` table holds the owner as "Particl
 *   support" (`mirrorIdentity`, used by every writer of that table), so every
 *   join on it — jobs, notes, chat, activity, approvals, exports — reads so;
 * - the signed-in session's display name is "Particl support" inside a client
 *   workspace (`maskSessionUser`), so names written at the time of an action
 *   (picked by, review link by, push text, invite email) are too;
 * - the Team list shows the owner as one "Particl support" row with no
 *   address, @mention lists leave them out, audit lines name them "Particl
 *   support" (`ownerMaskFor`);
 * - a few stored values guests or members read are masked as they are read
 *   (`storedActorMask`, `maskStoredActor`).
 * What was written before is rewritten only on request, per workspace, after
 * a dry run (lib/platformOwnerScrub.ts).
 */

export const SUPPORT_ACTOR = "Particl support";
export const SYSTEM_ACTOR = "Particl";

/** The address a client workspace's `users` row carries for the owner: reserved TLD, never deliverable, never a person. */
export const SUPPORT_MIRROR_DOMAIN = "support.particl.invalid";

/**
 * The platform owner: the configured address, the accounts that are theirs
 * (the house workspace's owner, and the account at that address), and those
 * accounts' names (only ever compared against, never shown outside the house).
 */
export type PlatformOwnerIdentity = { email: string | null; accountIds: string[]; names?: string[] };

type Who = { id?: unknown; email?: unknown } | null | undefined;

const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** The owner's address, exactly, or as a removed member's row mangles it ("<address>#deleted-<ts>"). */
export function isOwnerAddress(identity: PlatformOwnerIdentity, value: unknown): boolean {
  const email = norm(value);
  if (!identity.email || !email) return false;
  return email === identity.email || email.startsWith(`${identity.email}#deleted-`);
}

/** True when `who` is the platform owner described by `identity`. */
export function isOwnerIdentity(identity: PlatformOwnerIdentity, who: Who): boolean {
  if (!who) return false;
  if (isOwnerAddress(identity, who.email)) return true;
  const id = who.id == null ? "" : String(who.id);
  return Boolean(id) && identity.accountIds.includes(id);
}

/** A `users` row written for the owner in a client workspace. */
export function isSupportMirrorEmail(email: unknown): boolean {
  return norm(email).endsWith(`@${SUPPORT_MIRROR_DOMAIN}`);
}

let cached: { at: number; identity: PlatformOwnerIdentity } | null = null;
const CACHE_MS = 60_000;

const envIdentity = (): PlatformOwnerIdentity => ({ email: norm(process.env.SUPER_ADMIN_EMAIL) || null, accountIds: [], names: [] });

/** Who the platform owner is, read the way `isPlatformOwner` reads it. Cached for a minute. */
export async function platformOwnerIdentity(): Promise<PlatformOwnerIdentity> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.identity;
  const identity = envIdentity();
  const names = new Set<string>();
  try {
    const { legacyWorkspace, findAccountByEmail, getAccount } = await import("./platform");
    const house = await legacyWorkspace();
    const accounts = [
      house?.ownerId ? await getAccount(house.ownerId) : null,
      identity.email ? await findAccountByEmail(identity.email) : null,
    ];
    for (const a of accounts) {
      if (!a?.id) continue;
      if (!identity.accountIds.includes(String(a.id))) identity.accountIds.push(String(a.id));
      if (String(a.name ?? "").trim()) names.add(String(a.name).trim());
    }
  } catch {
    // No platform database yet: the address alone decides, and nothing is cached.
    return identity;
  }
  identity.names = [...names];
  cached = { at: Date.now(), identity };
  return identity;
}

/** For tests: forget the cached identity. */
export function resetPlatformOwnerIdentity(): void {
  cached = null;
}

export type OwnerMask = {
  /** False in the house workspace: nothing is hidden there. */
  active: boolean;
  /** Is this the platform owner (and is this a workspace that hides them)? */
  hides(who: Who): boolean;
  /** Rows without the platform owner; every row in the house workspace. */
  members<T extends Who>(rows: T[]): T[];
  /** The name a workspace sees for this person. */
  name(who: (Who & { name?: unknown }) | null | undefined): string;
};

/** The mask for one workspace, given who the owner is. Synchronous, so it can run over a list. */
export function maskFor(ws: Pick<TenantWorkspace, "id"> | null | undefined, identity: PlatformOwnerIdentity): OwnerMask {
  const active = !isHouseWorkspace(ws);
  const hides = (who: Who) => active && (isOwnerIdentity(identity, who) || isSupportMirrorEmail(who?.email));
  return {
    active,
    hides,
    members: (rows) => rows.filter((r) => !hides(r)),
    name: (who) => (hides(who) ? SUPPORT_ACTOR : String(who?.name ?? "")),
  };
}

/** The mask for one workspace. */
export async function ownerMaskFor(ws: Pick<TenantWorkspace, "id"> | null | undefined): Promise<OwnerMask> {
  if (isHouseWorkspace(ws)) return maskFor(ws, { email: null, accountIds: [] });
  return maskFor(ws, await platformOwnerIdentity());
}

/** The name a workspace sees for an account: "Particl support" for the platform owner outside the house. */
export async function publicActorName(
  ws: Pick<TenantWorkspace, "id"> | null | undefined,
  who: { id?: unknown; email?: unknown; name?: unknown },
): Promise<string> {
  return (await ownerMaskFor(ws)).name(who);
}

/** The address a workspace may record or show for an account: none for the platform owner outside the house. */
export async function publicActorEmail(
  ws: Pick<TenantWorkspace, "id"> | null | undefined,
  who: { id?: unknown; email?: unknown },
): Promise<string | null> {
  if ((await ownerMaskFor(ws)).hides(who)) return null;
  return typeof who.email === "string" ? who.email : null;
}

/**
 * A stored "who" value (an address, an account id) as the workspace in scope
 * may show it: "Particl support" when it is the platform owner's, outside the
 * house. Synchronous for row mappers: it reads the identity already looked up
 * in this instance, or the configured address alone.
 */
export function maskStoredActor<T extends string | null | undefined>(value: T): T | string {
  if (value == null || value === "") return value;
  const ws = currentTenant()?.workspace;
  if (!ws || isHouseWorkspace(ws)) return value;
  const identity = cached?.identity ?? envIdentity();
  return isOwnerAddress(identity, value) || identity.accountIds.includes(String(value)) ? SUPPORT_ACTOR : value;
}

type Member = { id?: unknown; email?: unknown; name?: unknown };

/** The owner's names that no other member of this workspace goes by: only those may be matched as theirs. */
export function uniqueOwnerNames(identity: PlatformOwnerIdentity, members: Member[]): string[] {
  const others = new Set(members.filter((m) => !isOwnerIdentity(identity, m) && !isSupportMirrorEmail(m.email)).map((m) => String(m.name ?? "").trim()));
  return [...new Set((identity.names ?? []).map((n) => n.trim()).filter((n) => n && n !== SUPPORT_ACTOR && !others.has(n)))];
}

const ATOMIK_FOR = "Atomik for ";

/**
 * A stored "who" value — an address, an account id, or a display name written
 * at the time (also as "Atomik for <name>") — as a workspace may show it:
 * "Particl support" when it is the platform owner's, outside the house. A
 * name counts only when no other member of the workspace goes by it. Built
 * once per read (`members` is the workspace's `users` rows), then synchronous.
 */
export async function storedActorMask(
  ws: Pick<TenantWorkspace, "id"> | null | undefined,
  members: () => Promise<Member[]>,
): Promise<<T extends string | null | undefined>(value: T) => T | string> {
  if (!ws || isHouseWorkspace(ws)) return (value) => value;
  const identity = await platformOwnerIdentity();
  const names = identity.names?.length ? uniqueOwnerNames(identity, await members()) : [];
  const owner = (v: string) => isOwnerAddress(identity, v) || identity.accountIds.includes(v) || names.includes(v.trim());
  return (value) => {
    if (value == null || value === "") return value;
    const atomik = value.startsWith(ATOMIK_FOR);
    const core = atomik ? value.slice(ATOMIK_FOR.length) : value;
    return owner(core) ? (atomik ? `${ATOMIK_FOR}${SUPPORT_ACTOR}` : SUPPORT_ACTOR) : value;
  };
}

/** `storedActorMask` for the workspace in scope, reading its members from its own database. */
export async function storedActorMaskHere(): Promise<<T extends string | null | undefined>(value: T) => T | string> {
  const ws = currentTenant()?.workspace;
  return storedActorMask(ws, async () => {
    const { db } = await import("./db");
    return (await db().execute("SELECT id, email, name FROM users")).rows as unknown as Member[];
  });
}

/**
 * The id a client workspace's Team list gives the platform owner's row: an
 * opaque value of that workspace, so the row carries nothing that names or
 * follows the account across workspaces. `resolveMemberId` turns it back.
 */
export function supportMemberId(workspaceId: string, accountId: string): string {
  return `support_${createHash("sha256").update(`${workspaceId}:${accountId}`).digest("hex").slice(0, 24)}`;
}

/** The account behind a Team row id: the support row's opaque id resolves to the owner's account. */
export async function resolveMemberId(ws: Pick<TenantWorkspace, "id">, id: string): Promise<string> {
  if (!id.startsWith("support_") || isHouseWorkspace(ws)) return id;
  const identity = await platformOwnerIdentity();
  return identity.accountIds.find((accountId) => supportMemberId(ws.id, accountId) === id) ?? id;
}

/**
 * What a workspace's own `users` table stores for an account. Outside the
 * house the platform owner is stored as "Particl support" at an address that
 * is not theirs, so nothing read from that workspace's database can name them.
 */
export function mirrorIdentity(
  ws: Pick<TenantWorkspace, "id"> | null | undefined,
  account: { id: string; email: string; name: string },
  identity: PlatformOwnerIdentity,
): { email: string; name: string } {
  if (isHouseWorkspace(ws) || !isOwnerIdentity(identity, account)) return { email: account.email, name: account.name };
  return { email: `${account.id}@${SUPPORT_MIRROR_DOMAIN}`, name: SUPPORT_ACTOR };
}

/**
 * The signed-in account as a client workspace sees it. The address stays (it
 * is what proves who they are to the platform checks, and it is returned only
 * to its own holder); the name — which routes write into records other people
 * read — becomes "Particl support".
 */
export function maskSessionUser<U extends { id: string; email: string; name: string }>(
  user: U,
  ws: Pick<TenantWorkspace, "id"> | null | undefined,
  identity: PlatformOwnerIdentity,
): U {
  if (isHouseWorkspace(ws) || !ws || !isOwnerIdentity(identity, user)) return user;
  return { ...user, name: SUPPORT_ACTOR };
}

/* ── Who marked a take ── */
/**
 * Who marked a take, as a reader may be told. `review_by`, `picked_by` and `approved_by` hold a display name; a few rows hold an account id instead (the starter's
 * demo take once did). An account id is never output: it is read through this workspace's own `users` row to the name, and the name through the owner mask (the
 * platform owner reads "Particl support" outside the house, this file). An id that names no one here reads as nothing.
 */
export const isAccountId = (value: unknown): value is string => typeof value === "string" && /^usr_/.test(value);

/** A lookup for these stored values: built with one read of this workspace's users (only when an account id is among them) and one of its members for the mask. */
export async function readableActors(values: Iterable<unknown>): Promise<(value: unknown) => string | null> {
  const { db } = await import("./db");
  const present = [...new Set([...values].filter((v): v is string => typeof v === "string" && v !== ""))];
  if (!present.length) return () => null;
  const ids = present.filter(isAccountId);
  const names = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const rows = (await db().execute({ sql: `SELECT id, name FROM users WHERE id IN (${chunk.map(() => "?").join(",")})`, args: chunk }).catch(() => ({ rows: [] as { id?: unknown; name?: unknown }[] }))).rows;
    for (const row of rows) if (row.name) names.set(String(row.id), String(row.name));
  }
  const shown = await storedActorMaskHere();
  return (value) => {
    if (typeof value !== "string" || value === "") return null;
    if (isAccountId(value)) {
      /* The owner's own ids are matched as ids first, with certainty; only then is the name looked up (and masked, for a name nobody else goes by). */
      const byId = String(shown(value));
      if (byId !== value) return byId;
      const name = names.get(value);
      return name ? String(shown(name)) : null;
    }
    return String(shown(value));
  };
}

/* ── The owner's account id, at the response boundary ── */

/**
 * The platform owner's account ids, as a CLIENT workspace's members may see them (owner, 14 Oct: "hide my account id in client workspaces"): every one of them that is not
 * the viewer's own reads as the opaque id the Team page already gives the support row (`supportMemberId`), inside any value or key of a response. The viewer's own id is
 * left alone (the owner's own screens compare it with what they made), and the house workspace is untouched. This is for what is SENT: the stored rows keep the raw id,
 * because the server needs it (who may change work, who may release a take, the jobs tray, recovery).
 */
export async function storedAccountIdMask(
  ws: Pick<TenantWorkspace, "id"> | null | undefined,
  viewerId?: string | null,
): Promise<<T>(value: T) => T> {
  if (!ws || isHouseWorkspace(ws)) return (value) => value;
  const ids = (await platformOwnerIdentity()).accountIds.filter((id) => id && id !== viewerId);
  if (!ids.length) return (value) => value;
  const opaque = new Map(ids.map((id) => [id, supportMemberId(ws.id, id)] as const));
  const swap = (text: string) => { let out = text; for (const [id, hidden] of opaque) if (out.includes(id)) out = out.split(id).join(hidden); return out; };
  const walk = (value: unknown): unknown =>
    typeof value === "string" ? swap(value)
    : Array.isArray(value) ? value.map(walk)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, inner]) => [swap(key), walk(inner)]))
    : value;
  return <T,>(value: T) => walk(value) as T;
}

/** `storedAccountIdMask` for the workspace in scope. */
export async function storedAccountIdMaskHere(viewerId?: string | null) {
  return storedAccountIdMask(currentTenant()?.workspace, viewerId);
}

/**
 * Every JSON answer a data route gives, with the owner's account id hidden from everyone but the owner (lib/auth.ts › withTenant calls this on each). Cheap when there
 * is nothing to hide: the body is only parsed when it holds one of the ids. Not JSON, or compressed, or empty: returned as it is.
 */
export async function hideOwnerAccountId(res: Response, ws: Pick<TenantWorkspace, "id"> | null | undefined, viewerId?: string | null): Promise<Response> {
  if (!ws || isHouseWorkspace(ws) || !res.body) return res;
  if (!/json/i.test(res.headers.get("content-type") ?? "") || res.headers.get("content-encoding")) return res;
  const ids = (await platformOwnerIdentity()).accountIds.filter((id) => id && id !== viewerId);
  if (!ids.length) return res;
  const text = await res.clone().text();
  if (!ids.some((id) => text.includes(id))) return res;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return res; }
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify((await storedAccountIdMask(ws, viewerId))(parsed)), { status: res.status, statusText: res.statusText, headers });
}
