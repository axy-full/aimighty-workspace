import { expect, type Page } from "@playwright/test";
import { signInWithNewInterface } from "./newInterface";
import { newProject, type CanvasNode } from "../../lib/workbench/studio";

/* Stream 3's browser specs share this: a signed-in local workspace with the new interface on and a production with today's canvas nodes. Neutral names only. */
export const SHOTS = process.env.S03_SHOTS || "/private/tmp/claude-s03-shots";

export const node = (id: string, type: CanvasNode["type"], title: string, extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, title, type, x: 0, y: 0, width: 254, linked: [], ...extra });

export async function seedBoard(page: Page, more: CanvasNode[] = []) {
  const workspaceId = (await signInWithNewInterface(page.request, "Board Tester")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project = {
    ...newProject("Board fixture"),
    brief: "A short film about a morning market opening.",
    nodes: [
      node("node-brief01", "brief", "The brief", { text: "A morning market opens; light comes up on the stalls." }),
      node("node-look0001", "moodboard", "Morning light", { text: "Low sun, warm stalls." }),
      node("node-cast0001", "character", "Lead", { refKind: "cast" }),
      node("node-place001", "element", "The market", { refKind: "environment" }),
      node("node-shot0001", "scene", "Opening wide", { text: "Wide on the empty market at first light.", linked: ["node-look0001"] }),
      node("node-shot0002", "scene", "The first stall", { text: "Hands lift the shutter of the first stall." }),
      node("node-grade001", "grade", "Colour", { linked: ["node-shot0001"] }),
      node("node-note0001", "note", "Note", { text: "Keep the camera low.", x: 96, y: 72 }),
      ...more,
    ],
  };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId: productionId } = await saved.json() as { productionProjectId?: string };
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  const paid: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path === "/api/generate" || path.startsWith("/api/generate/"))) paid.push(path);
  });
  return { project, paid, productionId: productionId ?? null, headers: { "X-Workbench-Scope": scope } };
}

export const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1280;


/** A plain grey PNG of this size, made here (no file to ship): big enough that an engine's reference check takes it. */
export function grey(width = 640, height = 360): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.alloc(1 + width * 3, 0x80); row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { deflateSync } = require("node:zlib") as typeof import("node:zlib");
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
