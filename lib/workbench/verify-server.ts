import { createHash } from "node:crypto";
import sharp from "sharp";
import type { Client, InStatement } from "@libsql/client";
import { db } from "../db";
import { getAtomikProject } from "./atomik-server";
import { AtomikReferenceError, loadAtomikReferences, type AtomikVisual } from "./atomik-references";
import type { AtomikVideoFrame } from "./atomik-reference-types";
import type { DevelopmentResult } from "./development-types";
import type { Project } from "./studio";
import {
  VERIFY_FRAMES, isVerifyCard, verificationStanding, verifyKeyOf, verifyParts, verifySubject,
  type TakeVerification, type Verdict, type VerifyCheck, type VerifyKey,
} from "./verify";
import { mockColourScore, verifyChunk, type VerifySnapshot } from "./verify-judge";

/*
 * The server half of a Verify check (plan PR 7). A check runs as the
 * development kind `verify` (lib/workbench/development-server.ts): the same
 * quote, reservation, durable phase, settlement and recovery as every agent
 * step. This module gathers its evidence, keeps its result and answers what a
 * board shows.
 *
 * take_verifications (tenant table, additive): one row per check that
 * finished, unique on (take_id, master_set_hash, rubric, frames_hash). The same
 * take checked against the same masters is read back for free; a new master
 * version is a new key, so a new, priced check.
 */

