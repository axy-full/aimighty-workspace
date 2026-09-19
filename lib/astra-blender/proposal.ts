import { z } from 'zod';
import { astraSceneSchema, parseAstraScene, type AstraScene } from './scene';
import type { Asset } from '../workbench/studio';

export const astraRequestSchema = z.object({
  sceneDigest: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.enum(['scene', 'native']).optional(),
  nativeDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  referenceIds: z.array(z.string().min(1).max(120)).max(4).optional(),
}).strict().refine(value => value.mode === 'native' ? !!value.nativeDigest : !value.nativeDigest, 'Native requests must bind the saved 3D source.');
export type AstraRequest = z.infer<typeof astraRequestSchema>;
export const astraProposalSchema = z.object({ baseSceneDigest: z.string().regex(/^[a-f0-9]{64}$/), scene: astraSceneSchema }).strict();
export type AstraProposal = z.infer<typeof astraProposalSchema>;
export const astraAgentResultSchema = z.object({
  summary: z.string().min(1).max(4000),
  steps: z.array(z.string().min(1).max(1000)).min(1).max(8),
  sceneJson: z.string().min(1).max(180000),
}).strict();
export type AstraAgentResult = z.infer<typeof astraAgentResultSchema>;

/** Canonical key order comes from the schema, identical in the browser and server. */
export function serializeAstraScene(scene: AstraScene): string { return JSON.stringify(parseAstraScene(scene)); }
export async function astraSceneDigest(scene: AstraScene): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serializeAstraScene(scene)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function astraAssetKind(asset: Pick<Asset, 'kind' | 'mime'>): 'image' | 'model' | null {
  return asset.kind === 'image' ? 'image' : asset.kind === 'document' && asset.mime === 'model/gltf-binary' ? 'model' : null;
}
export function validateAstraBindings(scene: AstraScene, assets: Pick<Asset, 'id' | 'kind' | 'mime'>[]) {
  for (const object of scene.objects) {
    if (!object.assetId) continue;
    const asset = assets.find(item => item.id === object.assetId);
    if (!asset || astraAssetKind(asset) !== object.type) throw new Error(`The asset for ${object.name} is unavailable or has the wrong media type.`);
  }
}
export function validateAstraProposal(value: AstraAgentResult, source: AstraScene, assets: Pick<Asset, 'id' | 'kind' | 'mime'>[]): AstraScene {
  const scene = parseAstraScene(JSON.parse(value.sceneJson));
  validateAstraBindings(scene, assets);
  for (const object of source.objects.filter(item => item.locked)) {
    if (JSON.stringify(scene.objects.find(item => item.id === object.id)) !== JSON.stringify(object)) throw new Error(`Astra changed the locked object ${object.name}. Unlock it before requesting changes.`);
  }
  return scene;
}
