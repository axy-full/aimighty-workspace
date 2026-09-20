import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "particl-worker-registration-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

/**
 * The Inngest sync registers exactly what `functions` exports. A native render
 * that is enqueued to an event nobody serves would fall back to inline
 * execution on the request path, so the registration itself is pinned here.
 */
test("the served worker list registers the Astra render function on its event with bounded concurrency", async () => {
  const { functions, astraRender } = await import("../../lib/workers");
  const { EVENTS } = await import("../../lib/inngest");
  const ids = functions.map((fn) => fn.id());
  expect(ids).toEqual(["worker-probe", "render", "astra-blender-render", "audio-dubbing"]);
  expect(functions).toContain(astraRender);

  const opts = astraRender.opts as {
    id: string;
    name?: string;
    triggers?: { event?: string }[];
    concurrency?: { limit: number; key?: string }[];
    retries?: number;
  };
  expect(opts.name).toBe("Render Astra 3D");
  expect(opts.triggers?.map((t) => t.event)).toEqual([EVENTS.astraRender]);
  expect(EVENTS.astraRender).toBe("astra-blender/render.requested");
  expect(opts.retries).toBe(2);
  expect(opts.concurrency).toEqual([
    { limit: 4 },
    { limit: 2, key: "event.data.workspaceId" },
  ]);
});
