/**
 * Account objects a request can name by id, checked against THIS workspace
 * before anything is quoted or sent.
 *
 * A Soul ID (`soul_id`) and a reference element (a `<<<element_id>>>` token
 * the account expands inside a prompt) live on the connected account, not in
 * Particl. Particl is a standalone platform: a request may name only the ones
 * this workspace made (recorded in its own tables), never one the account
 * holds for any other reason. On the platform's shared website account each
 * one must also be registered to this workspace on the platform registry,
 * and any other id-shaped parameter the workflows do not already classify is
 * refused, so no workspace can reach another's objects by guessing an id.
 */
import { requireTenant } from "@/lib/tenant";
import { particlCharacterIds } from "./character-records";
import { particlElementIds } from "./element-records";
import { websiteObjectOwners } from "./platform-jobs";
import type { ConsumerFunding } from "./funding";

export class ForeignAccountObjectError extends Error {
  readonly code = "object_not_particl";
  readonly status = 409;
  readonly paidAttempted = false;
  constructor() {
    super("This request names a character or element that was not made in this workspace. Pick one from Cast.");
    this.name = "ForeignAccountObjectError";
  }
}

const TOKEN = /<<<([^<>\s]{1,100})>>>/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Parameters another guard already decides: live listings (presets, preset
 * voices, public styles) and setup items (lib/higgsfield-consumer/marketing-records.ts). */
const CLASSIFIED = new Set([
  "soul_id", "preset_id", "voice_id", "style_id",
  "product_ids", "web_product_ids", "avatar_ids", "avatars", "brand_kit_id", "ad_reference_id", "hook_id", "setting_id", "assets",
]);

export type NamedAccountObjects = { souls: string[]; elements: string[]; unclassified: string[] };
/** Pure: every account object a request names — in its parameters and in any text it carries. */
export function accountObjectsNamed(request: { prompt?: unknown; parameters?: Record<string, unknown> | null }): NamedAccountObjects {
  const souls = new Set<string>(), elements = new Set<string>(), unclassified = new Set<string>();
  const texts: string[] = typeof request.prompt === "string" ? [request.prompt] : [];
  for (const [name, value] of Object.entries(request.parameters ?? {})) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item !== "string") continue;
      texts.push(item);
      if (name === "soul_id") souls.add(item);
      else if (!CLASSIFIED.has(name) && UUID.test(item.trim())) unclassified.add(`${name}`);
    }
  }
  for (const text of texts) for (const match of text.matchAll(TOKEN)) elements.add(match[1]);
  return { souls: [...souls], elements: [...elements], unclassified: [...unclassified] };
}

/**
 * Refuse, before any quote, a request naming a Soul ID or element this
 * workspace did not make — and, on the platform's shared account, one not
 * registered to this workspace, or any unclassified id-shaped parameter.
 * Naming nothing reads nothing.
 */
export async function refuseForeignAccountObjects(
  request: { prompt?: unknown; parameters?: Record<string, unknown> | null },
  funding: ConsumerFunding,
): Promise<void> {
  const named = accountObjectsNamed(request);
  const platform = funding.kind === "platform_account";
  if (platform && named.unclassified.length) throw new ForeignAccountObjectError();
  if (!named.souls.length && !named.elements.length) return;
  const [souls, elements] = await Promise.all([
    named.souls.length ? particlCharacterIds() : Promise.resolve(new Set<string>()),
    named.elements.length ? particlElementIds() : Promise.resolve(new Set<string>()),
  ]);
  if (named.souls.some((id) => !souls.has(id)) || named.elements.some((id) => !elements.has(id))) throw new ForeignAccountObjectError();
  if (!platform) return;
  const owners = await websiteObjectOwners([...named.souls, ...named.elements]);
  const workspaceId = requireTenant().id;
  const mine = (id: string, kind: "soul" | "element") => owners.get(id)?.workspaceId === workspaceId && owners.get(id)?.kind === kind;
  if (named.souls.some((id) => !mine(id, "soul")) || named.elements.some((id) => !mine(id, "element"))) throw new ForeignAccountObjectError();
}
