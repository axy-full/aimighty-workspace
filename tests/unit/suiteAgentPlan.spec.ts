import { expect, test } from '@playwright/test';
import { newProject, type Plan, type Project } from '../../lib/workbench/studio';
import { applySuiteAgentPlan } from '../../lib/workbench/suite-agent-plan';
import { projectSchema } from '../../lib/workbench/studio-schema';
import { generationReferenceIds } from '../../lib/workbench/node-graph';

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
  expect(saved.plans[0].applied).toBe(true);
  expect(applySuiteAgentPlan(saved, plan, createId)).toBe(saved);
});

test('cross-project, deleted references and capacity failures leave the entire original project untouched', () => {
  const { project, plan, createId } = fixture();
  const before = JSON.stringify(project);
  expect(() => applySuiteAgentPlan({ ...project, id: 'other' }, plan, createId)).toThrow('another project');
  expect(() => applySuiteAgentPlan({ ...project, assets: [] }, plan, createId)).toThrow('no longer available');
  const full = { ...project, nodes: Array.from({ length: 248 }, (_, index) => ({ id: `existing-${index}`, type: 'note' as const, title: 'Existing', x: 0, y: 0, width: 300, linked: [] })) };
  expect(() => applySuiteAgentPlan(full, plan, createId)).toThrow('250-node');
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
