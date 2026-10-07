import { followOldRoute, type RawSearch } from "@/lib/shell/old-routes.server";

/**
 * Old address of the sequence wall: the board.
 * Redirected, never drawn (docs/old-shells.md): lib/shell/old-routes.ts holds where it goes.
 */
export const dynamic = "force-dynamic";
export default async function Moved({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<RawSearch> }) {
  const { id } = await params;
  await followOldRoute(`/canvas/${id}`, await searchParams);
}
