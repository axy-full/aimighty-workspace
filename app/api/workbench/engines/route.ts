import { withTenant, requireUser } from '@/lib/auth';
import { modelConfigured } from '@/lib/providers';
import { MediaQuoteError, workbenchGenerationModels, referencePrices, quoteWorkbenchMedia, rendersSound, workbenchRate, workbenchUse, workbenchAudioRates, NO_REFERENCES, type RateAt, type ReferencePrices } from '@/lib/workbench/media-quote';
import { requireReadySoulIdentity } from '@/lib/soulIdentities';

export const GET = withTenant(async (req: Request) => {
  const got = await requireUser();
  if (got.response) return got.response;
  const q = new URL(req.url).searchParams;
  const configured = workbenchGenerationModels().filter(model => modelConfigured(model));
  const listed = (at: RateAt, refs: ReferencePrices | null) => configured.map(model => ({ id: model.id, label: model.label, kind: model.kind, family: model.family,
    resolutions: model.resolutions, ratios: model.ratios, durations: model.durations, untestedResolutions: model.untestedResolutions,
    maxReferenceImages: model.maxReferenceImages, maxReferenceVideos: model.maxReferenceVideos, soulIdentity: model.soulIdentity || undefined, marketing: model.marketing || undefined,
    /* The model sheet's row: what the engine is for in Gen, whether its takes carry sound, and its price (credits only, nothing reserved). */
    use: workbenchUse(model), audio: rendersSound(model) || undefined, rate: refs ? workbenchRate(model, at, refs) : null }));
  const headers = { 'Cache-Control': 'no-store' };
  if (!q.has('model')) {
    /* The list, priced where Gen's composer stands (all optional; the untouched composer without them):
       pickRatio/pickResolution/pickDuration are its picks, aspect the project's, seconds its sound length,
       and uploadId/genId/imageRefs its references — each engine then resolves them as composerSettings does. */
    const text = (name: string) => { const v = q.get(name); return v && v.length <= 24 ? v : undefined; };
    const pickDuration = Number(q.get('pickDuration'));
    const at: RateAt = { aspect: text('aspect'), picks: { ratio: text('pickRatio'), resolution: text('pickResolution'), ...(Number.isInteger(pickDuration) && pickDuration > 0 ? { duration: pickDuration } : {}) } };
    const references = [...q.getAll('uploadId').map(uploadId => ({ uploadId })), ...q.getAll('genId').map(genId => ({ genId }))];
    const imageRefs = Number(q.get('imageRefs') || 0);
    /* References that cannot be priced leave every rate empty: Generate then says why. */
    const refs = Number(q.get('unresolvedVideoRefs') || 0) > 0 ? null
      : references.length || imageRefs ? await referencePrices(references, imageRefs).catch((error: unknown) => { if (error instanceof MediaQuoteError) return null; throw error; })
      : NO_REFERENCES;
    return Response.json({ models: listed(at, refs), audio: workbenchAudioRates(Number(q.get('seconds') || 10)), credits: null }, { headers });
  }
  const models = listed({}, NO_REFERENCES);
  try {
    const model = configured.find(item => item.id === q.get('model'));
    if (!model) throw new MediaQuoteError('This generation engine is unavailable. Choose a configured engine.');
    if (model.marketing) throw new MediaQuoteError("Marketing Studio needs a live quote for the complete prompt and settings. Request POST /api/generate/quote.", 409);
    if (model.soulIdentity) {
      const identityId = q.get('soulIdentityId');
      if (!identityId) throw new MediaQuoteError('Attach a ready identity from Cast & Elements to this node.');
      try { await requireReadySoulIdentity(identityId, undefined, q.get('projectId') || undefined); }
      catch (error) { throw new MediaQuoteError(error instanceof Error ? error.message : 'That identity is unavailable.'); }
    }
    if (Number(q.get('unresolvedVideoRefs') || 0) > 0) throw new MediaQuoteError('Upload the bound reference video from your device before estimating this take.');
    const references = [...q.getAll('uploadId').map(uploadId => ({ uploadId })), ...q.getAll('genId').map(genId => ({ genId }))];
    const refPrices = await referencePrices(references, Number(q.get('imageRefs') || q.get('refs') || 0));
    const quote = quoteWorkbenchMedia(model, { resolution: q.get('resolution') || model.resolutions[0], ratio: q.get('ratio') || '16:9', duration: Number(q.get('duration') || 5) }, refPrices);
    return Response.json({ models, ...quote }, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof MediaQuoteError ? error.message : 'The reference estimate could not be read.' }, { status: error instanceof MediaQuoteError ? error.status : 500, headers });
  }
});
