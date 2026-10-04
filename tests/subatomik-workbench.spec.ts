import { test, expect, type Page, type Locator } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { saveSchema } from "../lib/workbench/studio-schema";
import { GENJUTSU_MODELS } from "../lib/genjutsuTypes";
import { legacyShell } from "./helpers/legacyShell";

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=",
  "base64",
);
const wallet = "22222222-2222-4222-8222-222222222222",
  consumerProviderId = "33333333-3333-4333-8333-333333333333";
const consumerGenerationId = `gen_hfc_${"c".repeat(40)}`;
type ConsumerJob = Record<string, unknown> & { id: string; status: string };
async function fixture(
  page: Page,
  lostResponse = false,
  consumerOptions: {
    loseSubmit?: boolean;
    loseQuote?: boolean;
    connected?: boolean;
  } = {},
) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  me.owner = true;
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  let project: Project = {
    ...newProject("Viral launch"),
    id: "viral-draft",
    productionProjectId: "viral-production",
  };
  let revision = 1,
    finished = false,
    cancellationRequested = false,
    cancelled = false;
  const quotes: Record<string, unknown>[] = [],
    posts: { key: string; body: Record<string, unknown> }[] = [],
    unexpected: string[] = [],
    errors: string[] = [];
  const consumerJobs: ConsumerJob[] = [],
    consumerPosts: Record<string, unknown>[] = [];
  const uploads = [
    {
      id: "motion-original",
      filename: "Camera movement.mp4",
      kind: "video",
      mime: "video/mp4",
      durationS: 5,
      bytes: 10000,
      width: 640,
      height: 360,
      createdAt: Date.now(),
      url: "/api/uploads/motion-original",
    },
    {
      id: "wardrobe-original",
      filename: "Wardrobe.png",
      kind: "image",
      mime: "image/png",
      bytes: 500,
      width: 512,
      height: 512,
      createdAt: Date.now(),
      url: "/api/uploads/wardrobe-original",
    },
    {
      id: "world-original",
      filename: "World.png",
      kind: "image",
      mime: "image/png",
      bytes: 500,
      width: 512,
      height: 512,
      createdAt: Date.now(),
      url: "/api/uploads/world-original",
    },
  ];
  const sourceTake = {
    id: "saved-camera-take",
    title: "Generated movement",
    kind: "video",
    model: "seedance",
    prompt: "Camera move",
    params: { duration: 5 },
    status: "succeeded",
    storedUrl: "/api/media/saved-camera-take",
    createdAt: Date.now(),
  };
  const take = () => ({
    id: "genjutsu-result",
    kind: "video",
    model: String(posts[0]?.body.model ?? GENJUTSU_MODELS["motion-transfer"]),
    title: "Recast take",
    prompt: "Recast in a silver suit.",
    params: {
      sourceUploadId: posts[0]?.body.sourceUploadId,
      sourceGenId: posts[0]?.body.sourceGenId,
      resolution: posts[0]?.body.resolution ?? "720p",
      workbenchProjectId: "viral-draft",
      references: (
        (posts[0]?.body.references ?? []) as Record<string, unknown>[]
      ).map((ref) => ({ ...ref, kind: "image" })),
      duration: 5,
      videoMetadata: { seconds: 5 },
    },
    projectId: project.productionProjectId,
    status: cancelled ? "cancelled" : finished ? "succeeded" : "queued",
    storedUrl: finished ? "/api/media/genjutsu-result" : null,
    estimatedCredits: 12,
    creditsBilled: finished ? 12 : null,
    createdAt: Date.now(),
    createdBy: me.id,
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    const json = (data: unknown, status = 200) =>
      route.fulfill({ json: data, status });
    if (path === "/api/me") return json(me);
    if (path === "/api/higgsfield/consumer/connection") {
      expect(req.headers()["x-workbench-scope"]).toBe(scope);
      return json({
        connected: consumerOptions.connected ?? true,
        requiresReconnect: false,
      });
    }
    if (path === "/api/higgsfield/consumer/genjutsu") {
      expect(req.headers()["x-workbench-scope"]).toBe(scope);
      if (req.method() === "GET")
        return json({
          connection: {
            connected: consumerOptions.connected ?? true,
            requiresReconnect: false,
          },
          capabilities: {
            resolutions: ["480p", "720p", "1080p"],
            minSeconds: 4,
            maxSeconds: 30,
            maxImages: 30,
            maxMediaBytes: 52428800,
          },
          jobs: consumerJobs,
        });
      const body = req.postDataJSON();
      consumerPosts.push(body);
      expect(body.draftId).toBe("viral-draft");
      if (body.action === "quote") {
        const existing = consumerJobs.find(
          (job) => job.quoteKey === body.idempotencyKey,
        );
        if (existing) return json({ job: existing });
        const job: ConsumerJob = {
          id: `11111111-1111-4111-8111-${String(consumerJobs.length + 1).padStart(12, "0")}`,
          status: "quoted",
          draftId: "viral-draft",
          input: body.input,
          quoteKey: body.idempotencyKey,
          workspaceId: wallet,
          workspaceName: "Fixture wallet",
          quoteCredits: 18,
          creditUnit: "higgsfield_credits",
          quoteExpiresAt: Date.now() + 300000,
          createdAt: Date.now(),
          providerJobId: null,
        };
        consumerJobs.push(job);
        if (
          consumerOptions.loseQuote &&
          consumerPosts.filter((p) => p.action === "quote").length === 1
        )
          return route.abort("connectionreset");
        return json({ job });
      }
      const job = consumerJobs.find((item) => item.id === body.id);
      expect(job).toBeTruthy();
      if (!job) return json({ error: "Unavailable" }, 404);
      if (body.action === "submit") {
        expect(body).toEqual({
          action: "submit",
          draftId: "viral-draft",
          id: job.id,
          workspaceId: wallet,
          credits: 18,
        });
        job.status = consumerOptions.loseSubmit ? "uncertain" : "accepted";
        job.providerJobId = consumerProviderId;
        job.providerReceipt = { job_id: consumerProviderId };
        if (consumerOptions.loseSubmit) return route.abort("connectionreset");
        return json({ job });
      }
      if (body.action === "status") {
        job.status = "completed";
        job.originalAvailable = true;
        job.originalAvailability = "available";
        job.result = {
          original: {
            generationId: consumerGenerationId,
            providerJobId: consumerProviderId,
            bytes: 1234,
            sha256: "b".repeat(64),
            width: 1080,
            height: 1920,
            seconds: 5,
            credits: 18,
            creditUnit: "higgsfield_credits",
            asset: {
              generationId: consumerGenerationId,
              url: `/api/media/${consumerGenerationId}`,
              kind: "video",
              mime: "video/mp4",
              width: 1080,
              height: 1920,
              durationS: 5,
            },
          },
        };
        return json({ job, pollAfterSeconds: 15 });
      }
    }
    if (path === "/api/workbench/projects") {
      expect(req.headers()["x-workbench-scope"]).toBe(scope);
      if (req.method() === "PUT") {
        project = saveSchema.parse(req.postDataJSON()).project as Project;
        return json({
          revision: ++revision,
          productionProjectId: project.productionProjectId,
          shotMappings: project.shotMappings ?? {},
        });
      }
      return json({
        project: url.searchParams.get("id") === "missing" ? null : project,
        revision,
        projects: [{ id: project.id, name: project.name }],
        productions: [],
      });
    }
    if (path === "/api/projects")
      return json({
        projects: [{ id: project.productionProjectId, name: project.name }],
      });
    if (path === "/api/workbench/library")
      return json({
        uploads: [],
        generations: posts.length ? [take()] : [],
        nextCursor: null,
        nextPageCursor: null,
      });
    if (path === "/api/uploads")
      return json({ uploads, nextCursor: null, nextPageCursor: null });
    const upload = uploads.find(
      (item) => path === `/api/uploads/${item.id}/metadata`,
    );
    if (upload) {
      expect(req.headers()["x-workbench-scope"]).toBe(scope);
      return json({ upload });
    }
    if (
      path === "/api/uploads/wardrobe-original" ||
      path === "/api/uploads/world-original"
    )
      return route.fulfill({ body: pixel, contentType: "image/png" });
    if (
      path === "/api/uploads/motion-original" ||
      path.startsWith("/api/media/")
    )
      return route.fulfill({
        path: "public/fixtures/clip.mp4",
        contentType: "video/mp4",
      });
    if (path === "/api/jobs")
      return json({
        generations: [sourceTake],
        nextCursor: null,
        nextPageCursor: null,
      });
    if (path === "/api/jobs/saved-camera-take")
      return json({ generation: sourceTake });
    if (path === "/api/jobs/genjutsu-result") {
      if (cancellationRequested) cancelled = true;
      else finished = true;
      return json({ generation: take() });
    }
    if (path === "/api/generations/genjutsu-result/cancel") {
      expect(req.headers()["x-workbench-scope"]).toBe(scope);
      cancellationRequested = true;
      return json({ status: "requested" }, 202);
    }
    if (path === "/api/generate/quote") {
      expect(req.headers()["x-workbench-scope"]).toBe(scope);
      quotes.push(req.postDataJSON());
      return json({
        fingerprint: "a".repeat(64),
        estimatedCredits: 12,
        price: 12,
        unit: "cr",
      });
    }
    if (path === "/api/generate") {
      expect(req.headers()["x-workbench-scope"]).toBe(scope);
      posts.push({
        key: req.headers()["idempotency-key"],
        body: req.postDataJSON(),
      });
      if (lostResponse && posts.length === 1) return route.abort("failed");
      return json({ id: "genjutsu-result" });
    }
    if (path === "/api/workbench/atomik")
      return json({ configured: false, models: [], jobs: [] });
    if (path === "/api/atomik/chats") return json({ chats: [] });
    if (path === "/api/pipelines")
      return json({
        runs: [],
        publications: [],
        models: [],
        audio: { configured: false, voices: [], speechModels: [] },
      });
    if (path === "/api/settings")
      return json({ settings: {}, defaults: {}, models: null });
    if (path === "/api/engines" || path === "/api/workbench/engines")
      return json({ engines: [], models: [] });
    if (req.method() !== "GET") unexpected.push(`${req.method()} ${path}`);
    return json({});
  });
  return {
    quotes,
    posts,
    consumerJobs,
    consumerPosts,
    errors,
    unexpected,
    get project() {
      return project;
    },
  };
}
async function useCard(page: Page, id: string) {
  const card = page.locator(`[data-library-id="${id}"]`);
  if (page.viewportSize()!.width < 760) {
    await card.getByRole("button", { name: /^Actions for / }).click();
    await page
      .getByRole("menuitem", { name: "Use as reference", exact: true })
      .click();
  } else
    await card
      .getByRole("button", { name: "Use as reference", exact: true })
      .click();
}
async function dropIdentity(
  page: Page,
  target: Locator,
  id: string,
  origin: "upload" | "gen",
) {
  const data = await page.evaluateHandle(
    ({ id, origin }) => {
      const d = new DataTransfer();
      d.setData(
        "application/x-particl-asset",
        JSON.stringify(
          origin === "upload"
            ? {
                kind: "upload",
                upload: {
                  id,
                  filename: "Forged name",
                  url: "https://untrusted.invalid/file",
                  durationS: 0,
                },
              }
            : {
                kind: "gen",
                gen: { id, storedUrl: "https://untrusted.invalid/file" },
              },
        ),
      );
      return d;
    },
    { id, origin },
  );
  await target.dispatchEvent("drop", { dataTransfer: data });
  await data.dispose();
}

