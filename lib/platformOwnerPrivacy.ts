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
 *   (`publicStoredActor`, `maskStoredActor`).
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

/**
 * A stored "who" value — an address, an account id, or a display name written
 * at the time — as a workspace may show it. A name counts as the owner's only
 * when no other member of that workspace goes by it (`members`, the
 * workspace's `users` rows; without them a name is never matched).
 */
export async function publicStoredActor(
  ws: Pick<TenantWorkspace, "id"> | null | undefined,
  value: string | null | undefined,
  members?: () => Promise<{ id?: unknown; email?: unknown; name?: unknown }[]>,
): Promise<string | null> {
  if (value == null || value === "" || isHouseWorkspace(ws)) return value ?? null;
  const identity = await platformOwnerIdentity();
  if (isOwnerAddress(identity, value) || identity.accountIds.includes(value)) return SUPPORT_ACTOR;
  const name = value.trim();
  if (members && (identity.names ?? []).includes(name)) {
    const others = (await members()).filter((m) => !isOwnerIdentity(identity, m) && !isSupportMirrorEmail(m.email));
    if (!others.some((m) => String(m.name ?? "").trim() === name)) return SUPPORT_ACTOR;
  }
  return value;
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
