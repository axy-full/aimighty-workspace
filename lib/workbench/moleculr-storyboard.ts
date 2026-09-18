import { EMPTY_MOLECULR, marketingReferenceIds, moleculrNode, moleculrPrompt, moleculrReferences, moleculrVideoPrompt, moleculrVideoReferences, type MoleculrGenerationOptions } from './moleculr';
import { referenceAdBinding } from './reference-ad';
import { generationReferenceIds } from './node-graph';
import { creativeTemplate } from './moleculr-creative';
import { bindMoleculrReferences } from './moleculr-graph';
import type { Project } from './studio';

/** Prepares editable, asset-bound shots. No provider request or credit spend. */
export function buildMoleculrStoryboard(project: Project, createId: () => string, now = new Date().toISOString()): Project {
  const brief = project.moleculr ?? EMPTY_MOLECULR;
  const template = creativeTemplate(brief);
  if (!template?.beats.length) throw new Error('Choose a video creative brief before building its storyboard.');
  if (brief.variants.length + template.beats.length > 100) throw new Error('This storyboard would exceed the 100-variant project limit.');
  if (brief.productAssetIds.some(id => !project.assets.some(asset => asset.id === id && asset.kind === 'image'))) throw new Error('A product reference is missing. Review the product selection first.');
  if (brief.castAssetIds[0] && !project.assets.some(asset => asset.id === brief.castAssetIds[0] && asset.kind === 'image')) throw new Error('The selected cast reference is missing. Review the cast selection first.');
  const refs = moleculrVideoReferences(project, brief, brief.castAssetIds[0]);
  const referenceVideo = referenceAdBinding(project, brief.referenceAd);
  let next: Project = { ...project, nodes: [...project.nodes], moleculr: { ...brief, variants: [...brief.variants] } };
  const used = new Set([...project.nodes.map(node => node.id), ...brief.variants.map(variant => variant.id)]);
  const uniqueId = () => { const value = createId(); if (!value || used.has(value)) throw new Error('Could not create a unique storyboard identity.'); used.add(value); return value; };
  const base = moleculrVideoPrompt(project, brief, brief.hooks.find(hook => hook.trim()) ?? 'Introduce the product clearly.', brief.castAssetIds[0]);
  for (const [index, beat] of template.beats.entries()) {
    const id = uniqueId();
    const shot = `SHOT ${index + 1} OF ${template.beats.length} — ${beat.title}. Target duration ${beat.seconds} seconds. ${beat.prompt}\nKeep product, cast, light direction and screen direction consistent with the other campaign shots.`;
    const prompt = `${base.slice(0, 12000 - shot.length - 2)}\n\n${shot}`;
    const node = moleculrNode(id, prompt, `${index + 1}. ${beat.title}`, next.nodes.length, 'video');
    const binding = bindMoleculrReferences(next, node, refs, uniqueId, referenceVideo?.assetId);
    next = { ...next, nodes: [...next.nodes, ...binding.sources, binding.node], moleculr: { ...next.moleculr!, variants: [...next.moleculr!.variants, { id, nodeId: id, hook: beat.title, kind: 'video', templateId: template.id, ...(brief.activeProductId && brief.productAssetIds.length ? { productId: brief.activeProductId } : {}), ...(brief.castAssetIds[0] ? { castAssetId: brief.castAssetIds[0] } : {}), ...(referenceVideo ? { referenceVideo } : {}), createdAt: now, generation: { ratio: brief.creative?.aspect ?? template.aspect, duration: beat.seconds } }] } };
  }
  return next;
}

