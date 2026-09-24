import { textVendor, directTextCostUsd, sdkTextUsage, TEXT_PROVIDER_HEADER, type TextVendor } from '../openai-direct';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ToolLoopAgent, stepCountIs } from 'ai';
import type { JSONObject } from '@ai-sdk/provider';
import { db, now } from '../db';
import { catalog, textCostUsd, textQuoteCostUsd, type CatalogModel } from '../catalog';
import { atomikModels, getAtomikProject } from './atomik-server';
import { atomikReasoningRequest } from '../atomik-reasoning';
import { gatewayReachable } from '../gateway';
import { languageAuth, languageModel } from '../language-provider';
import { allowanceCheck } from '../allowance';
import { reserveGenerationSpend } from '../generationRequests';
import { assertMeterFunding, meter, type MeterEvent } from '../meter';
import { platformDb, platformReady } from '../platform';
import { billingTransaction } from '../billingLedger';
import { vendorKey } from '../vendorKeys';
import { billCredits } from '../creditTerms';
import { paidByPlatform } from '../platformSpend';
import { engineMock } from '../mock';
import { requireTenant, type TenantToken } from '../tenant';
import { recoveryFetch, resolveRecoveryJobTx, withRecoveryJob } from '../recovery';
import { sourceCanonical, type DevelopmentJob, type DevelopmentQuote, type DevelopmentRequest, type DevelopmentResult, type DevelopmentStage } from './development-types';
import { compactBeatSheet } from '../production/beats';
import { boardShots } from '../production/boards';
import { ENGINE_PROMPT_LIMIT, shotRenderPrompt, textKey } from '../production/rig-prompt';
import { loadAtomikReferences } from './atomik-references';
import { ATOMIK_IMAGE_TOKENS } from './atomik-reference-types';
import type { Project } from './studio';
import { FRAMES_PER_CHUNK, DEVELOPMENT_STAGES, DEVELOPMENT_CRITIQUE_BYTES, DEVELOPMENT_REQUEST_CEILING_USD, developmentAnswerTokens, parseAgentJson, developmentResultBytes, developmentChunks, developmentInstructions, developmentCritiqueSchema, validateDevelopmentResult, type DevelopmentChunk } from './development-plan';

export class DevelopmentError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'DevelopmentError'; }
}
export const developmentRequestSchema = z.object({
  projectId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/), requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/),
  kind: z.enum(['idea', 'screenplay', 'adfilm', 'write', 'frames', 'sketch', 'cast', 'environment', 'condense', 'rig']), model: z.string().min(1).max(120),
  effort: z.string().min(1).max(40).default('auto'), instructions: z.string().trim().max(5000).optional(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), maxCredits: z.number().int().min(0).max(1_000_000).optional(),
  maxUsd: z.number().finite().min(0).max(1000).optional(),
  fromJobId: z.string().regex(/^wb_development_[a-f0-9-]+$/).optional(),
  fromBeats: z.literal(true).optional(),
  shotId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/).optional(), sketchAssetId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
  nodeId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
}).strict();
export type DevelopmentCall = {
  model: CatalogModel; effort: string; stage: DevelopmentStage; kind: DevelopmentRequest['kind'];
  instructions: string; prompt: string; maxTokens: number; chunk: DevelopmentChunk;
  /** Bounded review images (data URLs) sent with the prompt — the sketch reader's drawing. */
  images?: string[];
};
export type DevelopmentReply = { text: string; inputTokens?: number; outputTokens?: number; costUsd?: number; directUsage?: unknown; finishReason?: string };
export type DevelopmentDependencies = {
  models: typeof catalog; allowance: typeof allowanceCheck; reserve: typeof reserveGenerationSpend; meter: typeof meter;
  call: (input: DevelopmentCall) => Promise<DevelopmentReply>;
  auth: (model: string) => Promise<DevelopmentAuth>;
  funding: (id: string, model?: string) => Promise<void>;
  reservation: (id: string) => Promise<boolean>;
};
export type DevelopmentAuth = { token: string; method: 'api-key' | 'oidc'; vendor?: TextVendor };
async function developmentAuth(model: string): Promise<DevelopmentAuth> {
  if (engineMock()) return { token: 'mock-not-sent', method: 'api-key' };
  const vendor = textVendor(model);
  const method = vendor === 'openai' || vendorKey('gateway') ? 'api-key' : 'oidc';
  const auth = await languageAuth(model);
  const token = auth.Authorization?.replace(/^Bearer\s+/i, '');
  if (!token) throw new DevelopmentError('This workspace has no connected development provider.', 503);
  return { token, method, vendor };
}
async function reservationExists(id: string) {
  await platformReady();
  const row = (await platformDb().execute({ sql: 'SELECT workspace_id FROM meter_events WHERE id=?', args: [id] })).rows[0];
  if (row && row.workspace_id !== requireTenant().id) throw new Error('The development reservation belongs to another workspace.');
  return !!row;
}
const dependencies = (overrides?: Partial<DevelopmentDependencies>): DevelopmentDependencies => ({
  models: catalog, allowance: allowanceCheck, reserve: reserveGenerationSpend, meter, call: callDevelopmentAgent,
  auth: developmentAuth, reservation: reservationExists,
  funding: async (id, model) => { if (!await reservationExists(id)) throw new Error('The development reservation is missing. No provider call was sent.'); await assertMeterFunding(id, textVendor(model ?? '') === 'openai' ? 'openai' : 'vercel'); },
  ...overrides,
});
const initialized = new Map<string, Promise<void>>();
export async function developmentReady() {
  const ws = requireTenant(), key = ws.id + ':' + ws.dbUrl;
  if (!initialized.has(key)) initialized.set(key, (async () => {
    // Existing project bootstrap is shared with the workbench and Atomik.
    const { atomikReady } = await import('./atomik-server');
    await atomikReady();
    await db().batch([
      `CREATE TABLE IF NOT EXISTS workbench_development_jobs (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, project_id TEXT NOT NULL, production_project_id TEXT NOT NULL,
        request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, request_body TEXT NOT NULL, source_hash TEXT NOT NULL,
        snapshot TEXT NOT NULL, model_body TEXT NOT NULL, chunks TEXT NOT NULL, status TEXT NOT NULL,
        estimate_usd REAL NOT NULL, estimate_credits INTEGER NOT NULL, cost_usd REAL, credits INTEGER,
        result TEXT, error TEXT, funded_by_platform INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(owner,request_id))`,
      `CREATE TABLE IF NOT EXISTS workbench_development_steps (
        job_id TEXT NOT NULL, step_index INTEGER NOT NULL, chunk_index INTEGER NOT NULL, stage TEXT NOT NULL,
        status TEXT NOT NULL, estimate_usd REAL NOT NULL, max_tokens INTEGER NOT NULL,
        response TEXT, result TEXT, usage TEXT, cost_usd REAL, error TEXT, updated_at INTEGER NOT NULL,
        PRIMARY KEY(job_id,step_index))`,
      'CREATE INDEX IF NOT EXISTS workbench_development_project ON workbench_development_jobs(owner,project_id,created_at)',
      'CREATE INDEX IF NOT EXISTS workbench_development_active ON workbench_development_jobs(status,updated_at)',
      'CREATE INDEX IF NOT EXISTS workbench_development_step_active ON workbench_development_steps(status,updated_at)',
    ], 'write');
    const columns = (await db().execute('PRAGMA table_info(workbench_development_jobs)')).rows;
    for (const [name, definition] of [['funded_by_platform', 'INTEGER NOT NULL DEFAULT 0'], ['settled', 'INTEGER NOT NULL DEFAULT 0']]) {
      if (!columns.some(column => column.name === name)) await db().execute(`ALTER TABLE workbench_development_jobs ADD COLUMN ${name} ${definition}`).catch(error => { if (!/duplicate column/i.test((error as Error).message)) throw error; });
    }
  })().catch(error => { initialized.delete(key); throw error; }));
  await initialized.get(key);
}

