import { NextResponse } from "next/server";
import { db, ready, now } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getLook } from "@/lib/looks";
import { readUploadBytes } from "@/lib/storage";
import { gatewayReachable, gatewayAuth, GATEWAY_URL, explainGatewayFailure } from "@/lib/gateway";
import { GATEWAY_MODELS } from "@/lib/enhance";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string }> };

/**
 * The Moodboard half of a Look: Claude looks at the reference stills and
 * writes the style block in the bank's register — light, lens, grade,
 * palette, texture, motion feel — and nothing about what is in them. What
 * comes back is a draft in the editor, not a decision; `apply` saves it.
 */
const SYSTEM = `You write STYLE BLOCKS for a film studio's prompt library. You are shown reference stills that share a look. Describe the LOOK only — never the subject, wardrobe, props, place, people or story in them.

Write 3 to 6 short declarative sentences, at most 110 words in total, covering only what is present: the light (source, quality, direction), the lens feel (focal length, depth of field, distortion), the grade (contrast, saturation, palette, colour of shadows and highlights), texture (grain, halation, softness), and the motion feel if the stills imply one. Plain camera language. No adjectives of quality ("beautiful", "cinematic"), no brand names, no headings, no lists, no preamble. Output the block and nothing else.`;

export async function POST(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const { id } = await params;
  const look = await getLook(id);
  if (!look) return NextResponse.json({ error: "No such look." }, { status: 404 });
  if (!look.refs.length) {
    return NextResponse.json({ error: "Add a few reference stills first — that is what gets described." }, { status: 400 });
  }
  if (!gatewayReachable()) {
    return NextResponse.json({ error: "Describing a look needs Vercel AI Gateway, which this deployment can't reach." }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));

  const rs = await db().execute({
    sql: `SELECT id, mime, ext, stored_url, derivative_url FROM uploads
          WHERE id IN (${look.refs.map(() => "?").join(",")}) AND kind='image'`,
    args: look.refs,
  });
  const content: Record<string, unknown>[] = [{ type: "text", text: "Reference stills for one look follow. Write the style block." }];
  for (const r of rs.rows as unknown as { id: string; mime: string; ext: string; stored_url: string; derivative_url: string | null }[]) {
    // The delivery copy when there is one — a description needs the look, not the megabytes.
    const useDelivery = Boolean(r.derivative_url);
    const bytes = await readUploadBytes(useDelivery ? `${r.id}-api` : r.id, useDelivery ? "jpg" : r.ext, r.derivative_url ?? r.stored_url);
    content.push({ type: "image_url", image_url: { url: `data:${useDelivery ? "image/jpeg" : r.mime};base64,${bytes.toString("base64")}` } });
  }

  const auth = await gatewayAuth();
  const res = await fetch(GATEWAY_URL(), {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GATEWAY_MODELS()[0],
      max_tokens: 400,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const raw = await res.text();
  if (!res.ok) {
    const plain = explainGatewayFailure(res.status, raw);
    return NextResponse.json({ error: plain ?? `The writer couldn't answer (${res.status}).` }, { status: 502 });
  }
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const j = JSON.parse(raw) as any;
  const text: string = String(j.choices?.[0]?.message?.content ?? "").trim().replace(/\s+/g, " ").slice(0, 1200);
  if (!text) return NextResponse.json({ error: "The writer returned nothing." }, { status: 502 });

  if (body.apply === true && !look.builtin) {
    await db().execute({ sql: `UPDATE shot_presets SET prose=?, updated_at=? WHERE id=?`, args: [text, now(), id] });
  }
  return NextResponse.json({ prose: text, costUsd: typeof j.usage?.cost === "number" ? j.usage.cost : null });
}
