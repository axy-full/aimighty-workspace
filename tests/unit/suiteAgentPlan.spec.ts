import { PROJECT_LIMITS, limitText } from '../../lib/workbench/project-limits';
import { expect, test } from '@playwright/test';
import { newProject, type Plan, type Project } from '../../lib/workbench/studio';
import { applySuiteAgentPlan } from '../../lib/workbench/suite-agent-plan';
import { projectSchema } from '../../lib/workbench/studio-schema';
import { generationReferenceIds } from '../../lib/workbench/node-graph';
import { EMPTY_MOLECULR, variantAssets } from '../../lib/workbench/moleculr';

function fixture() {
  const project = newProject('Brand film');
  project.assets = [{ id: 'product', name: 'Hero product', kind: 'image', category: 'Product', url: '/api/uploads/original', uploadId: 'original', description: '', prompt: '', status: 'Draft', locked: false, version: 1, refs: [] }];
  const plan: Plan = { id: 'agent-plan', request: 'Develop a launch', model: 'anthropic/claude-sonnet-4.6', depth: 'Deep', intent: 'campaign', summary: 'A considered campaign.', steps: ['Build the hero frame.'], applied: false, refs: ['product'],
    suiteAgent: { suite: 'moleculr', projectId: project.id, hooks: ['A new perspective.'], assumptions: ['Product claims need verification.'], actions: [
      { kind: 'image', title: 'Hero frame', prompt: 'Soft motivated light, precise product proportions.', referenceIds: ['product'] },
      { kind: 'video', title: 'Hero movement', prompt: 'Slow dolly toward the hero product.', referenceIds: ['product'] },
      { kind: 'audio', title: 'Score', prompt: 'A restrained, atmospheric instrumental cue.', referenceIds: [] },
    ] } };
  project.plans = [plan];
  let id = 0;
  return { project, plan, createId: () => `agent-node-${++id}` };
}

test('reviewed agent actions persist editable media nodes, originals and campaign hooks without rendering', () => {
  const { project, plan, createId } = fixture();
  const before = JSON.stringify(project);
  const result = applySuiteAgentPlan(project, plan, createId);
  const saved = projectSchema.parse(JSON.parse(JSON.stringify(result))) as Project;
  expect(JSON.stringify(project)).toBe(before);
  expect(saved.nodes.filter(node => node.type === 'media')).toHaveLength(1);
  const actions = saved.nodes.filter(node => node.type === 'generate');
  expect(actions.map(node => node.mode)).toEqual(['Image', 'Video', 'Audio']);
  expect(actions.every(node => node.role === 'Marketing strategist')).toBe(true);
  expect(generationReferenceIds(actions[0], saved)).toEqual(['product']);
  expect(generationReferenceIds(actions[1], saved)).toEqual(['product']);
  expect(saved.assets[0].uploadId).toBe('original');
  expect(saved.moleculr?.hooks).toEqual(['A new perspective.']);
  expect(saved.moleculr?.variants.map(variant => ({ nodeId: variant.nodeId, kind: variant.kind, hook: variant.hook }))).toEqual([
    { nodeId: actions[0].id, kind: 'image', hook: 'Hero frame' }, { nodeId: actions[1].id, kind: 'video', hook: 'Hero movement' },
  ]);
  expect(saved.plans[0].applied).toBe(true);
  expect(applySuiteAgentPlan(saved, plan, createId)).toBe(saved);
});

test('cross-project, deleted references and capacity failures leave the entire original project untouched', () => {
  const { project, plan, createId } = fixture();
  const before = JSON.stringify(project);
  expect(() => applySuiteAgentPlan({ ...project, id: 'other' }, plan, createId)).toThrow('another project');
  expect(() => applySuiteAgentPlan({ ...project, assets: [] }, plan, createId)).toThrow('no longer available');
  const full = { ...project, nodes: Array.from({ length: PROJECT_LIMITS.nodes - 2 }, (_, index) => ({ id: `existing-${index}`, type: 'note' as const, title: 'Existing', x: 0, y: 0, width: 300, linked: [] })) };
  expect(() => applySuiteAgentPlan(full, plan, createId)).toThrow(`${limitText(PROJECT_LIMITS.nodes)}-node`);
  expect(JSON.stringify(project)).toBe(before);
  expect(full.nodes).toHaveLength(248);
});

