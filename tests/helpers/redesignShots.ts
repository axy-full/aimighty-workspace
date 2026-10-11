import type { Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/*
 * Screenshots of a built screen beside the prototype URL it matches (docs/redesign-plan.md › "Screenshots").
 *
 * The prototype (design/particl-prototype-12) is served from a local static server started here, never from the
 * network: requests to any other host are refused, except Google Fonts (the prototype falls back to the system
 * stack without them), so the stand-in stills load from the prototype's own assets/ folder.
 * Output: <REDESIGN_SHOTS_DIR or ../redesign-shots>/<name>/<width>x<height>-{app,proto,beside}.png
 */

const ROOT = path.resolve(__dirname, "../../design/particl-prototype-12");
const PAGE = "Particl prototype.dc.html";
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".webp": "image/webp", ".css": "text/css", ".txt": "text/plain" };

let served: { server: Server; origin: string } | null = null;

async function prototypeOrigin(): Promise<string> {
  if (served) return served.origin;
  const server = createServer(async (req, res) => {
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname); }
    catch { res.writeHead(400).end(); return; }
    const file = path.resolve(ROOT, "." + pathname);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const port = (server.address() as { port: number }).port;
  served = { server, origin: `http://127.0.0.1:${port}` };
  return served.origin;
}

export async function closePrototypeServer(): Promise<void> {
  if (!served) return;
  await new Promise((resolve) => served!.server.close(resolve));
  served = null;
}

/** The prototype's URL for a query such as "?view=board&stage=Shots". */
export async function prototypeUrl(query: string): Promise<string> {
  return `${await prototypeOrigin()}/${encodeURIComponent(PAGE)}${query.startsWith("?") || !query ? query : `?${query}`}`;
}

/** Opens the prototype at `query` in `page` (offline) and waits for it to render. */
export async function openPrototype(page: Page, query: string): Promise<void> {
  const origin = await prototypeOrigin();
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) return route.continue();
    /* The three Dune Studies stills come from the prototype's own copies, never from particl.app. */
    const still = /^\/campaign\/(hero|environment|character)\.webp$/.exec(url.pathname);
    if (still && /(^|\.)particl\.app$/.test(url.hostname)) return route.fulfill({ path: path.join(ROOT, "assets", `${still[1]}.webp`), contentType: "image/webp" });
    return route.abort();
  });
  await page.goto(await prototypeUrl(query), { waitUntil: "load" });
  /* The prototype compiles its React source in the page (Babel): wait for the app root to have content. */
  await page.waitForFunction(() => (document.querySelector("#root, [data-dc-root], body > div")?.textContent ?? "").trim().length > 20, null, { timeout: 30_000 });
  await page.waitForTimeout(800);
}

/**
 * Writes the app screenshot (the page as it is now), the prototype screenshot (opened in a second page of the same
 * context) and one image with both side by side, app on the left. `prepare` sets the prototype's state that no URL
 * reaches (a right-click menu) before its screenshot.
 */
export async function captureBeside(appPage: Page, name: string, protoQuery: string, prepare?: (proto: Page) => Promise<void>): Promise<{ dir: string; files: string[] }> {
  const size = appPage.viewportSize() ?? { width: 1440, height: 900 };
  const dir = path.resolve(process.env.REDESIGN_SHOTS_DIR ?? "../redesign-shots", name);
  await mkdir(dir, { recursive: true });
  const tag = `${size.width}x${size.height}`;
  const app = await appPage.screenshot({ animations: "disabled" });
  const proto = await appPage.context().newPage();
  try {
    await openPrototype(proto, protoQuery);
    if (prepare) { await prepare(proto); await proto.waitForTimeout(400); }
    const protoShot = await proto.screenshot({ animations: "disabled" });
    const gap = 16;
    const beside = await sharp({ create: { width: size.width * 2 + gap, height: size.height, channels: 3, background: "#808080" } })
      .composite([{ input: app, left: 0, top: 0 }, { input: protoShot, left: size.width + gap, top: 0 }])
      .png().toBuffer();
    const files = [`${tag}-app.png`, `${tag}-proto.png`, `${tag}-beside.png`];
    await writeFile(path.join(dir, files[0]), app);
    await writeFile(path.join(dir, files[1]), protoShot);
    await writeFile(path.join(dir, files[2]), beside);
    await writeFile(path.join(dir, `${tag}.json`), JSON.stringify({ name, app: appPage.url().replace(/^https?:\/\/[^/]+/, ""), prototype: protoQuery, size }, null, 2));
    return { dir, files };
  } finally {
    await proto.close();
  }
}
