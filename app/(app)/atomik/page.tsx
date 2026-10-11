import { followOldRoute, type RawSearch } from "@/lib/shell/old-routes.server";

/**
 * The old Atomik suite page: Atomik is the panel, and the control room is its own pages.
 * Redirected, never drawn (docs/old-shells.md): lib/shell/old-routes.ts holds where it goes.
 */
export const dynamic = "force-dynamic";
export default async function Moved({ searchParams }: { searchParams: Promise<RawSearch> }) {
  await followOldRoute("/atomik", await searchParams);
}
