import { validAssetId } from "@/lib/preview";

/**
 * A take in the address bar, and a link to one (idea 26). Pure: what the URL
 * says, what a copied link carries, and whether it may open here.
 *
 * `asset=generation:<id>` (or `upload:<id>`) is the selected take on /suites.
 * The Workspace selection (lib/workspace/state.tsx: selKind "take", selId) stays
 * the one source: `asset` mirrors it, beside the older `sel=take:<id>`, which is
 * still read and still written, so the two cannot disagree. An `asset` wins over
 * a `sel` that says otherwise (it is the newer, explicit claim); an id that is
 * not a plain Library id is ignored, never looked up.
 *
 * A copied link names no one's private draft. It carries the workspace it was
 * copied in (`ws`), the production the take belongs to (`production`) and the
 * take: whoever opens it resolves their OWN draft of that production through the
 * existing route (GET /api/workbench/projects?production=), or opens the
 * production explicitly — nothing is read from, or created from, a teammate's
 * draft. A link from another workspace never resolves ids in this one.
 */

export const ASSET_PARAM = "asset";
export const WORKSPACE_PARAM = "ws";
export const PRODUCTION_PARAM = "production";
/** The params a link adds for its own resolution: gone from the address bar once it has resolved or been dismissed. */
export const LINK_PARAMS = [WORKSPACE_PARAM, PRODUCTION_PARAM] as const;

/** A workspace or production id as the routes mint them: plain, bounded. */
const REF = /^[A-Za-z0-9_-]{1,100}$/;

export type AssetLink = {
  asset: string;
  /** The workspace the link was copied in; null for an address-bar URL, which resolves in the active workspace. */
  workspace: string | null;
  /** The shared production the take belongs to; null for an address-bar URL, which names the draft instead. */
  production: string | null;
  /** A draft id from an address-bar URL: only ever resolved as the reader's own draft, never anyone else's. */
  project: string | null;
  /** A `ws` or `production` that is there but malformed: the link cannot be checked, so it does not open. */
  broken: boolean;
};

const single = (q: URLSearchParams, key: string): string | null | undefined => {
  const all = q.getAll(key);
  return all.length === 0 ? null : all.length === 1 ? all[0] : undefined;
};

/** The take the URL names in `asset` (exactly one, strictly a Library id), or null. */
export function assetParam(search: string | URLSearchParams): string | null {
  const q = typeof search === "string" ? new URLSearchParams(search) : search;
  const value = single(q, ASSET_PARAM);
  return value ? validAssetId(value) : null;
}

/** The take a URL selects: its `asset`, else a `sel=take:<id>` with a Library id; null for anything else. */
export function selectedTakeParam(search: string | URLSearchParams): string | null {
  const q = typeof search === "string" ? new URLSearchParams(search) : search;
  const asset = assetParam(q);
  if (asset) return asset;
  const sel = q.get("sel");
  return sel?.startsWith("take:") ? validAssetId(sel.slice(5)) : null;
}

/** What a link to a take says, or null when the URL names no take in `asset`. */
export function readAssetLink(search: string): AssetLink | null {
  const q = new URLSearchParams(search);
  const asset = assetParam(q);
  if (!asset) return null;
  let broken = false;
  const ref = (key: string) => {
    const value = single(q, key);
    if (value === null) return null;
    if (value && REF.test(value)) return value;
    broken = true;
    return null;
  };
  const workspace = ref(WORKSPACE_PARAM), production = ref(PRODUCTION_PARAM);
  const project = q.get("project");
  return { asset, workspace, production, project: project && project.length <= 100 && !/[\u0000-\u001f\u007f]/.test(project) ? project : null, broken };
}

/** The search string with `asset` set to this take, or removed; every other param kept as it was. */
export function withAsset(search: string, asset: string | null): string {
  const q = new URLSearchParams(search);
  const valid = validAssetId(asset);
  if (valid) q.set(ASSET_PARAM, valid); else q.delete(ASSET_PARAM);
  const text = q.toString();
  return text ? "?" + text : "";
}

/** The search string without the link's own params (once it has resolved), and without the take too when `dropAsset`. */
export function withoutLink(search: string, dropAsset = false): string {
  const q = new URLSearchParams(search);
  for (const key of LINK_PARAMS) q.delete(key);
  if (dropAsset) {
    q.delete(ASSET_PARAM);
    if (q.get("sel")?.startsWith("take:")) q.delete("sel");
  }
  const text = q.toString();
  return text ? "?" + text : "";
}

/**
 * How a change of the selected take enters history: opening a take from a grid,
 * and leaving it for the grid, are places Back returns to; stepping through
 * takes (Previous/Next, the viewer's arrows), a link resolving and a repair
 * rewrite the entry they are on, so Back still leaves the take, not each step.
 */
export type SelectReason = "open" | "close" | "step" | "link" | "repair";
export function selectHistory(reason: SelectReason): "push" | "replace" {
  return reason === "open" || reason === "close" ? "push" : "replace";
}

/** The link "Copy link" puts on the clipboard: the workspace, the production and the take — no private draft. */
export function assetLinkHref(input: { origin: string; workspace: string | null | undefined; production: string | null | undefined; asset: string }): string | null {
  const asset = validAssetId(input.asset);
  if (!asset || !input.workspace || !REF.test(input.workspace) || !input.production || !REF.test(input.production)) return null;
  const q = new URLSearchParams({ page: "takes", sp: "takes", [WORKSPACE_PARAM]: input.workspace, [PRODUCTION_PARAM]: input.production, [ASSET_PARAM]: asset });
  return `${input.origin.replace(/\/+$/, "")}/suites?${q.toString()}`;
}

/**
 * Whether a link may open in the workspace this session is in: "here" (it was
 * copied here, or names no workspace and is resolved by this workspace's own
 * reads), "switch" (another workspace the account belongs to: switching is
 * offered, nothing is resolved here), "elsewhere" (a workspace this account is
 * not in: nothing is resolved, and nothing about the take is shown).
 */
export function linkWorkspace(link: Pick<AssetLink, "workspace">, active: string | null | undefined, memberOf: readonly { id: string }[]): "here" | "switch" | "elsewhere" {
  if (!link.workspace || link.workspace === active) return "here";
  return memberOf.some((w) => w.id === link.workspace) ? "switch" : "elsewhere";
}

/** The scope and project a callback was started for; late ones for any other are dropped. */
export type Captured = { scope: string; projectId: string | null };
export function stillCurrent(captured: Captured, live: Captured): boolean {
  return captured.scope === live.scope && captured.projectId === live.projectId;
}