test("Subatomik uses verified shared originals, reviews each quote, stores a result and hands it to Edit", async ({
  page,
}, info) => {
  const f = await fixture(page);
  await page.goto(await legacyShell(page, "/subatomik?project=viral-draft&page=motion-transfer&account=particl"));
  await expect(
    page.getByRole("heading", { name: "Subatomik Viral Studio", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Suites", exact: true })
      .getByRole("link"),
  ).toHaveCount(4);
  await expect(
    page.getByRole("button", { name: "Review transform cost", exact: true }),
  ).toBeDisabled();
  await useCard(page, "upload:motion-original");
  await expect(page.getByRole("button", { name: "Review transform cost", exact: true })).toBeDisabled();
  expect(f.quotes).toHaveLength(0);
  /* The page takes one asset at a time (a drop while another is still being added is refused): the source is in first. */
  await expect(page.getByLabel("Transform source preview")).toHaveAttribute("src", "/api/uploads/motion-original");
  await dropIdentity(
    page,
    page.getByLabel("Transform reference drop area"),
    "wardrobe-original",
    "upload",
  );
  await expect(page.getByLabel("Transform source preview")).toHaveAttribute(
    "src",
    "/api/uploads/motion-original",
  );
  await expect(
    page.getByRole("button", {
      name: "Remove reference Wardrobe.png",
      exact: true,
    }),
  ).toBeVisible();
  await dropIdentity(
    page,
    page.getByLabel("Transform reference drop area"),
    "world-original",
    "upload",
  );
  await page
    .getByRole("button", {
      name: "Move reference World.png earlier",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Enlarge reference World.png", exact: true })
    .click();
  const preview = page.getByRole("dialog", {
    name: "Reference image preview",
    exact: true,
  });
  await expect(preview).toBeVisible();
  await expect(
    preview.getByRole("link", {
      name: "Download reference original",
      exact: true,
    }),
  ).toHaveAttribute("href", "/api/uploads/world-original?download=1");
  await preview
    .getByRole("button", { name: "Close reference preview", exact: true })
    .click();
  await page
    .getByLabel("Transform creative direction")
    .fill("Recast in a silver suit.");
  await page
    .getByRole("button", { name: "Review transform cost", exact: true })
    .click();
  const approve = page.getByRole("checkbox", {
    name: "Approve 12 cr for this generation.",
    exact: true,
  });
  await expect(approve).toBeVisible();
  expect(f.posts).toHaveLength(0);
  await expect(
    page.getByRole("button", { name: "Generate · 12 cr", exact: true }),
  ).toBeDisabled();
  await approve.check();
  await page.getByLabel("Transform output quality").selectOption("480p");
  await expect(page.getByLabel("Transform generation quote")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Review transform cost", exact: true })
    .click();
  await expect(approve).not.toBeChecked();
  await approve.check();
  await page
    .getByRole("button", { name: "Generate · 12 cr", exact: true })
    .click();
  await expect.poll(() => f.posts.length).toBe(1);
  expect(f.posts[0].key).toBeTruthy();
  expect(f.posts[0].body).toMatchObject({
    model: GENJUTSU_MODELS["motion-transfer"],
    task: "genjutsu",
    sourceUploadId: "motion-original",
    references: [
      { uploadId: "world-original", role: "reference_image" },
      { uploadId: "wardrobe-original", role: "reference_image" },
    ],
    resolution: "480p",
    prompt: "Recast in a silver suit.",
    projectId: "viral-production",
    workbenchProjectId: "viral-draft",
    maxCredits: 12,
    quoteFingerprint: "a".repeat(64),
    refine: false,
  });
  expect(JSON.stringify(f.posts)).not.toContain("untrusted.invalid");
  await page
    .getByRole("button", { name: "Refresh results", exact: true })
    .click();
  await expect(page.getByLabel("Transform after preview")).toHaveAttribute(
    "src",
    "/api/media/genjutsu-result?stream=1",
  );
  await expect(page.getByLabel("Transform before preview")).toHaveAttribute(
    "src",
    "/api/uploads/motion-original",
  );
  await expect(
    page.getByRole("link", { name: "Download original", exact: true }),
  ).toHaveAttribute("href", "/api/media/genjutsu-result?download=1");
  await page.getByRole("button", { name: "Wipe view", exact: true }).click();
  await page
    .getByRole("slider", { name: "Comparison wipe position", exact: true })
    .press("End");
  await expect(
    page.getByRole("slider", { name: "Comparison wipe position", exact: true }),
  ).toHaveValue("100");
  await page
    .getByLabel("Comparison playback speed", { exact: true })
    .selectOption("0.5");
  await page
    .getByRole("button", { name: "Play comparison", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Pause comparison", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Pause comparison", exact: true })
    .click();
  await page
    .getByRole("slider", { name: "Comparison playback position", exact: true })
    .press("End");
  expect(
    await page
      .getByLabel("Transform before preview", { exact: true })
      .evaluate((video: HTMLVideoElement) =>
        Math.abs(
          video.currentTime -
            (
              document.querySelector(
                '[aria-label="Transform after preview"]',
              ) as HTMLVideoElement
            ).currentTime,
        ),
      ),
  ).toBeLessThan(0.12);
  await page
    .getByLabel("Transform creative direction")
    .fill("An unsaved later idea.");
  await page.getByLabel("Transform output quality").selectOption("720p");
  await page.getByRole("button", { name: "Recreate", exact: true }).click();
  await expect(page.getByLabel("Transform creative direction")).toHaveValue(
    "Recast in a silver suit.",
  );
  await expect(page.getByLabel("Transform output quality")).toHaveValue("480p");
  await expect(page.getByLabel("Transform generation quote")).toHaveCount(0);
  expect(f.posts).toHaveLength(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("subatomik-ready-original.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Use in Edit", exact: true }).click();
  await expect(page).toHaveURL("/workbench?project=viral-draft&stage=edit");
  expect(
    f.project.assets.some((asset) => asset.generationId === "genjutsu-result"),
  ).toBe(true);
  expect(f.project.shots).toHaveLength(1);
  expect(f.posts).toHaveLength(1);
  expect(f.unexpected).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("Object Swap recovers the exact request after reload and cannot turn a lost response into another charge", async ({
  page,
}) => {
  const f = await fixture(page, true);
  await page.goto(await legacyShell(page, "/subatomik?project=viral-draft&page=object-swap&account=particl"));
  await dropIdentity(
    page,
    page.getByLabel("Transform source drop area"),
    "saved-camera-take",
    "gen",
  );
  await expect(page.getByLabel("Transform source preview")).toHaveAttribute(
    "src",
    "/api/media/saved-camera-take",
  );
  await dropIdentity(page, page.getByLabel("Transform reference drop area"), "wardrobe-original", "upload");
  await page
    .getByRole("button", { name: "Review transform cost", exact: true })
    .click();
  await page
    .getByRole("checkbox", {
      name: "Approve 12 cr for this generation.",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Generate · 12 cr", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Recover saved transform request",
      exact: true,
    }),
  ).toBeEnabled();
  await page.reload();
  await expect(page.getByLabel("Transform creative direction")).toBeDisabled();
  await page
    .getByRole("button", {
      name: "Recover saved transform request",
      exact: true,
    })
    .click();
  await expect.poll(() => f.posts.length).toBe(2);
  expect(f.posts[1]).toEqual(f.posts[0]);
  expect(f.posts[0].body).toMatchObject({
    model: GENJUTSU_MODELS["object-swap"],
    sourceGenId: "saved-camera-take",
    prompt: "",
    references: [{ uploadId: "wardrobe-original", role: "reference_image" }],
  });
  await expect(
    page.getByRole("button", {
      name: "Recover saved transform request",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(f.quotes).toHaveLength(1);
  expect(f.unexpected).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("queued cancellation remains pending until the existing job confirms it", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto(await legacyShell(page, "/subatomik?project=viral-draft&page=motion-transfer&account=particl"));
  await useCard(page, "upload:motion-original");
  // One asset at a time: the source is in before the reference is dropped.
  await expect(page.getByLabel("Transform source preview")).toHaveAttribute("src", "/api/uploads/motion-original");
  await dropIdentity(page, page.getByLabel("Transform reference drop area"), "wardrobe-original", "upload");
  await page
    .getByRole("button", { name: "Review transform cost", exact: true })
    .click();
  await page
    .getByRole("checkbox", {
      name: "Approve 12 cr for this generation.",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Generate · 12 cr", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Request cancellation", exact: true })
    .click();
  await expect(
    page.getByText("Cancellation requested · awaiting confirmation", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Download original", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Refresh results", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Subatomik project results" }),
  ).toContainText("cancelled");
  await expect(
    page.getByRole("button", { name: "Request cancellation", exact: true }),
  ).toHaveCount(0);
  expect(f.posts).toHaveLength(1);
  expect(f.unexpected).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("the page always bills the Particl workspace: the owner's account is never read, there is no connect prompt, no toggle and no account link; an old account link and Shorts say so", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto(await legacyShell(page, "/subatomik?project=viral-draft&page=motion-transfer"));
  await expect(page.getByRole("button", { name: "Review transform cost", exact: true })).toBeVisible();
  await expect(page.getByText("No connected account yet.")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Workspace settings", exact: true })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Transform billing account" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Connected account transform", exact: true })).toHaveCount(0);
  await expect(page.locator('a[href*="higgsfield.ai"]')).toHaveCount(0);
  await expect(page.getByText(/Use connected credits instead/)).toHaveCount(0);
  /* A link from before the retirement that asked for the account bills the workspace too. */
  await page.goto(await legacyShell(page, "/subatomik?project=viral-draft&page=motion-transfer&account=higgsfield"));
  await expect(page.getByRole("button", { name: "Review transform cost", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Connected account transform", exact: true })).toHaveCount(0);
  /* Shorts ran only on the account: the page says it is retired, and asks nothing. */
  await page.goto(await legacyShell(page, "/subatomik?project=viral-draft&page=shorts"));
  await expect(page.getByTestId("subatomik-shorts-retired")).toContainText("Shorts is retired. The connected account is no longer used. Past results stay in your Library.");
  expect(f.consumerPosts).toEqual([]);
  expect(f.unexpected).toEqual([]);
  expect(f.errors).toEqual([]);
});
