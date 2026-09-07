import type { Metadata } from "next";
import { resolveShare } from "@/lib/shares";
import { runInTenant } from "@/lib/tenant";
import { db, ready } from "@/lib/db";

/**
 * A review page belongs to the studio that sent it (brief 2.6), down to
 * the browser tab: the platform's name never appears in front of someone
 * else's client, so the title is the workspace's and the production's.
 */
export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const found = await resolveShare(token).catch(() => null);
  if (!found) return { title: "Review", robots: { index: false, follow: false } };
  const production = await runInTenant(found.workspace, async () => {
    await ready();
    const rs = await db().execute({ sql: `SELECT name FROM projects WHERE id = ? LIMIT 1`, args: [found.share.projectId] });
    return rs.rows.length ? String((rs.rows[0] as { name?: string }).name ?? "") : "";
  }).catch(() => "");
  return {
    title: production ? `${production} · ${found.workspace.name}` : found.workspace.name,
    description: `Approved takes for ${production || "this production"}.`,
    robots: { index: false, follow: false },
  };
}

export default function ReviewLayout({ children }: { children: React.ReactNode }) {
  return children;
}
