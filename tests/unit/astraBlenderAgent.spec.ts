import { test, expect } from '@playwright/test';
import { MockLanguageModelV4 } from 'ai/test';
import { APICallError, type LanguageModelV4GenerateResult, type LanguageModelV4Content } from '@ai-sdk/provider';
import { createAstraAgent, astraAgentMessages, astraAgentInputTokens, ASTRA_AGENT_INPUT_TOKENS, type AstraAgentEnvelope } from '../../lib/astra-blender/agent';
import { createAstraScene, ASTRA_BLENDER_MODEL } from '../../lib/astra-blender/scene';
import { astraSceneDigest, validateAstraProposal } from '../../lib/astra-blender/proposal';
import { validateAstraGlb } from '../../lib/astra-blender/glb';
import { atomikPendingInput, persistPendingAtomik } from '../../lib/workbench/atomik-pending-request';

const scene = createAstraScene('product');
const candidate = { summary: 'A product study.', steps: ['Prepare the scene.'], sceneJson: JSON.stringify(scene) };
function envelope(): AstraAgentEnvelope { return { model: ASTRA_BLENDER_MODEL, context: 'Create a product scene.', scene, baseSceneDigest: 'a'.repeat(64), maxTokens: 12000, inputTokenBudget: ASTRA_AGENT_INPUT_TOKENS, assetIds: [], providerOptions: { openai: { reasoningEffort: 'medium' } }, pricingModel: { id: ASTRA_BLENDER_MODEL, name: 'GPT-6 Astra', type: 'language', owner: 'openai', description: '', contextWindow: 1050000, maxTokens: 128000, pricing: { input: .00001, output: .00005 } } }; }
function response(content: LanguageModelV4Content[], tools = false): LanguageModelV4GenerateResult { return { content, finishReason: { unified: tools ? 'tool-calls' : 'stop', raw: undefined }, usage: { inputTokens: { total: 200, noCache: 200, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 100, text: 100, reasoning: undefined } }, warnings: [] }; }

