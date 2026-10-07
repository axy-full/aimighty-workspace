import { followOldRoute, type RawSearch } from "@/lib/shell/old-routes.server";

/**
 * The older Atomik breakdown page: the board's Brief region.
 * Redirected, never drawn (docs/old-shells.md): lib/shell/old-routes.ts holds where it goes. Only the page goes; its data stays.
 */
export const dynamic = "force-dynamic";
export default async function Moved({ searchParams }: { searchParams: Promise<RawSearch> }) {
  await followOldRoute("/atomik/breakdown", await searchParams);
}
