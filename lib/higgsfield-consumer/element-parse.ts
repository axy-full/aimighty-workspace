/** Client-safe: a reference element as the account returns it — bounded, id-shaped, text only. */
export type ConnectedElement = { elementId: string; name: string; category: "character" | "environment" | "prop" | null; previewUrl: string | null };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const ID = /^[A-Za-z0-9_-]{1,100}$/;
function one(v: unknown, fallbackName = "", fallbackCategory: ConnectedElement["category"] = null): ConnectedElement | null {
  if (!record(v)) return null;
  const id = typeof v.element_id === "string" ? v.element_id : typeof v.id === "string" ? v.id : "";
  if (!ID.test(id)) return null;
  const name = (typeof v.name === "string" && v.name.trim() ? v.name : fallbackName || id).replace(/\p{Cc}/gu, " ").slice(0, 80);
  const category = ["character", "environment", "prop"].includes(String(v.category)) ? (v.category as ConnectedElement["category"]) : fallbackCategory;
  const preview = [v.preview_url, v.thumbnail_url, v.url].find((u) => typeof u === "string" && /^https:\/\//.test(u)) as string | undefined;
  return { elementId: id, name, category, previewUrl: preview ?? null };
}
function list(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (!record(v)) return [];
  for (const key of ["elements", "items", "results", "data"]) if (Array.isArray(v[key])) return v[key] as unknown[];
  return [];
}
export function parseElements(v: unknown): ConnectedElement[] {
  return list(v).slice(0, 200).map((x) => one(x)).filter((x): x is ConnectedElement => Boolean(x)).slice(0, 100);
}
export function parseElementCreate(v: unknown, name: string, category: ConnectedElement["category"]): ConnectedElement | null {
  if (record(v)) for (const key of ["element", "data", "result"]) { const hit = one(v[key], name, category); if (hit) return hit; }
  return one(v, name, category) ?? parseElements(v)[0] ?? null;
}
/** The prompt token the account reads an element by. */
export const elementToken = (id: string) => `<<<${id}>>>`;
