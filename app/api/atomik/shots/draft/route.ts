import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { db, ready, now, id as newId } from "@/lib/db";
import { getTreatment } from "@/lib/atomikDocs";
import { listCast } from "@/lib/cast";
import { resolveModel } from "@/lib/atomik";
import { gatewayAuth, gatewayReachable, explainGatewayFailure } from "@/lib/gateway";
import { engineFor } from "@/lib/engines";
import { findModel, textCostUsd } from "@/lib/catalog";
import { estimateRefineUsd } from "@/lib/refineGate";
import { meter } from "@/lib/meter";
import { specToPhrase } from "@/lib/studio";
import { shotsFromReply, shotCostUsd, setupVocabulary, suggestEngine } from "@/lib/shotBuilder";

export const dynamic = "force-dynamic";

const SYSTEM = [
  "You break ONE scene of a film treatment into shots for a production studio. Every shot must be filmable as a single generated clip of 2 to 15 seconds.",
  "For each shot give a short title, a one-paragraph description in present tense (what is in frame and what happens — no camera jargon in the prose),",
  "planned seconds, the setup as FIELDS using only the values listed (leave a row out if nothing fits), the cast as @Name from the names given,",
  "the engine — \"kling\" for water, cloth, hair, smoke and physics-heavy motion, \"seedance\" for everything else — and one short line of why.",
  'Return ONLY a JSON object: {"shots": [{"title": string, "description": string, "planned": number, "setup": {row: value}, "cast": string[], "engine": "seedance"|"kling", "why": string}]} — no prose outside it, no code fence.',
].join(" ");

/**
 * The shot builder (brief 1.8): a scene in, a shot list out with every Setup
 * row as a field, cast tagged, an engine per shot and a credit estimate per
 * shot and for the scene — before anything is rendered. Proposals only:
 * nothing is written until a person adds a shot.
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  const projectId = String(body.projectId ?? "");
  const n = Number(body.scene);
  if (!projectId || !Number.isInteger(n) || n < 1) return NextResponse.json({ error: "Which scene?" }, { status: 400 });
  const t = await getTreatment(projectId);
  const scene = t?.scenes.find((s) => s.n === n);
  if (!t || !scene) return NextResponse.json({ error: "No such scene." }, { status: 404 });
  if (!gatewayReachable()) return NextResponse.json({ error: "Vercel AI Gateway isn't connected for this workspace — add a gateway key under Settings › Vendors & keys." }, { status: 503 });

  const castNames = (await listCast(projectId)).map((c) => c.name);
  const model = await resolveModel(typeof body.model === "string" ? body.model.slice(0, 120) : "auto", "shot");
  const auth = await gatewayAuth();
  const hint = suggestEngine(`${scene.title} ${scene.prose}`);
  const user = [
    `LOGLINE: ${t.logline || "(none yet)"}`,
    Object.keys(t.setup).length ? `THE PRODUCTION'S SETUP (carry it unless the shot needs otherwise): ${specToPhrase(t.setup)}` : "",
    `CAST NAMES: ${castNames.length ? castNames.map((c) => `@${c}`).join(", ") : "(none)"}`,
    `SETUP ROWS AND THEIR VALUES:\n${setupVocabulary()}`,
    `SCENE ${n} — ${scene.title || "Untitled"} (${scene.secs}s):\n${scene.prose || "(empty)"}`,
    `THE RULE SAYS: ${hint.engine} (${hint.why}). Follow it unless a shot is clearly otherwise, and say why.`,
  ].filter(Boolean).join("\n\n");
  const res = await engineFor("vercel").run!({ body: JSON.stringify({ model, max_tokens: 2400, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] }), auth, timeoutMs: 120_000, mock: "shots" });
  const raw = res.text;
  if (!res.ok) {
    const plain = explainGatewayFailure(res.status, raw);
    let msg = raw.slice(0, 300); try { msg = JSON.parse(raw)?.error?.message ?? msg; } catch { /* raw */ }
    return NextResponse.json({ error: plain ?? `${model} failed (${res.status}): ${msg}` }, { status: 502 });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let j: any = null; try { j = JSON.parse(raw); } catch { /* handled below */ }
  const text: string = j?.choices?.[0]?.message?.content ?? "";
  const shots = shotsFromReply(text, castNames);
  if (!shots) return NextResponse.json({ error: `${model} answered, but not with shots. Try once more, or another model.` }, { status: 502 });

  let costUsd = Number(j?.usage?.cost ?? NaN);
  if (!Number.isFinite(costUsd)) {
    const cm = await findModel(model);
    const inTok = Number(j?.usage?.prompt_tokens ?? (SYSTEM.length + user.length) / 4);
    const outTok = Number(j?.usage?.completion_tokens ?? text.length / 4);
    costUsd = (cm && textCostUsd(cm, inTok, outTok)) || estimateRefineUsd(model, user.length, SYSTEM.length) || 0;
  }
  await ready();
  const spendId = newId("spend");
  await db().execute({ sql: `INSERT INTO atomik_spend (id, kind, model, cost_usd, user_id, created_at) VALUES (?,?,?,?,?,?)`, args: [spendId, "shots", model, costUsd, got.user.id, now()] });
  await meter({ id: spendId, kind: "text", engine: "vercel", model, status: "succeeded", engineCostUsd: costUsd, projectId, createdBy: got.user.id }, { critical: false });
  const priced = shots.map((s) => ({ ...s, takeUsd: shotCostUsd(s.engine, s.planned) }));
  return NextResponse.json({ scene: n, shots: priced, sceneUsd: Math.round(priced.reduce((a, s) => a + s.takeUsd, 0) * 1000) / 1000, model, costUsd });
});
