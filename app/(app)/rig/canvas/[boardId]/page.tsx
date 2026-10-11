import { followOldRoute, type RawSearch } from "@/lib/shell/old-routes.server";

/**
 * The old Rig canvas: the board.
 * Redirected, never drawn (docs/old-shells.md): lib/shell/old-routes.ts holds where it goes.
 */
export const dynamic = "force-dynamic";
export default async function Moved({ params, searchParams }: { params: Promise<{ boardId: string }>; searchParams: Promise<RawSearch> }) {
  const { boardId } = await params;
  await followOldRoute(`/rig/canvas/${boardId}`, await searchParams);
}
