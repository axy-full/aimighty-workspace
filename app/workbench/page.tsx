import { followOldRoute, type RawSearch } from "@/lib/shell/old-routes.server";

/**
 * The old Studio. Everyone goes to the Suites shell (lib/shell/old-routes.ts); a signed-in account with no workspace
 * is told so there (components/graphite/NoWorkspace.tsx), so nothing is left that draws the Studio.
 */
export const dynamic = "force-dynamic";
export default async function Workbench({ searchParams }: { searchParams: Promise<RawSearch> }) {
  await followOldRoute("/workbench", await searchParams);
}
