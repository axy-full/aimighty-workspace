/**
 * Client-safe half of the connected account's characters (Soul IDs): the
 * types, the parsers, the plan gate and the block reasons. No server imports —
 * the Cast card ships this to the browser; characters.ts holds the reads and
 * the build and re-exports everything here.
 */
/** The list keys the account has used for its characters (mirrors video-contract's CONNECTED_LIST_KEYS without importing the server module). */
const LIST_KEYS = ["items", "results", "data", "list", "characters", "souls"];

export const CHARACTER_TYPES = ["soul", "soul_2", "soul_cinematic"] as const;
export type CharacterType = (typeof CHARACTER_TYPES)[number];
export type ConnectedCharacter = { soulId: string; name: string; type: CharacterType | null; status: "ready" | "training" | "failed" | null; previewUrl: string | null };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 120) => (typeof value === "string" ? value.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const ID = /^[A-Za-z0-9_-]{1,200}$/;

function listIn(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!record(value)) return [];
  for (const key of LIST_KEYS) if (Array.isArray(value[key])) return value[key] as unknown[];
  return [];
}

export function parseCharacters(value: unknown, limit = 100): ConnectedCharacter[] {
  const out: ConnectedCharacter[] = [];
  for (const entry of listIn(value).slice(0, limit)) {
    if (!record(entry)) continue;
    const rawId = entry.soul_id ?? entry.id;
    const soulId = typeof rawId === "string" && ID.test(rawId) ? rawId : "";
    if (!soulId) continue;
    const type = CHARACTER_TYPES.find((t) => t === entry.type) ?? null;
    const status = ["ready", "training", "failed"].find((s) => s === entry.status) as ConnectedCharacter["status"] ?? null;
    const preview = [entry.preview_url, entry.image_url, entry.thumbnail_url].find((v) => typeof v === "string" && /^https:\/\//i.test(v));
    out.push({ soulId, name: text(entry.name) || soulId, type, status, previewUrl: typeof preview === "string" ? preview.slice(0, 2048) : null });
  }
  return out;
}


export const SOUL_BUILD_TYPES = ["soul_2", "soul_cinematic"] as const;
export type SoulBuildType = (typeof SOUL_BUILD_TYPES)[number];
export const SOUL_BUILD_STILLS = { min: 5, max: 20 } as const;
export type SoulBuildSource = { uploadId: string } | { genId: string };

/** The plan gate: the account's current plan, and whether it reads as a paid one. Training needs a paid plan (SKILL.md). */
export type ConnectedPlan = { connected: boolean; available: boolean; plan: string | null; paid: boolean | null };
const FREE = /\b(free|trial|none|basic)\b/i;
export function parsePlan(value: unknown): { plan: string | null; paid: boolean | null } {
  const pick = (v: unknown): string | null => {
    if (!record(v)) return null;
    for (const key of ["current_plan", "plan", "subscription", "plan_name", "tier"]) {
      const found = v[key];
      if (typeof found === "string" && text(found, 60)) return text(found, 60);
      if (record(found)) { const nested = pick(found); if (nested) return nested; }
      if (record(found) && typeof found.name === "string") return text(found.name, 60);
    }
    return null;
  };
  const plan = pick(value);
  return { plan, paid: plan === null ? null : !FREE.test(plan) };
}
/** Why Build identity cannot run, in the card's words; null when it can. */
export function soulBuildBlock(state: { name: string; stills: number; plan: ConnectedPlan | null; connected: boolean }): string | null {
  if (!state.connected) return "Connect the account in Workspace › Engines.";
  if (!state.name.trim()) return "Name the identity.";
  if (state.stills < SOUL_BUILD_STILLS.min || state.stills > SOUL_BUILD_STILLS.max) return `Pick ${SOUL_BUILD_STILLS.min}–${SOUL_BUILD_STILLS.max} stills of the same person (${state.stills} picked).`;
  if (state.plan && state.plan.available && state.plan.paid === false) return `A paid Higgsfield plan is required — the account reads as ${state.plan.plan}.`;
  return null;
}

/** The account's reply to a create, parsed the way the list is: the new Soul ID and its status when the reply names them. */
export function parseCharacterCreate(value: unknown): ConnectedCharacter | null {
  const candidates: unknown[] = [];
  if (record(value)) { candidates.push(value); for (const key of ["character", "soul", "data", "result"]) if (record(value[key])) candidates.push(value[key]); }
  candidates.push(...listIn(value));
  for (const entry of candidates) { const [parsed] = parseCharacters([entry], 1); if (parsed) return parsed; }
  return null;
}

export type SoulBuildOutcome =
  | { state: "training"; character: ConnectedCharacter }
  | { state: "accepted"; character: null }
  | { state: "refused"; reason: string };
