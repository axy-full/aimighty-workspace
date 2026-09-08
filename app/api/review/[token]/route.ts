import { NextResponse } from "next/server";
import { runInTenant } from "@/lib/tenant";
import { resolveShare } from "@/lib/shares";
import { db, ready } from "@/lib/db";
import { getSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ token: string }> };

/**
 * What a client review link opens (brief 2.6): a production's Approved
 * takes in shot order, with the notes on each, under the workspace's own
 * name. No session, no login, nothing of the platform's branding — and
 * nothing but the Approved takes of the one production the link names.
 */
export const GET = async function GET(_req: Request, { params }: Ctx) {
  const { token } = await params;
  const found = await resolveShare(token);
  if (!found) return NextResponse.json({ error: "This review link has expired or been withdrawn." }, { status: 404 });
  const { share, workspace } = found;

  const out = await runInTenant(workspace, async () => {
    await ready();
    const project = await db().execute({ sql: `SELECT id, name, description FROM projects WHERE id = ? LIMIT 1`, args: [share.projectId] });
    if (!project.rows.length) return null;
    const takes = await db().execute({
      sql: `SELECT g.id, g.kind, g.version, g.created_at, g.prompt, g.params,
                   s.code AS shot_code, s.title AS shot_title, s.position AS shot_pos,
                   g.review_by
            FROM generations g LEFT JOIN shots s ON s.id = g.shot_id
            WHERE g.project_id = ? AND g.review_state = 'approved' AND g.deleted = 0 AND g.status = 'succeeded'
            ORDER BY COALESCE(s.position, 1e9), s.code, g.version`,
      args: [share.projectId],
    });
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const rows = takes.rows as any[];
    const ids = rows.map((r) => String(r.id));
    const notes = ids.length
      ? await db().execute({
          sql: `SELECT n.gen_id, n.text, n.created_at, u.name AS author, 0 AS guest FROM notes n JOIN users u ON u.id = n.user_id WHERE n.gen_id IN (${ids.map(() => "?").join(",")})
                UNION ALL
                SELECT r.gen_id, r.text, r.created_at, r.guest AS author, 1 AS guest FROM review_notes r WHERE r.gen_id IN (${ids.map(() => "?").join(",")})
                ORDER BY created_at`,
          args: [...ids, ...ids],
        })
      : { rows: [] as any[] };
    const byGen = new Map<string, { text: string; author: string; guest: boolean; at: number }[]>();
    for (const n of notes.rows as any[]) {
      const k = String(n.gen_id);
      (byGen.get(k) ?? byGen.set(k, []).get(k)!).push({ text: String(n.text), author: String(n.author ?? "the studio"), guest: Number(n.guest) === 1, at: Number(n.created_at) });
    }
    const logo = (await getSetting("brandLogoUploadId")) || null;
    const p = project.rows[0] as any;
    return {
      workspace: { name: workspace.name, logo: logo ? `/api/review/${token}/logo` : null },
      production: { name: String(p.name ?? ""), description: String(p.description ?? "") },
      takes: rows.map((r) => {
        const params = ((): Record<string, unknown> => { try { return JSON.parse(r.params || "{}"); } catch { return {}; } })();
        return {
          id: String(r.id), kind: r.kind === "image" ? "image" : "video",
          shot: r.shot_code ? String(r.shot_code) : null, title: r.shot_title ? String(r.shot_title) : null,
          version: Number(r.version ?? 1),
          prompt: String((params.rawPrompt as string | undefined) ?? r.prompt ?? "").split(/\n\s*\n/)[0],
          approvedBy: r.review_by ? String(r.review_by) : null,
          media: `/api/review/${token}/media/${r.id}`,
          notes: byGen.get(String(r.id)) ?? [],
        };
      }),
      expiresAt: share.expiresAt,
    };
  });

  if (!out) return NextResponse.json({ error: "This production is no longer here." }, { status: 404 });
  return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
};
