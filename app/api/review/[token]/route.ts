import { NextResponse } from "next/server";
import { SAMPLE_CLIP_CREDIT, isSampleClipUrl } from "@/lib/sampleClip";
import { runInTenant } from "@/lib/tenant";
import { resolveShare } from "@/lib/shares";
import { db, ready } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { originalKindOf } from "@/lib/originalMedia";
import { reviewSet } from "@/lib/security/review-link";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ token: string }> };

/**
 * What a client review link opens (brief 2.6): a production's Approved
 * takes in shot order, with this link's own client comments on each, under
 * the workspace's own name. No session, no login, nothing of the platform's
 * branding, and nothing but the Approved takes of the one production the
 * link names: no prompt, no member's name, no team note, no internal description.
 */
export const GET = async function GET(_req: Request, { params }: Ctx) {
  const { token } = await params;
  const found = await resolveShare(token);
  if (!found) return NextResponse.json({ error: "This review link has expired or been withdrawn." }, { status: 404 });
  const { share, workspace } = found;

  const out = await runInTenant(workspace, async () => {
    await ready();
    /* A Crew review link (lib/security/review-link.ts) opens its production's review set; an older link, the
       Approved takes below, exactly as before. Reading is never limited. */
    if (found.review) {
      const set = await reviewSet(token, share.id, share.projectId);
      if (!set) return null;
      const logo = (await getSetting("brandLogoUploadId")) || null;
      return { kind: "review" as const, workspace: { name: workspace.name, logo: logo ? `/api/review/${token}/logo` : null }, production: set.production, takes: set.takes, expiresAt: share.expiresAt };
    }
    const project = await db().execute({ sql: `SELECT id, name FROM projects WHERE id = ? LIMIT 1`, args: [share.projectId] });
    if (!project.rows.length) return null;
    const takes = await db().execute({
      sql: `SELECT g.id, g.kind, g.version, g.created_at, g.stored_url,
                   s.code AS shot_code, s.title AS shot_title, s.position AS shot_pos
            FROM generations g LEFT JOIN shots s ON s.id = g.shot_id
            WHERE g.project_id = ? AND g.review_state = 'approved' AND g.deleted = 0 AND g.status = 'succeeded'
            ORDER BY COALESCE(s.position, 1e9), s.code, g.version`,
      args: [share.projectId],
    });
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const rows = takes.rows as any[];
    const ids = rows.map((r) => String(r.id));
    /* As on a Crew review link (lib/security/review-link.ts › reviewSet): this link's own client comments only. Never the
       team's notes or who wrote them, never another link's comments, never the prompt or who approved a take. */
    const notes = ids.length
      ? await db().execute({
          sql: `SELECT gen_id, text, created_at, guest FROM review_notes WHERE share_id = ? AND gen_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at LIMIT 2000`,
          args: [share.id, ...ids],
        })
      : { rows: [] as any[] };
    const byGen = new Map<string, { text: string; author: string; guest: boolean; at: number }[]>();
    for (const n of notes.rows as any[]) {
      const k = String(n.gen_id);
      (byGen.get(k) ?? byGen.set(k, []).get(k)!).push({ text: String(n.text), author: String(n.guest || "the client"), guest: true, at: Number(n.created_at) });
    }
    const logo = (await getSetting("brandLogoUploadId")) || null;
    const p = project.rows[0] as any;
    return {
      workspace: { name: workspace.name, logo: logo ? `/api/review/${token}/logo` : null },
      production: { name: String(p.name ?? "") },
      takes: rows.map((r) => ({
        id: String(r.id), kind: originalKindOf(r.kind),
        shot: r.shot_code ? String(r.shot_code) : null, title: r.shot_title ? String(r.shot_title) : null,
        version: Number(r.version ?? 1),
        media: `/api/review/${token}/media/${r.id}`,
        notes: byGen.get(String(r.id)) ?? [],
        /* The starter's sample clip (Big Buck Bunny, CC BY 3.0) carries its credit onto the review link (lib/sampleClip.ts). */
        ...(isSampleClipUrl(String(r.stored_url ?? "")) ? { credit: SAMPLE_CLIP_CREDIT } : {}),
      })),
      expiresAt: share.expiresAt,
    };
  });

  if (!out) return NextResponse.json({ error: "This production is no longer here." }, { status: 404 });
  return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
};
