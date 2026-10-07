import { isHouseWorkspace } from "./houseWorkspace";
import type { TenantWorkspace } from "./tenant";

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
 * Applied at the data boundary, in three places:
 * - a client workspace's own `users` table never holds the owner's address or
 *   name (`mirrorIdentity`, used by every writer of that table, and a scrub on
 *   the workspace database's first open), so every join on it — jobs, notes,
 *   chat, activity, approvals, exports — reads "Particl support";
 * - the signed-in session's display name is "Particl support" inside a client
 *   workspace (`maskSessionUser`), so names written at the time of an action
 *   (picked by, review link by, push text, invite email) are too;
 * - lists read from the platform database (Team) leave the owner out
 *   (`ownerMaskFor`).
 */

export const SUPPORT_ACTOR = "Particl support";
export const SYSTEM_ACTOR = "Particl";

/** The address a client workspace's `users` row carries for the owner: reserved TLD, never deliverable, never a person. */
const SUPPORT_MIRROR_DOMAIN = "support.particl.invalid";

/**
 * The platform owner: the configured address, and the accounts that are
 * theirs (the house workspace's owner, and the account at that address).
 */
export type PlatformOwnerIdentity = { email: string | null; accountIds: string[] };

type Who = { id?: unknown; email?: unknown } | null | undefined;

const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** True when `who` is the platform owner described by `identity`. */
export function isOwnerIdentity(identity: PlatformOwnerIdentity, who: Who): boolean {
  if (!who) return false;
  const email = norm(who.email);
  if (identity.email && email && (email === identity.email || email.startsWith(`${identity.email}#deleted-`))) return true;
  const id = who.id == null ? "" : String(who.id);
  return Boolean(id) && identity.accountIds.includes(id);
}

/** A `users` row written for the owner in a client workspace. */
export function isSupportMirrorEmail(email: unknown): boolean {
  return norm(email).endsWith(`@${SUPPORT_MIRROR_DOMAIN}`);
}

let cached: { at: number; identity: PlatformOwnerIdentity } | null = null;
const CACHE_MS = 60_000;

/** Who the platform owner is, read the way `isPlatformOwner` reads it. Cached for a minute. */
export async function platformOwnerIdentity(): Promise<PlatformOwnerIdentity> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.identity;
  const email = norm(process.env.SUPER_ADMIN_EMAIL) || null;
  const accountIds: string[] = [];
  try {
    const { legacyWorkspace, findAccountByEmail } = await import("./platform");
    const house = await legacyWorkspace();
    if (house?.ownerId) accountIds.push(house.ownerId);
    const byAddress = email ? await findAccountByEmail(email) : null;
    if (byAddress?.id && !accountIds.includes(String(byAddress.id))) accountIds.push(String(byAddress.id));
  } catch {
    // No platform database yet: the address alone decides, and nothing is cached.
    return { email, accountIds };
  }
  const identity = { email, accountIds };
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
 * Rewrites a client workspace's `users` row for the platform owner, if one
 * was written before the rule (run once per workspace database per instance,
 * from lib/db.ts). The row keeps its id, so everything the owner made stays
 * filed under it; only the address and name change.
 */
export async function scrubOwnerFromWorkspaceDb(
  c: { execute(stmt: { sql: string; args: (string | number | null)[] }): Promise<unknown> },
  ws: Pick<TenantWorkspace, "id">,
  identity?: PlatformOwnerIdentity,
): Promise<void> {
  if (isHouseWorkspace(ws)) return;
  const who = identity ?? (await platformOwnerIdentity());
  if (!who.email && !who.accountIds.length) return;
  const ids = who.accountIds.length ? who.accountIds : [""];
  await c.execute({
    sql: `UPDATE users SET name = ?, email = id || ?
          WHERE email NOT LIKE ? AND (id IN (${ids.map(() => "?").join(",")}) OR LOWER(email) = ? OR LOWER(email) LIKE ?)`,
    args: [SUPPORT_ACTOR, `@${SUPPORT_MIRROR_DOMAIN}`, `%@${SUPPORT_MIRROR_DOMAIN}`,
      ...ids, who.email ?? "", who.email ? `${who.email}#deleted-%` : ""],
  });
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
