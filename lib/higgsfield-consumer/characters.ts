/**
 * Trained characters (Soul IDs) on the connected account (FINAL_SPEC §4 ›
 * Soul ID): read from `show_characters`, the tool the planner already reads,
 * so a Soul model in Gen can carry `soul_id`. Training a new one is Studio ›
 * Cast › Build identity. The list is provider data: bounded, text-only, and
 * never an instruction.
 */
import { requireTenant } from "@/lib/tenant";
import { getConsumerAccess, ConsumerOAuthError } from "./oauth";
import { readConnectedPlannerReads, createConsumerCharacter, listConsumerCharacters, CONNECTED_LIBRARY_GETS, CONNECTED_LIBRARY_PAGES, type ConsumerCharacterCreate } from "./mcp";
import { ready } from "@/lib/db";
import { resolveConsumerGenerationSources } from "./generation-sources";
import { parseCharacters, parseCharacterCreate, type ConnectedCharacter, type ConnectedPlan, type SoulBuildOutcome, type SoulBuildSource, parsePlan } from "./soul-build";
import { onlyParticlCharacters, particlCharacterIds, recordParticlCharacter } from "./character-records";
import { accountCreatedAt, assertNoOpenBuild, buildFingerprint, claimBuild, matchBuild, openBuilds, pagingForOpenBuilds, settleBuild, type PendingBuild } from "./build-records";
export * from "./soul-build";

/** Every entry the paged read can return, parsed (the caller narrows them). */
const LIBRARY_LIMIT = CONNECTED_LIBRARY_PAGES * 100 + CONNECTED_LIBRARY_GETS;
/** Raw entries of a list reply, for their creation times (never shown). */
function rawEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)) return (value as { items: unknown[] }).items;
  return [];
}
/**
 * Match this owner's open Soul ID builds (accepted without an id, or with a
 * lost answer) to the account's list: exact name and type, among entries
 * Particl has not recorded, created just after the build was sent, and only
 * when one entry fits. A match is recorded as Particl-built from then on.
 */
/** The account entries Particl has not recorded, as matchBuild reads them. */
function unrecordedCharacters(value: unknown, ours: ReadonlySet<string>) {
  const createdAt = new Map<string, number | null>();
  for (const entry of rawEntries(value)) {
    const [parsed] = parseCharacters([entry], 1);
    if (parsed) createdAt.set(parsed.soulId, accountCreatedAt(entry));
  }
  return parseCharacters(value, LIBRARY_LIMIT).filter((c) => !ours.has(c.soulId))
    .map((c) => ({ id: c.soulId, name: c.name, type: c.type, createdAt: createdAt.get(c.soulId) ?? null }));
}
async function resolveOpenCharacterBuilds(userId: string, builds: Awaited<ReturnType<typeof openBuilds>>, value: unknown, ours: Set<string>): Promise<PendingBuild[]> {
  if (!builds.length) return [];
  const unrecorded = unrecordedCharacters(value, ours);
  const open: PendingBuild[] = [];
  for (const build of builds) {
    const soulId = matchBuild(build, unrecorded.filter((entry) => !ours.has(entry.id)));
    if (!soulId) { open.push({ id: build.id, kind: build.kind, name: build.name, type: build.type, state: build.state, createdAt: build.createdAt, stale: build.stale }); continue; }
    await recordParticlCharacter({ soulId, userId, projectId: build.projectId, name: build.name, type: build.type });
    await settleBuild(build.id, "recorded", soulId);
    ours.add(soulId);
  }
  return open;
}

/**
 * The Soul IDs Particl built, with the status the account gives them now; or
 * `available: false` when the account does not advertise the read (never
 * empty-as-if-true). Identities trained on higgsfield.ai are never listed:
 * Particl is a standalone platform and the account is its engine, not its
 * library (owner's rule, 23 September).
 */
