import { merge3 } from "./merge";
import { PROJECT_ENCODING_HEADER, PROJECT_GZIP_FROM } from "./project-limits";
import type { Project } from "./studio";
import { projectSchema } from "./studio-schema";

export class DraftRequestError extends Error {
  constructor(
    message: string,
    public retryable = false,
    public uncertain = false,
    /** The HTTP status when the server answered. */
    public status?: number,
    /** The server's reason code: "revision_conflict" when another save landed first. */
    public code?: string,
  ) {
    super(message);
  }
}
export type DraftReceipt = {
  revision: number;
  productionProjectId?: string;
  shotMappings?: Record<string, string>;
};
export type DraftWrite = { project: Project; revision: number };

/** A bounded request; browser/network failures remain distinct from a rejected save. */
export async function draftRequest<T>(
  url: string,
  scope: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: "no-store",
      headers: { ...init.headers, "X-Workbench-Scope": scope },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new DraftRequestError(
      "Connection interrupted. Your edits are still here; Studio will reconnect and check the saved version.",
      true,
      true,
    );
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401)
      throw new DraftRequestError(
        "Your session expired. Download your current work before signing in again.",
        false, false, 401,
      );
    throw new DraftRequestError(
      data?.error ||
        `Studio could not ${init.method === "PUT" ? "save" : "load"} this project (${response.status}). Your current work is preserved.`,
      response.status >= 500,
      response.status >= 500 && init.method === "PUT",
      response.status,
      typeof data?.code === "string" ? data.code : undefined,
    );
  }
  if (!data)
    throw new DraftRequestError(
      "Studio received an incomplete response. Your current work is preserved.",
      true,
      init.method === "PUT",
    );
  return data as T;
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, ordered(v)]),
    );
  return value;
}
export function sameDraftContent(left: Project, right: Project) {
  const content = (p: Project) =>
    JSON.stringify(
      ordered(
        Object.fromEntries(
          Object.entries(p).filter(
            ([key]) => !["productionProjectId", "shotMappings"].includes(key),
          ),
        ),
      ),
    );
  return content(left) === content(right);
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 100;
}
function receipt(
  value: unknown,
  expectedRevision: number,
): DraftReceipt | null {
  if (
    !object(value) ||
    value.revision !== expectedRevision ||
    !Number.isSafeInteger(value.revision) ||
    !identity(value.productionProjectId) ||
    !object(value.shotMappings)
  )
    return null;
  if (
    Object.entries(value.shotMappings).some(
      ([key, id]) => !identity(key) || !identity(id),
    )
  )
    return null;
  return {
    revision: expectedRevision,
    productionProjectId: value.productionProjectId,
    shotMappings: value.shotMappings as Record<string, string>,
  };
}
function incompleteWrite() {
  return new DraftRequestError(
    "Studio received an incomplete save response. Your edits are preserved while the saved version is checked.",
    true,
    true,
  );
}
/** A lost PUT response may already have committed. Read before resubmitting;
 * never advance past another window's revision or overwrite it. */
export async function reconcileDraftWrite(
  base: string,
  scope: string,
  write: DraftWrite,
): Promise<DraftReceipt | null> {
  let read: unknown;
  try {
    read = await draftRequest<unknown>(
      base + "/projects?id=" + encodeURIComponent(write.project.id),
      scope,
    );
  } catch (error) {
    // A failed read tells us nothing about the prior PUT, including when the
    // read was definitively rejected. Keep that captured write for later checks.
    if (error instanceof DraftRequestError)
      throw new DraftRequestError(error.message, error.retryable, true);
    throw incompleteWrite();
  }
  if (
    !object(read) ||
    !Number.isSafeInteger(read.revision) ||
    Number(read.revision) < 0
  )
    throw incompleteWrite();
  const revision = Number(read.revision);
  if (read.project === null && revision === 0) {
    if (write.revision === 0) return null;
    throw new DraftRequestError(
      "This project changed in another window. Your edits are preserved. Download your current work before reloading.",
      false, false, 409, "revision_conflict",
    );
  }
  if (
    !object(read.project) ||
    revision === 0 ||
    read.project.id !== write.project.id ||
    !projectSchema.safeParse(read.project).success
  )
    throw incompleteWrite();
  const project = read.project as Project;
  if (
    revision === write.revision + 1 &&
    sameDraftContent(project, write.project)
  ) {
    const result = receipt(
      {
        revision,
        productionProjectId: project.productionProjectId,
        shotMappings: project.shotMappings,
      },
      revision,
    );
    if (!result) throw incompleteWrite();
    return result;
  }
  if (revision === write.revision) return null;
  throw new DraftRequestError(
    "This project changed in another window. Your edits are preserved. Download your current work before reloading.",
    false, false, 409, "revision_conflict",
  );
}
/**
 * A feature film's project runs to several megabytes, past what one request
 * may carry, so a large save travels gzipped (project JSON packs about 8:1).
 */