export class VerifyError extends Error {
  constructor(message: string, public status = 422) { super(message); this.name = "VerifyError"; }
}
export const ALREADY_CHECKED = "This take was already checked against these masters. Its scorecard is on the card. Reading it again is free.";
export const CHECK_RUNNING = "This take is being checked against these masters right now. Its scorecard lands on the card when the check is done.";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS take_verifications (
     id TEXT PRIMARY KEY,
     production_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     verify_node_id TEXT NOT NULL,
     take_id TEXT NOT NULL,
     master_set_hash TEXT NOT NULL,
     master_set TEXT NOT NULL,
     masters TEXT NOT NULL,
     rubric INTEGER NOT NULL,
     frames_hash TEXT NOT NULL,
     frames_key TEXT NOT NULL,
     frames TEXT NOT NULL,
     checks TEXT NOT NULL,
     verdict TEXT NOT NULL,
     judge_model TEXT NOT NULL,
     meter_event_id TEXT NOT NULL,
     credits INTEGER NOT NULL,
     funded_by_platform INTEGER NOT NULL,
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE(take_id, master_set_hash, rubric, frames_hash)
   )`,
  "CREATE INDEX IF NOT EXISTS take_verifications_production ON take_verifications(production_id, created_at)",
];
const created = new WeakMap<Client, Promise<void>>();
/** Creates the table on first use (idempotent), in the workspace's own database. */
export async function verifyReady() {
  const client = db();
  let pending = created.get(client);
  if (!pending) {
    pending = client.batch(SCHEMA, "write").then(() => {}).catch((error) => { created.delete(client); throw error; });
    created.set(client, pending);
  }
  await pending;
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
/** The stored key: the take as it is, and digests of the master set and the frame points. */
export function verifyKeyHashes(key: VerifyKey) {
  return { takeId: key.takeId, masterSetHash: sha(key.masterSet), rubric: key.rubric, framesHash: sha(key.framesKey) };
}
/** One digest for the whole key: how a running check of the same key is found. */
export const verifyKeyHash = (key: VerifyKey) => sha(JSON.stringify([key.takeId, key.masterSet, key.rubric, key.framesKey]));

type Row = Record<string, unknown>;
function publicVerification(row: Row): TakeVerification {
  return {
    id: String(row.id), takeId: String(row.take_id), verifyNodeId: String(row.verify_node_id),
    masterSet: String(row.master_set), rubric: Number(row.rubric), framesKey: String(row.frames_key),
    masters: JSON.parse(String(row.masters)), frames: JSON.parse(String(row.frames)), checks: JSON.parse(String(row.checks)),
    verdict: String(row.verdict) as Verdict, judgeModel: String(row.judge_model),
    credits: Number(row.credits), ownKey: !Number(row.funded_by_platform), createdAt: Number(row.created_at),
  };
}

/** The check stored for exactly this key, or null. Reading it spends nothing. */
export async function storedVerification(key: VerifyKey): Promise<TakeVerification | null> {
  await verifyReady();
  const k = verifyKeyHashes(key);
  const row = (await db().execute({ sql: "SELECT * FROM take_verifications WHERE take_id=? AND master_set_hash=? AND rubric=? AND frames_hash=?", args: [k.takeId, k.masterSetHash, k.rubric, k.framesHash] })).rows[0];
  return row ? publicVerification(row as Row) : null;
}
/** Whether a check of this key is queued or running (anyone's): a second paid check of it is refused. */
export async function verifyInFlight(keyHash: string): Promise<boolean> {
  return (await db().execute({ sql: "SELECT 1 FROM workbench_development_jobs WHERE status IN ('queued','running') AND json_extract(request_body,'$.kind')='verify' AND json_extract(snapshot,'$.verify.keyHash')=? LIMIT 1", args: [keyHash] })).rows.length > 0;
}

/** The Verify card a request names, what it checks now, and the key a check of it is stored under. */
export function verifyTarget(project: Project, nodeId: string | undefined) {
  const node = nodeId ? project.nodes.find((n) => n.id === nodeId) : undefined;
  if (!node || !isVerifyCard(node)) throw new VerifyError("Choose a Verify card on the Rig.", 404);
  const subject = verifySubject(project, node);
  if (subject.problem) throw new VerifyError(subject.problem, 409);
  const key = verifyKeyOf(subject)!;
  return { node, subject, key, keyHash: verifyKeyHash(key) };
}

/** The stored check for what this card checks now, if there is one: the quote answers with it, free. */
export async function storedVerificationFor(project: Project, nodeId: string | undefined): Promise<TakeVerification | null> {
  const node = nodeId ? project.nodes.find((n) => n.id === nodeId) : undefined;
  if (!node || !isVerifyCard(node)) return null;
  const key = verifyKeyOf(verifySubject(project, node));
  const stored = key ? await storedVerification(key) : null;
  return stored ? { ...stored, standing: "current" } : null;
}

/**
 * A check's evidence and snapshot, read the same way for the free quote and
 * again at the paid start (so the start refuses a source that changed): the
 * take's bounded review copies (a still, or the three frames the browser
 * sampled and stored), then each master's. Refused when the key is stored
 * already (free to read) or a check of it is running.
 */
export async function compileVerify(project: Project, nodeId: string | undefined, videoFrames: AtomikVideoFrame[] | undefined, owner: string) {
  await verifyReady();
  const { node, subject, key, keyHash } = verifyTarget(project, nodeId);
  if (await storedVerification(key)) throw new VerifyError(ALREADY_CHECKED, 409);
  if (await verifyInFlight(keyHash)) throw new VerifyError(CHECK_RUNNING, 409);
  const take = subject.take!, asset = take.asset!;
  const frames = [...(videoFrames ?? [])].sort((a, b) => a.timeSeconds - b.timeSeconds);
  let takeImages: AtomikVisual[];
  const masterImages: AtomikVisual[] = [];
  try {
    if (asset.kind === "video") {
      if (frames.length !== VERIFY_FRAMES.max || frames.some((f) => f.assetId !== asset.id)) throw new VerifyError("Prepare the take's three review frames before asking for the price.", 422);
      takeImages = (await loadAtomikReferences(project, [asset.id], owner, frames)).images;
    } else {
      if (frames.length) throw new VerifyError("Only a video take is checked from sampled frames.", 422);
      takeImages = (await loadAtomikReferences(project, [asset.id], owner)).images;
    }
    for (const master of subject.masters) {
      const image = (await loadAtomikReferences(project, [master.asset!.id], owner)).images[0];
      if (!image) throw new VerifyError(`${master.node.title || "A master"}'s picture could not be read. Upload it again as a PNG or JPEG.`, 422);
      masterImages.push(image);
    }
  } catch (error) {
    if (error instanceof AtomikReferenceError) throw new VerifyError(error.message, error.status);
    throw error;
  }
  if (!takeImages.length) throw new VerifyError("The take could not be read. Upload it again, or generate it again.", 422);
  const snapshot: VerifySnapshot = {
    nodeId: node.id, key, keyHash, checks: subject.checks,
    take: { assetId: asset.id, title: take.node.title, name: asset.name, kind: asset.kind === "video" ? "video" : "image", version: asset.version, identity: take.identity! },
    frames: takeImages.map((image, i) => ({
      t: asset.kind === "video" ? image.timeSeconds ?? frames[i]?.timeSeconds ?? null : null,
      uploadId: asset.kind === "video" ? frames[i]?.uploadId ?? null : asset.uploadId ?? null,
      sha256: image.sha256, image: i + 1,
    })),
    masters: subject.masters.map((m, i) => ({
      nodeId: m.node.id, kind: m.kind, title: m.node.title, assetId: m.asset!.id, name: m.asset!.name, version: m.asset!.version,
      identity: m.identity!, sha256: masterImages[i].sha256, image: takeImages.length + i + 1, ...(m.node.elementId ? { elementId: m.node.elementId } : {}),
    })),
    images: [...takeImages, ...masterImages].map((image) => ({ sha256: image.sha256, dataUrl: image.dataUrl })),
  };
  return { canonical: JSON.stringify({ kind: "verify", verify: snapshot }), chunk: verifyChunk(subject.checks), images: snapshot.images.length };
}

/**
 * The finished check's row, written in the same batch that marks its job
 * succeeded (so it exists exactly when the job does). A key stored already, by
 * a check that finished first, keeps its row.
 */
