import { z } from 'zod';
import { db } from '@/lib/db';
import { findWorkbenchMedia } from '@/lib/workbench/media-records';
import { requireUser, withTenant } from '@/lib/auth';
import { requireTenant } from '@/lib/tenant';
import { readBoundedText } from '@/lib/requestBody';
import { workbenchScopeProblem } from '@/lib/workbench/request-scope';
import { getAtomikProject, AtomikError } from '@/lib/workbench/atomik-server';
import { createAstraScene } from '@/lib/astra-blender/scene';
import { astraSceneDigest, validateAstraBindings } from '@/lib/astra-blender/proposal';
import { compileAstraBlender, type AstraAssetBindings } from '@/lib/astra-blender/blender-export';
import { originalAssetDownload } from '@/lib/workbench/original-asset';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const inputSchema = z.object({ projectId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/), sceneDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const POST = withTenant(async (request: Request) => {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const problem = workbenchScopeProblem(request, requireTenant().id, auth.user.id, !auth.token);
  if (problem) return Response.json({ error: problem }, { status: 409 });
  if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  try {
    const input = inputSchema.parse(JSON.parse(await readBoundedText(request, 2000)));
    const project = await getAtomikProject(auth.user.id, input.projectId);
    const scene = project.astraBlender ?? createAstraScene('product');
    if (await astraSceneDigest(scene) !== input.sceneDigest) throw new AtomikError('The scene changed. Save it and request a new export.', 409);
    const assets = [...project.assets, ...(project.sharedAssets ?? [])];
    validateAstraBindings(scene, assets);
    const bindings: AstraAssetBindings = Object.create(null);
    const files: { assetId: string; filename: string; url: string }[] = [];
    const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/tiff': 'tiff', 'image/bmp': 'bmp', 'model/gltf-binary': 'glb' };
    for (const object of scene.objects) {
      if (!object.assetId || bindings[object.assetId]) continue;
      const asset = assets.find(item => item.id === object.assetId)!;
      const original = originalAssetDownload(asset);
      let mime: string | undefined;
      const stored = original?.url.match(/^\/api\/(uploads|media|workbench\/media)\/([A-Za-z0-9_-]+)(?:\?|$)/);
      if (stored?.[1] === 'uploads') {
        const row = (await db().execute({ sql:'SELECT mime FROM uploads WHERE id=?', args:[stored[2]] })).rows[0];
        if (row) mime = String(row.mime);
      } else if (stored?.[1] === 'media') {
        const row = (await db().execute({ sql:"SELECT kind FROM generations WHERE id=? AND deleted=0 AND status='succeeded'", args:[stored[2]] })).rows[0];
        if (row?.kind === 'image') mime = 'image/png';
      } else if (stored?.[1] === 'workbench/media') {
        const row = await findWorkbenchMedia(stored[2], auth.user.id);
        if (row) mime = String(row.mime);
      }
      const ext = stored ? extensions[mime ?? ''] : original?.url.match(/^\/campaign\/[A-Za-z0-9_.-]+\.(png|jpe?g|webp|tiff?|bmp)$/i)?.[1]?.toLowerCase();
      if (!original || !ext) throw new AtomikError(`Export ${asset.name} as PNG, JPEG, WebP, TIFF, BMP or an embedded GLB, then attach it to this scene.`, 422);
      const filename = `asset-${files.length + 1}.${ext}`;
      bindings[object.assetId] = { path: `/astra/assets/${filename}`, kind: object.type as 'model' | 'image' };
      files.push({ assetId: object.assetId, filename, url: original.url });
    }
    return Response.json({ scene, script: compileAstraBlender(scene, bindings, { exportGlb: true, portableAssets: true }), files }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    const status = error instanceof AtomikError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500;
    return Response.json({ error: status === 500 ? 'The Blender export could not be prepared. Save the scene and try again.' : (error as Error).message }, { status });
  }
});
