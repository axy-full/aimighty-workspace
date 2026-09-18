import { z } from 'zod';
import type { SuiteId } from '../suites';
import type { Plan, Project, CanvasNode } from './studio';
import { EMPTY_MOLECULR } from './moleculr';

export const suiteAgentActionSchema = z.object({
  kind: z.enum(['image', 'video', 'audio', 'note']),
  title: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(3).max(4000),
  referenceIds: z.array(z.string().min(1).max(100)).max(6),
}).strict();
export const suiteAgentResultSchema = z.object({
  intent: z.enum(['campaign', 'script', 'shots', 'revision', 'continuity']),
  summary: z.string().trim().min(1).max(5000),
  steps: z.array(z.string().trim().min(1).max(3000)).min(1).max(8),
  actions: z.array(suiteAgentActionSchema).min(1).max(8),
  hooks: z.array(z.string().trim().min(1).max(300)).max(12),
  assumptions: z.array(z.string().trim().min(1).max(600)).max(8),
}).strict();
export const suiteAgentPlanSchema = suiteAgentResultSchema.omit({ intent: true, summary: true, steps: true }).extend({
  suite: z.enum(['particl', 'atomik', 'moleculr', 'subatomik']),
  projectId: z.string().min(1).max(100),
});
export type SuiteAgentResult = z.infer<typeof suiteAgentResultSchema>;
export type SuiteAgentPlan = z.infer<typeof suiteAgentPlanSchema>;

export const SUITE_AGENT_COPY: Record<SuiteId, { title: string; placeholder: string; mission: string }> = {
  particl: { title: 'Production agent', placeholder: 'Plan this scene, develop its visual language and prepare the shots…', mission: 'Develop cinematic production: story, shot coverage, continuity, cast, environments, lighting, camera and sound.' },
  atomik: { title: 'Production orchestrator', placeholder: 'Turn the brief into a staged production plan with review checkpoints…', mission: 'Break the production into concrete image, video and audio tasks, with dependencies, asset reuse and review checkpoints.' },
  moleculr: { title: 'Campaign agent', placeholder: 'Develop product angles, campaign hooks, cast and image or video variants…', mission: 'Develop a campaign with distinct hooks, product-accurate creative directions and executable image/video briefs. Use supplied product and cast references. Never invent endorsements, product claims or performance.' },
  subatomik: { title: 'Viral studio agent', placeholder: 'Develop a visual hook, plan a transformation and prepare variations for review…', mission: 'Develop original short-form creative hooks, motion-transfer and object-replacement directions from the supplied project references. Propose concrete editable production actions and review criteria. Do not invent trend research, virality scores, performance guarantees, provider presets or unsupported engine controls. Generation remains a separately quoted action.' },
};