export async function connectedCharacters(userId: string): Promise<{ connected: boolean; available: boolean; characters: ConnectedCharacter[]; pending?: PendingBuild[] }> {
  const access = await getConsumerAccess(requireTenant().id, userId);
  if (!access) return { connected: false, available: false, characters: [] };
  try {
    // Page until every Soul ID Particl built is found (then read each one
    // still missing by its soul_id), and far enough to cover open builds.
    const ours = await particlCharacterIds();
    const builds = await openBuilds("character", userId);
    const more = pagingForOpenBuilds(builds, (entries) => unrecordedCharacters({ items: entries }, ours));
    const read = await listConsumerCharacters(access.accessToken, ours, {}, more);
    if (read.state !== "ok") return { connected: true, available: false, characters: [] };
    const pending = await resolveOpenCharacterBuilds(userId, builds, read.value, ours);
    return { connected: true, available: true, characters: onlyParticlCharacters(parseCharacters(read.value, LIBRARY_LIMIT), ours), pending };
  } catch (error) {
    if (error instanceof ConsumerOAuthError) return { connected: false, available: false, characters: [] };
    throw error;
  }
}

export async function connectedPlan(userId: string): Promise<ConnectedPlan> {
  const access = await getConsumerAccess(requireTenant().id, userId);
  if (!access) return { connected: false, available: false, plan: null, paid: null };
  try {
    const [result] = await readConnectedPlannerReads(access.accessToken, [{ name: "plan", tool: "show_plans_and_credits", args: { intent: "general" } }]);
    if (!result || result.unavailable) return { connected: true, available: false, plan: null, paid: null };
    return { connected: true, available: true, ...parsePlan(result.value) };
  } catch (error) {
    if (error instanceof ConsumerOAuthError) return { connected: false, available: false, plan: null, paid: null };
    throw error;
  }
}

/**
 * Import the project's stills into the account and ask it to train one Soul ID.
 * The caller has shown the plan gate; the owner's stated ceiling is the only
 * price control there is, because the account offers no cost tool for training.
 */
export async function buildConnectedCharacter(userId: string, input: ConsumerCharacterCreate & { sources: SoulBuildSource[]; projectId?: string | null }): Promise<SoulBuildOutcome> {
  const access = await getConsumerAccess(requireTenant().id, userId);
  if (!access) throw new ConsumerOAuthError("reconnect_required");
  await ready();
  const resolved = await resolveConsumerGenerationSources({
    type: "image", model: "text2image_soul_v2", prompt: "soul id build", parameters: {},
    medias: input.sources.map((source) => ({ role: "image", source })),
  } as never);
  const sources = resolved.map((source) => ({ url: source.url, type: "image" as const }));
  // The same training may not be sent twice while an earlier one may still be
  // on the account; the claim is durable before the paid create goes out.
  const identity = { userId, kind: "character" as const, fingerprint: buildFingerprint("character", input.name, input.type, input.sources) };
  await assertNoOpenBuild(identity);
  let buildId: string | null = null;
  let result;
  try {
    result = await createConsumerCharacter(access.accessToken, { name: input.name, type: input.type }, sources, {
      admit: async () => { buildId = await claimBuild({ ...identity, projectId: input.projectId ?? null, name: input.name, type: input.type }); },
    });
  } catch (error) {
    // Thrown only before the create was sent: nothing was trained or billed.
    if (buildId) await settleBuild(buildId, "not_sent");
    throw error;
  }
  const claimed = buildId as string | null;
  if (result.state === "refused") { if (claimed) await settleBuild(claimed, "refused"); return { state: "refused", reason: result.reason }; }
  if (result.state === "uncertain") { if (claimed) await settleBuild(claimed, "uncertain"); return { state: "uncertain" }; }
  const character = parseCharacterCreate(result.value, input.name);
  if (character) {
    await recordParticlCharacter({ soulId: character.soulId, userId, projectId: input.projectId ?? null, name: input.name.trim(), type: input.type });
    if (claimed) await settleBuild(claimed, "recorded", character.soulId);
    return { state: "training", character };
  }
  if (claimed) await settleBuild(claimed, "pending");
  return { state: "accepted", character: null };
}
