import { PROJECT_LIMITS, limitText } from "../workbench/project-limits";
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { db } from '../db';
import { openUploadStream, openMediaStream, storeUpload } from '../storage';
import { findWorkbenchMedia } from '../workbench/media-records';
import { originalAssetDownload } from '../workbench/original-asset';
import { workbenchTransaction } from '../workbench/records';
import type { Asset, Project } from '../workbench/studio';
import { ASTRA_SANDBOX_INPUT_DIR, validateAstraGlb, type AstraRenderInput, type AstraRenderArtifacts } from './sandbox';
import type { AstraNativeBindings } from './native-runtime';
import type { AstraRenderArtifact } from './render-contract';
const MAX_INPUT = 100 * 1024 * 1024;
const MIMES: Record<string, {
    ext: string;
    kind: 'image' | 'model' | 'blend';
}> = { 'image/png': { ext: 'png', kind: 'image' }, 'image/jpeg': { ext: 'jpg', kind: 'image' }, 'image/webp': { ext: 'webp', kind: 'image' }, 'image/bmp': { ext: 'bmp', kind: 'image' }, 'image/tiff': { ext: 'tiff', kind: 'image' }, 'model/gltf-binary': { ext: 'glb', kind: 'model' }, 'application/x-blender': { ext: 'blend', kind: 'blend' } };
async function boundedStream(stream: ReadableStream<Uint8Array>, limit: number) { const reader = stream.getReader(), chunks: Buffer[] = []; let size = 0; try {
    while (true) {
        const part = await reader.read();
        if (part.done)
            break;
        size += part.value.byteLength;
        if (size > limit)
            throw new Error('A native input exceeds its byte limit.');
        chunks.push(Buffer.from(part.value));
    }
}
finally {
    await reader.cancel().catch(() => { });
    reader.releaseLock();
} return Buffer.concat(chunks, size); }
/** Resolve only canonical project media identities inside the authenticated tenant. */
export async function loadAstraRenderInputs(assets: Asset[], owner: string): Promise<{
    bindings: AstraNativeBindings;
    inputs: AstraRenderInput[];
}> {
    const bindings: AstraNativeBindings = Object.create(null), inputs: AstraRenderInput[] = [];
    let total = 0;
    for (const asset of assets) {
        const original = originalAssetDownload(asset);
        if (!original)
            throw new Error('A native input has no stored original.');
        const match = original.url.match(/^\/api\/(uploads|media|workbench\/media)\/([A-Za-z0-9_-]+)(?:\?|$)/);
        let mime = '', data: Buffer;
        if (match) {
            const [, kind, id] = match;
            if (kind === 'media') {
                const row = (await db().execute({ sql: "SELECT kind,bytes FROM generations WHERE id=? AND deleted=0 AND status='succeeded'", args: [id] })).rows[0];
                if (!row || row.kind !== 'image' || Number(row.bytes) > 50 * 1024 * 1024)
                    throw new Error('A source image is unavailable.');
                mime = 'image/png';
                const stored = await openMediaStream(id, 'image');
                data = await boundedStream(stored, 50 * 1024 * 1024);
            }
            else {
                const row = kind === 'uploads' ? (await db().execute({ sql: 'SELECT mime,ext,bytes AS size,stored_url FROM uploads WHERE id=?', args: [id] })).rows[0] : await findWorkbenchMedia(id, owner);
                if (!row || !MIMES[String(row.mime)] || Number(row.size) > 50 * 1024 * 1024)
                    throw new Error('A source file is unavailable or too large.');
                mime = String(row.mime);
                const stored = await openUploadStream(id, String(row.ext), null, String(row.stored_url));
                data = await boundedStream(stored.stream, 50 * 1024 * 1024);
            }
        }
        else if (/^\/campaign\/(hero|character|environment)\.webp$/.test(original.url)) {
            mime = 'image/webp';
            data = await readFile(path.join(process.cwd(), 'public', original.url.slice(1)));
        }
        else
            throw new Error('Native inputs must be stored project assets.');
        if (data.length > 50 * 1024 * 1024 || !data.length || (total += data.length) > MAX_INPUT)
            throw new Error('Native input files exceed their size allowance.');
        const format = MIMES[mime];
        if (format.kind === 'model')
            validateAstraGlb(data);
        if (format.kind === 'blend' && data.toString('ascii', 0, 7) !== 'BLENDER')
            throw new Error('Use an uncompressed native .blend file.');
        if (format.kind === 'image') {
            const meta = await sharp(data, { limitInputPixels: 16777216, animated: false }).metadata();
            if (!meta.width || !meta.height || meta.width > 8192 || meta.height > 8192 || (meta.pages ?? 1) > 1)
                throw new Error('Use a static image within the texture pixel limit.');
        }
        const filePath = `${ASTRA_SANDBOX_INPUT_DIR}/asset-${inputs.length + 1}.${format.ext}`;
        bindings[asset.id] = { path: filePath, kind: format.kind };
        inputs.push({ path: filePath, data });
    }
    return { bindings, inputs };
}
export type StoredAstraArtifact = AstraRenderArtifact & {
    sha256: string;
    storedUrl: string;
    ext: string;
};
export function astraArtifactPlan(jobId: string): Omit<StoredAstraArtifact, 'bytes' | 'sha256' | 'storedUrl'>[] { return ([['blend', 'scene.blend', 'application/x-blender'], ['preview', 'preview.png', 'image/png'], ['glb', 'scene.glb', 'model/gltf-binary']] as const).map(([kind, filename, mime]) => { const uploadId = `${jobId}_${kind}`; return { kind, filename, mime, uploadId, assetId: `astra-${uploadId}`, url: `/api/uploads/${uploadId}`, ext: filename.split('.').at(-1)! }; }); }
export async function storeAstraArtifacts(jobId: string, data: AstraRenderArtifacts, onStored: (artifact: StoredAstraArtifact) => Promise<void>) {
    for (const item of astraArtifactPlan(jobId)) {
        const bytes = data[item.kind];
        if (!bytes)
            continue;
        const stored = await storeUpload(item.uploadId, item.ext, bytes, item.mime);
        await onStored({ ...item, bytes: bytes.length, sha256: stored.sha256, storedUrl: stored.url });
    }
}
/** Transfer reserved bytes to uploads and merge outputs into the latest draft atomically. */
export async function registerAstraArtifacts(jobId: string, owner: string, projectId: string, artifacts: StoredAstraArtifact[]) {
    if (!artifacts.some(a => a.kind === 'blend') || !artifacts.some(a => a.kind === 'preview'))
        throw new Error('Native outputs are incomplete.');
    await workbenchTransaction(async (tx) => {
        const row = (await tx.execute({ sql: 'SELECT body,revision FROM workbench_projects WHERE owner=? AND project_id=?', args: [owner, projectId] })).rows[0];
        const project = row ? JSON.parse(String(row.body)) as Project : null;
        const missing=project?artifacts.filter(item=>!project.assets.some(asset=>asset.id===item.assetId)).length:artifacts.length;
        const canAttach=!!project&&project.assets.length+missing<=PROJECT_LIMITS.assets;
        for (const item of artifacts) {
            await tx.execute({ sql: 'INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,kind,duration_s,created_at) VALUES(?,?,?,?,?,?,NULL,NULL,?,?,NULL,?) ON CONFLICT(id) DO NOTHING', args: [item.uploadId, item.filename, item.mime, item.ext, item.bytes, item.sha256, item.storedUrl, item.kind === 'preview' ? 'image' : 'file', Date.now()] });
            if (canAttach && project && !project.assets.some(asset => asset.id === item.assetId))
                project.assets.push({ id: item.assetId, name: `Astra ${item.filename}`, kind: item.kind === 'preview' ? 'image' : 'document', category: 'Astra', url: item.url, mime: item.mime, uploadId: item.uploadId, description: 'Native 3D render output', prompt: '', status: 'Draft', locked: false, version: 1, refs: [] });
        }
        if(canAttach)await tx.execute({ sql: 'UPDATE workbench_projects SET body=?,revision=revision+1,updated_at=? WHERE owner=? AND project_id=?', args: [JSON.stringify(project), Date.now(), owner, projectId] });
        await tx.execute({ sql: 'UPDATE astra_render_jobs SET outputs_registered=1,assets_registered=?,error=?,updated_at=? WHERE id=?', args: [canAttach?1:0,canAttach?null:project?`Outputs are saved in the Library and available below. This project has no room for them (${limitText(PROJECT_LIMITS.assets)} assets maximum).`:'Outputs are saved in the Library. The original project is no longer available.',Date.now(), jobId] });
        await tx.execute({ sql: 'DELETE FROM astra_render_storage WHERE job_id=?', args: [jobId] });
    });
}
