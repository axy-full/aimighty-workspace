import { followOldRoute, type RawSearch } from "@/lib/shell/old-routes.server";

/**
 * Pipelines and their runs: Control room > Activity.
 * Redirected, never drawn (docs/old-shells.md): lib/shell/old-routes.ts holds where it goes.
 */
export const dynamic = "force-dynamic";
export default async function Moved({ searchParams }: { searchParams: Promise<RawSearch> }) {
  await followOldRoute("/pipelines", await searchParams);
}
