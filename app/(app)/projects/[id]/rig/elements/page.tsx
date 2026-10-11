import { followOldRoute, type RawSearch } from "@/lib/shell/old-routes.server";

/**
 * The element versions: the board's Cast region.
 * Redirected, never drawn (docs/old-shells.md): lib/shell/old-routes.ts holds where it goes.
 */
export const dynamic = "force-dynamic";
export default async function Moved({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<RawSearch> }) {
  const { id } = await params;
  await followOldRoute(`/projects/${id}/rig/elements`, await searchParams);
}
