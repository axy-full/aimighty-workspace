import type { Project } from "./studio";
import { projectSchema } from "./studio-schema";

export class DraftRequestError extends Error {
  constructor(
    message: string,
    public retryable = false,
    public uncertain = false,
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
      );
    throw new DraftRequestError(
      data?.error ||
        `Studio could not ${init.method === "PUT" ? "save" : "load"} this project (${response.status}). Your current work is preserved.`,
      response.status >= 500,
      response.status >= 500 && init.method === "PUT",
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
  );
}
export async function writeDraft(
  base: string,
  scope: string,
  write: DraftWrite,
): Promise<DraftReceipt> {
  try {
    const data = await draftRequest<unknown>(base + "/projects", scope, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(write),
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
