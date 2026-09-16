import { assetFilename, type Asset } from './studio';

/** A download always addresses stored source bytes, never a preview or a canvas render. */
export function originalAssetDownload(asset: Asset): { url: string; filename: string } | null {
  if (asset.kind === 'link') return null;
  const path = asset.url.split(/[?#]/, 1)[0];
  if (/^\/api\/(?:uploads|media|workbench\/media)\/[A-Za-z0-9_-]+$/.test(path)) {
    return { url: `${path}?download=1`, filename: assetFilename(asset) };
  }
  // Included campaign examples are already files, not transformed preview routes.
  if (/^\/campaign\/[A-Za-z0-9_.-]+$/.test(path)) return { url: path, filename: assetFilename(asset) };
  // Older client state may contain a preview URL; recover only a bound source identity.
  if (asset.generationId && /^[A-Za-z0-9_-]+$/.test(asset.generationId)) {
    return { url: `/api/media/${asset.generationId}?download=1`, filename: assetFilename(asset) };
  }
  if (asset.uploadId && /^[A-Za-z0-9_-]+$/.test(asset.uploadId)) {
    return { url: `/api/uploads/${asset.uploadId}?download=1`, filename: assetFilename(asset) };
  }
  return null;
}

/** Let the browser stream large originals to disk instead of buffering them in JS memory. */
export function downloadOriginalAsset(asset: Asset): void {
  const original = originalAssetDownload(asset);
  if (!original) throw new Error('This asset has no stored original. Upload the source file to download it here.');
  const link = document.createElement('a');
  link.href = original.url;
  link.download = original.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
