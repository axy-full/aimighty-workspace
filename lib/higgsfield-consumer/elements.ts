/**
 * Reference elements on the connected account (Cast & Elements = Soul Studio):
 * a character, environment or prop the account keeps as a reusable reference.
 * Particl is a standalone platform — only the elements Particl created are
 * recorded and listed; the account's own library stays on higgsfield.ai
 * (owner's rule, 23 September). The list is provider data: bounded, text-only.
 */
import { db, ready } from "@/lib/db";
import { requireTenant } from "@/lib/tenant";
import { getConsumerAccess, ConsumerOAuthError } from "./oauth";
import { createConsumerElement, listConsumerElements, type ConsumerElementCategory } from "./mcp";
import { resolveConsumerGenerationSources } from "./generation-sources";
import type { SoulBuildSource } from "./soul-build";
export * from "./element-parse";
import { parseElementCreate, parseElements, type ConnectedElement } from "./element-parse";

const initialized = new WeakMap<ReturnType<typeof db>, Promise<void>>();
async function elementsReady() {
  await ready();
  const client = db();
  if (!initialized.has(client))
    initialized.set(client, client.execute(`CREATE TABLE IF NOT EXISTS higgsfield_consumer_elements (
 element_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT, name TEXT NOT NULL, category TEXT NOT NULL, created_at INTEGER NOT NULL)`).then(() => {}).catch((e) => { initialized.delete(client); throw e; }));
  await initialized.get(client);
}
async function particlElementIds(): Promise<Set<string>> {
  await elementsReady();
  return new Set((await db().execute("SELECT element_id FROM higgsfield_consumer_elements ORDER BY created_at DESC LIMIT 500")).rows.map((row) => String(row.element_id)));
}

export async function connectedElements(userId: string): Promise<{ connected: boolean; available: boolean; elements: ConnectedElement[] }> {
  const access = await getConsumerAccess(requireTenant().id, userId);
  if (!access) return { connected: false, available: false, elements: [] };
  try {
    const read = await listConsumerElements(access.accessToken);
    if (read.state !== "ok") return { connected: true, available: false, elements: [] };
    const ours = await particlElementIds();
    return { connected: true, available: true, elements: parseElements(read.value).filter((e) => ours.has(e.elementId)) };
  } catch (error) {
    if (error instanceof ConsumerOAuthError) return { connected: false, available: false, elements: [] };
    throw error;
  }
}

export type ElementBuildOutcome = { state: "created"; element: ConnectedElement } | { state: "accepted"; element: null } | { state: "refused"; reason: string };
export async function buildConnectedElement(userId: string, input: { name: string; category: ConsumerElementCategory; description: string; sources: SoulBuildSource[]; projectId?: string | null }): Promise<ElementBuildOutcome> {
  const access = await getConsumerAccess(requireTenant().id, userId);
  if (!access) throw new ConsumerOAuthError("reconnect_required");
  await elementsReady();
  const resolved = await resolveConsumerGenerationSources({ type: "image", model: "soul_cinematic", prompt: "reference element", parameters: {}, medias: input.sources.map((source) => ({ role: "image", source })) } as never);
  const result = await createConsumerElement(access.accessToken, { name: input.name, category: input.category, description: input.description }, resolved.map((s) => ({ url: s.url, type: "image" as const })), { sending: () => {} });
  if (result.state === "refused") return { state: "refused", reason: result.reason };
  const element = parseElementCreate(result.value, input.name, input.category);
  if (element) await db().execute({ sql: "INSERT OR IGNORE INTO higgsfield_consumer_elements(element_id,user_id,project_id,name,category,created_at) VALUES(?,?,?,?,?,?)", args: [element.elementId, userId, input.projectId ?? null, input.name.trim(), input.category, Date.now()] });
  return element ? { state: "created", element } : { state: "accepted", element: null };
}
