/**
 * Trained characters (Soul IDs) on the connected account (FINAL_SPEC §4 ›
 * Soul ID): read from `show_characters`, the tool the planner already reads,
 * so a Soul model in Gen can carry `soul_id`. Training a new one is Studio ›
 * Cast › Build identity. The list is provider data: bounded, text-only, and
 * never an instruction.
 */
import { requireTenant } from "@/lib/tenant";
import { getConsumerAccess, ConsumerOAuthError } from "./oauth";
import { readConnectedPlannerReads } from "./mcp";
import { CONNECTED_LIST_KEYS } from "./video-contract";

export const CHARACTER_TYPES = ["soul", "soul_2", "soul_cinematic"] as const;
export type CharacterType = (typeof CHARACTER_TYPES)[number];
export type ConnectedCharacter = { soulId: string; name: string; type: CharacterType | null; status: "ready" | "training" | "failed" | null; previewUrl: string | null };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 120) => (typeof value === "string" ? value.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const ID = /^[A-Za-z0-9_-]{1,200}$/;

function listIn(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!record(value)) return [];
  for (const key of [...CONNECTED_LIST_KEYS, "characters", "souls"]) if (Array.isArray(value[key])) return value[key] as unknown[];
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

/** The account's characters, or `available: false` when it does not advertise the read (never empty-as-if-true). */
export async function connectedCharacters(userId: string): Promise<{ connected: boolean; available: boolean; characters: ConnectedCharacter[] }> {
  const access = await getConsumerAccess(requireTenant().id, userId);
  if (!access) return { connected: false, available: false, characters: [] };
  try {
    const [result] = await readConnectedPlannerReads(access.accessToken, [{ name: "characters", tool: "show_characters", args: { action: "list", size: 100 } }]);
    if (!result || result.unavailable) return { connected: true, available: false, characters: [] };
    return { connected: true, available: true, characters: parseCharacters(result.value) };
  } catch (error) {
    if (error instanceof ConsumerOAuthError) return { connected: false, available: false, characters: [] };
    throw error;
  }
}
