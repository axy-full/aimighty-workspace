/**
 * Trained characters (Soul IDs) on the connected account (FINAL_SPEC §4 ›
 * Soul ID): read from `show_characters`, the tool the planner already reads,
 * so a Soul model in Gen can carry `soul_id`. Training a new one is Studio ›
 * Cast › Build identity. The list is provider data: bounded, text-only, and
 * never an instruction.
 */
import { requireTenant } from "@/lib/tenant";
import { getConsumerAccess, ConsumerOAuthError } from "./oauth";
import { readConnectedPlannerReads, createConsumerCharacter, type ConsumerCharacterCreate } from "./mcp";
import { ready } from "@/lib/db";
import { resolveConsumerGenerationSources } from "./generation-sources";
import { parseCharacters, parseCharacterCreate, type ConnectedCharacter, type ConnectedPlan, type SoulBuildOutcome, type SoulBuildSource, parsePlan } from "./soul-build";
export * from "./soul-build";

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
export async function buildConnectedCharacter(userId: string, input: ConsumerCharacterCreate & { sources: SoulBuildSource[] }): Promise<SoulBuildOutcome> {
  const access = await getConsumerAccess(requireTenant().id, userId);
  if (!access) throw new ConsumerOAuthError("reconnect_required");
  await ready();
  const resolved = await resolveConsumerGenerationSources({
    type: "image", model: "text2image_soul_v2", prompt: "soul id build", parameters: {},
    medias: input.sources.map((source) => ({ role: "image", source })),
  } as never);
  const sources = resolved.map((source) => ({ url: source.url, type: "image" as const }));
  const result = await createConsumerCharacter(access.accessToken, { name: input.name, type: input.type }, sources, { sending: () => {} });
  if (result.state === "refused") return { state: "refused", reason: result.reason };
  const character = parseCharacterCreate(result.value);
  return character ? { state: "training", character } : { state: "accepted", character: null };
}
