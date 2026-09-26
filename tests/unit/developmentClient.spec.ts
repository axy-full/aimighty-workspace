import { test, expect } from '@playwright/test';
import { clearDevelopment, developmentSourceHash, readDevelopment, readKindDevelopment, recordDevelopment, withDevelopmentLock } from '../../lib/workbench/development-client';
import { PROJECT_LIMITS } from '../../lib/workbench/project-limits';
import { applyDevelopment } from '../../lib/workbench/development-apply';
import { newProject } from '../../lib/workbench/studio';
import { publishedContext } from '../../lib/workbench/published-context';
import { projectSchema, saveSchema } from '../../lib/workbench/studio-schema';
import type { DevelopmentJob } from '../../lib/workbench/development-types';

function storage() { const map = new Map<string, string>(); return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } }; }
const request = (id = 'request-first') => JSON.stringify({ projectId: 'project-one', requestId: id, kind: 'adfilm', model: 'anthropic/claude-test', effort: 'auto', sourceHash: 'a'.repeat(64), maxCredits: 9, maxUsd: .9 });
test('development recovery keeps exact quoted request, rejects races, and isolates workspace identity', async () => {
  const store = storage(), record = recordDevelopment(store, 'scope-a', 'project-one', request());
  expect(readDevelopment(store, 'scope-a', 'project-one')).toEqual(record);
  expect(readDevelopment(store, 'scope-b', 'project-one')).toBeNull();
  expect(() => recordDevelopment(store, 'scope-a', 'project-one', request('request-second'))).toThrow('earlier development');
  expect(clearDevelopment(store, record, 'another-request')).toBe(false);
  expect(readDevelopment(store, 'scope-a', 'project-one')).toEqual(record);
  expect(clearDevelopment(store, record, 'request-first')).toBe(true);
  expect(readDevelopment(store, 'scope-a', 'project-one')).toBeNull();
  const order: string[] = [];
  await Promise.all([withDevelopmentLock('same', 'one', async () => { order.push('first'); await Promise.resolve(); order.push('first done'); }), withDevelopmentLock('same', 'one', async () => { order.push('second'); })]);
  expect(order).toEqual(['first', 'first done', 'second']);
});
test('the breakdown panel recovers only its own kind; an agent run on the project neither blocks nor relabels it', () => {
  const store = storage();
  const body = (kind: string, id: string) => JSON.stringify({ projectId: 'project-one', requestId: id, kind, model: 'anthropic/claude-test', effort: 'auto', sourceHash: 'a'.repeat(64), maxCredits: 9, maxUsd: .9 });
  /* The Production agent's unconfirmed frames run sits in the project's shared slot. */
  const agent = recordDevelopment(store, 'scope-a', 'project-one', body('frames', 'request-agent'));
  expect(readKindDevelopment(store, 'scope-a', 'project-one', 'screenplay')).toBeNull();
  /* The panel records its own request beside it instead of being refused. */
  const panel = recordDevelopment(store, 'scope-a', 'project-one', body('screenplay', 'request-panel'), 'screenplay');
  expect(readKindDevelopment(store, 'scope-a', 'project-one', 'screenplay')).toEqual(panel);
  expect(readKindDevelopment(store, 'scope-a', 'project-one', 'adfilm')).toBeNull();
  expect(readDevelopment(store, 'scope-a', 'project-one')).toEqual(agent);
  expect(() => recordDevelopment(store, 'scope-a', 'project-one', body('screenplay', 'request-other'), 'screenplay')).toThrow('earlier development');
  expect(clearDevelopment(store, panel, 'request-panel')).toBe(true);
  expect(readKindDevelopment(store, 'scope-a', 'project-one', 'screenplay')).toBeNull();
  expect(readDevelopment(store, 'scope-a', 'project-one')).toEqual(agent);
  expect(clearDevelopment(store, agent, 'request-agent')).toBe(true);
  /* A breakdown left in the shared slot before slots were keyed is still the panel's to recover. */
  const legacy = recordDevelopment(store, 'scope-a', 'project-one', body('screenplay', 'request-legacy'));
  expect(readKindDevelopment(store, 'scope-a', 'project-one', 'screenplay')).toEqual(legacy);
  expect(clearDevelopment(store, legacy, 'request-legacy')).toBe(true);
  expect(readDevelopment(store, 'scope-a', 'project-one')).toBeNull();
  /* An unreadable shared record might be the panel's own: it still pauses new paid requests. */
  store.setItem('particl:development:v1:scope-a:project-one', '{malformed');
  expect(() => readKindDevelopment(store, 'scope-a', 'project-one', 'screenplay')).toThrow();
  store.removeItem('particl:development:v1:scope-a:project-one');
  /* A record moved to another slot's key is refused, not trusted. */
  store.setItem('particl:development:v1:scope-a:project-one:idea', JSON.stringify({ ...panel, slot: 'screenplay' }));
  expect(() => readDevelopment(store, 'scope-a', 'project-one', 'idea')).toThrow('does not match');
});
test('development source identity covers final script text and creative inputs but not canvas operations', async () => {
  const project = { ...newProject('Ad film'), scriptFormat: 'adfilm' as const, script: 'OPEN\n' + 'Full source. '.repeat(5000) + 'FINAL END FRAME' };
  const hash = await developmentSourceHash(project, 'adfilm');
  expect(await developmentSourceHash({ ...project, nodes: [{ id: 'note', title: 'Canvas note', type: 'note', x: 0, y: 0, width: 200, linked: [] }] }, 'adfilm')).toBe(hash);
  expect(await developmentSourceHash({ ...project, script: project.script + ' changed' }, 'adfilm')).not.toBe(hash);
  expect(await developmentSourceHash({ ...project, direction: 'New visual rules' }, 'adfilm')).not.toBe(hash);
  expect(await developmentSourceHash(project, 'screenplay')).not.toBe(hash);
});
test('reviewed scene application retains original source and provenance, refuses duplicate or oversized application atomically', () => {
  const project = { ...newProject('Script'), scriptFormat: 'adfilm' as const, script: 'OPEN\nThe product catches the sunrise.\nEND FRAME' };
  const job: DevelopmentJob = { id: 'dev-one', requestId: 'request-one', projectId: project.id, productionProjectId: null, kind: 'adfilm', model: 'anthropic/claude-test', effort: 'auto', instructions: '', sourceHash: 'a'.repeat(64), status: 'succeeded', completedChunks: 1, totalChunks: 1, currentStage: 'complete', completedSteps: 3, totalSteps: 3, estimateCredits: 2, credits: 1, error: null, createdAt: 1, updatedAt: 2, result: { summary: 'Summary', recommendation: 'Proposed', ideas: [], critique: [], assumptions: [], scenes: [{ id: 'scene-one', heading: 'Open', sourceStart: 0, sourceEnd: project.script.length, summary: 'Introduce product', beats: ['Light reveals the product.'], shots: [{ description: 'Product reveal', framing: 'Close', movement: 'Slow push', lighting: 'Sunrise', sound: 'Breath' }], characters: [], props: ['Product'], locations: ['Studio'], productionNotes: ['Keep pack artwork legible.'] }] } };
  const applied = applyDevelopment(project, job, { scenes: ['scene-one'] });
  expect(applied.nodes[0].text).toContain(project.script);
  expect(applied.nodes[0].text).toContain('Lighting: Sunrise');
  expect(applied.nodes[0].developmentSource).toEqual({ jobId: job.id, sourceHash: job.sourceHash, sceneId: 'scene-one', sourceStart: 0, sourceEnd: project.script.length });
  expect(projectSchema.parse(applied).scriptFormat).toBe('adfilm');
  expect(publishedContext(applied).scriptFormat).toBe('adfilm');
  expect(publishedContext(newProject('Older script')).scriptFormat).toBe('screenplay');
  expect(() => applyDevelopment(applied, job, { scenes: ['scene-one'] })).toThrow('already');
  expect(() => applyDevelopment(project, { ...job, projectId: 'another-project' }, { scenes: ['scene-one'] })).toThrow('this project');
  const tooLarge = structuredClone(job); tooLarge.result!.scenes[0].summary = 'x'.repeat(30000);
  expect(() => applyDevelopment(project, tooLarge, { scenes: ['scene-one'] })).toThrow('text limit');
  /* The project's node limit applies, not the old 250: a feature-sized canvas still takes the scene. */
  const rig = Array.from({ length: 300 }, (_, i) => ({ id: `rig-${i}`, title: `Rig ${i}`, type: 'note' as const, x: 0, y: 0, width: 200, linked: [] }));
  const big = applyDevelopment({ ...project, nodes: rig }, job, { scenes: ['scene-one'] });
  expect(big.nodes).toHaveLength(301);
  expect(projectSchema.safeParse(big).success).toBe(true);
  const full = Array.from({ length: PROJECT_LIMITS.nodes }, (_, i) => ({ ...rig[0], id: `full-${i}` }));
  expect(() => applyDevelopment({ ...project, nodes: full }, job, { scenes: ['scene-one'] })).toThrow('room for 0');
  /* A long breakdown below a tall canvas widens instead of running off the bottom edge. */
  const many = structuredClone(job);
  many.result!.scenes = Array.from({ length: 120 }, (_, i) => ({ ...job.result!.scenes[0], id: `scene-${i}` }));
  const low = [{ ...rig[0], y: 17000 }];
  const wide = applyDevelopment({ ...project, nodes: low }, many, { scenes: many.result!.scenes.map(scene => scene.id) });
  const placed = wide.nodes.slice(1);
  expect(placed).toHaveLength(120);
  expect(Math.min(...placed.map(node => node.y))).toBe(17290);
  expect(Math.max(...placed.map(node => node.y))).toBeLessThanOrEqual(20000);
  expect(new Set(placed.map(node => `${node.x},${node.y}`)).size).toBe(120);
  expect(projectSchema.safeParse(wide).success).toBe(true);
  /* Four columns, as before, whenever the batch fits. */
  expect(applyDevelopment(project, many, { scenes: ['scene-0', 'scene-4'] }).nodes.map(node => [node.x, node.y])).toEqual([[50, 1030], [400, 1030]]);
  expect(applyDevelopment(project, many, { scenes: many.result!.scenes.slice(0, 5).map(scene => scene.id) }).nodes.map(node => [node.x, node.y]).slice(3)).toEqual([[1100, 1030], [50, 1320]]);
  expect(() => applyDevelopment({ ...project, nodes: [{ ...rig[0], y: 19800 }] }, job, { scenes: ['scene-one'] })).toThrow('Rearrange the canvas');
  expect(project.nodes).toHaveLength(0);
  const source = { id: 'original-pdf', name: 'Original screenplay.pdf', kind: 'document' as const, category: 'Screenplay', url: '/api/uploads/original-pdf', uploadId: 'original-pdf', description: '', prompt: '', status: 'Draft' as const, locked: false, version: 1, refs: [] };
  const fromPdf = applyDevelopment({ ...project, assets: [source], scriptSource: { assetId: source.id, filename: source.name, sha256: 'b'.repeat(64), pages: [], importedAt: '2026-09-16', edited: false, acknowledgedEmptyPages: [] } }, job, { scenes: ['scene-one'] });
  const published = publishedContext({ ...fromPdf, scriptSource: undefined, sharedNodes: fromPdf.nodes });
  expect(published.assets.map(asset => asset.id)).toContain(source.id);
  expect(published.nodes[0].developmentSource?.sourceAssetId).toBe(source.id);
  expect(saveSchema.safeParse({ project: { ...fromPdf, scriptSource: undefined, assets: [] }, revision: 0 }).success).toBe(false);
});
test('idea application adds reviewed treatment without erasing the original brief or direction', () => {
  const project = { ...newProject('Idea'), brief: 'Original client brief', direction: 'Existing direction' };
  const job = { id: 'development-idea', projectId: project.id, kind: 'idea', status: 'succeeded', result: { ideas: [{ title: 'Quiet confidence', logline: 'A new perspective.', treatment: 'Hold the gaze.', visualDirection: 'Warm practical light.', critique: 'Keep the promise clear.' }] } } as DevelopmentJob;
  const next = applyDevelopment(project, job, { idea: 0 });
  expect(next.brief).toBe(project.brief);
  expect(next.direction).toContain('Existing direction');
  expect(next.direction).toContain('Warm practical light.');
  expect(() => applyDevelopment(next, job, { idea: 0 })).toThrow('already');
});
