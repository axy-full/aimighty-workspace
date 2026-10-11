import { followOldRoute, type RawSearch } from "@/lib/shell/old-routes.server";

/**
 * A shot's bindings: the board's Shots region.
 * Redirected, never drawn (docs/old-shells.md): lib/shell/old-routes.ts holds where it goes. Only the page goes; its data stays.
 */
export const dynamic = "force-dynamic";
export default async function Moved({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<RawSearch> }) {
  const { id } = await params;
  await followOldRoute(`/shots/${id}`, await searchParams);
}
