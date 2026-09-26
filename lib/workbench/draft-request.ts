import { mergeDraft } from "./draft-merge";
import type { MergeOptions } from "./merge";
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
/** Which editor sent a save and its count of saves sent (lib/workbench/records.ts DraftWriteTag). */
export type DraftWriteTag = { writer: string; seq: number };

/**
 * One editor's saves of one draft. The server records each save under this
 * identity, so a save whose reply was lost can be checked — did it land? —
 * instead of guessed at from the revisions around it.
 */
export type DraftWriter = {
  readonly id: string;
  seq: number;
  /** The save sent whose outcome is not known yet: settled before anything else is sent. */
  unconfirmed: UnconfirmedWrite | null;
};
/** A save sent whose reply was lost: the edited draft it carried (`mine`) and the draft that was edited from (`base`). */
export type UnconfirmedWrite = { projectId: string; seq: number; mine: Project; base: Project };

export function draftWriter(): DraftWriter {
  return { id: crypto.randomUUID(), seq: 0, unconfirmed: null };
}

async function putDraft(base: string, scope: string, write: DraftWrite, tag?: DraftWriteTag): Promise<DraftReceipt> {
  const data = await draftRequest<unknown>(base + "/projects", scope, {
    method: "PUT",
    ...(await draftBody(JSON.stringify(tag ? { ...write, write: tag } : write))),
  });
  const result = receipt(data, write.revision + 1);
  if (!result) throw incompleteWrite();
  return result;
}

export type CheckedWrite = { landed: number | null; project: Project | null; revision: number };

/**
 * Whether a tagged save landed (the revision it landed at, or null), with the
 * draft as the server holds it now. The server fences a save it finds did not
 * land, so the answer never changes. Throws when it cannot be asked: the
 * outcome is still unknown then.
 */
export async function checkDraftWrite(base: string, scope: string, projectId: string, tag: DraftWriteTag): Promise<CheckedWrite> {
  let data: unknown;
  try {
    data = await draftRequest<unknown>(base + "/projects", scope, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "check-write", projectId, write: tag }),
    });
  } catch (error) {
    if (!(error instanceof DraftRequestError)) throw incompleteWrite();
    /* Not answered: the save is still unconfirmed. A refusal that retrying would not fix (signed out) says so. */
    const temporary = error.retryable || error.uncertain || error.status === undefined || error.status >= 500;
    throw temporary ? new DraftRequestError(error.message, true, true, error.status, error.code) : error;
  }
  if (!object(data) || !Number.isSafeInteger(data.revision) || Number(data.revision) < 0 || !(data.landed === null || Number.isSafeInteger(data.landed)))
    throw incompleteWrite();
  const project = data.project;
  /* The draft as stored, whatever schema it was saved under: only its shape is checked here. */
  if (project !== null && (!object(project) || project.id !== projectId || !Array.isArray(project.nodes) || !Array.isArray(project.assets))) throw incompleteWrite();
  return { landed: data.landed as number | null, project: project as Project | null, revision: Number(data.revision) };
}

export async function writeDraft(
  base: string,
  scope: string,
  write: DraftWrite,
  /** With a writer the save is tagged, and a lost reply is settled by asking the server whether it landed. */
  writer?: DraftWriter,
): Promise<DraftReceipt> {
  const tag = writer ? { writer: writer.id, seq: ++writer.seq } : undefined;
  try {
    return await putDraft(base, scope, write, tag);
  } catch (error) {
    if (!(error instanceof DraftRequestError) || !error.uncertain) throw error;
    if (!tag) {
      const result = await reconcileDraftWrite(base, scope, write);
      if (result) return result;
      throw error;
    }
    /* Throws (still unknown) when the server cannot be asked; the caller's own retry reads and writes again. */
    const checked = await checkDraftWrite(base, scope, write.project.id, tag);
    if (checked.landed === null || !checked.project)
      throw new DraftRequestError("Connection interrupted before the save arrived. Nothing was saved; your edits are still here.", true, false);
    const result = receipt({ revision: checked.landed, productionProjectId: checked.project.productionProjectId, shotMappings: checked.project.shotMappings }, checked.landed);
    if (!result) throw incompleteWrite();
    return result;
  }
}

/** Another save landed first (the revision moved on): the edits can be merged into the newer version and saved again. */
export const isDraftConflict = (problem: unknown) => problem instanceof DraftRequestError && problem.code === "revision_conflict";

/** How many times a save is merged into a newer version and sent again before the conflict is reported. */
export const MERGE_TRIES = 3;

/** Before a save whose outcome is unknown (a 5xx, a dropped connection) is checked and sent again: a server that is struggling gets a moment. */
const UNKNOWN_PAUSE_MS = 250;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type MergedWrite = {
  /** The draft exactly as the server held it at `revision` (last read or saved): what `mine` was edited from. */
  base: Project;
  /** The edited draft. */
  mine: Project;
  revision: number;
  /**
   * The editor's writer (one per editor and draft): its saves are tagged, and
   * a save of it left unconfirmed is settled before this one is sent.
   */
  writer?: DraftWriter;
  /** Records an undo put back, by id: what each was when it was taken out (merge3's ancestors). */
  ancestors?: MergeOptions["ancestors"];
  /** What this editor made from a source both windows share, as made (recordMade; merge3's `made`). */
  made?: MergeOptions["made"];
};

