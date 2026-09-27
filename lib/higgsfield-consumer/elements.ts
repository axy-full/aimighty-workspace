/**
 * Reference elements on the connected account (Cast & Elements = Soul Studio):
 * a character, environment or prop the account keeps as a reusable reference.
 * Particl is a standalone platform — only the elements Particl created are
 * recorded and listed; the account's own library stays on higgsfield.ai
 * (owner's rule, 23 September). The list is provider data: bounded, text-only.
 */
import { requireTenant } from "@/lib/tenant";
import { ConsumerJobError } from "./jobs";
import { websiteFunding } from "./funding";
import { getConsumerAccess, ConsumerOAuthError } from "./oauth";
import { createConsumerElement, listConsumerElements, type ConsumerElementCategory } from "./mcp";
import { resolveConsumerGenerationSources } from "./generation-sources";
import type { SoulBuildSource } from "./soul-build";
export * from "./element-parse";
import { parseElementCreate, parseElements, type ConnectedElement } from "./element-parse";
import { accountCreatedAt, assertNoOpenBuild, buildFingerprint, claimBuild, matchableEntries, matchBuild, openBuilds, pagingForOpenBuilds, settleBuild, type PendingBuild } from "./build-records";
import { consumerElementsReady as elementsReady, particlElementIds, recordParticlElement as recordElement } from "./element-records";

const entryId = (entry: unknown) =>
  entry && typeof entry === "object" && !Array.isArray(entry)
    ? (typeof (entry as Record<string, unknown>).element_id === "string" ? (entry as Record<string, string>).element_id : typeof (entry as Record<string, unknown>).id === "string" ? (entry as Record<string, string>).id : null)
    : null;
export async function connectedElements(userId: string): Promise<{ connected: boolean; available: boolean; elements: ConnectedElement[]; pending?: PendingBuild[] }> {
  const access = await getConsumerAccess(requireTenant().id, userId);
  if (!access) return { connected: false, available: false, elements: [] };
  try {
    const ours = await particlElementIds();
    // An element accepted without a named id is matched by exact name and category among unrecorded entries made just after it was sent.
    const unrecordedOf = (entries: readonly unknown[]) => entries.flatMap((entry) => {
      const id = entryId(entry), [parsed] = parseElements([entry]);
      return id && parsed && !ours.has(id) ? [{ id, name: parsed.name, type: parsed.category, createdAt: accountCreatedAt(entry) }] : [];
    });
    const builds = await openBuilds("element", userId);
    // Page (and `get` by id) until every element Particl created is found, and far enough to cover open builds.
    const read = await listConsumerElements(access.accessToken, {}, ours, pagingForOpenBuilds(builds, unrecordedOf));
    if (read.state !== "ok") return { connected: true, available: false, elements: [] };
    const entries = (read.value as { items: unknown[] }).items;
    const pending: PendingBuild[] = [];
    const unrecorded = builds.length ? await matchableEntries(userId, unrecordedOf(entries)) : [];
    for (const build of builds) {
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
  // An element build has no price of its own: a managed workspace is refused
  // here (the seam decides), and the platform's shared account never builds one yet.
  if ((await websiteFunding({ tool: "element-build" })).kind !== "own_account") throw new ConsumerJobError("particl_quote_unavailable", 409);
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