/** Pure, atomic handoff. Planning never invokes a rendering provider. */
export function applySuiteAgentPlan(project: Project, plan: Plan, createId: () => string, createdAt = new Date().toISOString()): Project {
  if (plan.applied || project.plans.some(item => item.id === plan.id && item.applied)) return project;
  const proposal = suiteAgentPlanSchema.parse(plan.suiteAgent);
  if (proposal.projectId !== project.id) throw new Error('This proposal belongs to another project.');
  const assets = [...project.assets, ...(project.sharedAssets ?? [])];
  const brief = project.moleculr ?? EMPTY_MOLECULR;
  const variants = proposal.suite === 'moleculr' ? [...brief.variants] : [];
  const variantCount = proposal.actions.filter(action => action.kind === 'image' || action.kind === 'video').length;
  if (proposal.suite === 'moleculr' && variants.length + variantCount > 100) throw new Error('This plan would exceed the 100-variant campaign limit. Remove unused variants first.');
  const importedAssets: Project['assets'] = [];
  const localIds = new Set(project.assets.map(asset => asset.id));
  for (const action of proposal.actions) {
    if (action.kind === 'audio' && action.referenceIds.length) throw new Error('Audio generation cannot use visual references. Review this proposal.');
    for (const id of new Set(action.referenceIds)) {
      const asset = assets.find(item => item.id === id);
      if (!asset || !['image', 'video'].includes(asset.kind)) throw new Error('A proposed reference is no longer available in this project. Run a new plan with the current assets.');
      if (action.kind === 'image' && asset.kind !== 'image') throw new Error('A still-image proposal needs image references.');
      if (!localIds.has(id)) {
        // Graph rendering resolves draft assets. Bind this draft's selected
        // shared record without changing its original upload/generation identity.
        importedAssets.push(structuredClone(asset));
        localIds.add(id);
      }
    }
  }
  if (project.assets.length + importedAssets.length > 500) throw new Error('This plan would exceed the 500-asset library limit. Remove unused assets first.');
  // Campaign product/cast selections use canonical draft images only. Shared
  // references may still be linked to a node, but cannot invent product roles.
  const images = new Set(project.assets.filter(asset => asset.kind === 'image').map(asset => asset.id));
  const nodes: CanvasNode[] = [];
  const sources = new Map<string, string>();
  for (const action of proposal.actions) {
    const links: string[] = [];
    for (const id of [...new Set(action.referenceIds)]) {
      const asset = assets.find(item => item.id === id)!;
      let source = sources.get(id);
      if (!source) {
        const existing = project.nodes.find(node => node.type === 'media' && node.assetId === id && !node.bypassed && !node.locked && !node.linked.length);
        source = existing?.id ?? createId();
        sources.set(id, source);
        if (!existing) nodes.push({ id: source, type: 'media', title: asset.name, assetId: id, x: 40, y: Math.min(18000, 100 + nodes.length * 260), width: 260, linked: [] });
      }
      links.push(source);
    }
    const nodeId = createId();
    nodes.push({ id: nodeId, type: action.kind === 'note' ? 'note' : 'generate', title: action.title, text: action.prompt,
      mode: action.kind === 'audio' ? 'Audio' : action.kind === 'video' ? 'Video' : 'Image', role: proposal.suite === 'moleculr' ? 'Marketing strategist' : proposal.suite === 'atomik' ? 'Producer' : 'Director',
      x: 420 + (nodes.length % 2) * 360, y: Math.min(18000, 100 + Math.floor(nodes.length / 2) * 300), width: 300, linked: links, status: 'draft' });
    if (proposal.suite === 'moleculr' && (action.kind === 'image' || action.kind === 'video')) {
      const refs = new Set(action.referenceIds.filter(id => images.has(id)));
      const productIds = new Set((brief.products ?? []).filter(product =>
        (product.id === brief.activeProductId ? brief.productAssetIds : product.assetIds).some(id => refs.has(id)),
      ).map(product => product.id));
      const productId = productIds.size === 1 && brief.activeProductId && productIds.has(brief.activeProductId) ? brief.activeProductId : undefined;
      const productImages = new Set([...(brief.productAssetIds ?? []), ...(brief.products ?? []).flatMap(product => product.assetIds)]);
      const castIds = [...new Set(brief.castAssetIds.filter(id => refs.has(id) && !productImages.has(id)))];
      variants.push({ id: nodeId, nodeId, kind: action.kind, hook: action.title,
        ...(productId ? { productId } : {}), ...(castIds.length === 1 ? { castAssetId: castIds[0] } : {}), createdAt });
    }
  }
  if (project.nodes.length + nodes.length > 250) throw new Error('This plan would exceed the 250-node canvas limit. Remove unused nodes first.');
  return { ...project, assets: importedAssets.length ? [...project.assets, ...importedAssets] : project.assets, nodes: [...project.nodes, ...nodes],
    plans: project.plans.some(item => item.id === plan.id) ? project.plans.map(item => item.id === plan.id ? { ...item, applied: true } : item) : [...project.plans, { ...plan, applied: true }],
    ...(proposal.suite === 'moleculr' ? { moleculr: { ...brief, variants, hooks: [...new Set([...brief.hooks, ...proposal.hooks])].slice(0, 12) } } : {}),
  };
}
