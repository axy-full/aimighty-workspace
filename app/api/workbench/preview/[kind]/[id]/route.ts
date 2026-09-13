import sharp from 'sharp';
import { requireUser, withTenant } from '@/lib/auth';
import { db, ready } from '@/lib/db';
import { requireTenant } from '@/lib/tenant';
import { readImageBytes, readUploadBytes } from '@/lib/storage';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const previews = new Map<string, Buffer>();
const pending = new Map<string, Promise<Buffer>>();
const MAX_BYTES = 32 * 1024 * 1024;
let usedBytes = 0;
type Context = { params: Promise<{ kind: string; id: string }> };
/** Small immutable image previews; tenant authorization precedes every cache lookup. */
export const GET = withTenant(async (_req: Request, { params }: Context) => {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const { kind, id } = await params;
  if (!['generation', 'upload'].includes(kind) || !/^[\w-]{1,100}$/.test(id)) return new Response('Not found', { status: 404 });
  await ready();
  const result = await db().execute({ sql: kind === 'generation'
    ? `SELECT kind,bytes,'png' AS ext,stored_url FROM generations WHERE id=? AND deleted=0 AND status='succeeded'`
    : 'SELECT kind,bytes,ext,stored_url FROM uploads WHERE id=?', args: [id] });
  const row = result.rows[0];
  if (!row || row.kind !== 'image') return new Response('Not found', { status: 404 });
  if (Number(row.bytes) > 32 * 1024 * 1024) return new Response('Use original image', { status: 413 });
  const key = `${requireTenant().id}:${kind}:${id}`;
  try {
    let bytes = previews.get(key);
    if (!bytes) {
      let task = pending.get(key);
      if (!task) {
        task = (async () => {
          const source = kind === 'generation' ? await readImageBytes(id) : await readUploadBytes(id, String(row.ext), String(row.stored_url));
          const thumbnail = await sharp(source, { limitInputPixels: 64_000_000 }).rotate().resize(640, 640, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
          while (usedBytes + thumbnail.length > MAX_BYTES && previews.size) {
            const oldest = previews.keys().next().value!;
            usedBytes -= previews.get(oldest)!.length; previews.delete(oldest);
          }
          previews.set(key, thumbnail); usedBytes += thumbnail.length;
          return thumbnail;
        })().finally(() => pending.delete(key));
        pending.set(key, task);
      }
      bytes = await task;
    }
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/webp', 'Content-Length': String(bytes.length), 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
  } catch { return new Response('Preview unavailable', { status: 422 }); }
});
