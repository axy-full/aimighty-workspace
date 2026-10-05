import { getWorkspace } from "@/lib/platform";
import { tenantClient } from "@/lib/db";
import { readSite } from "@/lib/site/settings.server";
import { SAMPLE_TITLE, cleanSampleTitle, type GuestSample } from "./sample";

/** The workspace setting stream 12's builder writes when the sample production exists (never in DEFAULTS, never written by a person). */
const SAMPLE_SETTING = "sampleProduction";

/**
 * What a signed-out visitor may read: the sample production's title, from the ONE workspace the platform owner named
 * in /admin (lib/site/settings.ts › guestWorkspace), and only while Guest Home is on. Nothing else is read: no other
 * workspace, no person, no price, no cost, no setting but the sample's own row and its one project's name. The
 * workspace comes only from the site row, never from the request, so no visitor can point it elsewhere.
 *
 * Null when there is nothing to show (Guest Home off, no workspace named, the workspace gone, no sample built yet,
 * or anything unreadable): the caller answers 404 and the page shows the frames' layout with "A 15-second film".
 */
export async function guestSample(): Promise<GuestSample | null> {
  const site = await readSite();
  if (!site.guestHome || !site.guestWorkspace) return null;
  try {
    const ws = await getWorkspace(site.guestWorkspace);
    if (!ws || ws.deletedAt != null) return null;
    const db = tenantClient(ws);
    const row = (await db.execute({ sql: `SELECT value FROM settings WHERE key = ? LIMIT 1`, args: [SAMPLE_SETTING] })).rows[0] as { value?: unknown } | undefined;
    if (typeof row?.value !== "string") return null;
    const projectId = (JSON.parse(row.value) as { projectId?: unknown }).projectId;
    if (typeof projectId !== "string" || !projectId) return null;
    const project = (await db.execute({ sql: `SELECT name FROM projects WHERE id = ? LIMIT 1`, args: [projectId] })).rows[0] as { name?: unknown } | undefined;
    if (!project) return null;
    return { title: cleanSampleTitle(project.name) ?? SAMPLE_TITLE };
  } catch {
    return null;
  }
}
