import { followOldRoute, type RawSearch } from "@/lib/shell/old-routes.server";

/**
 * A project's Takes list: the board's Shots region.
 * Redirected, never drawn (docs/old-shells.md): lib/shell/old-routes.ts holds where it goes.
 */
export const dynamic = "force-dynamic";
export default async function Moved({ params, searchParams }: { params: Promise<{ prod: string; project: string }>; searchParams: Promise<RawSearch> }) {
  const { prod, project } = await params;
  await followOldRoute(`/productions/${prod}/${project}/media`, await searchParams);
}
