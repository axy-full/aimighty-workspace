import { test, expect, type Page, type Locator } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";
import { screenplayPdf } from "./helpers/screenplayPdf";
import {newProject,type Asset} from '../lib/workbench/studio';

type Upload = { id: string; filename: string; url: string };
const assetCard = (page: Page | Locator, origin: "generation" | "upload", id: string) =>
  page.locator(`[data-library-id="${origin}:${id}"]`);
const library = (page: Page) =>
  page.getByRole("region", { name: "Workspace asset library", exact: true });
async function selectSource(root:Page|Locator,name:'Uploads'|'Generations') {
  await root.getByRole('group',{name:'Asset source',exact:true}).getByRole('button',{name,exact:true}).click();
}
async function showLibrary(page: Page) {
  if (page.viewportSize()!.width < 900)
    await page.getByRole("group", { name: "Generation view" })
      .getByRole("button", { name: /^Takes/ }).click();
}
/** Phone thumbnails expose the same commands through their visible action menu. */
async function chooseAssetAction(page: Page, card: Locator, action: string) {
  if (page.viewportSize()!.width <= 759) {
    await card.getByRole("button", { name: /^Actions for / }).click();
    await page.getByRole("menuitem", { name: action, exact: true }).click();
  } else {
    await card.getByRole("button", { name: action, exact: true }).click();
  }
}
function wav() {
  const bytes = Buffer.alloc(44 + 4800 * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24);
  bytes.writeUInt32LE(96000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

/** Real intake and listing, guarded by signInLocally before any fixture writes. */
async function fixture(page: Page) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  const headers = { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` };
  const upload = async (filename: string, buffer: Buffer, purpose: "reference" | "chat") => {
    const session = randomUUID();
    const chunk = await page.request.post("/api/uploads/chunk", {
      headers,
      multipart: { session, index: "0", chunk: { name: "chunk", mimeType: "application/octet-stream", buffer } },
    });
    expect(chunk.ok(), await chunk.text()).toBe(true);
    const finished = await page.request.post("/api/uploads/finish", {
      headers, data: { session, count: 1, filename, purpose },
    });
    expect(finished.ok(), await finished.text()).toBe(true);
    const result = await finished.json() as Upload;
    const original = await page.request.get(result.url);
    expect(original.ok(), await original.text()).toBe(true);
    expect(await original.body()).toEqual(buffer);
    return result;
  };
  const image = await sharp({ create: { width: 512, height: 512, channels: 3, background: "#354765" } }).png().toBuffer();
  const video = await readFile("tests/fixtures/astra-source.mp4");
  const imageUpload = await upload("Original lighting reference.png", image, "reference");
  const videoUpload = await upload("Original camera clip.mp4", video, "chat");
  const audioUpload = await upload("Original production sound.wav", wav(), "chat");
  const pdfUpload = await upload("Original screenplay.pdf", screenplayPdf([["INT. TEST STUDIO - DAY", "A camera waits in an empty room."]]), "chat");
  const otherUpload = await upload("Original colour look.cube", Buffer.from("LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n"), "chat");

  const production = await page.request.post("/api/projects", { data: { name: "Library fixture production" } });
  expect(production.ok(), await production.text()).toBe(true);
  const projectId = (await production.json()).id;
  const shotResponse = await page.request.post("/api/shots", { data: { projectId, code: "SH01", title: "Filed opening frame", kind: "shot" } });
  expect(shotResponse.ok(), await shotResponse.text()).toBe(true);
  const shot = await shotResponse.json();
  const shotId = shot.id ?? shot.shot?.id;
  expect(typeof shotId).toBe("string");
  // These are completed historical rows, not provider submissions. The fixture
  // database is explicitly local, newly provisioned, and belongs to this login.
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  let tenantUrl = "";
  try {
    const row = await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id = ?", args: [account.workspace.id] });
    tenantUrl = String(row.rows[0].db_url);
  } finally { platform.close(); }
  expect(tenantUrl).toMatch(/^file:/);
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  const generationImage = `gen_library_image_${randomUUID().replaceAll("-", "")}`;
  const generationVideo = `gen_library_video_${randomUUID().replaceAll("-", "")}`;
  try {
    for (const [id, kind, title, data, ext, filed] of [
      [generationImage, "image", "Filed lighting take", image, "png", true],
      [generationVideo, "video", "Unfiled motion take", video, "mp4", false],
    ] as const) {
      await mkdir(path.join(process.cwd(), ".data", "generations"), { recursive: true });
      await writeFile(path.join(process.cwd(), ".data", "generations", `${id}.${ext}`), data);
      await tenant.execute({
        sql: "INSERT INTO generations(id,project_id,shot_id,model,prompt,params,status,stored_url,kind,title,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        args: [id, filed ? projectId : null, filed ? shotId : null, kind === "image" ? "gemini-3-pro-image" : "seedance-2.5", `${title} prompt`, JSON.stringify({ duration: 1.5, resolution: "1080p", width: kind === "image" ? 512 : 720, height: kind === "image" ? 512 : 1280 }), "succeeded", `/api/media/${id}`, kind, title, me.id, Date.now(), Date.now()],
      });
    }
  } finally { tenant.close(); }
  const draft={...newProject('Library fixture Studio project'),productionProjectId:projectId,assets:[
    ...[imageUpload,videoUpload,audioUpload,pdfUpload,otherUpload].map(item=>({id:item.id,uploadId:item.id,url:item.url})),
    ...[generationImage,generationVideo].map(id=>({id,generationId:id,url:`/api/media/${id}`})),
  ].map(item=>({name:item.id,kind:'image',category:'Reference',description:'',prompt:'',status:'Draft',locked:false,version:1,refs:[],...item} as Asset))};
  const draftSave=await page.request.put('/api/workbench/projects',{headers,data:{project:draft,revision:0}});
  expect(draftSave.ok(),await draftSave.text()).toBe(true);
  await page.addInitScript(({scope,id})=>localStorage.setItem(scope,id),{scope:headers['X-Workbench-Scope'],id:draft.id});
  const paidRequests: Record<string, unknown>[] = [];
  await page.route(/\/api\/(generate|audio)$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    paidRequests.push(route.request().postDataJSON());
    return route.abort("blockedbyclient");
  });
  return { image, imageUpload, videoUpload, audioUpload, pdfUpload, otherUpload, generationImage, generationVideo, draftId:draft.id, scope: headers["X-Workbench-Scope"], paidRequests: () => paidRequests.length, submissions: paidRequests };
}

test("Gen lists linked project assets by source and type across modes and uploads originals through the library", async ({ page }, info) => {
  test.skip(!["customer-1440x900", "customer-390x844"].includes(info.project.name), "bounded desktop and phone asset-library coverage");
  const f = await fixture(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const jobsQueries: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/workbench/library" && url.searchParams.get("source") === "generations") jobsQueries.push(url);
  });
  await page.goto("/generate?mode=video");
  for (const mode of ["Video", "Images", "Audio"] as const) {
    await page.getByRole("navigation", { name: "Generation mode" }).getByRole("button", { name: mode, exact: true }).click();
    await showLibrary(page);
    await library(page).getByRole('group',{name:'Asset scope',exact:true}).getByRole('button',{name:'This project',exact:true}).click();
    if (page.viewportSize()!.width <= 759) {
      await expect(page.getByRole("group", { name: "Generation view", exact: true }).getByRole("button", { name: "Takes & assets", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(library(page)).toBeVisible();
    } else {
      await expect(library(page).getByRole("heading", { name: "Takes & assets", exact: true })).toBeVisible();
    }
    await selectSource(library(page),'Generations');
    await expect(assetCard(page, "generation", f.generationImage)).toBeVisible();
    await expect(assetCard(page, "generation", f.generationVideo)).toBeVisible();
    await selectSource(library(page),'Uploads');
    for (const item of [f.imageUpload, f.videoUpload, f.audioUpload, f.pdfUpload, f.otherUpload])
      await expect(assetCard(page, "upload", item.id)).toContainText(item.filename);
    const headings = library(page).getByRole("heading", { level: 3 });
    await expect(headings).toHaveText(["Images", "Videos", "Audio", "Documents", "Other files"]);
    const order = await headings.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top));
    expect(order.every((top, index) => !index || top > order[index - 1])).toBe(true);
  }
  expect(jobsQueries.length).toBeGreaterThan(0);
  expect(jobsQueries.every((url) => url.searchParams.get("projectId") === f.draftId && !url.searchParams.has("kind") && !url.searchParams.has("unfiled"))).toBe(true);
  const search = page.getByRole("textbox", { name: "Search assets", exact: true });
  await search.fill("Original screenplay");
  await expect(assetCard(page, "upload", f.pdfUpload.id)).toBeVisible();
  await expect(assetCard(page, "upload", f.imageUpload.id)).toHaveCount(0);
  await expect(assetCard(page, "generation", f.generationImage)).toHaveCount(0);
  await search.fill("");
  // A general library original is not constrained by BytePlus's 300px
  // reference minimum; this file remains useful to image and upscale tools.
  const libraryImage = await readFile("public/fixtures/still.png");
  const finished = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/uploads/finish" && response.request().method() === "POST");
  const chooser = page.waitForEvent("filechooser");
  await library(page).getByRole("button", { name: "Upload assets", exact: true }).click();
  await (await chooser).setFiles({ name: "New shared lighting.png", mimeType: "image/png", buffer: libraryImage });
  const receipt = await finished;
  expect(receipt.ok(), await receipt.text()).toBe(true);
  const uploaded = await receipt.json() as Upload;
  await expect(assetCard(page, "upload", uploaded.id)).toContainText("New shared lighting.png");
  expect(await page.request.get(uploaded.url).then((response) => response.body())).toEqual(libraryImage);
  await assetCard(page, "upload", uploaded.id).getByRole("button", { name: "Preview New shared lighting.png", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "New shared lighting.png", exact: true });
  await expect(preview.locator("img")).toHaveJSProperty("naturalWidth", 256);
  await expect(preview.getByRole("link", { name: "Download original", exact: true })).toHaveAttribute("href", `${uploaded.url}?download=1`);
  await preview.getByRole("button", { name: "Close preview", exact: true }).click();
  await page.screenshot({ path: info.outputPath("gen-library-by-type.png"), fullPage: true });
  await chooseAssetAction(page, assetCard(page, "upload", uploaded.id), "Use as reference");
  await expect(page.getByRole("region", { name: "Images composer", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove New shared lighting.png", exact: true })).toBeVisible();
  expect(f.paidRequests()).toBe(0);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("gen-workspace-assets.png"), fullPage: true });
});

async function malformedDrop(page: Page, target: Locator) {
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.setData("application/x-particl-asset", "{invalid-json");
    return data;
  });
  await target.dispatchEvent("dragover", { dataTransfer: transfer });
  await target.dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
}

test("Gen drags real generated and uploaded images into reference slots with duplicate and invalid-drop feedback", async ({ page }) => {
  test.skip(test.info().project.name !== "customer-1440x900", "desktop HTML drag-and-drop regression");
  const f = await fixture(page);
  await page.goto("/generate?mode=images");
  const composer = page.getByRole("region", { name: "Images composer", exact: true });
  await selectSource(library(page),'Generations');
  const generated = assetCard(page, "generation", f.generationImage);
  await expect(generated).toHaveAttribute("draggable", "true");
  const references = composer.getByLabel("Generation references", { exact: true });
  // The creation pane accepts a take even when dropped over the prompt rather
  // than exactly inside the reference well; it does not replace the prompt.
  await generated.dragTo(composer.getByRole("textbox", { name: "Prompt", exact: true }));
  await expect(page.getByRole("button", { name: "Remove Filed lighting take", exact: true })).toBeVisible();
  await expect(composer.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("");
  await generated.dragTo(references);
  await expect(page.getByText("This asset is already attached.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove Filed lighting take", exact: true })).toHaveCount(1);
  await selectSource(library(page),'Uploads');
  await assetCard(page, "upload", f.imageUpload.id).dragTo(references);
  await expect(page.getByRole("button", { name: "Remove Original lighting reference.png", exact: true })).toBeVisible();
  await assetCard(page, "upload", f.videoUpload.id).dragTo(references);
  await expect(page.getByText("Choose an image reference.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove Original camera clip.mp4", exact: true })).toHaveCount(0);
  await malformedDrop(page, references);
  await expect(page.getByText("Drag a saved workspace asset or a file from your device.", { exact: true })).toBeVisible();
  expect(f.paidRequests()).toBe(0);
  // Browser automation cannot drag from the operating system file manager;
  // dispatch its native File/DataTransfer payload to exercise that separate path.
  const fileDrop = await page.evaluateHandle((bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(bytes)], "Dropped device frame.png", { type: "image/png" }));
    return data;
  }, Array.from(f.image));
  const finish = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/uploads/finish" && response.request().method() === "POST");
  await references.dispatchEvent("dragover", { dataTransfer: fileDrop });
  await references.dispatchEvent("drop", { dataTransfer: fileDrop });
  const fileResponse = await finish;
  expect(fileResponse.ok(), await fileResponse.text()).toBe(true);
  const dropped = await fileResponse.json() as Upload;
  await fileDrop.dispose();
  await expect(page.getByRole("button", { name: "Remove Dropped device frame.png", exact: true })).toBeVisible();
  await composer.getByRole("textbox", { name: "Prompt", exact: true }).fill("Maintain the actor and use the original lighting references.");
  await page.locator("[data-render]").filter({ visible: true }).click();
  await expect(page.getByRole("button", { name: /Recover batch/ })).toBeEnabled();
  expect(f.submissions).toHaveLength(1);
  expect(f.submissions[0].references).toEqual([
    { genId: f.generationImage, role: "reference_image" },
    { uploadId: f.imageUpload.id, role: "reference_image" },
    { uploadId: dropped.id, role: "reference_image" },
  ]);
  // The paid boundary was deliberately dropped. Intake must not rewrite the
  // durable request while the UI offers recovery of that one submission.
  await assetCard(page, "upload", f.videoUpload.id).dragTo(references);
  await assetCard(page, "upload", f.imageUpload.id).getByRole("button", { name: "Use as reference", exact: true }).click();
  await expect(page.getByText("Finish or recover the current request before changing its assets.", { exact: true })).toBeVisible();
  await expect(composer.locator("[data-reference-id]")).toHaveCount(3);
  expect(f.submissions).toHaveLength(1);
});

test("Gen drags workspace assets into Seedance, Topaz and Astra source panels without submitting paid work", async ({ page }) => {
  test.skip(test.info().project.name !== "customer-1440x900", "desktop source-panel regression");
  const f = await fixture(page);
  const sourceScopes: (string | undefined)[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/workbench/library' && url.searchParams.get('projectId')===f.draftId && url.searchParams.get('limit')==='500')
      sourceScopes.push(request.headers()["x-workbench-scope"]);
  });
  await page.goto(`/make/images?ref=upload:${f.imageUpload.id}&task=upscale&source=upload:${f.imageUpload.id}`);
  await expect(page).toHaveURL(/\/generate\?/);
  const redirected = new URL(page.url());
  expect(redirected.searchParams.get("mode")).toBe("images");
  expect(redirected.searchParams.get("ref")).toBe(`upload:${f.imageUpload.id}`);
  expect(redirected.searchParams.get("task")).toBe("upscale");
  await expect(page.getByRole("region", { name: "Topaz Image Upscale", exact: true }).getByLabel("Source image", { exact: true })).toHaveValue(`upload:${f.imageUpload.id}`);
  await page.goto("/make/not-a-generation-mode");
  // Next streams notFound() inside the app shell with HTTP 200; verify the
  // missing-route contract rather than the transport status after streaming.
  await expect(page).toHaveURL(/\/make\/not-a-generation-mode$/);
  await expect(page.getByText("Nothing here", { exact: true })).toBeVisible();
  await expect(page.locator('meta[name="robots"][content*="noindex"]').first()).toBeAttached();
  await expect(page.getByRole("region", { name: "Topaz Image Upscale", exact: true })).toHaveCount(0);
  for (const [mode, task, panelName, sourceLabel, dropLabel, origin, id] of [
    ["video", "edit", "Seedance 2.5 Edit", "Source clip", "Edit source drop area", "generation", f.generationVideo],
    ["video", "upscale", "Topaz Astra 2", "Astra source clip", "Astra source drop area", "upload", f.videoUpload.id],
    ["images", "upscale", "Topaz Image Upscale", "Source image", "Upscale image drop area", "upload", f.imageUpload.id],
  ] as const) {
    await page.goto(`/generate?mode=${mode}&task=${task}`);
    const panel = page.getByRole("region", { name: panelName, exact: true });
    await expect(panel).toBeVisible();
    await selectSource(library(page),origin==='generation'?'Generations':'Uploads');
    await assetCard(page, origin, id).dragTo(panel.getByLabel(dropLabel, { exact: true }));
    await expect(panel.getByLabel(sourceLabel, { exact: true })).toHaveValue(`${origin}:${id}`);
    const sourceToast = page.getByRole("status").filter({ hasText: /selected (as|for)/ });
    await expect(sourceToast).toBeVisible();
    await expect.poll(async () => {
      const toastBounds = await sourceToast.boundingBox();
      const dockBounds = await page.getByRole("navigation", { name: "Particl Production Studio pages", exact: true }).boundingBox();
      return !!toastBounds && !!dockBounds && toastBounds.y + toastBounds.height <= dockBounds.y;
    }).toBe(true);
  }
  const originalImage = assetCard(page, "upload", f.imageUpload.id);
  await originalImage.getByRole("button", { name: "Edit image", exact: true }).click();
  const removeReference = page.getByRole("button", { name: "Remove Original lighting reference.png", exact: true });
  await expect(removeReference).toBeVisible();
  await removeReference.click();
  await expect(removeReference).toHaveCount(0);
  await originalImage.getByRole("button", { name: "Edit image", exact: true }).click();
  await expect(removeReference).toBeVisible();
  await assetCard(page, "upload", f.videoUpload.id).getByRole("button", { name: "Edit clip", exact: true }).click();
  await expect(page.getByRole("region", { name: "Seedance 2.5 Edit", exact: true }).getByLabel("Source clip", { exact: true })).toHaveValue(`upload:${f.videoUpload.id}`);
  await originalImage.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Upscale image", exact: true }).click();
  await expect(page.getByRole("region", { name: "Topaz Image Upscale", exact: true }).getByLabel("Source image", { exact: true })).toHaveValue(`upload:${f.imageUpload.id}`);
  expect(sourceScopes.length).toBeGreaterThan(0);
  expect(sourceScopes.every((scope) => scope === f.scope)).toBe(true);
  expect(f.paidRequests()).toBe(0);
});

test("Gen keeps take and upload pages independent and refreshes cursor boundaries when assets arrive or change", async ({ page }, info) => {
  test.skip(info.project.name !== "customer-1440x900", "deterministic browser pagination lifecycle regression");
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const draft=newProject('Pagination Studio project');
  const saved=await page.request.put('/api/workbench/projects',{headers:{'X-Workbench-Scope':scope},data:{project:draft,revision:0}});
  expect(saved.ok(),await saved.text()).toBe(true);
  await page.addInitScript(({scope,id})=>localStorage.setItem(scope,id),{scope,id:draft.id});
  let phase = 0;
  const cursors: string[] = [];
  // The APIs' real tuple cursors are covered separately. This controlled list
  // boundary makes insertion between two loaded pages reproducible in the UI.
  await page.route("**/api/workbench/library?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('source')!=='generations') return route.fallback();
    expect(url.searchParams.get('projectId')).toBe(draft.id);
    const order = phase === 0 ? ["a", "b", "c", "d"] : phase === 1 ? ["new", "a", "b", "c", "d"] : ["new", "a", "b", "d"];
    const cursor = url.searchParams.get("cursor");
    cursors.push(cursor ?? "first");
    const offset = cursor ? order.indexOf(cursor) + 1 : 0;
    const ids = order.slice(offset, offset + 2);
    await route.fulfill({ json: {
      generations: ids.map((id, index) => ({
        id: `page_${id}`, kind: "image", model: "gemini-3-pro-image", title: `Paged take ${id}`, prompt: `Paged take ${id}`, params: {},
        status: id === "a" && phase === 0 ? "running" : "succeeded", storedUrl: `/api/media/page_${id}`, sourceUrl: null,
        createdAt: 100000 - (offset + index) * 100, updatedAt: 100000 + phase, creditsBilled: 0, costUsd: null, refineCostUsd: null,
      })),
      nextPageCursor: offset + ids.length < order.length ? ids.at(-1) : null,
    } });
  });
  await page.route("**/api/workbench/library?*", async (route) => {
    const url=new URL(route.request().url());
    if(url.searchParams.get('source')!=='uploads')return route.fallback();
    expect(url.searchParams.get('projectId')).toBe(draft.id);
    const cursor = url.searchParams.get("cursor");
    const id = cursor ? "upload_page_b" : "upload_page_a";
    await route.fulfill({ json: { uploads: [{ id, filename: `${id}.txt`, kind: "file", mime: "application/octet-stream", bytes: 10, createdAt: 1, url: `/api/uploads/${id}` }], nextCursor: cursor ? null : "upload_page_a" } });
  });
  await page.route("**/api/media/page_*", (route) => route.fulfill({ path: "public/fixtures/still.png", contentType: "image/png" }));
  await page.goto("/generate?mode=images");
  await library(page).getByRole('group',{name:'Asset scope',exact:true}).getByRole('button',{name:'This project',exact:true}).click();
  await selectSource(library(page),'Generations');
  await expect(assetCard(page, "generation", "page_a")).toHaveAttribute("draggable", "false");
  await selectSource(library(page),'Uploads');
  await library(page).getByRole("button", { name: "Load more uploads", exact: true }).click();
  await expect(library(page).locator('[data-library-id^="upload:"]')).toHaveCount(2);
  await selectSource(library(page),'Generations');
  await expect(library(page).locator('[data-library-id^="generation:"]')).toHaveCount(2);
  await library(page).getByRole("button", { name: "Load more takes", exact: true }).click();
  await expect(library(page).locator('[data-library-id^="generation:"]')).toHaveCount(4);
  await selectSource(library(page),'Uploads');
  await expect(library(page).locator('[data-library-id^="upload:"]')).toHaveCount(2);
  await selectSource(library(page),'Generations');
  const changed = () => page.evaluate((currentScope) => window.dispatchEvent(new CustomEvent("particl:assets-changed", { detail: { scope: currentScope } })), scope);
  phase = 1;
  await changed();
  await expect(assetCard(page, "generation", "page_new")).toBeVisible();
  await expect(assetCard(page, "generation", "page_a")).toHaveAttribute("draggable", "true");
  await expect(assetCard(page, "generation", "page_c")).toBeVisible();
  await expect(assetCard(page, "generation", "page_d")).toHaveCount(0);
  expect(cursors).toContain("a");
  await library(page).getByRole("button", { name: "Load more takes", exact: true }).click();
  await expect(assetCard(page, "generation", "page_d")).toBeVisible();
  await expect(library(page).locator('[data-library-id^="generation:"]')).toHaveCount(5);
  phase = 2;
  await changed();
  await expect(assetCard(page, "generation", "page_c")).toHaveCount(0);
  await expect(library(page).locator('[data-library-id^="generation:"]')).toHaveCount(4);
  await expect(library(page).getByRole("button", { name: "Load more takes", exact: true })).toHaveCount(0);
  await selectSource(library(page),'Uploads');
  await expect(library(page).locator('[data-library-id^="upload:"]')).toHaveCount(2);
});

test("collective Library navigation lists shared originals and all takes, with working reuse and edit handoffs", async ({ page }, info) => {
  test.skip(!["customer-1440x900", "customer-360x640", "customer-390x844"].includes(info.project.name), "collective library on desktop and phone");
  const f = await fixture(page);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/generate");
  const allAssets=page.getByRole('link',{name:'All assets',exact:true});
  await expect(page.getByRole('button',{name:'Select project',exact:true})).toContainText('Library fixture Studio project');
  await allAssets.click();
  await expect(page).toHaveURL(/\/library\?.*all=1/);
  await expect(page.getByRole("heading", { name: page.viewportSize()!.width <= 759 ? "Workspace uploads and generated takes" : "All assets", exact: true })).toBeVisible();
  await expect(allAssets).toHaveAttribute("aria-current", "page");
  const collective = page.getByRole("region", { name: "Collective workspace assets", exact: true });
  await expect(collective.getByRole("heading", { level: 3 })).toHaveText(["Images", "Videos", "Audio", "Documents", "Other files"]);
  for (const upload of [f.imageUpload, f.videoUpload, f.audioUpload, f.pdfUpload, f.otherUpload])
    await expect(assetCard(page, "upload", upload.id)).toContainText(upload.filename);
  await selectSource(collective,'Generations');
  for (const id of [f.generationImage, f.generationVideo]) await expect(assetCard(page, "generation", id)).toBeVisible();
  await selectSource(collective,'Uploads');
  const query = page.getByRole("textbox", { name: "Search all workspace assets", exact: true });
  await query.fill("Original screenplay");
  await expect(assetCard(page, "upload", f.pdfUpload.id)).toBeVisible();
  await expect(assetCard(page, "upload", f.imageUpload.id)).toHaveCount(0);
  await query.fill("");
  const original = await page.request.get(`${f.imageUpload.url}?download=1`);
  expect(original.ok()).toBe(true);
  expect(await original.body()).toEqual(f.image);
  expect(original.headers()["content-disposition"]).toContain("attachment");
  const finish = page.waitForResponse(response => new URL(response.url()).pathname === "/api/uploads/finish" && response.request().method() === "POST");
  await collective.getByLabel("Upload library assets", { exact: true }).setInputFiles({ name: "Collective lighting source.png", mimeType: "image/png", buffer: f.image });
  const receipt = await finish;
  expect(receipt.ok(), await receipt.text()).toBe(true);
  const uploaded = await receipt.json() as Upload;
  await expect(assetCard(page, "upload", uploaded.id)).toBeVisible();
  for (const name of ["Elements", "References", "Unfiled takes"]) {
    await page.getByRole("group", { name: "Asset library views", exact: true }).getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("button", { name: "New asset", exact: false }).filter({ visible: true })).toBeVisible();
  }
  await page.getByRole("group", { name: "Asset library views", exact: true }).getByRole("button", { name: "All files", exact: true }).click();
  await expect(assetCard(page, "upload", uploaded.id)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("collective-assets.png"), fullPage: true });
  await chooseAssetAction(page, assetCard(page, "upload", f.imageUpload.id), "Use as reference");
  await expect(page).toHaveURL(new RegExp(`mode=images&ref=upload%3A${f.imageUpload.id}`));
  await expect(page.getByRole("button", { name: "Remove Original lighting reference.png", exact: true })).toBeVisible();
  await allAssets.click();
  await expect(page).toHaveURL(/\/library\?.*all=1/);
  await expect(collective).toBeVisible();
  await chooseAssetAction(page, assetCard(collective, "upload", f.videoUpload.id), "Edit clip");
  await expect(page).toHaveURL(new RegExp(`mode=video&task=edit&source=upload%3A${f.videoUpload.id}`));
  await expect(page.getByRole("region", { name: "Seedance 2.5 Edit", exact: true }).getByLabel("Source clip", { exact: true })).toHaveValue(`upload:${f.videoUpload.id}`);
  await allAssets.click();
  // Gen also renders these take cards on desktop. Confirm the destination
  // before opening its menu, otherwise navigation can remove Gen’s old menu.
  await expect(page).toHaveURL(/\/library\?.*all=1/);
  await expect(collective).toBeVisible();
  await selectSource(collective,'Generations');
  await assetCard(collective, "generation", f.generationImage).getByRole("button", { name: "Actions for Filed lighting take", exact: true }).click();
  await page.getByRole("menu", { name: "Actions for Filed lighting take", exact: true })
    .getByRole("menuitem", { name: "Use prompt", exact: true }).click();
  await expect(page.getByRole("region", { name: "Images composer", exact: true }).getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("Filed lighting take prompt");
  expect(f.paidRequests()).toBe(0);
  expect(errors).toEqual([]);
});
