import sharp from 'sharp';
import { requireUser, withTenant } from '@/lib/auth';
import { db, ready } from '@/lib/db';
import { mayReadTake } from '@/lib/draftProject';
import { requireTenant } from '@/lib/tenant';
import { uploadOpenableBy } from '@/lib/uploadAccess';
import { readImageBytes, readUploadBytes } from '@/lib/storage';
import { parseTier } from '@/lib/imageTiers';
import { isDemoMediaUrl } from '@/lib/demoProduction';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
/* A cached preview is its bytes, or "original" when the asked width is the original's own or more (the answer is the original itself). */
const previews = new Map<string, Buffer | 'original'>();
const pending = new Map<string, Promise<Buffer | 'original'>>();
const MAX_BYTES = 32 * 1024 * 1024;
let usedBytes = 0;
/* "original" answers hold no bytes: a cap on how many are remembered. */
const MAX_ENTRIES = 4000;
function evictOldest() {
  const oldest = previews.keys().next().value;
  if (oldest === undefined) return;
  const held = previews.get(oldest)!;
  if (held !== 'original') usedBytes -= held.length;
  previews.delete(oldest);
}
type Context = { params: Promise<{ kind: string; id: string }> };
/**
 * Small immutable image previews; tenant authorization precedes every cache lookup.
 * `?w=<tier>` (lib/imageTiers.ts) asks for the still at that width, for a srcset: a downscale of the original, never wider than it.
 * A tier at or above the original's width is answered with the original itself (a redirect to its own route, which checks the
 * same access again). Without `w`, the 640 px thumbnail it has always been. Any other `w` is a 404.
 */
export const GET = withTenant(async (req: Request, { params }: Context) => {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const { kind, id } = await params;
  if (!['generation', 'upload'].includes(kind) || !/^[\w-]{1,100}$/.test(id)) return new Response('Not found', { status: 404 });
  const asked = new URL(req.url).searchParams.get('w');
  const tier = parseTier(asked);
  if (asked != null && tier == null) return new Response('Not found', { status: 404 });
  await ready();
  /* An upload's preview is its bytes: the same access, and the same 404, as the original (lib/uploadAccess.ts), before any cached preview is looked up. */
  if (kind === 'upload' && !(await uploadOpenableBy(id, auth.user))) return new Response('Not found', { status: 404 });
  const result = await db().execute({ sql: kind === 'generation'
    ? `SELECT kind,bytes,'png' AS ext,stored_url,project_id FROM generations WHERE id=? AND deleted=0 AND status='succeeded'`
    : 'SELECT kind,bytes,ext,stored_url,NULL AS project_id FROM uploads WHERE id=?', args: [id] });
  const row = result.rows[0];
  /* A take of a private board this person may not see is as absent as an unknown id (lib/draftProject.ts). */
  if (!row || row.kind !== 'image' || (kind === 'generation' && !(await mayReadTake(auth.user, row.project_id == null ? null : String(row.project_id))))) return new Response('Not found', { status: 404 });
  const original = `/api/${kind === 'generation' ? 'media' : 'uploads'}/${id}`;
  const toOriginal = () => new Response(null, { status: 302, headers: { Location: original, 'Cache-Control': 'private, max-age=86400' } });
  /* A starter production's demo still has no bytes in this workspace's storage: its tiers are its original (app/api/media/[id] sends the viewer on). */
  if (tier != null && isDemoMediaUrl(row.stored_url == null ? null : String(row.stored_url))) return toOriginal();
  if (Number(row.bytes) > 32 * 1024 * 1024) return tier != null ? toOriginal() : new Response('Use original image', { status: 413 });
  const key = `${requireTenant().id}:${kind}:${id}${tier != null ? `:w${tier}` : ''}`;
  try {
    let bytes = previews.get(key);
    if (!bytes) {
      let task = pending.get(key);
      if (!task) {
        task = (async () => {
          const source = kind === 'generation' ? await readImageBytes(id) : await readUploadBytes(id, String(row.ext), String(row.stored_url));
          const image = sharp(source, { limitInputPixels: 64_000_000 }).rotate();
          if (tier != null) {
            /* A tier is a width (a srcset's w descriptor): the original when it is no wider, else a downscale to exactly that width. */
            const meta = await image.metadata();
            const upright = (meta.orientation ?? 1) >= 5;
            const width = upright ? meta.height : meta.width;
            if (!width || width <= tier) {
              if (previews.size >= MAX_ENTRIES) evictOldest();
              previews.set(key, 'original');
              return 'original' as const;
            }
          }
          const thumbnail = tier != null
            ? await image.resize({ width: tier, withoutEnlargement: true }).webp({ quality: tier >= 1920 ? 84 : 80 }).toBuffer()
            : await image.resize(640, 640, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
          while ((usedBytes + thumbnail.length > MAX_BYTES || previews.size >= MAX_ENTRIES) && previews.size) evictOldest();
          previews.set(key, thumbnail); usedBytes += thumbnail.length;
          return thumbnail;
        })().finally(() => pending.delete(key));
        pending.set(key, task);
      }
      bytes = await task;
    }
    if (bytes === 'original') return toOriginal();
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/webp', 'Content-Length': String(bytes.length), 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
  } catch { return new Response('Preview unavailable', { status: 422 }); }
});
