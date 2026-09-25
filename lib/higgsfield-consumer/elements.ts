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
import { accountCreatedAt, assertNoOpenBuild, buildFingerprint, claimBuild, matchBuild, openBuilds, settleBuild, type PendingBuild } from "./build-records";

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

const entryId = (entry: unknown) =>
  entry && typeof entry === "object" && !Array.isArray(entry)
    ? (typeof (entry as Record<string, unknown>).element_id === "string" ? (entry as Record<string, string>).element_id : typeof (entry as Record<string, unknown>).id === "string" ? (entry as Record<string, string>).id : null)
    : null;
async function recordElement(element: { elementId: string }, input: { userId: string; projectId: string | null; name: string; category: string }) {
  await db().execute({ sql: "INSERT OR IGNORE INTO higgsfield_consumer_elements(element_id,user_id,project_id,name,category,created_at) VALUES(?,?,?,?,?,?)", args: [element.elementId, input.userId, input.projectId, input.name.trim(), input.category, Date.now()] });
}
export async function connectedElements(userId: string): Promise<{ connected: boolean; available: boolean; elements: ConnectedElement[]; pending?: PendingBuild[] }> {
  const access = await getConsumerAccess(requireTenant().id, userId);
  if (!access) return { connected: false, available: false, elements: [] };
  try {
    const ours = await particlElementIds();
    // Page (and `get` by id) until every element Particl created is found.
    const read = await listConsumerElements(access.accessToken, {}, ours);
    if (read.state !== "ok") return { connected: true, available: false, elements: [] };
    const entries = (read.value as { items: unknown[] }).items;
    // An element accepted without a named id is matched by exact name and category among unrecorded entries made just after it was sent.
    const pending: PendingBuild[] = [];
    const unrecorded = entries.flatMap((entry) => {
      const id = entryId(entry), [parsed] = parseElements([entry]);
      return id && parsed && !ours.has(id) ? [{ id, name: parsed.name, type: parsed.category, createdAt: accountCreatedAt(entry) }] : [];
    });
    for (const build of await openBuilds("element", userId)) {
      const elementId = matchBuild(build, unrecorded.filter((entry) => !ours.has(entry.id)));
      if (!elementId) { pending.push({ id: build.id, kind: build.kind, name: build.name, type: build.type, state: build.state, createdAt: build.createdAt, stale: build.stale }); continue; }
      await recordElement({ elementId }, { userId, projectId: build.projectId, name: build.name, category: build.type });
      await settleBuild(build.id, "recorded", elementId);
      ours.add(elementId);
    }
    return { connected: true, available: true, elements: parseElements({ items: entries.filter((entry) => ours.has(entryId(entry) ?? "")) }), pending };
  } catch (error) {
    if (error instanceof ConsumerOAuthError) return { connected: false, available: false, elements: [] };
    throw error;
  }
}

export type ElementBuildOutcome = { state: "created"; element: ConnectedElement } | { state: "accepted"; element: null } | { state: "refused"; reason: string } | { state: "uncertain"; element: null };
export async function buildConnectedElement(userId: string, input: { name: string; category: ConsumerElementCategory; description: string; sources: SoulBuildSource[]; projectId?: string | null }): Promise<ElementBuildOutcome> {
  const access = await getConsumerAccess(requireTenant().id, userId);
  if (!access) throw new ConsumerOAuthError("reconnect_required");
  await elementsReady();
  const resolved = await resolveConsumerGenerationSources({ type: "image", model: "soul_cinematic", prompt: "reference element", parameters: {}, medias: input.sources.map((source) => ({ role: "image", source })) } as never);
  // Durable before the paid create goes out; the same element is never sent twice while one may still be on the account.
  const identity = { userId, kind: "element" as const, fingerprint: buildFingerprint("element", input.name, input.category, input.sources) };
  await assertNoOpenBuild(identity);
  let buildId: string | null = null;
  let result;
  try {
    result = await createConsumerElement(access.accessToken, { name: input.name, category: input.category, description: input.description }, resolved.map((s) => ({ url: s.url, type: "image" as const })), {
      admit: async () => { buildId = await claimBuild({ ...identity, projectId: input.projectId ?? null, name: input.name, type: input.category }); },
    });
  } catch (error) {
    // Thrown only before the create was sent: nothing was made or billed.
    if (buildId) await settleBuild(buildId, "not_sent");
    throw error;
  }
  const claimed = buildId as string | null;
  if (result.state === "refused") { if (claimed) await settleBuild(claimed, "refused"); return { state: "refused", reason: result.reason }; }
  if (result.state === "uncertain") { if (claimed) await settleBuild(claimed, "uncertain"); return { state: "uncertain", element: null }; }
  const element = parseElementCreate(result.value, input.name, input.category);
  if (element) {
    await recordElement(element, { userId, projectId: input.projectId ?? null, name: input.name, category: input.category });
    if (claimed) await settleBuild(claimed, "recorded", element.elementId);
    return { state: "created", element };
  }
  if (claimed) await settleBuild(claimed, "pending");
  return { state: "accepted", element: null };
}
