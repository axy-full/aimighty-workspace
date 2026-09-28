import { assetLinkHref } from "./asset-link";

/** What Copy link says, whichever surface pressed it (the Inspector, the viewer). */
export const LINK_SAY = {
  copied: "Link copied — it opens this take for people in this workspace.",
  unsaved: "Save this project first: a link names its production.",
  blocked: "This browser blocked the clipboard.",
} as const;

/**
 * Copy a link to one take (lib/shell/asset-link.ts › assetLinkHref): the
 * workspace, the production and the take — never a private draft, a media URL
 * or a signed address. Answers what to say.
 */
export async function copyAssetLink(input: { workspace: string | null | undefined; production: string | null | undefined; asset: string }): Promise<string> {
  const href = typeof window === "undefined" ? null : assetLinkHref({ origin: window.location.origin, ...input });
  if (!href) return LINK_SAY.unsaved;
  try {
    await navigator.clipboard.writeText(href);
    return LINK_SAY.copied;
  } catch {
    return LINK_SAY.blocked;
  }
}
