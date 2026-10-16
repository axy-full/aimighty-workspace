import type { Page } from "@playwright/test";

/** The edit's sequence as the browser reads it (the server refuses a draft that names a take it does not hold, and no engine runs here). */
export async function withCut(page: Page, patch: Record<string, unknown>) {
  const asset = (id: string, generationId: string) => ({ id, name: id, kind: "video", category: "Video", url: `/api/media/${generationId}`, description: "", prompt: "", status: "Selected", locked: false, version: 1, refs: [], generationId, seconds: 5 });
  await page.route(/\/api\/workbench\/projects\?id=/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    try {
      const response = await route.fetch();
      const body = await response.json() as { project?: Record<string, unknown> };
      if (body.project) Object.assign(body.project, {
        assets: [asset("clip-a1", "tk-s1"), asset("clip-a2", "tk-s2")],
        shots: [{ id: "cut-1", name: "Opening wide", assetId: "clip-a1", duration: 120, sourceIn: 0, note: "" }, { id: "cut-2", name: "The walk", assetId: "clip-a2", duration: 120, sourceIn: 0, note: "" }],
        ...patch,
      });
      await route.fulfill({ response, json: body });
    } catch { /* the test ended while this read was in flight */ }
  });
}

