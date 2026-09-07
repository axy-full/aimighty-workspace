import { db, ready } from "./db";

/**
 * The cast — the people, places, props and looks a production keeps coming back to.
 *
 * The hardest thing in AI video isn't making one good shot, it's making the
 * second one match. Describing a face again in every prompt gets you a
 * different face. So a character is defined ONCE — a name, a description, and
 * a still to hold onto — and cited in prompts as @Maya.
 *
 * The citation is sugar over the reference system that already exists: at
 * render time @Maya becomes the @ImageN the model actually understands, with
 * its still attached in the right position and its description folded in. The
 * engines never learn a new trick; the team stops retyping.
 */

export type CastMember = {
  id: string;
  projectId: string | null;   // null = available to the whole workspace
  name: string;
  kind: "character" | "location" | "prop" | "style";
  description: string;
  uploadId: string | null;
  /** A ready, trained identity stands behind this name (brief 1.3). */
  trained?: boolean;
  createdAt: number;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function rowToCast(r: any): CastMember {
  return {
    id: r.id,
    projectId: r.project_id ?? null,
    name: r.name,
    kind: r.kind === "location" ? "location" : r.kind === "prop" ? "prop" : r.kind === "style" ? "style" : "character",
    description: r.description ?? "",
    uploadId: r.upload_id ?? null,
    trained: Number(r.trained ?? 0) === 1,
    createdAt: Number(r.created_at),
  };
}

/** Everything castable in this project, plus everything shared workspace-wide. */
export async function listCast(projectId?: string | null): Promise<CastMember[]> {
  await ready();
  const rs = projectId
    ? await db().execute({
        sql: `SELECT cast_members.*, EXISTS(SELECT 1 FROM identities i WHERE i.cast_id = cast_members.id AND i.status = 'ready' AND i.lora_url IS NOT NULL) AS trained FROM cast_members WHERE project_id = ? OR project_id IS NULL
              ORDER BY kind, LOWER(name)`,
        args: [projectId],
      })
    : await db().execute(
        `SELECT cast_members.*, EXISTS(SELECT 1 FROM identities i WHERE i.cast_id = cast_members.id AND i.status = 'ready' AND i.lora_url IS NOT NULL) AS trained FROM cast_members ORDER BY kind, LOWER(name)`
      );
  return rs.rows.map(rowToCast);
}

/** A name is citable if it can't be confused with @Image1 / @Video2. */
export function nameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return "Give them a name.";
  if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(n)) {
    return "Names are letters, digits and underscores, starting with a letter — that's what makes @Name citable in a prompt.";
  }
  if (/^(image|video)\d*$/i.test(n)) {
    return "That name collides with the @Image / @Video citations the models already use.";
  }
  return null;
}

export type CastExpansion = {
  prompt: string;
  /** Upload ids to attach, in the order their @ImageN indices were assigned. */
  attach: string[];
  used: CastMember[];
  missing: string[];
};

/**
 * Rewrite a prompt's @Name citations into the @ImageN form the engines take.
 *
 * `startIndex` is how many reference images the request already carries, so a
 * cast still attached third becomes @Image3 and nothing collides with the
 * references a person dragged in themselves.
 */
export function expandCast(
  prompt: string, cast: CastMember[], startIndex: number
): CastExpansion {
  const byName = new Map(cast.map((c) => [c.name.toLowerCase(), c]));
  const attach: string[] = [];
  const used: CastMember[] = [];
  const missing: string[] = [];
  const assigned = new Map<string, string>();   // cast id → the token it became

  const out = prompt.replace(/@([A-Za-z][A-Za-z0-9_]{0,31})/g, (whole, name: string) => {
    // Leave the engines' own citations alone.
    if (/^(image|video)\d+$/i.test(name)) return whole;
    const member = byName.get(name.toLowerCase());
    if (!member) { missing.push(name); return whole; }

    if (assigned.has(member.id)) return assigned.get(member.id)!;

    let token: string;
    if (member.uploadId) {
      attach.push(member.uploadId);
      token = `@Image${startIndex + attach.length}`;
    } else {
      // No still to hold onto — the name still carries its description.
      token = member.name;
    }
    assigned.set(member.id, token);
    used.push(member);
    return token;
  });

  // Fold the descriptions in once, at the end, so the shot reads as a shot and
  // the definitions read as definitions.
  const notes = used
    .filter((m) => m.description.trim())
    .map((m) => `${assigned.get(m.id)} is ${m.name}: ${m.description.trim()}`);

  return {
    prompt: notes.length ? `${out.trim()}\n\n${notes.join(" ")}` : out,
    attach,
    used,
    missing,
  };
}