test('invalid audio or video-to-still references are refused before any node is applied', () => {
  const { project, plan, createId } = fixture();
  const audio = structuredClone(plan);
  audio.suiteAgent!.actions[2].referenceIds = ['product'];
  expect(() => applySuiteAgentPlan(project, audio, createId)).toThrow('Audio generation');
  project.assets[0].kind = 'video';
  expect(() => applySuiteAgentPlan(project, plan, createId)).toThrow('still-image proposal');
});

test('campaign variants preserve node originals and only identify the actual selected active product and one cast', () => {
  const { project, plan, createId } = fixture();
  project.assets.push({ ...project.assets[0], id: 'cast', name: 'Selected presenter' });
  project.moleculr = { ...EMPTY_MOLECULR, activeProductId: 'product-profile', productName: 'Hero', productAssetIds: ['product'], castAssetIds: ['cast'],
    products: [{ id: 'product-profile', name: 'Hero', url: '', description: 'Reviewed details', brand: 'Brand', assetIds: ['product'] }] };
  plan.suiteAgent!.actions[0].referenceIds = ['product', 'cast', 'product'];
  const createdAt = '2026-09-17T00:00:00.000Z';
  const result = applySuiteAgentPlan(project, plan, createId, createdAt);
  const first = result.moleculr!.variants[0], second = result.moleculr!.variants[1];
  expect(first).toMatchObject({ id: first.nodeId, productId: 'product-profile', castAssetId: 'cast', kind: 'image', createdAt });
  expect(second).toMatchObject({ productId: 'product-profile', kind: 'video', createdAt });
  expect(second.castAssetId).toBeUndefined();
  expect(generationReferenceIds(result.nodes.find(node => node.id === first.nodeId)!, result)).toEqual(['product', 'cast']);
  const completed = { ...result, assets: [...result.assets, { ...project.assets[0], id: 'rendered', nodeId: first.nodeId }, { ...project.assets[0], id: 'unrelated-render', nodeId: 'unrelated' }] };
  expect(variantAssets(completed, result.moleculr!).map(asset => asset.id)).toEqual(['rendered']);
  expect(projectSchema.safeParse(result).success).toBe(true);
  expect(applySuiteAgentPlan(result, plan, createId, '2026-09-18T00:00:00.000Z')).toBe(result);
});

test('text-only variants are tracked while ambiguous product or cast roles stay unset', () => {
  const { project, plan, createId } = fixture();
  project.assets.push(...['other-product', 'cast-1', 'cast-2'].map(id => ({ ...project.assets[0], id })));
  project.moleculr = { ...EMPTY_MOLECULR, activeProductId: 'active', productAssetIds: ['product'], castAssetIds: ['cast-1', 'cast-2'], products: [
    { id: 'active', name: 'A', url: '', description: '', brand: '', assetIds: ['product'] },
    { id: 'other', name: 'B', url: '', description: '', brand: '', assetIds: ['other-product'] },
  ] };
  plan.suiteAgent!.actions[0].referenceIds = ['product', 'other-product', 'cast-1', 'cast-2'];
  plan.suiteAgent!.actions[1].referenceIds = [];
  plan.suiteAgent!.actions.push({ kind: 'note', title: 'Review', prompt: 'Review approved product facts.', referenceIds: [] });
  const result = applySuiteAgentPlan(project, plan, createId);
  expect(result.moleculr!.variants).toHaveLength(2);
  expect(result.moleculr!.variants.every(variant => !variant.productId && !variant.castAssetId && !variant.templateId)).toBe(true);
  expect(result.nodes.find(node => node.id === result.moleculr!.variants[1].nodeId)?.linked).toEqual([]);
});

