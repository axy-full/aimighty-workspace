import { followOldRoute, type RawSearch } from "@/lib/shell/old-routes.server";

/**
 * The recipes list of the old Rig: the board.
 * Redirected, never drawn (docs/old-shells.md): lib/shell/old-routes.ts holds where it goes.
 */
export const dynamic = "force-dynamic";
export default async function Moved({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<RawSearch> }) {
  const { projectId } = await params;
  await followOldRoute(`/rig/recipes/${projectId}`, await searchParams);
}