/**
 * The agents a director can choose — Claude, Grok (the Gateway's `spacexai/`
 * reasoning models) or OpenAI — each priced by the live catalogue. Grok runs
 * at its provider's default reasoning: its effort controls are not verified
 * through this path, so none is offered rather than one that might be ignored.
 */
export function developmentModels(models: CatalogModel[]) {
  const byId = new Map(models.map((model) => [model.id, model]));
  return atomikModels(models).filter(model => /^(anthropic\/claude-|openai\/|spacexai\/grok-)/.test(model.id))
    .map(model => ({ ...model, vision: canSee(byId.get(model.id)!) }))
    .map(model => (model.id.startsWith('spacexai/') ? { ...model, efforts: model.efforts.filter(option => option.value === 'auto') } : model));
}
/** A model that takes image input: the catalogue's input modalities, or (Grok lists none) its vision tag. */
export function canSee(model: CatalogModel): boolean {
  return Boolean(model.inputModalities?.includes('image') || model.tags?.includes('vision'));
}
export function developmentSourceHash(canonical: string) { return createHash('sha256').update(canonical).digest('hex'); }

type Snapshot = { name: string; brief: string; audience: string; deliverables: string; direction: string; fps: number; aspect: string; script?: string; fromJobId?: string; beatSheet?: unknown;
  /* frames / sketch */ style?: string; shots?: { id: string }[]; shot?: unknown; sketch?: { assetId: string; name: string; sha256: string; dataUrl: string } };
