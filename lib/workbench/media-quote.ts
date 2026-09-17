import { db, ready } from '../db';
import { MODELS, type ModelDef } from '../models';
import { estimateCostUsd, estimateImageCostUsd } from '../vendorPricing';
import { generatedReferenceSeconds, videoReferenceSeconds } from '../referenceDuration';
import { billCredits } from '../creditTerms';
import { soulCharacterGenerationEnabled } from '../vendorRates';

export class MediaQuoteError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'MediaQuoteError'; }
}
export type QuoteReference = { uploadId?: string; genId?: string };
export type ReferencePrices = { images: number; videos: number; inputSeconds: number; hasVideoInput: boolean };
function baselineCost(model: ModelDef) {
  const ratio = model.ratios.includes('16:9') ? '16:9' : model.ratios[0];
  const duration = model.durations.includes(5) ? 5 : model.durations[0];
  return model.kind === 'image'
    ? estimateImageCostUsd(model.id, model.resolutions[0], 0)?.net ?? Infinity
    : estimateCostUsd(model.id, model.resolutions[0], ratio, duration, 0, false, { audio: false, task: 'generate' })?.net ?? Infinity;
}
export function workbenchGenerationModels(models: ModelDef[] = MODELS) {
  return models.filter(model => (model.soulIdentity ? soulCharacterGenerationEnabled() : model.marketing || !model.hidden) && !model.stillTask && (model.supportsTasks ?? ['generate']).includes('generate'))
    .sort((a, b) => baselineCost(a) - baselineCost(b));
}

/** Resolve tenant-owned rows; a claimed image role cannot hide a video's input cost. */
export async function referencePrices(refs: QuoteReference[], extraImages = 0): Promise<ReferencePrices> {
  if (!Number.isInteger(extraImages) || extraImages < 0 || extraImages > 50 || refs.length > 50) throw new MediaQuoteError('Too many reference images.');
  if (refs.some(ref => Boolean(ref.genId) === Boolean(ref.uploadId))) throw new MediaQuoteError('Each reference must name one saved upload or generation.');
  await ready();
  const uploads = refs.filter(ref => ref.uploadId).map(ref => ref.uploadId!);
  const generations = refs.filter(ref => ref.genId).map(ref => ref.genId!);
  if ([...uploads, ...generations].some(id => !/^[a-zA-Z0-9_-]{1,160}$/.test(id))) throw new MediaQuoteError('Invalid reference identity.');
  const [uploadRows, generationRows] = await Promise.all([
    uploads.length ? db().execute({ sql: `SELECT id,kind,mime,duration_s FROM uploads WHERE id IN (${uploads.map(() => '?').join(',')})`, args: uploads }) : { rows: [] },
    generations.length ? db().execute({ sql: `SELECT id,kind,status,stored_url,params FROM generations WHERE deleted=0 AND id IN (${generations.map(() => '?').join(',')})`, args: generations }) : { rows: [] },
  ]);
  const byUpload = new Map(uploadRows.rows.map(row => [String(row.id), row]));
  const byGeneration = new Map(generationRows.rows.map(row => [String(row.id), row]));
  const resolved: { kind: string; durationS: number | null }[] = [];
  for (const ref of refs) {
    if (ref.uploadId) {
      const row = byUpload.get(ref.uploadId);
      if (!row) throw new MediaQuoteError('A selected upload is unavailable in this workspace.', 404);
      const kind = row.kind === 'video' || String(row.mime).startsWith('video/') ? 'video' : String(row.mime).startsWith('image/') ? 'image' : String(row.kind);
      if (!['image', 'video'].includes(kind)) throw new MediaQuoteError('Only images and video can be generation references.');
      resolved.push({ kind, durationS: row.duration_s == null ? null : Number(row.duration_s) });
    } else {
      const row = byGeneration.get(ref.genId!);
      if (!row || row.status !== 'succeeded' || !row.stored_url) throw new MediaQuoteError('A selected generation has not completed or is unavailable.', 404);
      const kind = String(row.kind || 'video');
      if (!['image', 'video'].includes(kind)) throw new MediaQuoteError('Audio cannot be a visual generation reference.');
      resolved.push({ kind, durationS: kind === 'video' ? generatedReferenceSeconds(row.params) : null });
    }
  }
  const inputSeconds = videoReferenceSeconds(resolved);
  if (inputSeconds == null) throw new MediaQuoteError('A reference video has no verified duration. Upload the clip again before estimating its cost.');
  const videos = resolved.filter(ref => ref.kind === 'video').length;
  return { images: extraImages + resolved.filter(ref => ref.kind === 'image').length, videos, inputSeconds, hasVideoInput: videos > 0 };
}
export function quoteWorkbenchMedia(model: ModelDef, params: { resolution: string; ratio: string; duration: number }, refs: ReferencePrices) {
  if (!model.resolutions.includes(params.resolution) || !model.ratios.includes(params.ratio) || (model.kind === 'video' && !model.durations.includes(params.duration))) throw new MediaQuoteError('Choose a size, aspect and duration supported by this engine.');
  if (refs.images > model.maxReferenceImages) throw new MediaQuoteError(`${model.label} accepts at most ${model.maxReferenceImages} reference images.`);
  if (refs.videos > model.maxReferenceVideos || (model.kind === 'image' && refs.videos)) throw new MediaQuoteError(`${model.label} accepts at most ${model.maxReferenceVideos} reference videos.`);
  if (refs.inputSeconds > model.maxVideoSecondsTotal) throw new MediaQuoteError(`Reference videos total ${refs.inputSeconds.toFixed(1)}s; ${model.label} allows ${model.maxVideoSecondsTotal}s combined.`);
  const estimate = model.kind === 'image' ? estimateImageCostUsd(model.id, params.resolution, refs.images)
    : estimateCostUsd(model.id, params.resolution, params.ratio, params.duration, refs.inputSeconds, refs.hasVideoInput, { audio: false, task: 'generate' });
  return { credits: estimate ? billCredits(estimate.net, model.id) : null, inputSeconds: refs.inputSeconds, hasVideoInput: refs.hasVideoInput };
}
