import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { Generation } from "../../lib/jobs";
import type { LibraryUpload } from "../../lib/genLibrary";
import type { Project } from "../../lib/workbench/studio";

/**
 * Test fixtures for the /workspace page specs (Takes, Cast, Edit). Every
 * record here is test data served through page.route — the app reads the
 * same shapes from the real routes.
 */

export const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
export const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];

let clock = 1_790_000_000_000;
const at = () => (clock -= 60_000);

export function generation(fields: Partial<Generation> & { id: string }): Generation {
  const createdAt = fields.createdAt ?? at();
  return {
    projectId: "prod-ws", projectName: null, arkTaskId: null, kind: "image", reviewState: "", reviewBy: null,
    pickedBy: null, pickedAt: null, approvedBy: null, approvedAt: null, model: "gemini-3.1-flash-image",
    prompt: "", title: null, params: {}, status: "succeeded", sourceUrl: null, storedUrl: `/api/media/${fields.id}`,
    totalTokens: null, costUsd: null, creditsBilled: null, providerCreditQuote: null, refineCostUsd: null,
    refineModel: null, refineInTokens: null, refineOutTokens: null, error: null, createdBy: "u", authorName: null,
    shotId: null, shotCode: null, shotScene: null, shotTitle: null, version: 1, durationMs: null, durationS: null,
    provider: "mock", attempts: 1, task: "generate", sourceGenId: null, createdAt, updatedAt: createdAt,
    ...fields,
  } as Generation;
}

export function upload(fields: Partial<LibraryUpload> & { id: string; filename: string }): LibraryUpload {
  return {
    mime: "image/webp", kind: "image", bytes: 120_000, width: 1920, height: 1080, durationS: null,
    sha256: "a".repeat(64), url: `/api/uploads/${fields.id}`, createdAt: at(), ...fields,
  };
}

export type ProjectRoute = { current: Project; list?: { id: string; name: string }[]; revision?: number };

/** GET /api/workbench/projects answers with `store.current`; PUT saves into it (revision-checked like the route). */
export async function mockProjects(page: Page, store: ProjectRoute) {
  let revision = store.revision ?? 1;
  await page.route("**/api/workbench/projects**", async (route) => {
    const request = route.request();
    if (request.method() === "GET")
      return route.fulfill({ json: { projects: store.list ?? [{ id: store.current.id, name: store.current.name, revision, updatedAt: "2026-09-18T10:00:00Z" }], productions: [], project: store.current, revision, shared: null } });
    if (request.method() === "PUT") {
      const body = request.postDataJSON() as { project: Project; revision: number };
      if (body.revision !== revision) return route.fulfill({ status: 409, json: { error: "This project changed in another window." } });
      revision++;
      store.current = { ...body.project, productionProjectId: store.current.productionProjectId ?? "prod-ws", shotMappings: store.current.shotMappings ?? {} };
      return route.fulfill({ json: { revision, productionProjectId: store.current.productionProjectId, shotMappings: store.current.shotMappings } });
    }
    if (request.method() === "POST") {
      const body = request.postDataJSON() as { action?: string; nodeId?: string };
      if (body.action === "map-shot") return route.fulfill({ json: { productionProjectId: "prod-ws", shotId: "shot_" + String(body.nodeId).replace(/[^a-zA-Z0-9_-]/g, "") } });
    }
    return route.fulfill({ status: 400, json: { error: "Unexpected projects request in a workspace test." } });
  });
}

export type LibraryRoute = { uploads: LibraryUpload[]; generations: Generation[]; pageSize?: number };

/** GET /api/workbench/library with real cursor paging over the fixture arrays; POST files an upload. */
export async function mockLibrary(page: Page, store: LibraryRoute, onFile?: (uploadId: string) => void) {
  await page.route("**/api/workbench/library**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = request.postDataJSON() as { uploadId: string };
      onFile?.(body.uploadId);
      return route.fulfill({ json: { ok: true } });
    }
    const url = new URL(request.url());
    const source = url.searchParams.get("source") as "uploads" | "generations";
    const size = store.pageSize ?? 60;
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    const all = source === "uploads" ? store.uploads : store.generations;
    const items = all.slice(offset, offset + size);
    const next = offset + size < all.length ? String(offset + size) : null;
    return route.fulfill({ json: source === "uploads" ? { uploads: items, nextCursor: next } : { generations: items, nextPageCursor: next } });
  });
}

const STILLS = ["hero", "character", "environment"].map((name) => readFileSync(`public/campaign/${name}.webp`));

/** Stored media: every upload and generation URL answers with a real still. */
export async function mockMedia(page: Page) {
  await page.route(/\/api\/(uploads|media)\/[A-Za-z0-9_-]+(\?.*)?$/, (route) => {
    const request = route.request();
    const id = new URL(request.url()).pathname.split("/").pop()!;
    if (request.method() !== "GET" || ["chunk", "finish", "session"].includes(id)) return route.fallback();
    const body = STILLS[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % STILLS.length];
    return route.fulfill({ body, contentType: "image/webp" });
  });
}

/** Any paid route reached without an explicit mock fails the test. */
export async function forbidPaidWork(page: Page) {
  await page.route(/\/api\/(generate|jobs\/[^/]+\/retry|soul\/identities|audio(\/dub)?)$/, (route) => {
    if (route.request().method() === "POST") throw new Error("Workspace tests must not submit paid work without a mock.");
    return route.fallback();
  });
}

/** Every child of every header row stays inside its row and left of the Inspector. */
export async function assertNoClipping(page: Page) {
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const inspector = document.querySelector('[data-testid="inspector"]')?.getBoundingClientRect() ?? null;
    for (const row of Array.from(document.querySelectorAll<HTMLElement>("[data-row]"))) {
      const name = row.dataset.row!;
      const rowRect = row.getBoundingClientRect();
      for (const child of Array.from(row.children) as HTMLElement[]) {
        const rect = child.getBoundingClientRect();
        if (!rect.width) continue;
        const right = rect.right - rowRect.left + row.scrollLeft;
        if (right > row.scrollWidth + 0.5) out.push(`${name}: ${child.className || child.tagName} ends at ${right} past scrollWidth ${row.scrollWidth}`);
        if (inspector && ["project", "page", "crumbs"].includes(name) && rect.right > inspector.left + 0.5)
          out.push(`${name}: ${child.className || child.tagName} overlaps the Inspector (${rect.right} > ${inspector.left})`);
      }
      if (["project", "page", "crumbs"].includes(name) && row.scrollWidth > row.clientWidth + 0.5)
        out.push(`${name}: row content ${row.scrollWidth} wider than the row ${row.clientWidth}`);
    }
    for (const id of ["project-title", "page-title"]) {
      const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (el && el.scrollWidth > el.clientWidth + 0.5) out.push(`${id} truncated: ${el.scrollWidth} > ${el.clientWidth}`);
    }
    /* Page content never runs under the Inspector. */
    const content = document.querySelector<HTMLElement>('[data-testid="content"]');
    if (content && inspector) {
      const box = content.getBoundingClientRect();
      if (box.right > inspector.left + 0.5) out.push(`content ${box.right} runs under the Inspector ${inspector.left}`);
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`document scrolls horizontally: ${document.documentElement.scrollWidth} > ${innerWidth}`);
    return out;
  });
  expect(problems).toEqual([]);
}

/** 1200, 1440 and 1920 wide: the shell scrolls, it never clips. */
export const CLIP_WIDTHS = [{ width: 1200, height: 800 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }];
