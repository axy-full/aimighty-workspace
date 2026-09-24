import type { Client } from '@libsql/client';
import { db, now } from '@/lib/db';
import { assetCursor, assetPageQuery, AssetQueryError } from '@/lib/assetPagination';
import { listGenerations } from '@/lib/jobs';
import { listLibraryUploads } from '@/lib/uploadLibrary';
import { referencedMedia } from '@/lib/mediaBindings';
import { readDraft, workbenchReady } from './records';
import { archiveAndDelete } from '@/lib/archive';

export class ProjectLibraryError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const initialized = new WeakMap<Client, Promise<void>>();
export async function projectLibraryReady() {
  await workbenchReady();
  const client = db();
  if (!initialized.has(client)) initialized.set(client, client.batch([`CREATE TABLE IF NOT EXISTS project_library_uploads (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(project_id,upload_id)
  )`, 'CREATE INDEX IF NOT EXISTS idx_project_library_upload ON project_library_uploads(upload_id)'], 'write').then(() => {}).catch(error => { initialized.delete(client); throw error; }));
  await initialized.get(client);
}

/** A draft belongs to its author. Its production mapping is read from storage,
 * never accepted from the browser. Private drafts of collaborators are not scanned. */
export async function resolveProjectLibrary(owner: string, id: string) {
  if (!id || id.length > 100 || /[\u0000-\u001f\u007f]/.test(id)) throw new ProjectLibraryError('Choose a saved Studio project.');
  await projectLibraryReady();
  const draft = await readDraft(owner, id);
  if (!draft) throw new ProjectLibraryError('Save or open this Studio project before using its library.', 404);
  const productionProjectId = draft.project.productionProjectId;
  if (!productionProjectId || !(await db().execute({sql:'SELECT id FROM projects WHERE id=?',args:[productionProjectId]})).rows.length)
    throw new ProjectLibraryError('This Studio project no longer has a linked production project.', 409);
  const refs = referencedMedia(draft.project);
  const [shared, edits] = await Promise.all([
    db().execute({sql:'SELECT body FROM workbench_bibles WHERE project_id=? ORDER BY version DESC LIMIT 1',args:[productionProjectId]}),
    db().execute({sql:'SELECT DISTINCT kind,source_id FROM workbench_edit_sources WHERE owner=? AND draft_id=?',args:[owner,id]}),
  ]);
  for (const row of shared.rows) {
    const linked = referencedMedia(JSON.parse(String(row.body)));
    for (const upload of linked.uploads) refs.uploads.add(upload);
    for (const generation of linked.generations) refs.generations.add(generation);
  }
  for (const row of edits.rows) (row.kind === 'upload' ? refs.uploads : refs.generations).add(String(row.source_id));
  const derivedUploadIds = [...draft.project.assets, ...(draft.project.sharedAssets ?? [])].filter(asset=>asset.uploadId&&asset.parentId).map(asset=>asset.uploadId!);
  return { productionProjectId, uploadIds: [...refs.uploads], generationIds: [...refs.generations], derivedUploadIds };
}

export async function listProjectLibrary(owner: string, params: URLSearchParams) {
  if (params.getAll('projectId').length !== 1 || params.getAll('source').length !== 1)
    throw new AssetQueryError('Choose one Studio project and asset source.');
  const source = params.get('source');
  if (source !== 'uploads' && source !== 'generations') throw new AssetQueryError('Choose Uploads or Generations.');
  const page = assetPageQuery(params, 60);
  const scope = await resolveProjectLibrary(owner, params.get('projectId')!);
  if (source === 'uploads') {
    const result = await listLibraryUploads(params, scope);
    const derived = new Set(scope.derivedUploadIds);
    return {...result,uploads:result.uploads.map(upload=>({...upload,...(derived.has(upload.id)?{librarySource:'generation' as const}:{})}))};
  }
  const rows = await listGenerations({projectLibrary:scope,limit:page.limit,search:page.search,cursor:page.cursor,includeNext:true});
  const generations = rows.slice(0,page.limit), last = generations.at(-1);
  return {generations,nextPageCursor:rows.length>page.limit&&last?assetCursor({createdAt:last.createdAt,id:last.id}):null};
}

/** Free, idempotent filing of an already stored workspace original. */
export async function linkProjectLibraryUpload(owner: string, projectId: string, uploadId: string) {
  const scope = await resolveProjectLibrary(owner, projectId);
  if (!uploadId || uploadId.length > 200) throw new ProjectLibraryError('Choose a stored upload.');
  const result = await db().execute({
    sql:`INSERT INTO project_library_uploads(project_id,upload_id,created_by,created_at)
      SELECT ?,id,?,? FROM uploads WHERE id=? ON CONFLICT(project_id,upload_id) DO NOTHING`,
    args:[scope.productionProjectId,owner,now(),uploadId],
  });
  if (!result.rowsAffected && !(await db().execute({sql:'SELECT id FROM uploads WHERE id=?',args:[uploadId]})).rows.length)
    throw new ProjectLibraryError('This upload is no longer available in the workspace.',404);
}

/** Removing a filing never deletes original bytes or references in a draft, take or edit version. */
export async function unlinkProjectLibraryUpload(owner: string, projectId: string, uploadId: string) {
  const scope = await resolveProjectLibrary(owner,projectId);
  if (!uploadId || uploadId.length>200) throw new ProjectLibraryError('Choose a stored upload.');
  await archiveAndDelete(db(), "project_library_uploads", 'project_id=? AND upload_id=?', [scope.productionProjectId,uploadId]);
}
