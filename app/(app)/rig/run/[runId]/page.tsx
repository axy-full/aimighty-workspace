import { followOldRoute, type RawSearch } from "@/lib/shell/old-routes.server";

/**
 * A Rig run: Control room > Activity.
 * Redirected, never drawn (docs/old-shells.md): lib/shell/old-routes.ts holds where it goes.
 */
export const dynamic = "force-dynamic";
export default async function Moved({ params, searchParams }: { params: Promise<{ runId: string }>; searchParams: Promise<RawSearch> }) {
  const { runId } = await params;
  await followOldRoute(`/rig/run/${runId}`, await searchParams);
}