test('shared-only or non-image originals cannot be labeled as campaign product or cast images', () => {
  const { project, plan, createId } = fixture();
  project.sharedAssets = [{ ...project.assets[0], id: 'shared-cast' }];
  project.assets.push({ ...project.assets[0], id: 'clip', kind: 'video' });
  project.moleculr = { ...EMPTY_MOLECULR, activeProductId: 'active', productAssetIds: ['clip'], castAssetIds: ['shared-cast', 'clip'],
    products: [{ id: 'active', name: 'Video', url: '', description: '', brand: '', assetIds: ['clip'] }] };
  plan.suiteAgent!.actions[1].referenceIds = ['clip', 'shared-cast'];
  const result = applySuiteAgentPlan(project, plan, createId);
  expect(result.moleculr!.variants[1].productId).toBeUndefined();
  expect(result.moleculr!.variants[1].castAssetId).toBeUndefined();
  expect(generationReferenceIds(result.nodes.find(node => node.id === result.moleculr!.variants[1].nodeId)!, result)).toEqual(['clip', 'shared-cast']);
  expect(result.assets.find(asset => asset.id === 'shared-cast')).toEqual(project.sharedAssets[0]);
  expect(result.assets.find(asset => asset.id === 'shared-cast')).not.toBe(project.sharedAssets[0]);
  expect(project.assets.some(asset => asset.id === 'shared-cast')).toBe(false);
});

test('referenced shared originals are bound once, with canonical draft records taking precedence', () => {
  const { project, plan, createId } = fixture();
  project.sharedAssets = [
    { ...project.assets[0], name: 'Stale shared copy', uploadId: 'stale-upload' },
    { ...project.assets[0], id: 'shared', uploadId: undefined, generationId: 'original-generation', url: '/api/media/original-generation' },
    { ...project.assets[0], id: 'not-selected' },
  ];
  plan.suiteAgent!.actions[0].referenceIds = ['product', 'shared', 'shared'];
  plan.suiteAgent!.actions[1].referenceIds = ['shared'];
  const result = applySuiteAgentPlan(project, plan, createId);
  expect(result.assets.map(asset => asset.id)).toEqual(['product', 'shared']);
  expect(result.assets[0].uploadId).toBe('original');
  expect(result.assets[1].generationId).toBe('original-generation');
  expect(result.nodes.filter(node => node.type === 'media' && node.assetId === 'shared')).toHaveLength(1);
  expect(generationReferenceIds(result.nodes.find(node => node.id === result.moleculr!.variants[0].nodeId)!, result)).toEqual(['product', 'shared']);
  expect(projectSchema.safeParse(result).success).toBe(true);
});

test('shared reference binding respects the asset limit before any IDs or changes are made', () => {
  const { project, plan } = fixture();
  project.sharedAssets = [{ ...project.assets[0], id: 'shared' }];
  project.assets.push(...Array.from({ length: PROJECT_LIMITS.assets - 1 }, (_, index) => ({ ...project.assets[0], id: `existing-${index}` })));
  plan.suiteAgent!.actions[0].referenceIds = ['shared'];
  let ids = 0;
  const before = JSON.stringify(project);
  expect(() => applySuiteAgentPlan(project, plan, () => `node-${++ids}`)).toThrow(`${limitText(PROJECT_LIMITS.assets)}-asset`);
  expect(ids).toBe(0);
  expect(JSON.stringify(project)).toBe(before);
  project.assets.pop();
  expect(applySuiteAgentPlan(project, plan, () => `node-${++ids}`).assets).toHaveLength(500);
});

test('the 100-variant limit is checked atomically before IDs or project changes are made', () => {
  const { project, plan } = fixture();
  project.moleculr = { ...EMPTY_MOLECULR, variants: Array.from({ length: 99 }, (_, i) => ({ id: `variant-${i}`, nodeId: `old-node-${i}`, hook: 'Existing' })) };
  const before = JSON.stringify(project);
  let ids = 0;
  expect(() => applySuiteAgentPlan(project, plan, () => `node-${++ids}`)).toThrow('100-variant');
  expect(ids).toBe(0);
  expect(JSON.stringify(project)).toBe(before);
  project.moleculr.variants.pop();
  const result = applySuiteAgentPlan(project, plan, () => `node-${++ids}`);
  expect(result.moleculr!.variants).toHaveLength(100);
  expect(project.moleculr.variants).toHaveLength(98);
});
