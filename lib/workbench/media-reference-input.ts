import type { Asset } from './studio';

export function mediaReferenceIdentity(asset: Asset): { genId: string } | { uploadId: string } | null {
  if (asset.generationId) return { genId: asset.generationId };
  if (asset.uploadId) return { uploadId: asset.uploadId };
  const match = asset.url.match(/^\/api\/(uploads|media)\/([^/?#]+)(?:[?#]|$)/);
  if (!match) return null;
  try { return match[1] === 'uploads' ? { uploadId: decodeURIComponent(match[2]) } : { genId: decodeURIComponent(match[2]) }; }
  catch { return null; }
}
/** Only images without a saved ID are priced by count; videos require database duration metadata. */
export function mediaQuoteReferences(assets: Asset[]): string {
  const query = new URLSearchParams();
  let images = 0, unresolvedVideos = 0;
  for (const asset of assets) {
    const identity = mediaReferenceIdentity(asset);
    if (identity) {
      if ('genId' in identity) query.append('genId', identity.genId);
      else query.append('uploadId', identity.uploadId);
    } else if (asset.kind === 'image') images++;
    else if (asset.kind === 'video') unresolvedVideos++;
  }
  query.set('imageRefs', String(images));
  query.set('unresolvedVideoRefs', String(unresolvedVideos));
  return query.toString();
}