/** A batch is an editable shot plan, never an implied authorization to spend. */
export function prepareMoleculrVariants(project: Project, kind: 'image' | 'video', createId: () => string, now = new Date().toISOString()): Project {
  const brief = project.moleculr ?? EMPTY_MOLECULR;
  const hooks = [...new Set(brief.hooks.map(hook => hook.trim()).filter(Boolean))];
  const cast: (string | undefined)[] = brief.castAssetIds.length ? [...new Set(brief.castAssetIds)] : [undefined];
  if (!hooks.length) throw new Error('Add at least one campaign hook before preparing variations.');
  if (hooks.length * cast.length > 24) throw new Error('Prepare up to 24 hook and cast combinations at once. Reduce the hooks or cast selection.');
  if ([...brief.productAssetIds, ...brief.castAssetIds].some(id => !project.assets.some(asset => asset.id === id && asset.kind === 'image'))) throw new Error('A product or cast reference is missing. Review the selected images first.');
  const template = creativeTemplate(brief);
  const referenceVideo = kind === 'video' ? referenceAdBinding(project, brief.referenceAd) : undefined;
  const generation: Omit<MoleculrGenerationOptions, 'referenceAssetIds'> = { ...(brief.creative ? { ratio: brief.creative.aspect, ...(kind === 'video' ? { duration: brief.creative.seconds } : {}) } : {}),
    ...(kind === 'image' ? { modelId: 'higgsfield/marketing-studio-image', marketing: { quality: brief.marketing?.enhancePrompt ? 'high' : brief.marketing?.quality ?? 'high', enhancePrompt: brief.marketing?.enhancePrompt ?? false, ...(brief.marketing?.enhancePrompt && brief.marketing.presetId ? { presetId: brief.marketing.presetId } : {}) } } : {}) };
  if (generation.marketing?.enhancePrompt && (!generation.marketing.presetId || !brief.productAssetIds[0])) throw new Error('Select an available image preset and product reference before preparing preset variations.');
  let next: Project = { ...project, nodes: [...project.nodes], moleculr: { ...brief, variants: [...brief.variants] } };
  const used = new Set([...project.nodes.map(node => node.id), ...brief.variants.map(variant => variant.id)]);
  const uniqueId = () => { const value = createId(); if (!value || used.has(value)) throw new Error('Could not create a unique variant identity.'); used.add(value); return value; };
  let additions = 0;
  for (const hook of hooks) for (const castId of cast) {
    const sourceIds = generation.marketing?.enhancePrompt ? marketingReferenceIds(project, brief, brief.productAssetIds[0], castId) : (kind === 'video' ? moleculrVideoReferences : moleculrReferences)(project, { ...brief, castAssetIds: castId ? [castId] : [] }, castId).map(asset => asset.id);
    const prompt = (kind === 'video' ? moleculrVideoPrompt : moleculrPrompt)(project, brief, hook, castId).slice(0, kind === 'image' ? 5000 : 12000);
    if (brief.variants.some(variant => variant.kind === kind && variant.hook === hook && variant.castAssetId === castId && variant.productId === brief.activeProductId && variant.templateId === template?.id && JSON.stringify(variant.referenceVideo) === JSON.stringify(referenceVideo) && JSON.stringify(variant.generation) === JSON.stringify(generation) && project.nodes.some(node => node.id === variant.nodeId && node.text === prompt && (!referenceVideo || generationReferenceIds(node, project).includes(referenceVideo.assetId))))) continue;
    if (next.moleculr!.variants.length >= 100) throw new Error('These variations would exceed the 100-variant project limit. No batch was added.');
    const id = uniqueId();
    const binding = bindMoleculrReferences(next, moleculrNode(id, prompt, `${brief.productName || project.name} · ${hook}`, next.nodes.length, kind), sourceIds.map(id => project.assets.find(asset => asset.id === id)!), uniqueId, referenceVideo?.assetId);
    next = { ...next, nodes: [...next.nodes, ...binding.sources, binding.node], moleculr: { ...next.moleculr!, variants: [...next.moleculr!.variants, { id, nodeId: id, hook, kind, ...(castId ? { castAssetId: castId } : {}), ...(brief.activeProductId ? { productId: brief.activeProductId } : {}), ...(template ? { templateId: template.id } : {}), ...(referenceVideo ? { referenceVideo } : {}), generation, createdAt: now }] } };
    additions++;
  }
  if (!additions) throw new Error('These variations are already prepared. Review the existing shots below.');
  return next;
}
