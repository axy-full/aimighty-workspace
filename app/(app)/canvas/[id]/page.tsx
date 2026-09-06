import { redirect } from "next/navigation";

/**
 * The old pan-and-zoom board. "Canvas" now means one screen — the
 * production's sequence under /projects/[id]/canvas — so this address
 * simply goes there.
 */
export default async function OldCanvasPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/projects/${encodeURIComponent(id)}/canvas`);
}
