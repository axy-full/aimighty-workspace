import { withTenant, requireUser } from '@/lib/auth';
import { openUploadStream } from '@/lib/storage';
import { servingFor } from '@/lib/serveType';
import { findWorkbenchMedia } from '@/lib/workbench/media-records';
import { attachmentDisposition } from '@/lib/contentDisposition';
import { byteRange } from '@/lib/mediaRange';

export const dynamic = 'force-dynamic';
export const maxDuration = 800;

export const GET = withTenant(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const { id } = await params;
  const row = await findWorkbenchMedia(id, auth.user.id);
  if (!row) return new Response('Not found', { status: 404 });
  const serving = servingFor(String(row.mime));
  const headers = new Headers({
    'Content-Type': serving.contentType,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  });
  if (!serving.inline || new URL(req.url).searchParams.get('download') === '1') {
    headers.set('Content-Disposition', attachmentDisposition(String(row.name || `original.${row.ext}`)));
  }
  let range;
  try {
    range = byteRange(req.headers.has('if-range') ? null : req.headers.get('range'), Number(row.size));
  } catch {
    headers.set('Content-Range', `bytes */${row.size}`);
    return new Response(null, { status: 416, headers });
  }
  try {
    const { stream, size } = await openUploadStream(id, String(row.ext), range, String(row.stored_url), req.signal);
    if (size != null) headers.set('Content-Length', String(size));
    if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${range.total}`);
    return new Response(stream, { status: range ? 206 : 200, headers });
  } catch {
    return new Response('Not found', { status: 404 });
  }
});