/** What a merged save holds, and what of this editor's did not fit it (a full list another window filled first), said plainly. */
export type MergedSave = { project: Project; revision: number; notes: string[] };

/**
 * Saves an edited draft without ever writing over another save.
 *
 * When another save landed first (409 revision_conflict), the latest version
 * is read and the edits made since `base` are merged into it
 * (lib/workbench/draft-merge.ts), then saved at its revision; a few times at
 * most, then the conflict is thrown.
 *
 * A save whose reply was lost is never guessed at. Every save is tagged with
 * the editor's writer, and the server is asked whether it landed — it fences
 * a save it finds did not, so the answer is final. Landed: everything it
 * carried is saved, whatever was built on it since stands, and nothing is sent
 * again. Not landed: the edits are merged into the latest version and sent,
 * after a pause that doubles with each try (a 5xx is such a save too, and a
 * struggling server is not asked again at once). The last try's outcome, when
 * unknown, stays on the writer like any other.
 * When the server cannot be asked, the save stays unconfirmed on the writer
 * and the next call settles it first: edits made since then are merged from
 * what that save carried (landed) or from what it was edited from (not
 * landed), so an undo or a cleared field made meanwhile is saved as such.
 *
 * Resolves with what the server holds and its revision, identities included,
 * and notes on what of this editor's did not fit (mergeDraft).
 */
export async function writeMergedDraft(
  base: string,
  scope: string,
  write: MergedWrite,
  tries = MERGE_TRIES,
): Promise<MergedSave> {
  const writer = write.writer ?? draftWriter();
  const mine = write.mine, notes: string[] = [];
  let from = write.base, body = mine, revision = write.revision;
  /* The notes of the merge that is sent, not of one a later merge replaced. */
  const merge = (latest: Project) => {
    notes.length = 0;
    return mergeDraft(from, mine, latest, { ancestors: write.ancestors, made: write.made, notes });
  };

  const settle = async (tag: DraftWriteTag, carried: Project, edited: Project) => {
    writer.unconfirmed = { projectId: mine.id, seq: tag.seq, mine: carried, base: edited };
    const checked = await checkDraftWrite(base, scope, mine.id, tag);
    writer.unconfirmed = null;
    return checked;
  };

  /* An earlier save whose reply was lost: settled first. What it carried is the base of what is left to send when it
     landed; what it was edited from when it did not — which may be newer than `base`: that save's own call may have
     settled a save before it that landed. */
  const pending = writer.unconfirmed;
  if (pending && pending.projectId === mine.id) {
    const checked = await settle({ writer: writer.id, seq: pending.seq }, pending.mine, pending.base);
    if (checked.project) {
      from = checked.landed !== null ? pending.mine : pending.base;
      const merged = merge(checked.project);
      if (sameDraftContent(merged, checked.project)) return { project: checked.project, revision: checked.revision, notes };
      body = merged;
      revision = checked.revision;
    } else if (revision !== 0) throw lostDraft();
  }

  for (let attempt = 0; ; attempt++) {
    const tag = { writer: writer.id, seq: ++writer.seq };
    try {
      const receipt = await putDraft(base, scope, { project: body, revision }, tag);
      return { project: { ...body, productionProjectId: receipt.productionProjectId, shotMappings: receipt.shotMappings }, revision: receipt.revision, notes };
    } catch (error) {
      const conflict = isDraftConflict(error);
      const unknown = !conflict && error instanceof DraftRequestError && error.uncertain;
      /* The last try's outcome unknown: it stays on the writer, and the next save settles it first — never merged again from the old base. */
      if (unknown && attempt >= tries) writer.unconfirmed = { projectId: mine.id, seq: tag.seq, mine, base: from };
      if (attempt >= tries || !(conflict || unknown)) throw error;
      let latest: { project?: Project | null; revision: number };
      if (unknown) {
        writer.unconfirmed = { projectId: mine.id, seq: tag.seq, mine, base: from };
        await pause(UNKNOWN_PAUSE_MS * 2 ** attempt);
        /* Throws, still unconfirmed on the writer, when the server cannot be asked. */
        const checked = await settle(tag, mine, from);
        /* It landed: all it carried is saved, and whatever another window built on it since stands. */
        if (checked.landed !== null && checked.project) return { project: checked.project, revision: checked.revision, notes };
        latest = checked;
        if (!latest.project && revision === 0) continue;
      } else {
        try {
          latest = await draftRequest(`${base}/projects?id=${encodeURIComponent(mine.id)}`, scope);
        } catch {
          throw error;
        }
      }
      if (!latest.project || latest.project.id !== mine.id || !Number.isSafeInteger(latest.revision)) throw error;
      const merged = merge(latest.project);
      /* Everything this save carries is already there (another window made the same edits). */
      if (sameDraftContent(merged, latest.project)) return { project: latest.project, revision: latest.revision, notes };
      body = merged;
      revision = latest.revision;
    }
  }
}

function lostDraft() {
  return new DraftRequestError(
    "This project is no longer saved on the server. Your edits are preserved. Download your current work before reloading.",
    false, false, 409, "revision_conflict",
  );
}
