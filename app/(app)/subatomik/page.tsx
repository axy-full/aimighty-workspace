import { followOldRoute, type RawSearch } from "@/lib/shell/old-routes.server";

/**
 * The old Social page: Motion transfer and Object swap are Make's quick tools, History is the Social board's drawer.
 * (Shorts ran only on a signed-in Higgsfield account and is off for Release 1; its address opens Motion transfer.)
 * Redirected, never drawn (docs/old-shells.md): lib/shell/old-routes.ts holds where it goes.
 */
export const dynamic = "force-dynamic";
export default async function Moved({ searchParams }: { searchParams: Promise<RawSearch> }) {
  await followOldRoute("/subatomik", await searchParams);
}
