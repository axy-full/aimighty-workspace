import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { db, ready, now, id as newId } from "@/lib/db";
import { getTreatment, sceneFromReply } from "@/lib/atomikDocs";
import { resolveModel } from "@/lib/atomik";
import { gatewayAuth, gatewayReachable, explainGatewayFailure } from "@/lib/gateway";
import { engineFor } from "@/lib/engines";
import { findModel, textCostUsd } from "@/lib/catalog";
import { estimateRefineUsd } from "@/lib/refineGate";
import { meter } from "@/lib/meter";
import { specToPhrase } from "@/lib/studio";

export const dynamic = "force-dynamic";

const SYSTEM = [
  "You rewrite ONE scene of a film treatment for a production studio, in the voice of the treatment around it.",
  "You are given the logline, the shot setup the whole production carries, the other scenes' titles and lengths,",
  "and the scene to rewrite with its current title, length and prose. Keep what the scene is for; write it better:",
  "concrete, filmable, present tense, no camera jargon, no hype. Keep every @Name that is already there and invent no new people.",
  'Return ONLY a JSON object: {"title": string, "secs": number, "prose": string} — no prose outside it, no code fence.',
].join(" ");

/**
 * Regenerate one scene (brief 1.8): a proposal comes back, priced and
 * metered as text; nothing is written to the treatment here — the person
 * chooses to use it, so a human edit is never overwritten by a machine.
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  const projectId = String(body.projectId ?? "");
  const n = Number(body.n);
  if (!projectId || !Number.isInteger(n) || n < 1) return NextResponse.json({ error: "Which scene?" }, { status: 400 });
  const t = await getTreatment(projectId);
  const scene = t?.scenes.find((s) => s.n === n);
  if (!t || !scene) return NextResponse.json({ error: "No such scene." }, { status: 404 });
  if (!gatewayReachable()) return NextResponse.json({ error: "Vercel AI Gateway isn't connected for this workspace — add a gateway key under Settings › Vendors & keys." }, { status: 503 });

  const model = await resolveModel(typeof body.model === "string" ? body.model.slice(0, 120) : "auto", "idea");
  const auth = await gatewayAuth();
  const user = [
    `LOGLINE: ${t.logline || "(none yet)"}`,
    Object.keys(t.setup).length ? `SETUP: ${specToPhrase(t.setup)}` : "",
    `SCENES: ${t.scenes.map((s) => `${s.n}. ${s.title || "Untitled"} (${s.secs}s)`).join("; ")}`,
    `REWRITE SCENE ${n}:`, `title: ${scene.title || "(untitled)"}`, `secs: ${scene.secs}`, `prose: ${scene.prose || "(empty)"}`,
    typeof body.note === "string" && body.note.trim() ? `THE PERSON ASKS: ${body.note.trim().slice(0, 400)}` : "",
  ].filter(Boolean).join("\n");
  const res = await engineFor("vercel").run!({ body: JSON.stringify({ model, max_tokens: 900, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] }), auth, timeoutMs: 90_000, mock: "scene" });
  const raw = res.text;
  if (!res.ok) {
    const plain = explainGatewayFailure(res.status, raw);
    let msg = raw.slice(0, 300); try { msg = JSON.parse(raw)?.error?.message ?? msg; } catch { /* raw */ }
    return NextResponse.json({ error: plain ?? `${model} failed (${res.status}): ${msg}` }, { status: 502 });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let j: any = null; try { j = JSON.parse(raw); } catch { /* handled below */ }
  const text: string = j?.choices?.[0]?.message?.content ?? "";
  const out = sceneFromReply(text);
  if (!out) return NextResponse.json({ error: `${model} answered, but not with a scene. Try once more, or another model.` }, { status: 502 });

  let costUsd = Number(j?.usage?.cost ?? NaN);
  if (!Number.isFinite(costUsd)) {
    const cm = await findModel(model);
    const inTok = Number(j?.usage?.prompt_tokens ?? (SYSTEM.length + user.length) / 4);
    const outTok = Number(j?.usage?.completion_tokens ?? text.length / 4);
    costUsd = (cm && textCostUsd(cm, inTok, outTok)) || estimateRefineUsd(model, user.length, SYSTEM.length) || 0;
  }
  await ready();
  const spendId = newId("spend");
  await db().execute({ sql: `INSERT INTO atomik_spend (id, kind, model, cost_usd, user_id, created_at) VALUES (?,?,?,?,?,?)`, args: [spendId, "scene", model, costUsd, got.user.id, now()] });
  await meter({ id: spendId, kind: "text", engine: "vercel", model, status: "succeeded", engineCostUsd: costUsd, projectId, createdBy: got.user.id }, { critical: false });
  return NextResponse.json({ scene: { ...out, n, by: model, at: now() }, model, costUsd });
});
