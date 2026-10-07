import { followOldRoute, type RawSearch } from "@/lib/shell/old-routes.server";

/**
 * Old address of Gen by kind (video, image, audio); any other kind is a 404.
 * Redirected, never drawn (docs/old-shells.md): lib/shell/old-routes.ts holds where it goes.
 */
export const dynamic = "force-dynamic";
export default async function Moved({ params, searchParams }: { params: Promise<{ kind: string }>; searchParams: Promise<RawSearch> }) {
  const { kind } = await params;
  await followOldRoute(`/make/${kind}`, await searchParams);
}
