/**
 * Atomik recipes from the connected account's workflow bundles (A5 + A6),
 * server side. The catalogue and each recipe's guidance are read through the
 * toolset guard and cached in memory for one hour per connection, so the paid
 * planning quote and the turn it prices read the same text. Owner only.
 */
import { createHash } from "node:crypto";
import { requireTenant } from "@/lib/tenant";
import { getConsumerAccess } from "./oauth";
import { readConnectedWorkflow } from "./mcp";
import {
  parseBundleFile,
  parseSlashCommand,
  parseWorkflowCatalog,
  parseWorkflowInstructions,
  recipeGuidance,
  referencedFiles,
  type ConnectedRecipe,
} from "./workflows";

const TTL_MS = 3_600_000;
const memory = new Map<string, { value: unknown; expiresAt: number }>();
async function cached<T>(key: string, read: () => Promise<T>): Promise<T> {
  const hit = memory.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await read();
  memory.set(key, { value, expiresAt: Date.now() + TTL_MS });
  while (memory.size > 512) memory.delete(memory.keys().next().value!);
  return value;
}
type Owner = { id: string; owner?: boolean } | undefined;
async function access(user: Owner, token: unknown) {
  if (!user?.owner || token) return null;
  const granted = await getConsumerAccess(requireTenant().id, user.id).catch(() => null);
  return granted ? { ...granted, scope: createHash("sha256").update(`${requireTenant().id}:${user.id}:${granted.generation}`).digest("hex") } : null;
}

/** The recipes the owner's connected account offers; empty without a connection. */
export async function connectedRecipes(user: Owner, token: unknown): Promise<ConnectedRecipe[]> {
  const granted = await access(user, token);
  if (!granted) return [];
  try {
    return await cached(`catalog:${granted.scope}`, async () => parseWorkflowCatalog(await readConnectedWorkflow(granted.accessToken, { kind: "catalog" })));
  } catch {
    return [];
  }
}

export class RecipeError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "RecipeError";
  }
}
export type TurnRecipe = { name: string; args: string; guidance: string };
/**
 * `/name args` → the recipe's guidance for this turn, or null when the text is
 * not a slash command or the person is not the connected owner (the text is
 * then an ordinary message). An unknown name is refused.
 */
export async function recipeForMessage(user: Owner, token: unknown, text: string): Promise<TurnRecipe | null> {
  const slash = parseSlashCommand(text);
  if (!slash) return null;
  const granted = await access(user, token);
  if (!granted) return null;
  const recipes = await connectedRecipes(user, token);
  const recipe = recipes.find((r) => r.name === slash.name);
  if (!recipe) throw new RecipeError(`There is no /${slash.name} recipe on the connected account.`);
  const guidance = await cached<string>(`recipe:${granted.scope}:${recipe.name}:${recipe.version}`, async () => {
    const instructions = parseWorkflowInstructions(await readConnectedWorkflow(granted.accessToken, { kind: "instructions", workflow: recipe.name }), recipe.name);
    if (!instructions) throw new RecipeError(`The connected account did not return the /${recipe.name} recipe.`, 502);
    const files: { path: string; text: string }[] = [];
    for (const path of referencedFiles(instructions)) {
      const text = await readConnectedWorkflow(granted.accessToken, { kind: "file", workflow: recipe.name, path }).then(parseBundleFile).catch(() => "");
      files.push({ path, text });
    }
    return recipeGuidance(instructions, files);
  }).catch((error) => {
    if (error instanceof RecipeError) throw error;
    throw new RecipeError(`The connected account did not return the /${recipe.name} recipe. Try again shortly.`, 502);
  });
  return { name: recipe.name, args: slash.args, guidance };
}
