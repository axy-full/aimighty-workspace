import { z } from 'zod';
import type { Asset } from './studio';
import { originalAssetDownload } from './original-asset';
import { inspectPosterImageHeader } from './poster-image-header';

const color = z.string().regex(/^#[\da-f]{6}$/i);
const layerBase = { id: z.string().min(1).max(100), name: z.string().max(120), visible: z.boolean(), locked: z.boolean(), x: z.number().min(0).max(100), y: z.number().min(0).max(100), width: z.number().min(1).max(100), height: z.number().min(1).max(100), opacity: z.number().min(0).max(1) };
export const posterLayerSchema = z.discriminatedUnion('kind', [
  z.object({ ...layerBase, kind: z.literal('text'), text: z.string().max(2000), color, size: z.number().min(1).max(25), weight: z.enum(['regular', 'bold']), font: z.enum(['system', 'editorial', 'geometric']), align: z.enum(['left', 'center', 'right']) }).strict(),
  z.object({ ...layerBase, kind: z.literal('image'), assetId: z.string().min(1).max(100), fit: z.enum(['contain', 'cover']) }).strict(),
  z.object({ ...layerBase, kind: z.literal('shape'), color, radius: z.number().min(0).max(50) }).strict(),
]);
export const posterDocumentSchema = z.object({
  id: z.string().min(1).max(100), name: z.string().max(160), aspect: z.enum(['1:1', '4:5', '9:16', '16:9']), background: color,
  layers: z.array(posterLayerSchema).max(40).refine(layers => new Set(layers.map(layer => layer.id)).size === layers.length),
}).strict();
export type PosterDocument = z.infer<typeof posterDocumentSchema>;
export type PosterLayer = z.infer<typeof posterLayerSchema>;
export function posterDimensions(aspect: PosterDocument['aspect'], longEdge: number) {
  if (!Number.isSafeInteger(longEdge) || longEdge < 100 || longEdge > 4096) throw new Error('Choose a poster size between 100 and 4096 pixels.');
  const [w, h] = aspect.split(':').map(Number);
  return { width: Math.round(longEdge * w / Math.max(w, h)), height: Math.round(longEdge * h / Math.max(w, h)) };
}
export function createPoster(name: string, createId: () => string, background = '#141414'): PosterDocument {
  return { id: createId(), name: name.slice(0, 160), aspect: '4:5', background, layers: [
    { id: createId(), kind: 'text', name: 'Headline', text: name.slice(0, 120), x: 8, y: 8, width: 84, height: 32, opacity: 1, visible: true, locked: false, color: '#FFFFFF', size: 9, weight: 'bold', font: 'system', align: 'left' },
    { id: createId(), kind: 'text', name: 'Call to action', text: 'Discover more', x: 8, y: 86, width: 84, height: 10, opacity: 1, visible: true, locked: false, color: '#FFFFFF', size: 3, weight: 'regular', font: 'system', align: 'left' },
  ] };
}
export function posterSourceIds(document: PosterDocument): string[] {
  return [...new Set(document.layers.flatMap(layer => layer.kind === 'image' ? [layer.assetId] : []))];
}
function fontFamily(font: 'system' | 'editorial' | 'geometric') {
  return font === 'editorial' ? 'Georgia, serif' : font === 'geometric' ? 'Arial, sans-serif' : '-apple-system, BlinkMacSystemFont, Arial, sans-serif';
}
/** Wraps by measured pixels, including a single long unbroken word. */
export function posterTextLines(text: string, maxWidth: number, measure: (value: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth) { line = candidate; continue; }
      if (line) { lines.push(line); line = ''; }
      for (const character of word) {
        if (line && measure(line + character) > maxWidth) { lines.push(line); line = ''; }
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
}
async function boundedImageBlob(response: Response, signal?: AbortSignal) {
  const limit = 40 * 1024 * 1024;
  if (!response.ok || !response.body) throw new Error('The original image could not be loaded.');
  if (Number(response.headers.get('content-length') ?? 0) > limit) throw new Error('Use a poster reference smaller than 40 MB.');
  const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array<ArrayBuffer>[] = [];
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new Error('Use a poster reference smaller than 40 MB.');
      chunks.push(new Uint8Array(next.value));
    }
    return new Blob(chunks, { type: response.headers.get('content-type') ?? 'application/octet-stream' });
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
/** Originals remain separate assets. This only renders an explicit composition. */
export async function renderPoster(document: PosterDocument, assets: Asset[], longEdge: number, scope: string, signal?: AbortSignal): Promise<HTMLCanvasElement> {
  const poster = posterDocumentSchema.parse(document);
  const dimensions = posterDimensions(poster.aspect, longEdge);
  const canvas = window.document.createElement('canvas'); canvas.width = dimensions.width; canvas.height = dimensions.height;
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('This browser cannot render a poster.');
  const images = new Map<string, ImageBitmap>();
  let decodedPixels = 0, originalBytes = 0;
  try {
    for (const id of [...new Set(poster.layers.flatMap(layer => layer.kind === 'image' && layer.visible ? [layer.assetId] : []))]) {
      signal?.throwIfAborted();
      const asset = assets.find(item => item.id === id && item.kind === 'image');
      const source = asset && originalAssetDownload(asset);
      if (!source || !source.url.startsWith('/')) throw new Error('A poster image is missing its stored original. Select another project image.');
      const response = await fetch(source.url, { headers: { 'X-Workbench-Scope': scope }, cache: 'no-store', signal });
      const blob = await boundedImageBlob(response, signal);
      originalBytes += blob.size;
      if (originalBytes > 80 * 1024 * 1024) throw new Error('This design exceeds the 80 MB reference budget. Use fewer image layers or smaller reference copies.');
      inspectPosterImageHeader(new Uint8Array(await blob.arrayBuffer()), 40_000_000 - decodedPixels);
      signal?.throwIfAborted();
      const bitmap = await createImageBitmap(blob);
      decodedPixels += bitmap.width * bitmap.height;
      if (decodedPixels > 40_000_000) { bitmap.close(); throw new Error('This design exceeds the 40-megapixel reference budget. Use fewer image layers or smaller reference copies; originals remain in the library.'); }
      images.set(id, bitmap);
    }
    ctx.fillStyle = poster.background; ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const layer of poster.layers) {
      signal?.throwIfAborted(); if (!layer.visible) continue;
      const x = layer.x * canvas.width / 100, y = layer.y * canvas.height / 100, w = layer.width * canvas.width / 100, h = layer.height * canvas.height / 100;
      ctx.save(); ctx.globalAlpha = layer.opacity; ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
      if (layer.kind === 'shape') {
        ctx.fillStyle = layer.color; ctx.beginPath(); ctx.roundRect(x, y, w, h, Math.min(w, h) * layer.radius / 100); ctx.fill();
      } else if (layer.kind === 'image') {
        const image = images.get(layer.assetId)!;
        const scale = layer.fit === 'cover' ? Math.max(w / image.width, h / image.height) : Math.min(w / image.width, h / image.height);
        ctx.drawImage(image, x + (w - image.width * scale) / 2, y + (h - image.height * scale) / 2, image.width * scale, image.height * scale);
      } else {
        const size = layer.size * canvas.width / 100;
        ctx.fillStyle = layer.color; ctx.font = `${layer.weight === 'bold' ? '700' : '400'} ${size}px ${fontFamily(layer.font)}`; ctx.textBaseline = 'top'; ctx.textAlign = layer.align;
        const anchor = layer.align === 'center' ? x + w / 2 : layer.align === 'right' ? x + w : x;
        posterTextLines(layer.text, w, value => ctx.measureText(value).width).forEach((line, index) => { if (index * size * 1.2 < h) ctx.fillText(line, anchor, y + index * size * 1.2); });
      }
      ctx.restore();
    }
    return canvas;
  } finally { for (const bitmap of images.values()) bitmap.close(); }
}
export async function posterPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The poster could not be exported.')), 'image/png'));
}