export async function verificationStatements(row: Row, credits: number): Promise<InStatement[]> {
  await verifyReady();
  const snapshot = (JSON.parse(String(row.snapshot)) as { verify?: VerifySnapshot }).verify;
  const step = (await db().execute({ sql: "SELECT result FROM workbench_development_steps WHERE job_id=? AND stage='refine' AND status='succeeded'", args: [String(row.id)] })).rows[0];
  const result = step?.result ? (JSON.parse(String(step.result)) as DevelopmentResult).verify : undefined;
  if (!snapshot || !result) return [];
  const request = JSON.parse(String(row.request_body)) as { model?: string; projectId?: string };
  const k = verifyKeyHashes(snapshot.key);
  const masters = snapshot.masters.map((m) => ({ kind: m.kind, nodeId: m.nodeId, title: m.title, identity: m.identity, version: m.version, ...(m.elementId ? { elementId: m.elementId } : {}) }));
  const frames = snapshot.frames.map((f) => ({ t: f.t, uploadId: f.uploadId, sha256: f.sha256 }));
  return [{
    sql: `INSERT OR IGNORE INTO take_verifications(id,production_id,project_id,verify_node_id,take_id,master_set_hash,master_set,masters,rubric,frames_hash,frames_key,frames,checks,verdict,judge_model,meter_event_id,credits,funded_by_platform,created_by,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM workbench_development_jobs WHERE id=? AND status='succeeded')`,
    args: [String(row.id), String(row.production_project_id), String(request.projectId ?? row.project_id), snapshot.nodeId, k.takeId, k.masterSetHash, snapshot.key.masterSet,
      JSON.stringify(masters), k.rubric, k.framesHash, snapshot.key.framesKey, JSON.stringify(frames), JSON.stringify(result.checks), result.verdict,
      String(request.model ?? ""), String(row.id), credits, Number(row.funded_by_platform) ? 1 : 0, String(row.owner), Date.now(), String(row.id)],
  }];
}

/**
 * The production's checks, newest first, for the board and Takes: every check
 * its cards asked for, and any stored check of a take its cards show now (one
 * that another production's card asked for is the same check). Each says how
 * it stands against the saved board.
 */
export async function listVerifications(owner: string, projectId: string): Promise<{ verifications: TakeVerification[] }> {
  const project = await getAtomikProject(owner, projectId);
  await verifyReady();
  if (!project.productionProjectId) return { verifications: [] };
  const subjects = new Map(project.nodes.filter(isVerifyCard).map((node) => [node.id, verifySubject(project, node)]));
  const takes = [...new Set([...subjects.values()].flatMap((s) => (s.take?.identity ? [s.take.identity] : [])))].slice(0, 200);
  const rows = (await db().execute({
    sql: `SELECT * FROM take_verifications WHERE production_id=?${takes.length ? ` OR take_id IN (${takes.map(() => "?").join(",")})` : ""} ORDER BY created_at DESC, id DESC LIMIT 300`,
    args: [project.productionProjectId, ...takes],
  })).rows as Row[];
  return { verifications: rows.map((row) => {
    const v = publicVerification(row), subject = subjects.get(v.verifyNodeId);
    if (!subject) return v;
    const parts = verifyParts(subject);
    return { ...v, standing: verificationStanding(v, parts), mastersCurrent: v.masterSet === parts.masterSet };
  }) };
}

/* ── The mock judge (ENGINE_MOCK=1): no provider is called ─────────────── */

async function meanColour(dataUrl: string | undefined): Promise<number[]> {
  if (!dataUrl) return [];
  const stats = await sharp(Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64")).stats();
  return stats.channels.slice(0, 3).map((channel) => channel.mean);
}
/**
 * Scores each check by how alike the take's and the master's average colours
 * are (lib/workbench/verify-judge.ts mockColourScore); artifacts read as clean.
 * It reports tokens, not dollars, so the check settles through the same ledger
 * arithmetic a real one does.
 */
export async function mockVerifyReply(call: { prompt: string; images?: string[] }) {
  const request = JSON.parse(call.prompt) as { take: { images: { image: number }[] }; checks: { check: VerifyCheck; compareWith: number[] }[] };
  const colours = await Promise.all((call.images ?? []).map(meanColour));
  const takeImages = request.take.images.map((i) => i.image);
  const checks = request.checks.map(({ check, compareWith }) => {
    if (!compareWith.length) return { check, score: 0.9, seen: true, reasons: ["Mock judge: no provider was called. The take reads as clean."], frame: takeImages[0] ?? null };
    let best = { score: 0, frame: takeImages[0] ?? null };
    for (const t of takeImages) for (const m of compareWith) {
      const score = mockColourScore(colours[t - 1] ?? [], colours[m - 1] ?? []);
      if (score > best.score) best = { score, frame: t };
    }
    return { check, score: best.score, seen: true, reasons: [`Mock judge: no provider was called. The take's average colour is ${Math.round(best.score * 100)}% like the master's.`], frame: best.frame };
  });
  return {
    text: JSON.stringify({ checks, summary: "Mock judge: compared average colours only. No provider was called." }),
    inputTokens: Buffer.byteLength(call.prompt, "utf8") + (call.images?.length ?? 0) * 1100, outputTokens: 180,
  };
}
