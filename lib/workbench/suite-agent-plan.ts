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
  suite: z.enum(['particl', 'atomik', 'moleculr']),
  projectId: z.string().min(1).max(100),
});
export type SuiteAgentResult = z.infer<typeof suiteAgentResultSchema>;
export type SuiteAgentPlan = z.infer<typeof suiteAgentPlanSchema>;

export const SUITE_AGENT_COPY: Record<SuiteId, { title: string; placeholder: string; mission: string }> = {
  particl: { title: 'Production agent', placeholder: 'Plan this scene, develop its visual language and prepare the shots…', mission: 'Develop cinematic production: story, shot coverage, continuity, cast, environments, lighting, camera and sound.' },
  atomik: { title: 'Production orchestrator', placeholder: 'Turn the brief into a staged production plan with review checkpoints…', mission: 'Break the production into concrete image, video and audio tasks, with dependencies, asset reuse and review checkpoints.' },
  moleculr: { title: 'Campaign agent', placeholder: 'Develop product angles, campaign hooks, cast and image or video variants…', mission: 'Develop a campaign with distinct hooks, product-accurate creative directions and executable image/video briefs. Use supplied product and cast references. Never invent endorsements, product claims or performance.' },
};

/** Pure, atomic handoff. Planning never invokes a rendering provider. */
export function applySuiteAgentPlan(project: Project, plan: Plan, createId: () => string): Project {
  if (plan.applied || project.plans.some(item => item.id === plan.id && item.applied)) return project;
  const proposal = suiteAgentPlanSchema.parse(plan.suiteAgent);
  if (proposal.projectId !== project.id) throw new Error('This proposal belongs to another project.');
  const assets = [...project.assets, ...(project.sharedAssets ?? [])];
  const nodes: CanvasNode[] = [];
  const sources = new Map<string, string>();
  for (const action of proposal.actions) {
    const links: string[] = [];
    if (action.kind === 'audio' && action.referenceIds.length) throw new Error('Audio generation cannot use visual references. Review this proposal.');
    for (const id of [...new Set(action.referenceIds)]) {
      const asset = assets.find(item => item.id === id);
      if (!asset || !['image', 'video'].includes(asset.kind)) throw new Error('A proposed reference is no longer available in this project. Run a new plan with the current assets.');
      if (action.kind === 'image' && asset.kind !== 'image') throw new Error('A still-image proposal needs image references.');
      let source = sources.get(id);
      if (!source) {
        const existing = project.nodes.find(node => node.type === 'media' && node.assetId === id && !node.bypassed && !node.locked && !node.linked.length);
        source = existing?.id ?? createId();
        sources.set(id, source);
        if (!existing) nodes.push({ id: source, type: 'media', title: asset.name, assetId: id, x: 40, y: Math.min(18000, 100 + nodes.length * 260), width: 260, linked: [] });
      }
      links.push(source);
    }
    nodes.push({ id: createId(), type: action.kind === 'note' ? 'note' : 'generate', title: action.title, text: action.prompt,
      mode: action.kind === 'audio' ? 'Audio' : action.kind === 'video' ? 'Video' : 'Image', role: proposal.suite === 'moleculr' ? 'Marketing strategist' : proposal.suite === 'atomik' ? 'Producer' : 'Director',
      x: 420 + (nodes.length % 2) * 360, y: Math.min(18000, 100 + Math.floor(nodes.length / 2) * 300), width: 300, linked: links, status: 'draft' });
  }
  if (project.nodes.length + nodes.length > 250) throw new Error('This plan would exceed the 250-node canvas limit. Remove unused nodes first.');
  return { ...project, nodes: [...project.nodes, ...nodes],
    plans: project.plans.some(item => item.id === plan.id) ? project.plans.map(item => item.id === plan.id ? { ...item, applied: true } : item) : [...project.plans, { ...plan, applied: true }],
    ...(proposal.suite === 'moleculr' && proposal.hooks.length ? { moleculr: { ...(project.moleculr ?? EMPTY_MOLECULR), hooks: [...new Set([...(project.moleculr?.hooks ?? []), ...proposal.hooks])].slice(0, 12) } } : {}),
  };
}
