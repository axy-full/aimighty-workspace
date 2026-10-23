import type { Plan } from './studio';

/**
 * An Atomik plan as a person is sent it: no thinking model and no effort (Amendment (iii) §E: never disclosed). A plan keeps a `model`
 * (a saved project's plans require one) that says only "atomik", as does its reference-ad analysis. A Studio Atomik job's plan
 * (lib/workbench/atomik-server.ts › publicAtomikJob) and the plans a saved project keeps (lib/workbench/records.ts › readDraft, which
 * pages saved from job replies made before 23 Oct 2026 with the model in them) both read through it.
 */
export function publicAtomikPlan<P extends Plan>(plan: P): P {
  const { effort: _effort, ...rest } = plan;
  void _effort;
  return { ...rest, model: 'atomik', ...(rest.referenceAdAnalysis ? { referenceAdAnalysis: { ...rest.referenceAdAnalysis, model: 'atomik' } } : {}) } as P;
}

/** A saved project's plans, each read through publicAtomikPlan; anything that is not a plan object is left as it is. */
export function publicPlans(plans: unknown): unknown {
  return Array.isArray(plans) ? plans.map((plan) => plan && typeof plan === 'object' && !Array.isArray(plan) ? publicAtomikPlan(plan as Plan) : plan) : plans;
}
