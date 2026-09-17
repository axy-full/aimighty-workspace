import { withTenant, requireUser } from '@/lib/auth';
import { getProvider, providerConfigured } from '@/lib/providers';
import { MediaQuoteError, workbenchGenerationModels, referencePrices, quoteWorkbenchMedia } from '@/lib/workbench/media-quote';
import { requireReadySoulIdentity } from '@/lib/soulIdentities';

export const GET = withTenant(async (req: Request) => {
  const got = await requireUser();
  if (got.response) return got.response;
  const q = new URL(req.url).searchParams;
  const configured = workbenchGenerationModels().filter(model => providerConfigured(getProvider(model.provider)));
  const models = configured.map(model => ({ id: model.id, label: model.label, kind: model.kind, family: model.family,
    resolutions: model.resolutions, ratios: model.ratios, durations: model.durations,
    maxReferenceImages: model.maxReferenceImages, maxReferenceVideos: model.maxReferenceVideos, soulIdentity: model.soulIdentity || undefined }));
  const headers = { 'Cache-Control': 'no-store' };
  if (!q.has('model')) return Response.json({ models, credits: null }, { headers });
  try {
    const model = configured.find(item => item.id === q.get('model'));
    if (!model) throw new MediaQuoteError('This generation engine is unavailable. Choose a configured engine.');
    if (model.soulIdentity) {
      const identityId = q.get('soulIdentityId');
      if (!identityId) throw new MediaQuoteError('Connect a ready Soul identity from Characters or Elements to this node.');
      try { await requireReadySoulIdentity(identityId, undefined, q.get('projectId') || undefined); }
      catch (error) { throw new MediaQuoteError(error instanceof Error ? error.message : 'That Soul identity is unavailable.'); }
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