export async function draftBody(json: string): Promise<{ headers: Record<string, string>; body: BodyInit }> {
  if (json.length < PROJECT_GZIP_FROM || typeof CompressionStream === "undefined")
    return { headers: { "Content-Type": "application/json" }, body: json };
  const packed = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  return { headers: { "Content-Type": "application/json", [PROJECT_ENCODING_HEADER]: "gzip" }, body: packed };
}
export async function writeDraft(
  base: string,
  scope: string,
  write: DraftWrite,
): Promise<DraftReceipt> {
  try {
    const data = await draftRequest<unknown>(base + "/projects", scope, {
      method: "PUT",
      ...(await draftBody(JSON.stringify(write))),
    });
    const result = receipt(data, write.revision + 1);
    if (!result) throw incompleteWrite();
    return result;
  } catch (error) {
    if (!(error instanceof DraftRequestError) || !error.uncertain) throw error;
    const result = await reconcileDraftWrite(base, scope, write);
    if (result) return result;
    throw error;
  }
}

/** Another save landed first (the revision moved on): the edits can be merged into the newer version and saved again. */
export const isDraftConflict = (problem: unknown) => problem instanceof DraftRequestError && problem.code === "revision_conflict";

/** How many times a save is merged into a newer version and sent again before the conflict is reported. */
export const MERGE_TRIES = 3;

export type MergedWrite = {
  /** The draft exactly as the server held it at `revision` (last read or saved): what `mine` was edited from. */
  base: Project;
  /** The edited draft. */
  mine: Project;
  revision: number;
};

/**
 * Saves an edited draft without ever writing over another save.
 *
 * When another save landed first (409 revision_conflict), the latest version
 * is read and the edits made since `base` are merged into it
 * (lib/workbench/merge.ts), then saved at its revision; a few times at most,
 * then the conflict is thrown. A write whose outcome is unknown (the reply was
 * lost and `writeDraft` could not tell whether it landed) is reconciled the
 * same way: merging again over a version that already holds these edits
 * changes nothing, so nothing is ever applied twice, and when the latest
 * version already holds everything there is nothing left to send.
 *
 * Resolves with what the server holds and its revision, identities included.
 */
export async function writeMergedDraft(
  base: string,
  scope: string,
  write: MergedWrite,
  tries = MERGE_TRIES,
): Promise<{ project: Project; revision: number }> {
  let body = write.mine, revision = write.revision, rechecked = false;
  for (let attempt = 0; ; attempt++) {
    try {
      const receipt = await writeDraft(base, scope, { project: body, revision });
      return { project: { ...body, productionProjectId: receipt.productionProjectId, shotMappings: receipt.shotMappings }, revision: receipt.revision };
    } catch (error) {
      const conflict = isDraftConflict(error);
      const unconfirmed = !conflict && error instanceof DraftRequestError && error.uncertain;
      /* A lost reply is checked once more here; a network that stays down is the caller's to retry later. */
      if (attempt >= tries || !(conflict || (unconfirmed && !rechecked))) throw error;
      if (unconfirmed) rechecked = true;
      let latest: { project?: Project | null; revision: number };
      try {
        latest = await draftRequest(`${base}/projects?id=${encodeURIComponent(write.mine.id)}`, scope);
      } catch {
        throw error;
      }
      if (!latest.project || latest.project.id !== write.mine.id || !Number.isSafeInteger(latest.revision)) throw error;
      const merged = merge3(write.base, write.mine, latest.project);
      /* Everything this save carries is already there (it landed, or another window made the same edits). */
      if (sameDraftContent(merged, latest.project)) return { project: latest.project, revision: latest.revision };
      body = merged;
      revision = latest.revision;
    }
  }
}
