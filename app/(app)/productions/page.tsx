import { followOldRoute, type RawSearch } from "@/lib/shell/old-routes.server";

/**
 * The productions list: projects are Home's cards.
 * Redirected, never drawn (docs/old-shells.md): lib/shell/old-routes.ts holds where it goes.
 */
export const dynamic = "force-dynamic";
export default async function Moved({ searchParams }: { searchParams: Promise<RawSearch> }) {
  await followOldRoute("/productions", await searchParams);
}