test('the real SDK loop validates the candidate then disables tools for the final call', async () => {
  const model = new MockLanguageModelV4({ doGenerate: [response([{ type: 'tool-call', toolCallId: 'check', toolName: 'check_scene', input: JSON.stringify(candidate) }], true), response([{ type: 'text', text: JSON.stringify(candidate) }])] });
  const input = envelope(); const result = await createAstraAgent(input, model).generate({ messages: astraAgentMessages(input) });
  expect(result.output).toEqual(candidate);
  expect(model.doGenerateCalls).toHaveLength(2);
  expect(model.doGenerateCalls[1].toolChoice).toEqual({ type: 'none' });
  expect(model.doGenerateCalls[1].tools ?? []).toEqual([]);
  expect(model.doGenerateCalls[0].providerOptions).toMatchObject({ openai: { reasoningEffort: 'medium' } });
});
test('oversized context and retryable errors never cause unreviewed calls', async () => {
  const model = new MockLanguageModelV4({ doGenerate: async () => { throw new APICallError({ message: 'unconfirmed', url: 'https://mock.invalid', requestBodyValues: {}, statusCode: 503, isRetryable: true }); } });
  const input = envelope();
  await expect(createAstraAgent(input, model).generate({ messages: [{ role: 'user', content: 'x'.repeat(ASTRA_AGENT_INPUT_TOKENS) }] })).rejects.toThrow('context budget');
  expect(model.doGenerateCalls).toHaveLength(0);
  await expect(createAstraAgent(input, model).generate({ messages: astraAgentMessages(input) })).rejects.toThrow('unconfirmed');
  expect(model.doGenerateCalls).toHaveLength(1);
});
test('scene proposals preserve locked geometry and cannot invent asset references', async () => {
  const locked = structuredClone(scene); locked.objects[0].locked = true;
  expect(() => validateAstraProposal(candidate, locked, [])).toThrow('locked object');
  const imported = structuredClone(scene); imported.objects[0] = { ...imported.objects[0], type: 'model', assetId: 'nonexistent' };
  expect(() => validateAstraProposal({ ...candidate, sceneJson: JSON.stringify(imported) }, scene, [])).toThrow('unavailable');
  const reordered = { ...scene, name: scene.name };
  expect(await astraSceneDigest(reordered)).toBe(await astraSceneDigest(scene));
});
test('recovery preserves the scene digest and rejects a switched model or suite', () => {
  const values = new Map<string, string>(); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const body = { projectId: 'project', requestId: 'astra-request', request: 'A studio scene', model: ASTRA_BLENDER_MODEL, depth: 'Deep', effort: 'high', refs: [], maxCredits: 100, astraBlender: { sceneDigest: 'a'.repeat(64) } };
  const saved = persistPendingAtomik(storage, 'scope', 'project', JSON.stringify(body));
  expect(atomikPendingInput(saved)).toEqual(body);
  expect(() => atomikPendingInput({ ...saved, body: JSON.stringify({ ...body, model: 'auto' }) })).toThrow('cannot be verified');
  expect(() => atomikPendingInput({ ...saved, body: JSON.stringify({ ...body, suite: 'particl' }) })).toThrow('cannot be verified');
});
function glb(patch: Record<string, unknown> = {}) {
  const json = JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }], ...patch });
  const padded = json.padEnd(Math.ceil(json.length / 4) * 4, ' '); const data = Buffer.alloc(20 + padded.length + 12);
  data.writeUInt32LE(0x46546c67, 0); data.writeUInt32LE(2, 4); data.writeUInt32LE(data.length, 8); data.writeUInt32LE(padded.length, 12); data.writeUInt32LE(0x4e4f534a, 16); data.write(padded, 20); data.writeUInt32LE(4, 20 + padded.length); data.writeUInt32LE(0x004e4942, 24 + padded.length); return data;
}
test('GLB intake rejects external files, data URIs, oversized geometry and compressed decoders', () => {
  expect(validateAstraGlb(glb()).asset.version).toBe('2.0');
  for (const uri of ['https://secret.invalid', 'file:///etc/passwd', 'data:application/octet-stream;base64,AA==']) expect(() => validateAstraGlb(glb({ buffers: [{ byteLength: 4, uri }] }))).toThrow('Embed all buffers');
  expect(() => validateAstraGlb(glb({ accessors: [{ count: 999999999 }] }))).toThrow('oversized');
  expect(() => validateAstraGlb(glb({ extensionsUsed: ['KHR_draco_mesh_compression'] }))).toThrow('uncompressed');
});


test('native agent validates source bindings with real SDK tools and retains visual references across steps', async () => {
  const source = { schemaVersion: 1, name: 'Native', program: 'import bpy', assetIds: [] };
  const candidate = { summary: 'Editable rig.', steps: ['Create an armature.'], sourceJson: JSON.stringify(source) };
  const model = new MockLanguageModelV4({ doGenerate: [response([{ type: 'tool-call', toolCallId: 'native', toolName: 'check_program', input: JSON.stringify(candidate) }], true), response([{ type: 'text', text: JSON.stringify(candidate) }])] });
  const input = { ...envelope(), mode: 'native' as const, images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', label: 'Reviewed still' }] };
  const result = await createAstraAgent(input, model).generate({ messages: astraAgentMessages(input) });
  expect(result.output).toEqual(candidate);
  expect(model.doGenerateCalls).toHaveLength(2);
  expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain('executed');
  expect(model.doGenerateCalls[1].tools ?? []).toEqual([]);
  expect(astraAgentInputTokens(input, astraAgentMessages(input))).toBeGreaterThan(astraAgentInputTokens({ ...input, images: [] }, astraAgentMessages({ ...input, images: [] })) + 8000);
  expect(() => astraAgentInputTokens(input, [{ role: 'user', content: [{ type: 'image', image: 'data:image/png;base64,unapproved' }] }])).toThrow('Unreviewed image');
});