/** Images a phase sends with its prompt: only the sketch reader's one drawing. */
export function developmentImages(snapshot: { sketch?: { dataUrl?: string } }): string[] {
  return snapshot.sketch?.dataUrl ? [snapshot.sketch.dataUrl] : [];
}
/** The storyboard shots the agent writes for: every beat-sheet shot, numbered, with its scene. */
function boardSource(project: Project) {
  return boardShots(project.production?.beats).map((s) => ({ number: s.number, scene: s.scene, sceneSummary: s.sceneSummary, ...s.shot, characters: s.characters, locations: s.locations }));
}
/** The writer's source: the project, and the draft being redrafted (an earlier run's, or the script on the page). */
function writerCanonical(project: { name: string; brief: string; audience: string; deliverables: string; direction: string; fps: number; aspect: string; scriptFormat?: 'screenplay' | 'adfilm' }, base: string, fromJobId?: string, beatSheet?: unknown) {
  return JSON.stringify({ kind: 'write', name: project.name, brief: project.brief, audience: project.audience, deliverables: project.deliverables,
    direction: project.direction, fps: project.fps, aspect: project.aspect, scriptFormat: project.scriptFormat ?? 'screenplay', script: base, ...(fromJobId ? { fromJobId } : {}), ...(beatSheet ? { beatSheet } : {}) });
}
/** The script a finished writer run of this project produced, for its redraft. */
async function writerDraft(owner: string, projectId: string, jobId: string): Promise<string> {
  await developmentReady();
  const row = (await db().execute({ sql: "SELECT j.request_body,s.result FROM workbench_development_jobs j JOIN workbench_development_steps s ON s.job_id=j.id AND s.stage='refine' AND s.status='succeeded' WHERE j.id=? AND j.owner=? AND j.project_id=? AND j.status='succeeded'", args: [jobId, owner, projectId] })).rows[0];
  const kind = row ? (JSON.parse(String(row.request_body)) as DevelopmentRequest).kind : null;
  const text = row && kind === 'write' ? (JSON.parse(String(row.result)) as DevelopmentResult).script?.text : null;
  if (!text) throw new DevelopmentError('That draft is not a finished script of this project. Choose a finished draft to redraft.', 404);
  return text;
}
function promptFor(snapshot: Snapshot, input: DevelopmentRequest, chunk: DevelopmentChunk, draft?: unknown, critique?: unknown) {
  if (input.kind === 'rig') {
    const { kind: _kind, nodeId: _node, ...source } = snapshot as Snapshot & { kind?: string; nodeId?: string };
    return JSON.stringify({ directorRequest: input.instructions ?? '', ...source, ...(draft ? { savedDraft: draft } : {}), ...(critique ? { independentCritique: critique } : {}) });
  }
  if (input.kind === 'condense') {
    const { prompt } = snapshot as Snapshot & { prompt?: string };
    return JSON.stringify({ shotPrompt: prompt, ...(draft ? { savedDraft: draft } : {}), ...(critique ? { independentCritique: critique } : {}) });
  }
  if (input.kind === 'cast' || input.kind === 'environment') {
    const { kind: _kind, ...source } = snapshot as Snapshot & { kind?: string };
    return JSON.stringify({ directorRequest: input.instructions ?? '', ...source, ...(draft ? { savedDraft: draft } : {}), ...(critique ? { independentCritique: critique } : {}) });
  }
  if (input.kind === 'frames' || input.kind === 'sketch') {
    const { name, direction, aspect, style } = snapshot;
    const wanted = new Set(chunk.segments.map((segment) => segment.id));
    return JSON.stringify({ directorRequest: input.instructions ?? '', project: { name, direction, aspect }, look: style,
      ...(input.kind === 'frames' ? { shots: (snapshot.shots ?? []).filter((shot) => wanted.has(shot.id)) } : { shot: snapshot.shot, drawing: snapshot.sketch ? { name: snapshot.sketch.name, attached: true } : null }),
      ...(draft ? { savedDraft: draft } : {}), ...(critique ? { independentCritique: critique } : {}) });
  }
  const { script, fromJobId: _from, beatSheet, ...context } = snapshot;
  if (input.kind === 'write') return JSON.stringify({ directorRequest: input.instructions ?? '', project: context,
    ...(script?.trim() ? { currentDraft: script } : {}), ...(beatSheet ? { beatSheet } : {}), ...(draft ? { savedDraft: draft } : {}), ...(critique ? { independentCritique: critique } : {}) });
  return JSON.stringify({ directorRequest: input.instructions ?? '', project: context,
    ...(input.kind === 'idea' ? {} : { assignedSourceSegments: chunk.segments.map(segment => ({
      id: segment.id, heading: segment.heading, sourceStart: segment.start, sourceEnd: segment.end,
      text: (script ?? '').slice(segment.start, segment.end),
    })) }), ...(draft ? { savedDraft: draft } : {}), ...(critique ? { independentCritique: critique } : {}) });
}
async function compile(input: DevelopmentRequest, owner: string, deps: DevelopmentDependencies) {
  const project = await getAtomikProject(owner, input.projectId);
  if (!project.productionProjectId) throw new DevelopmentError('Save the project to link its production budget.', 409);
  let base = '', beatSheet: unknown;
  if (input.kind !== 'write' && (input.fromJobId || input.fromBeats)) throw new DevelopmentError('Only the script writer redrafts an earlier result.');
  if (input.fromJobId && input.fromBeats) throw new DevelopmentError('Redraft one source at a time: a draft, or the beat sheet.');
  if (input.kind === 'write') {
    if (input.fromJobId) base = await writerDraft(owner, input.projectId, input.fromJobId);
    if (input.fromBeats) {
      base = project.script ?? '';
      const sheet = project.production?.beats;
      if (!base.trim()) throw new DevelopmentError('Approve a script in Brief & Script first.');
      if (!sheet?.scenes.length) throw new DevelopmentError('Break the script into beats first.');
      beatSheet = compactBeatSheet(sheet);
    }
    if (!project.brief.trim() && !base.trim()) throw new DevelopmentError('Write the prompt for the script first.');
    if (input.fromJobId && !input.instructions?.trim()) throw new DevelopmentError('Write the notes for this redraft.');
  }
  if (input.kind !== 'sketch' && input.sketchAssetId) throw new DevelopmentError('Only the sketch reader takes a drawing.');
  if (input.kind !== 'sketch' && input.kind !== 'frames' && input.shotId) throw new DevelopmentError('Only the storyboard artist takes a shot.');
  if (input.kind !== 'condense' && input.kind !== 'rig' && input.nodeId) throw new DevelopmentError('Only the Rig steps take a Rig shot.');
  const style = project.production?.boards?.style ?? 'live';
  let canonical: string, boardChunks: DevelopmentChunk[] | null = null, images = 0;
  if (input.kind === 'frames') {
    const shots = boardSource(project).filter((shot) => !input.shotId || shot.id === input.shotId);
    if (!shots.length) throw new DevelopmentError(input.shotId ? 'Choose a shot of the beat sheet.' : 'Break the script into beats and shots first.');
    canonical = JSON.stringify({ kind: 'frames', name: project.name, direction: project.direction, aspect: project.aspect, style, shots });
    boardChunks = [];
    for (let i = 0; i < shots.length; i += FRAMES_PER_CHUNK) {
      const part = shots.slice(i, i + FRAMES_PER_CHUNK);
      boardChunks.push({ index: boardChunks.length, start: i, end: i + part.length, segments: part.map((shot, j) => ({ id: shot.id, heading: shot.number, start: i + j, end: i + j + 1 })) });
    }
  } else if (input.kind === 'sketch') {
    const shot = boardSource(project).find((value) => value.id === input.shotId);
    if (!shot) throw new DevelopmentError('Choose a shot of the beat sheet.', 404);
    const asset = project.assets.find((value) => value.id === input.sketchAssetId);
    if (!asset || asset.kind !== 'image') throw new DevelopmentError('Upload the drawing for this shot first.', 404);
    const refs = await loadAtomikReferences(project, [asset.id], owner);
    const image = refs.images[0];
    if (!image) throw new DevelopmentError('The drawing could not be read. Upload it again as a PNG or JPEG.', 422);
    canonical = JSON.stringify({ kind: 'sketch', name: project.name, direction: project.direction, aspect: project.aspect, style, shot, sketch: { assetId: asset.id, name: asset.name, sha256: image.sha256, dataUrl: image.dataUrl } });
    boardChunks = [{ index: 0, start: 0, end: 1, segments: [{ id: shot.id, heading: shot.number, start: 0, end: 1 }] }];
    images = 1;
  } else if (input.kind === 'rig') {
    const node = project.nodes.find((value) => value.id === input.nodeId);
    if (!node) throw new DevelopmentError('Choose a shot in the Rig.', 404);
    const assets = project.assets.filter((a) => a.kind === 'image' || a.kind === 'video').slice(0, 150)
      .map((a) => ({ id: a.id, name: a.name, kind: a.kind, category: a.category, about: (a.description || a.prompt || '').slice(0, 300) }));
    const beat = node.boardShotId ? boardSource(project).find((shot) => shot.id === node.boardShotId) : undefined;
    const inputs = node.linked.flatMap((id) => { const n = project.nodes.find((x) => x.id === id); return n?.assetId ? [n.assetId] : []; });
    canonical = JSON.stringify({ kind: 'rig', nodeId: node.id, name: project.name, direction: project.direction, aspect: project.aspect,
      shot: { title: node.title, prompt: node.text ?? '', notes: String(node.operations?.find((op) => op.kind === 'direction')?.values.note ?? ''), inputs, engine: node.engine ?? '' },
      ...(beat ? { beat, framePrompt: project.production?.boards?.frames[beat.id]?.prompt ?? '' } : {}),
      cast: (project.production?.cast?.entries ?? []).map((e) => ({ name: e.name, kind: e.kind, description: e.description })), availableAssets: assets });
    boardChunks = [{ index: 0, start: 0, end: canonical.length, segments: [{ id: node.id, heading: node.title.slice(0, 100), start: 0, end: 1 }, ...assets.map((a, i) => ({ id: a.id, heading: a.name.slice(0, 100), start: i + 1, end: i + 2 }))] }];
  } else if (input.kind === 'condense') {
    const node = project.nodes.find((value) => value.id === input.nodeId);
    if (!node) throw new DevelopmentError('Choose a shot in the Rig.', 404);
    const full = shotRenderPrompt(node, project).trim();
    if (full.length <= ENGINE_PROMPT_LIMIT) throw new DevelopmentError('This shot\'s prompt already fits the engine; nothing to condense.');
    canonical = JSON.stringify({ kind: 'condense', nodeId: node.id, key: textKey(full), prompt: full });
    boardChunks = [{ index: 0, start: 0, end: canonical.length, segments: [{ id: node.id, heading: textKey(full), start: 0, end: 1 }] }];
  } else if (input.kind === 'cast') {
    const sheet = project.production?.beats;
    const script = (project.script ?? '').slice(0, 40_000);
    if (!sheet?.scenes.length && !script.trim()) throw new DevelopmentError('Write the script or break it into beats first.');
    canonical = JSON.stringify({ kind: 'cast', name: project.name, brief: project.brief, direction: project.direction, aspect: project.aspect,
      ...(sheet?.scenes.length ? { beatSheet: compactBeatSheet(sheet) } : { script }), existingCast: (project.production?.cast?.entries ?? []).map((e) => e.name) });
    boardChunks = [{ index: 0, start: 0, end: canonical.length, segments: [] }];
  } else if (input.kind === 'environment') {
    const sheet = project.production?.beats;
    const script = (project.script ?? '').slice(0, 40_000);
    if (!sheet?.scenes.length && !script.trim() && !project.brief.trim()) throw new DevelopmentError('Write the brief or the script, or break it into beats, first.');
    const env = project.production?.environment;
    canonical = JSON.stringify({ kind: 'environment', name: project.name, brief: project.brief, direction: project.direction, aspect: project.aspect,
      ...(sheet?.scenes.length ? { beatSheet: compactBeatSheet(sheet) } : script.trim() ? { script } : {}),
      world: env?.world ?? '', existingPlaces: (env?.entries ?? []).map((e) => e.name) });
    boardChunks = [{ index: 0, start: 0, end: canonical.length, segments: [] }];
  } else canonical = input.kind === 'write' ? writerCanonical(project, base, input.fromJobId, beatSheet) : sourceCanonical(project, input.kind);
  const snapshot = JSON.parse(canonical) as Snapshot;
  if (input.kind === 'idea' && ![project.brief, project.direction].some(value => value.trim())) throw new DevelopmentError('Add a brief or a creative direction before developing ideas.');
  let chunks: DevelopmentChunk[];
  try { chunks = boardChunks ?? (input.kind === 'idea' || input.kind === 'write' ? [{ index: 0, start: 0, end: canonical.length, segments: [] }] : developmentChunks(project.script ?? '')); }
  catch (error) { throw new DevelopmentError((error as Error).message); }
  const models = await deps.models(), menu = developmentModels(models);
  const model = models.find(model => model.id === input.model && menu.some(entry => entry.id === model.id));
  if (!model) throw new DevelopmentError('Choose an available thinking model with confirmed pricing.', 422);
  if (images && !canSee(model)) throw new DevelopmentError(`${model.name} cannot see images. Choose an agent model that can read the drawing.`, 422);
  const answer = developmentAnswerTokens(input.kind);
  const reasoning = atomikReasoningRequest(model, input.effort, answer, answer);
  /* A critique is saved within 12,000 bytes, so it never needs a long answer's room. */
  const critiqueReasoning = atomikReasoningRequest(model, input.effort, 4000);
  const resultBytes = developmentResultBytes(input.kind);
  const estimates = chunks.flatMap(chunk => DEVELOPMENT_STAGES.map(stage => {
    const maxTokens = stage === 'critique' ? Math.min(reasoning.maxTokens, critiqueReasoning.maxTokens) : reasoning.maxTokens;
    const base = Buffer.byteLength(promptFor(snapshot, input, chunk) + developmentInstructions(input.kind, stage), 'utf8') + 2048;
    const prior = stage === 'draft' ? 0 : stage === 'critique' ? resultBytes : resultBytes + DEVELOPMENT_CRITIQUE_BYTES;
    const inputTokens = base + prior + images * ATOMIK_IMAGE_TOKENS;
    if (model.contextWindow && inputTokens + maxTokens > model.contextWindow) throw new DevelopmentError('This model has too little context for the complete source and review stages. Choose a larger-context model or shorten the project brief.', 422);
    const cost = textQuoteCostUsd(model, inputTokens, maxTokens, textVendor(model.id) === 'openai');
    if (cost == null || !Number.isFinite(cost) || cost < 0) throw new DevelopmentError('The selected model has no confirmed token price.', 503);
    return { chunk: chunk.index, stage, cost, maxTokens };
  }));
  const estimateUsd = estimates.reduce((sum, step) => sum + step.cost, 0);
  const limit = Math.min(1000, Math.max(1, Number(process.env.WORKBENCH_DEVELOPMENT_MAX_REQUEST_USD) || DEVELOPMENT_REQUEST_CEILING_USD));
  if (estimateUsd > limit) throw new DevelopmentError(`The full development workflow exceeds the per-request spending ceiling: at most $${estimateUsd.toFixed(2)} across ${estimates.length} agent steps with ${model.name}, against $${limit.toFixed(2)} per request. Choose a less expensive model or lower effort.`, 409);
  const sourceHash = developmentSourceHash(canonical);
  const estimateCredits = paidByPlatform(textVendor(input.model)) ? billCredits(estimateUsd, 'text') : 0;
  return { project, canonical, snapshot, sourceHash, chunks, estimates, estimateUsd, estimateCredits, model };
}
export async function quoteDevelopmentJob(input: DevelopmentRequest, owner: string, overrides?: Partial<DevelopmentDependencies>): Promise<DevelopmentQuote> {
  const compiled = await compile(input, owner, dependencies(overrides));
  return { quoteOnly: true, model: input.model, effort: input.effort, kind: input.kind,
    sourceHash: compiled.sourceHash, estimateCredits: compiled.estimateCredits, estimateUsd: compiled.estimateUsd,
    chunks: compiled.chunks.length, calls: compiled.estimates.length,
    sourceCharacters: input.kind === 'screenplay' || input.kind === 'adfilm' ? compiled.project.script?.length ?? 0 : compiled.canonical.length };
}
type Row = Record<string, unknown>;
/** `withResult` false leaves an older writer draft's full script off a list poll; it is read by its id when opened. */
async function publicJob(row: Row, offset = 0, withResult = true): Promise<DevelopmentJob> {
  const input = JSON.parse(String(row.request_body)) as DevelopmentRequest;
  const progress = await db().execute({ sql: 'SELECT status,stage,chunk_index FROM workbench_development_steps WHERE job_id=? ORDER BY step_index', args: [String(row.id)] });
  const completedSteps = progress.rows.filter(step => step.status === 'succeeded').length;
  const completedChunks = progress.rows.filter(step => step.stage === 'refine' && step.status === 'succeeded').length;
  const next = progress.rows.find(step => step.status !== 'succeeded');
  const totalChunks = JSON.parse(String(row.chunks)).length;
  const result = row.status === 'succeeded' && withResult ? (await db().execute({ sql: "SELECT result FROM workbench_development_steps WHERE job_id=? AND chunk_index=? AND stage='refine' AND status='succeeded'", args: [String(row.id), offset] })).rows[0] : null;
  return { id: String(row.id), requestId: input.requestId, projectId: input.projectId,
    productionProjectId: String(row.production_project_id), kind: input.kind, model: input.model, effort: input.effort,
    ...(input.kind === 'write' ? { source: input.fromBeats ? 'beats' as const : input.fromJobId ? 'draft' as const : 'prompt' as const } : {}),
    ...(input.kind === 'sketch' ? { shotId: input.shotId, sketchAssetId: input.sketchAssetId } : {}),
    ...(input.kind === 'frames' && input.shotId ? { shotId: input.shotId } : {}),
    ...(input.kind === 'condense' || input.kind === 'rig' ? { nodeId: input.nodeId } : {}),
    instructions: input.instructions ?? '', sourceHash: String(row.source_hash), status: String(row.status) as DevelopmentJob['status'],
    completedChunks, totalChunks, completedSteps, totalSteps: progress.rows.length,
    currentStage: next ? String(next.stage) as DevelopmentStage : 'complete',
    estimateCredits: Number(row.estimate_credits), estimateUsd: Number(row.estimate_usd),
    credits: row.credits == null ? null : Number(row.credits), costUsd: row.cost_usd == null ? null : Number(row.cost_usd),
    result: result?.result ? JSON.parse(String(result.result)) : null,
    ...(result?.result ? { resultPage: { offset, totalChunks, hasMore: offset + 1 < totalChunks } } : {}), error: row.error ? String(row.error) : null,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
function eventFor(row: Row, status: MeterEvent['status'], cost?: number): MeterEvent {
  const model = (JSON.parse(String(row.request_body)) as DevelopmentRequest).model;
  return { id: String(row.id), kind: 'text', engine: textVendor(model) === 'openai' ? 'openai' : 'vercel', model,
    projectId: String(row.production_project_id), createdBy: String(row.owner), status, engineCostUsd: cost };
}
const preparationTails = new Map<string, Promise<void>>();
export async function prepareDevelopmentJob(input: DevelopmentRequest, owner: string, token?: TenantToken, overrides?: Partial<DevelopmentDependencies>) {
  const ws = requireTenant(), key = ws.id + ':' + ws.dbUrl;
  const previous = preparationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>(resolve => { release = resolve; }); preparationTails.set(key, tail);
  await previous;
  try { return await prepareUnlocked(input, owner, token, overrides); }
  finally { release(); if (preparationTails.get(key) === tail) preparationTails.delete(key); }
}
async function prepareUnlocked(input: DevelopmentRequest, owner: string, token?: TenantToken, overrides?: Partial<DevelopmentDependencies>) {
  await developmentReady();
  const deps = dependencies(overrides), fingerprint = developmentSourceHash(JSON.stringify(input));
  const found = (await db().execute({ sql: 'SELECT * FROM workbench_development_jobs WHERE owner=? AND request_id=?', args: [owner, input.requestId] })).rows[0];
  if (found) {
    if (found.fingerprint !== fingerprint) throw new DevelopmentError('This request ID belongs to a different workflow. Start a new request.', 409);
    return { job: await publicJob(found), scheduled: false };
  }
  if (!input.sourceHash || input.maxCredits == null || (!paidByPlatform(textVendor(input.model)) && input.maxUsd == null)) throw new DevelopmentError('Review the complete workflow quote before starting.');
  const compiled = await compile(input, owner, deps);
  await deps.auth(input.model);
  if (input.sourceHash !== compiled.sourceHash) throw new DevelopmentError('The source changed after the quote. Save the current project and review a new quote.', 409);
  if (compiled.estimateCredits > input.maxCredits || (input.maxUsd != null && compiled.estimateUsd > input.maxUsd + 1e-9)) throw new DevelopmentError('The estimate changed. Review a new quote before starting.', 409);
  const allowance = await deps.allowance(textVendor(input.model), compiled.estimateUsd, input.model);
  if (!allowance.ok) throw new DevelopmentError(allowance.error, allowance.status);
  const id = 'wb_development_' + randomUUID(), ts = now();
  // Claim and immutable source snapshot commit before reserving or calling a provider.
  const inserted = await db().execute({ sql: `INSERT OR IGNORE INTO workbench_development_jobs(id,owner,project_id,production_project_id,request_id,fingerprint,request_body,source_hash,snapshot,model_body,chunks,status,estimate_usd,estimate_credits,funded_by_platform,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,?)`,
    args: [id, owner, input.projectId, compiled.project.productionProjectId!, input.requestId, fingerprint, JSON.stringify(input), compiled.sourceHash,
      compiled.canonical, JSON.stringify(compiled.model), JSON.stringify(compiled.chunks), compiled.estimateUsd, compiled.estimateCredits, paidByPlatform(textVendor(input.model)) ? 1 : 0, ts, ts] });
  if (!inserted.rowsAffected) {
    const duplicate = (await db().execute({ sql: 'SELECT * FROM workbench_development_jobs WHERE owner=? AND request_id=?', args: [owner, input.requestId] })).rows[0];
    if (!duplicate || duplicate.fingerprint !== fingerprint) throw new DevelopmentError('This request identity conflicts with another workflow.', 409);
    return { job: await publicJob(duplicate), scheduled: false };
  }
  const row = (await db().execute({ sql: 'SELECT * FROM workbench_development_jobs WHERE id=?', args: [id] })).rows[0];
  try {
    await db().batch(compiled.estimates.map((step, index) => ({ sql: `INSERT INTO workbench_development_steps(job_id,step_index,chunk_index,stage,status,estimate_usd,max_tokens,updated_at) VALUES(?,?,?,?,'queued',?,?,?)`, args: [id, index, step.chunk, step.stage, step.cost, step.maxTokens, ts] })), 'write');
    await deps.reserve(eventFor(row, 'running', compiled.estimateUsd), { token, projectId: compiled.project.productionProjectId });
    // Admission flag prevents a concurrent recovery POST from outrunning reservation.
    const admitted = await db().execute({ sql: "UPDATE workbench_development_jobs SET status='running',updated_at=? WHERE id=? AND status='queued'", args: [now(), id] });
    if (!admitted.rowsAffected) throw new Error('Admission was interrupted before a provider call. The reservation will be released.');
    row.status = 'running';
  } catch (error) {
    // A reservation can commit before its acknowledgement is lost. Never use
    // an in-memory boolean to decide whether this durable outbox needs settling.
    await db().execute({ sql: "UPDATE workbench_development_jobs SET status='failed',error=?,cost_usd=0,credits=0,settled=0,updated_at=? WHERE id=?", args: [(error as Error).message.slice(0,1000), now(), id] });
    await settleDevelopment({ ...row, status: 'failed', cost_usd: 0, settled: 0 }, deps);
    throw error;
  }
  return { job: await publicJob(row), scheduled: true };
}

/** SDK native provider settings preserve the catalogue's effort contract. */
export function developmentProviderOptions(model: CatalogModel, effort: string): Record<string, JSONObject> {
  const configured = atomikReasoningRequest(model, effort, 4000);
  const existing = configured.providerOptions as Record<string, JSONObject>;
  if (effort === 'auto') return existing;
  if (model.id.startsWith('openai/')) return { ...existing, openai: { ...existing.openai, reasoningEffort: effort } };
  if (effort.startsWith('budget:')) return { ...existing, anthropic: { thinking: { type: 'enabled', budgetTokens: Number(effort.slice(7)) } } };
  if (effort === 'none') return { ...existing, anthropic: { thinking: { type: 'disabled' } } };
  if (/^anthropic\/claude-(?:sonnet|opus|haiku)-(?:4|4\.5)$/.test(model.id)) return { ...existing, anthropic: { ...existing.anthropic, effort } };
  return { ...existing, anthropic: { ...existing.anthropic, thinking: { type: 'adaptive' }, effort } };
}
async function callDevelopmentAgent(input: DevelopmentCall): Promise<DevelopmentReply> {
  if (engineMock()) return mockDevelopmentReply(input);
  let auth: DevelopmentAuth;
  try { auth = await developmentAuth(input.model.id); }
  catch (error) { throw Object.assign(error as Error, { providerSubmitted: false }); }
  return executeDevelopmentAgent(input, auth, recoveryFetch);
}
/** The transport is injectable so the installed SDK protocol is exercised without spending. */
export async function executeDevelopmentAgent(input: DevelopmentCall, auth: DevelopmentAuth, fetcher: typeof fetch): Promise<DevelopmentReply> {
  let providerSubmitted = false;
  const trackedFetch: typeof fetch = (url, init) => {
    if ((init?.method ?? (url instanceof Request ? url.method : 'GET')).toUpperCase() === 'POST') providerSubmitted = true;
    return fetcher(url, init);
  };
  try {
  const model = languageModel(input.model.id, { auth: { Authorization: `Bearer ${auth.token}`, 'ai-gateway-auth-method': auth.method, ...(auth.vendor ? { [TEXT_PROVIDER_HEADER]: auth.vendor } : {}) }, fetch: trackedFetch });
  // Every phase is its own bounded agent and persisted worker step. Critique and
  // refinement consume the saved prior result, so no multi-call stream is lost.
  const agent = new ToolLoopAgent({ model, instructions: input.instructions,
    // The Anthropic SDK adds budgetTokens to maxOutputTokens. Our quote
    // already includes thinking, so subtract it here to keep the paid ceiling.
    maxOutputTokens: input.model.id.startsWith('anthropic/') && input.effort.startsWith('budget:') ? input.maxTokens - Number(input.effort.slice(7)) : input.maxTokens,
    maxRetries: 0, stopWhen: stepCountIs(1),
    providerOptions: developmentProviderOptions(input.model, input.effort) });
    const result = input.images?.length
      ? await agent.generate({ messages: [{ role: 'user', content: [{ type: 'text', text: input.prompt }, ...input.images.map((image) => ({ type: 'image' as const, image }))] }], abortSignal: AbortSignal.timeout(240_000) })
      : await agent.generate({ prompt: input.prompt, abortSignal: AbortSignal.timeout(240_000) });
    return { text: result.text, inputTokens: result.totalUsage.inputTokens, outputTokens: result.totalUsage.outputTokens, finishReason: result.finishReason,
      ...(textVendor(input.model.id) === 'openai' ? { directUsage: result.steps.length === 1 ? sdkTextUsage(result.steps[0].usage, true) : null } : {}) };
  } catch (error) { throw Object.assign(error as Error, { providerSubmitted }); }
}
/** The mock writer: a short, well-formed script that says which draft it is, so a redraft visibly differs. */
function mockWriterReply(input: DevelopmentCall): DevelopmentReply {
  const request = JSON.parse(input.prompt) as { directorRequest?: string; project?: { name?: string; brief?: string }; currentDraft?: string; beatSheet?: { heading: string; beats: string[] }[] };
  const redraft = Boolean(request.currentDraft);
  const note = request.directorRequest?.trim();
  const screenplay = [
    'EXT. FROZEN HARBOUR - DUSK', '',
    'Ice groans under a violet sky. A red FOX picks its way across the frozen harbour, breath smoking.', '',
    'INT. HARBOUR MASTER\'S HUT - CONTINUOUS', '',
    'MARA (60s), wrapped in wool, watches through a frosted window.', '',
    'MARA', '(to herself)', redraft ? 'You came back.' : 'Not tonight, little one.', '',
    ...(redraft && note ? ['EXT. FROZEN HARBOUR - NIGHT', '', `The fox stops at the hut's lamp. ${note.slice(0, 200)}`, ''] : []),
    ...(request.beatSheet ? request.beatSheet.flatMap((scene) => [scene.heading.toUpperCase(), '', ...scene.beats.map((beat) => beat), '']) : []),
    'FADE OUT.',
  ].join('\n');
  return { text: JSON.stringify({ title: request.project?.name || 'Untitled', logline: `A fox crosses a frozen harbour as an old harbour master keeps watch${redraft ? ' — redrafted from the director\'s notes' : ''}.`,
    screenplay, notes: [request.beatSheet ? `Mock redraft: plays the beat sheet's ${request.beatSheet.length} scenes.` : redraft ? 'Mock redraft: applied the director\'s notes.' : 'Mock draft: built from the prompt.'], critique: ['Mock review only; no provider was called.'], assumptions: ['The fox is a real animal, not a costume.'] }), inputTokens: 300, outputTokens: 400, costUsd: 0 };
}
/** The mock storyboard artist: a prompt per shot from its own description; a sketch reading that says a drawing was seen. */
function mockBoardReply(input: DevelopmentCall): DevelopmentReply {
  const request = JSON.parse(input.prompt) as { shots?: { id: string; number: string; description: string }[]; shot?: { id: string; number: string; description: string } };
  const text = input.kind === 'frames'
    ? JSON.stringify({ frames: (request.shots ?? []).map((shot) => ({ shotId: shot.id, prompt: `Frame ${shot.number}: ${shot.description || 'the scene'} — mock storyboard prompt.` })), critique: ['Mock review only; no provider was called.'], assumptions: [] })
    : JSON.stringify({ reading: `Mock reading of the drawing (${input.images?.length ?? 0} image seen): two figures, camera low on the left, looking right.`, prompt: `Shot ${request.shot?.number}: ${request.shot?.description || 'the scene'}, blocked as drawn — mock sketch prompt.`, critique: ['Mock review only; no provider was called.'], assumptions: [] });
  return { text, inputTokens: 300, outputTokens: 300, costUsd: 0 };
}
/** The mock casting director: one character and one prop, so a build can follow (places are built in Environment). */
function mockCastReply(input: DevelopmentCall): DevelopmentReply {
  const request = JSON.parse(input.prompt) as { existingCast?: string[] };
  return { text: JSON.stringify({ entries: [
    { name: 'Mara', kind: 'character', category: 'character', model: 'soul_cinematic', description: 'The harbour master; appears in every scene.', prompt: 'Mara, a woman in her sixties, weathered face, grey braid, heavy wool coat — mock cast prompt.' },
    { name: 'Mooring rope', kind: 'element', category: 'prop', model: 'soul_cinematic', description: 'The rope the fox steps over.', prompt: 'A frayed mooring rope, iced over, a clean plate — mock cast prompt.' },
  ].filter((e) => !(request.existingCast ?? []).includes(e.name)), critique: ['Mock review only; no provider was called.'], assumptions: [] }), inputTokens: 300, outputTokens: 300, costUsd: 0 };
}
/** The mock production designer: the world's rules and one place from the beat sheet, so a plate can follow. */
function mockEnvironmentReply(input: DevelopmentCall): DevelopmentReply {
  const request = JSON.parse(input.prompt) as { beatSheet?: { heading: string }[]; existingPlaces?: string[] };
  const place = request.beatSheet?.[0]?.heading ?? 'The harbour';
  return { text: JSON.stringify({ world: 'Late winter on a northern coast: low sun, salt haze, weathered timber and iron — mock world.', entries: [
    { name: place, notes: 'The main location; every scene returns here.', prompt: `${place}, wide at dusk, frozen water, a lit hut far behind — mock plate prompt.` },
  ].filter((e) => !(request.existingPlaces ?? []).includes(e.name)), critique: ['Mock review only; no provider was called.'], assumptions: [] }), inputTokens: 300, outputTokens: 300, costUsd: 0 };
}
/** The mock condenser: the prompt's first 8,000 characters, marked, so a render can follow. */
function mockCondenseReply(input: DevelopmentCall): DevelopmentReply {
  const request = JSON.parse(input.prompt) as { shotPrompt?: string };
  return { text: JSON.stringify({ prompt: `Condensed (mock): ${(request.shotPrompt ?? '').slice(0, 8000)}`, critique: ['Mock review only; no provider was called.'], assumptions: [] }), inputTokens: 300, outputTokens: 300, costUsd: 0 };
}
function mockDevelopmentReply(input: DevelopmentCall): DevelopmentReply {
  if (input.kind === 'cast' && input.stage !== 'critique') return mockCastReply(input);
  if (input.kind === 'environment' && input.stage !== 'critique') return mockEnvironmentReply(input);
  if (input.kind === 'condense' && input.stage !== 'critique') return mockCondenseReply(input);
  if (input.kind === 'rig' && input.stage !== 'critique') {
    const request = JSON.parse(input.prompt) as { shot?: { title?: string; prompt?: string }; framePrompt?: string; availableAssets?: { id: string; category: string }[] };
    const picks = (request.availableAssets ?? []).filter((a) => a.category === 'Character' || a.category === 'Storyboard').slice(0, 3).map((a) => a.id);
    return { text: JSON.stringify({ prompt: `Wired (mock): ${request.framePrompt || request.shot?.prompt || request.shot?.title || 'the shot'}`, notes: 'Mock notes: hold the frame.', inputs: picks, firstFrame: null, critique: ['Mock review only; no provider was called.'], assumptions: [] }), inputTokens: 300, outputTokens: 300, costUsd: 0 };
  }
  if ((input.kind === 'frames' || input.kind === 'sketch') && input.stage !== 'critique') return mockBoardReply(input);
  if (input.kind === 'write' && input.stage !== 'critique') return mockWriterReply(input);
  if (input.stage === 'critique') return { text: JSON.stringify({ issues: ['Mock review: verify continuity and production constraints.'], revisions: ['Keep the source action and label proposed visual choices.'] }), inputTokens: 100, outputTokens: 60, costUsd: 0 };
  const result: DevelopmentResult = { summary: 'Mock development proposal for review.', recommendation: 'Review the route and production requirements with your team.',
    ideas: input.kind === 'idea' ? ['Intimate character study', 'Expansive visual journey'].map(title => ({ title, logline: title + ' built around the project brief.', treatment: 'A specific opening, escalation and resolution grounded in the brief.', visualDirection: 'Motivated natural light and deliberate camera movement.', critique: 'Confirm audience and duration.' })) : [],
    scenes: input.chunk.segments.map(segment => ({ id: segment.id, heading: segment.heading, sourceStart: segment.start, sourceEnd: segment.end,
      summary: 'Source action developed into a cinematic scene.', beats: ['Establish the setting and dramatic intention.', 'Advance the source action.'],
      shots: [{ description: 'Establish the action with a motivated composition.', framing: 'Wide', movement: 'Slow push', lighting: 'Motivated key', sound: 'Location ambience' }],
      characters: [], props: [], locations: [segment.heading], productionNotes: ['Confirm continuity before shooting.'] })), critique: ['Mock review only; no provider was called.'], assumptions: ['Visual choices are proposals.'] };
  return { text: JSON.stringify(result), inputTokens: 200, outputTokens: 250, costUsd: 0 };
}

/** Claim exactly one phase. A started phase is never repeated, even by queue retry. */
export async function runDevelopmentStep(id: string, owner: string, overrides?: Partial<DevelopmentDependencies>): Promise<{ done: boolean; waiting: boolean; settlementPending?: boolean }> {
  return withRecoveryJob(requireTenant().id, id, async () => {
    await developmentReady();
    const deps = dependencies(overrides);
    const row = (await db().execute({ sql: 'SELECT * FROM workbench_development_jobs WHERE id=? AND owner=?', args: [id, owner] })).rows[0];
    if (!row) return { done: true, waiting: false };
    if (['succeeded', 'failed', 'uncertain'].includes(String(row.status))) {
      const settled = await settleDevelopment(row, deps);
      return { done: settled, waiting: false, settlementPending: !settled };
    }
    if (row.status === 'queued') {
      const recovered = await recoverAdmission(row, deps);
      return { done: recovered, waiting: !recovered };
    }
    if (row.status !== 'running') return { done: true, waiting: false };
    const next = (await db().execute({ sql: "SELECT * FROM workbench_development_steps WHERE job_id=? AND status<>'succeeded' ORDER BY step_index LIMIT 1", args: [id] })).rows[0];
    if (!next) { const settled = await finishDevelopmentJob(row, deps); return { done: settled, waiting: false, settlementPending: !settled }; }
    if (next.status !== 'queued') return { done: false, waiting: true };
    const claimed = await db().execute({ sql: "UPDATE workbench_development_steps SET status='running',updated_at=? WHERE job_id=? AND step_index=? AND status='queued' AND EXISTS(SELECT 1 FROM workbench_development_jobs WHERE id=? AND status='running')", args: [now(), id, Number(next.step_index), id] });
    if (!claimed.rowsAffected) return { done: false, waiting: true };
    await db().execute({ sql: 'UPDATE workbench_development_jobs SET updated_at=? WHERE id=?', args: [now(), id] });
    const input = JSON.parse(String(row.request_body)) as DevelopmentRequest;
    const model = JSON.parse(String(row.model_body)) as CatalogModel;
    const chunks = JSON.parse(String(row.chunks)) as DevelopmentChunk[];
    const chunk = chunks[Number(next.chunk_index)], stage = String(next.stage) as DevelopmentStage;
    const prior = (await db().execute({ sql: "SELECT stage,result FROM workbench_development_steps WHERE job_id=? AND chunk_index=? AND status='succeeded'", args: [id, chunk.index] })).rows;
    const draft = prior.find(step => step.stage === 'draft'), critique = prior.find(step => step.stage === 'critique');
    let submitted = false, returned = false, cost = Number(next.estimate_usd), reply: DevelopmentReply | undefined;
    try {
      await deps.funding(id, input.model);
      await deps.auth(input.model);
      const snapshot = JSON.parse(String(row.snapshot)) as Snapshot;
      const prompt = promptFor(snapshot, input, chunk, draft ? JSON.parse(String(draft.result)) : undefined, critique ? JSON.parse(String(critique.result)) : undefined);
      submitted = true;
      reply = await deps.call({ model, effort: input.effort, stage, kind: input.kind, chunk,
        prompt, instructions: developmentInstructions(input.kind, stage), maxTokens: Number(next.max_tokens), images: developmentImages(snapshot) });
      returned = true;
      const direct = textVendor(input.model) === 'openai';
      const directCost = direct ? directTextCostUsd(model, reply.directUsage) : null;
      if ((!direct || engineMock()) && typeof reply.costUsd === 'number' && Number.isFinite(reply.costUsd) && reply.costUsd >= 0) cost = reply.costUsd;
      else if (direct && directCost != null) cost = directCost;
      else if (!direct && typeof reply.inputTokens === 'number' && Number.isFinite(reply.inputTokens) && reply.inputTokens >= 0 && typeof reply.outputTokens === 'number' && Number.isFinite(reply.outputTokens) && reply.outputTokens >= 0) cost = textCostUsd(model, reply.inputTokens, reply.outputTokens) ?? cost;
      // Preserve the paid answer before validating its structure; invalid answers
      // remain addressable and cannot be silently purchased again as a repair.
      await db().execute({ sql: 'UPDATE workbench_development_steps SET response=?,usage=?,cost_usd=?,updated_at=? WHERE job_id=? AND step_index=?', args: [reply.text, JSON.stringify({ inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, ...(direct ? { directUsage: reply.directUsage } : {}) }), cost, now(), id, Number(next.step_index)] });
      if (direct && !engineMock() && (directCost == null || directCost > Number(next.estimate_usd) + 0.00000001)) {
        returned = false; cost = Number(next.estimate_usd);
        throw new Error('Direct provider usage is missing, invalid, or outside the approved price snapshot; this step needs billing review.');
      }
      if (reply.finishReason === 'length') throw new Error('The agent ran out of room before it finished its answer, so nothing was kept from this phase.');
      const value: unknown = parseAgentJson(reply.text);
      const result = stage === 'critique' ? developmentCritiqueSchema.parse(value) : validateDevelopmentResult(value, input.kind, chunk);
      if (stage === 'critique' && Buffer.byteLength(JSON.stringify(result), 'utf8') > DEVELOPMENT_CRITIQUE_BYTES) throw new Error('The critique exceeded its saved review budget.');
      const finished = await db().execute({ sql: "UPDATE workbench_development_steps SET status='succeeded',result=?,updated_at=? WHERE job_id=? AND step_index=? AND status='running'", args: [JSON.stringify(result), now(), id, Number(next.step_index)] });
      if (!finished.rowsAffected) return { done: true, waiting: false };
      await db().execute({ sql: 'UPDATE workbench_development_jobs SET updated_at=? WHERE id=?', args: [now(), id] });
      const more = (await db().execute({ sql: "SELECT 1 FROM workbench_development_steps WHERE job_id=? AND status<>'succeeded' LIMIT 1", args: [id] })).rows.length;
      if (!more) { const settled = await finishDevelopmentJob(row, deps); return { done: settled, waiting: false, settlementPending: !settled }; }
      return { done: !more, waiting: false };
    } catch (error) {
      const status = Number((error as { statusCode?: number }).statusCode);
      const rejection = status >= 400 && status < 500 && status !== 408;
      const notSubmitted = (error as { providerSubmitted?: boolean }).providerSubmitted === false;
      const uncertain = submitted && !returned && !rejection && !notSubmitted;
      if (!submitted || rejection || notSubmitted) cost = 0;
      const message = uncertain ? 'This provider attempt could not be confirmed. It will never be submitted again automatically. The approved estimate remains reserved for review.' :
        'This development phase could not complete: ' + ((error as Error).message || 'Invalid response').slice(0, 750) + ' The paid attempt is saved; no automatic resubmission will occur.';
      const stopped = await db().execute({ sql: "UPDATE workbench_development_steps SET status=?,error=?,cost_usd=?,updated_at=? WHERE job_id=? AND step_index=? AND status='running'", args: [uncertain ? 'uncertain' : 'failed', message, uncertain ? null : cost, now(), id, Number(next.step_index)] });
      if (!stopped.rowsAffected) return { done: false, waiting: true };
      const sum = (await db().execute({ sql: 'SELECT COALESCE(SUM(cost_usd),0) AS cost FROM workbench_development_steps WHERE job_id=?', args: [id] })).rows[0];
      const total = uncertain ? Number(row.estimate_usd) : Number(sum.cost);
      const stoppedJob = await db().execute({ sql: "UPDATE workbench_development_jobs SET status=?,error=?,cost_usd=?,credits=?,updated_at=? WHERE id=? AND status='running'", args: [uncertain ? 'uncertain' : 'failed', message, uncertain ? null : total, uncertain ? null : Number(row.funded_by_platform) ? billCredits(total, 'text') : 0, now(), id] });
      if (!stoppedJob.rowsAffected) return { done: false, waiting: true };
      const settled = await settleDevelopment({ ...row, status: uncertain ? 'uncertain' : 'failed', cost_usd: uncertain ? null : total }, deps);
      return { done: settled, waiting: false, settlementPending: !settled };
    }
  });
}
async function finishDevelopmentJob(row: Row, deps: DevelopmentDependencies) {
  const steps = (await db().execute({ sql: 'SELECT stage,status,cost_usd FROM workbench_development_steps WHERE job_id=? ORDER BY step_index', args: [String(row.id)] })).rows;
  if (!steps.length || steps.some(step => step.status !== 'succeeded')) throw new Error('The workflow has incomplete development phases.');
  const cost = steps.reduce((sum, step) => sum + Number(step.cost_usd ?? 0), 0);
  await db().execute({ sql: "UPDATE workbench_development_jobs SET status='succeeded',cost_usd=?,credits=?,updated_at=? WHERE id=? AND status='running'", args: [cost, Number(row.funded_by_platform) ? billCredits(cost, 'text') : 0, now(), String(row.id)] });
  return settleDevelopment({ ...row, status: 'succeeded', cost_usd: cost }, deps);
}

/** The terminal row is an outbox: failed ledger writes are retried without any provider work. */
async function settleDevelopment(row: Row, deps: DevelopmentDependencies): Promise<boolean> {
  if (Number(row.settled)) return true;
  try {
    if (!await deps.reservation(String(row.id))) {
      if (row.status !== 'failed' || Number(row.cost_usd ?? 0) !== 0) throw new Error('The completed attempt is missing its funding record.');
      await db().execute({ sql: 'UPDATE workbench_development_jobs SET settled=1 WHERE id=?', args: [String(row.id)] });
      return true;
    }
    await deps.meter(eventFor(row, row.status === 'succeeded' ? 'succeeded' : 'failed', row.status === 'uncertain' ? Number(row.estimate_usd) : Number(row.cost_usd ?? 0)), { critical: true });
    // A returned but structurally invalid answer is still a definitive paid
    // result. It must not keep recovery fenced as if the provider were unknown.
    if (row.status === 'failed' && Number(row.cost_usd ?? 0) > 0) await billingTransaction(tx => resolveRecoveryJobTx(tx, requireTenant().id, String(row.id)));
    await db().execute({ sql: 'UPDATE workbench_development_jobs SET settled=1 WHERE id=?', args: [String(row.id)] });
    return true;
  } catch { console.error('Development settlement is pending for a saved terminal job.'); return false; }
}

async function recoverAdmission(row: Row, deps: DevelopmentDependencies): Promise<boolean> {
  if (Number(row.updated_at) >= now() - 360_000) return false;
  const stopped = await db().execute({ sql: "UPDATE workbench_development_jobs SET status='failed',cost_usd=0,credits=0,error=?,updated_at=? WHERE id=? AND status='queued' AND updated_at=?", args: ['Admission was interrupted before any provider call. Any existing reservation is being released; start a new reviewed request.', now(), String(row.id), Number(row.updated_at)] });
  if (!stopped.rowsAffected) return false;
  if (await deps.reservation(String(row.id))) return settleDevelopment({ ...row, status: 'failed', cost_usd: 0 }, deps);
  await db().execute({ sql: 'UPDATE workbench_development_jobs SET settled=1 WHERE id=?', args: [String(row.id)] });
  return true;
}

export async function listDevelopmentJobs(owner: string, projectId: string, requestId?: string, overrides?: Partial<DevelopmentDependencies>, jobId?: string, offset = 0) {
  await getAtomikProject(owner, projectId); await developmentReady();
  const deps = dependencies(overrides);
  // Only a stale started provider phase is uncertain. Unstarted, fully reserved
  // phases remain safely resumable even if no browser or worker is running.
  const stale = (await db().execute({ sql: `SELECT j.*,s.step_index AS stale_step,s.updated_at AS stale_updated_at FROM workbench_development_jobs j JOIN workbench_development_steps s ON s.job_id=j.id WHERE j.owner=? AND j.project_id=? AND j.status='running' AND s.status='running' AND s.updated_at<?`, args: [owner, projectId, now() - 360_000] })).rows;
  for (const row of stale) {
    const fenced = await db().execute({ sql: "UPDATE workbench_development_steps SET status='uncertain',updated_at=? WHERE job_id=? AND step_index=? AND status='running' AND updated_at=?", args: [now(), String(row.id), Number(row.stale_step), Number(row.stale_updated_at)] });
    if (!fenced.rowsAffected) continue;
    const fencedJob = await db().execute({ sql: "UPDATE workbench_development_jobs SET status='uncertain',error=?,updated_at=? WHERE id=? AND status='running'", args: ['The provider phase was interrupted. Its approved estimate remains reserved; the attempt cannot be safely repeated.', now(), String(row.id)] });
    if (fencedJob.rowsAffected) await settleDevelopment({ ...row, status: 'uncertain' }, deps);
  }
  const admissions = (await db().execute({ sql: "SELECT * FROM workbench_development_jobs WHERE owner=? AND project_id=? AND status='queued' AND updated_at<?", args: [owner, projectId, now() - 360_000] })).rows;
  for (const row of admissions) await recoverAdmission(row, deps);
  const args = [owner, projectId, ...(requestId ? [requestId] : []), ...(jobId ? [jobId] : [])];
  // Polling does not need the complete screenplay or model snapshot. Keep
  // those large immutable columns off the database-to-function response.
  const rows = (await db().execute({ sql: 'SELECT id,owner,project_id,production_project_id,request_id,request_body,source_hash,chunks,status,estimate_usd,estimate_credits,cost_usd,credits,error,funded_by_platform,settled,created_at,updated_at FROM workbench_development_jobs WHERE owner=? AND project_id=?' + (requestId ? ' AND request_id=?' : '') + (jobId ? ' AND id=?' : '') + ' ORDER BY created_at DESC LIMIT 10', args })).rows;
  for (const row of rows) if (['succeeded', 'failed', 'uncertain'].includes(String(row.status))) await settleDevelopment(row, deps);
  if (jobId && rows.length && offset >= JSON.parse(String(rows[0].chunks)).length) throw new DevelopmentError('This result section does not exist.', 404);
  const newestDraft = rows.find(row => (JSON.parse(String(row.request_body)) as DevelopmentRequest).kind === 'write')?.id;
  const jobs = await Promise.all(rows.map(row => publicJob(row, offset, Boolean(jobId) || row.id === newestDraft || (JSON.parse(String(row.request_body)) as DevelopmentRequest).kind !== 'write')));
  // Present reserved jobs waiting between calls as resumable. Admission rows
  // retain queued but have no runnable provider phases until reservation commits.
  for (let index = 0; index < jobs.length; index++) if (jobs[index].status === 'running') {
    const active = (await db().execute({ sql: "SELECT 1 FROM workbench_development_steps WHERE job_id=? AND status='running' LIMIT 1", args: [jobs[index].id] })).rows.length;
    if (!active) jobs[index].status = 'queued';
  }
  return jobs;
}
export async function developmentState(owner: string, projectId: string, requestId?: string) {
  const jobs = await listDevelopmentJobs(owner, projectId, requestId);
  const configured = gatewayReachable() || !!vendorKey('openai');
  const models = configured ? developmentModels(await catalog()) : [];
  return { configured: configured && !!models.length, models, jobs };
}
