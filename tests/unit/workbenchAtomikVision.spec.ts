import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { db, ready } from "../../lib/db";
import { runInTenant, type TenantWorkspace } from "../../lib/tenant";
import { catalog, type CatalogModel } from "../../lib/catalog";
import { atomikPublicResponse } from "../../lib/workbench/atomik-response";
import { seedProject, type Asset } from "../../lib/workbench/studio";
import { workbenchReady } from "../../lib/workbench/records";
import { loadAtomikReferences } from "../../lib/workbench/atomik-references";
import {
  ATOMIK_IMAGE_TOKENS,
  atomikFrameTimes,
} from "../../lib/workbench/atomik-reference-types";
import {
  atomikRequestSchema,
  prepareAtomikJob,
  quoteAtomikJob,
  runAtomikJob,
  type AtomikDependencies,
} from "../../lib/workbench/atomik-server";
import {
  atomikPendingInput,
  persistPendingAtomik,
  readPendingAtomik,
} from "../../lib/workbench/atomik-pending-request";

const dir = mkdtempSync(path.join(tmpdir(), "atomik-vision-"));
test("credit responses omit internal dollar costs, rates and caps at every nested job boundary", () => {
  const state = {
    models: [
      { id: "vision", vision: true, inputPerMillion: 1, outputPerMillion: 2 },
    ],
    budgets: { maxRequestUsd: 0.25 },
    jobs: [
      {
        id: "job",
        estimateUsd: 0.02,
        costUsd: 0.01,
        estimateCredits: 2,
        credits: 1,
      },
    ],
    job: { id: "job", estimateUsd: 0.02 },
    estimateUsd: 0.02,
    estimateCredits: 2,
  };
  const customer = atomikPublicResponse(state, true);
  expect(JSON.stringify(customer)).not.toMatch(/Usd|PerMillion|budgets/);
  expect(customer).toMatchObject({
    models: [{ id: "vision", vision: true }],
    jobs: [{ id: "job", estimateCredits: 2, credits: 1 }],
    estimateCredits: 2,
  });
  expect(atomikPublicResponse(state, false)).toEqual(state);
});
function workspace(): TenantWorkspace {
  const id = randomUUID();
  return {
    id,
    slug: "unit",
    name: "Unit",
    legacy: false,
    dbUrl: "file:" + path.join(dir, id + ".db"),
    dbToken: null,
    keys: { gateway: "mock-only" },
    usesPlatformKeys: false,
    allowanceUsd: null,
    gatewayKeyId: null,
    ownerId: "owner",
    createdAt: 0,
    suspendedAt: null,
    suspendedReason: null,
    flaggedAt: null,
    flagNote: null,
    concurrency: 3,
    rendersPerHour: 30,
    storageQuotaBytes: null,
    deletedAt: null,
  };
}
const image = () =>
  sharp({
    create: { width: 800, height: 400, channels: 3, background: "#269dce" },
  })
    .png()
    .toBuffer();
const model: CatalogModel = {
  id: "anthropic/claude-sonnet-4.6",
  name: "Vision",
  owner: "test",
  type: "language",
  description: "",
  contextWindow: 200000,
  maxTokens: 8000,
  inputModalities: ["text", "image"],
  pricing: { input: 0.0000001, output: 0.0000003 },
};
async function upload(id: string, mime = "image/png", size = 200) {
  await db().execute({
    sql: `INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,duration_s,created_at) VALUES(?,?,?,'png',?,'test',?,?,6,?)`,
    args: [
      id,
      id,
      mime,
      size,
      "/api/uploads/" + id,
      mime.startsWith("video") ? "video" : "image",
      Date.now(),
    ],
  });
}
function asset(id: string, fields: Partial<Asset> = {}): Asset {
  return {
    ...seedProject().assets[0],
    id,
    url: "/api/uploads/" + id,
    uploadId: id,
    ...fields,
  };
}
async function fixture() {
  await ready();
  const project = {
    ...seedProject(),
    id: "draft-" + randomUUID(),
    productionProjectId: "production-" + randomUUID(),
  };
  await db().execute({
    sql: `INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,'owner',?,?,?,1,?)`,
    args: [
      "key-" + project.id,
      project.id,
      project.name,
      JSON.stringify(project),
      Date.now(),
    ],
  });
  const input = atomikRequestSchema.parse({
    projectId: project.id,
    requestId: randomUUID(),
    request: "Compare the image lighting and continuity",
    refs: ["hero"],
  });
  let calls = 0,
    reservations = 0,
    payload = "";
  const deps: Partial<AtomikDependencies> = {
    models: async () => [model],
    allowance: async () => ({ ok: true }),
    limits: async () => ({
      allow: true,
      limits: { concurrency: 3, rendersPerHour: 30, storageBytes: 1000000 },
      standing: { running: 0, startedLastHour: 0, usedBytes: 0 },
    }),
    reserve: async () => {
      reservations++;
    },
    meter: async () => {},
    auth: async () => ({}),
    run: async (request) => {
      calls++;
      payload = request.body;
      return {
        ok: true,
        status: 200,
        text: JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  intent: "continuity",
                  summary: "Review the supplied lighting.",
                  steps: ["Match key-light direction."],
                }),
              },
            },
          ],
          usage: { cost: 0.001 },
        }),
      };
    },
  };
  return {
    project,
    input,
    deps,
    calls: () => calls,
    reservations: () => reservations,
    payload: () => payload,
  };
}

test("catalog derives vision capability from the live modality field, never model names or descriptions", async () => {
  await runInTenant(workspace(), async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json({
        data: [
          { id: "test/actual", modalities: { input: ["text", "image", 99] } },
          {
            id: "test/vision-by-name",
            description: "A visual image model",
            modalities: { input: ["text"] },
          },
        ],
      });
    try {
      const models = await catalog(true);
      expect(models[0].inputModalities).toEqual(["text", "image"]);
      expect(models[1].inputModalities).toEqual(["text"]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

test("an uploaded raster supplies normalized pixels, dimensions and evidence hash after tenant lookup", async () => {
  await runInTenant(workspace(), async () => {
    await ready();
    await upload("photo");
    const bytes = await image();
    let reads = 0;
    const project = { ...seedProject(), assets: [asset("photo")] };
    const result = await loadAtomikReferences(project, ["photo"], "owner", [], {
      upload: async (id) => {
        expect(id).toBe("photo");
        reads++;
        return bytes;
      },
    });
    expect(reads).toBe(1);
    expect(result.inputTokens).toBe(ATOMIK_IMAGE_TOKENS);
    expect(result.images[0]).toMatchObject({
      assetId: "photo",
      width: 512,
      height: 256,
      firstFrameOnly: false,
    });
    expect(result.images[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    const sent = Buffer.from(result.images[0].dataUrl.split(",")[1], "base64");
    expect((await sharp(sent).metadata()).format).toBe("jpeg");
    expect(await sharp(sent).raw().toBuffer()).not.toHaveLength(0);
  });
});

test("foreign uploads, private legacy files and arbitrary URLs cannot reach a storage reader", async () => {
  const first = workspace(),
    second = workspace();
  await runInTenant(first, async () => {
    await ready();
    await upload("private-upload");
  });
  await runInTenant(second, async () => {
    await ready();
    let reads = 0;
    const readers = {
      upload: async () => {
        reads++;
        return image();
      },
      image: async () => {
        reads++;
        return image();
      },
      sample: async () => {
        reads++;
        return image();
      },
    };
    for (const selected of [
      asset("private-upload"),
      asset("remote", {
        uploadId: undefined,
        url: "http://169.254.169.254/latest/meta-data",
      }),
      asset("traversal", {
        uploadId: undefined,
        url: "/campaign/../../secrets",
      }),
    ]) {
      await expect(
        loadAtomikReferences(
          { ...seedProject(), assets: [selected] },
          [selected.id],
          "owner",
          [],
          readers,
        ),
      ).rejects.toThrow();
    }
    await db().execute({
      sql: `INSERT INTO workbench_media(id,owner,name,mime,ext,size,stored_url,sha256) VALUES('legacy','other-owner','Private','image/png','png',200,'private','hash')`,
      args: [],
    });
    const selected = asset("legacy-ref", {
      uploadId: undefined,
      url: "/api/workbench/media/legacy",
    });
    await expect(
      loadAtomikReferences(
        { ...seedProject(), assets: [selected] },
        [selected.id],
        "owner",
        [],
        readers,
      ),
    ).rejects.toThrow("private upload");
    expect(reads).toBe(0);
    await workbenchReady();
    await db().execute({
      sql: `INSERT INTO workbench_bibles(project_id,version,owner,body,created_at) VALUES('published',1,'other-owner',?,?)`,
      args: [JSON.stringify({ assets: [selected] }), Date.now()],
    });
    expect(
      (
        await loadAtomikReferences(
          { ...seedProject(), assets: [selected] },
          [selected.id],
          "owner",
          [],
          readers,
        )
      ).images,
    ).toHaveLength(1);
  });
});

test("completed generated stills are read by their tenant ID and deleted takes are rejected", async () => {
  await runInTenant(workspace(), async () => {
    await ready();
    await db().execute({
      sql: `INSERT INTO generations(id,model,prompt,params,status,kind,bytes,stored_url,created_at,updated_at) VALUES('take','mock','','{}','succeeded','image',100,'/api/media/take',?,?)`,
      args: [Date.now(), Date.now()],
    });
    const selected = asset("take-ref", {
      uploadId: undefined,
      generationId: "take",
      url: "/api/media/take",
    });
    let reads = 0;
    const readers = {
      image: async (id: string) => {
        expect(id).toBe("take");
        reads++;
        return image();
      },
    };
    expect(
      (
        await loadAtomikReferences(
          { ...seedProject(), assets: [selected] },
          [selected.id],
          "owner",
          [],
          readers,
        )
      ).images,
    ).toHaveLength(1);
    await db().execute("UPDATE generations SET deleted=1 WHERE id='take'");
    await expect(
      loadAtomikReferences(
        { ...seedProject(), assets: [selected] },
        [selected.id],
        "owner",
        [],
        readers,
      ),
    ).rejects.toThrow("unavailable");
    expect(reads).toBe(1);
  });
});

test("oversized, corrupt, duplicate and excessive references fail before a model call", async () => {
  await runInTenant(workspace(), async () => {
    await ready();
    await upload("oversized", "image/png", 33 * 1024 * 1024);
    await upload("corrupt");
    let reads = 0;
    const readers = {
      upload: async () => {
        reads++;
        return Buffer.from("<svg>not a raster</svg>");
      },
    };
    await expect(
      loadAtomikReferences(
        { ...seedProject(), assets: [asset("oversized")] },
        ["oversized"],
        "owner",
        [],
        readers,
      ),
    ).rejects.toThrow("32 MB");
    expect(reads).toBe(0);
    await expect(
      loadAtomikReferences(
        { ...seedProject(), assets: [asset("corrupt")] },
        ["corrupt"],
        "owner",
        [],
        readers,
      ),
    ).rejects.toThrow("decoded safely");
    await expect(
      loadAtomikReferences(seedProject(), ["hero", "hero"], "owner"),
    ).rejects.toThrow("only once");
    const assets = Array.from({ length: 7 }, (_, i) => asset("item-" + i));
    await expect(
      loadAtomikReferences(
        { ...seedProject(), assets },
        assets.map((a) => a.id),
        "owner",
        [],
        readers,
      ),
    ).rejects.toThrow("six images");
  });
});

test("a sampled time past the end of a generation-backed video is refused, from the column or the rendered duration", async () => {
  await runInTenant(workspace(), async () => {
    await ready();
    const take = async (id: string, durationS: number | null, params: string) =>
      db().execute({
        sql: `INSERT INTO generations(id,model,prompt,params,status,kind,bytes,stored_url,duration_s,created_at,updated_at) VALUES(?,'mock','',?,'succeeded','video',100,?,?,?,?)`,
        args: [id, params, "/api/media/" + id, durationS, Date.now(), Date.now()],
      });
    await take("measured", 6, "{}");
    await take("rendered", null, '{"duration":6}');
    await take("unknown", null, "{}");
    const frames = atomikFrameTimes(6).map((timeSeconds, i) => ({
      assetId: "take-clip",
      uploadId: "gen-frame-" + i,
      timeSeconds,
    }));
    for (const frame of frames) await upload(frame.uploadId);
    const readers = { upload: async () => image(), image: async () => image() };
    const projectFor = (generationId: string) => ({
      ...seedProject(),
      assets: [
        asset("take-clip", {
          kind: "video" as const,
          uploadId: undefined,
          generationId,
          url: "/api/media/" + generationId,
        }),
      ],
    });
    for (const generationId of ["measured", "rendered"]) {
      const project = projectFor(generationId);
      expect(
        (
          await loadAtomikReferences(
            project,
            ["take-clip"],
            "owner",
            frames,
            readers,
          )
        ).images.map((frame) => frame.timeSeconds),
      ).toEqual([0.6, 3, 5.4]);
      await expect(
        loadAtomikReferences(
          project,
          ["take-clip"],
          "owner",
          [{ ...frames[0], timeSeconds: 7 }, ...frames.slice(1)],
          readers,
        ),
      ).rejects.toThrow("outside");
    }
    // No length on the take and none in its params: unbounded, held only by the ceiling.
    await expect(
      loadAtomikReferences(
        projectFor("unknown"),
        ["take-clip"],
        "owner",
        [{ ...frames[0], timeSeconds: 3601 }, ...frames.slice(1)],
        readers,
      ),
    ).rejects.toThrow("outside");
    expect(
      (
        await loadAtomikReferences(
          projectFor("unknown"),
          ["take-clip"],
          "owner",
          [{ ...frames[0], timeSeconds: 7 }, ...frames.slice(1)],
          readers,
        )
      ).images,
    ).toHaveLength(3);
  });
});

test("sampled video frames are authorized, bounded, labeled and never substituted with descriptions", async () => {
  await runInTenant(workspace(), async () => {
    await ready();
    await upload("clip", "video/mp4");
    const selected = asset("clip", { kind: "video" });
    const project = { ...seedProject(), assets: [selected] };
    const frames = atomikFrameTimes(6).map((timeSeconds, i) => ({
      assetId: "clip",
      uploadId: "frame-" + i,
      timeSeconds,
    }));
    for (const frame of frames) await upload(frame.uploadId);
    const readers = { upload: async () => image() };
    await expect(
      loadAtomikReferences(project, ["clip"], "owner", [], readers),
    ).rejects.toThrow("three representative frames");
    const result = await loadAtomikReferences(
      project,
      ["clip"],
      "owner",
      frames,
      readers,
    );
    expect(result.images.map((frame) => frame.timeSeconds)).toEqual([
      0.6, 3, 5.4,
    ]);
    expect(result.inputTokens).toBe(3 * ATOMIK_IMAGE_TOKENS);
    await expect(
      loadAtomikReferences(
        project,
        ["clip"],
        "owner",
        [{ ...frames[0], timeSeconds: 7 }, ...frames.slice(1)],
        readers,
      ),
    ).rejects.toThrow("outside");
    await expect(
      loadAtomikReferences(
        project,
        ["clip"],
        "owner",
        [{ ...frames[0], uploadId: "foreign-frame" }, ...frames.slice(1)],
        readers,
      ),
    ).rejects.toThrow("unavailable");
    await expect(
      loadAtomikReferences(
        project,
        ["clip"],
        "owner",
        [{ ...frames[0], assetId: "unselected" }, ...frames.slice(1)],
        readers,
      ),
    ).rejects.toThrow("selected video");
  });
});

test("vision-aware free quote includes visual input and auto selects a capable economy model", async () => {
  await runInTenant(workspace(), async () => {
    const f = await fixture();
    f.deps.models = async () => [
      {
        ...model,
        id: "anthropic/claude-opus-4.7",
        inputModalities: ["text"],
        pricing: { input: 0, output: 0 },
      },
      model,
    ];
    const visual = await quoteAtomikJob(f.input, "owner", f.deps);
    const text = await quoteAtomikJob(
      { ...f.input, refs: [] },
      "owner",
      f.deps,
    );
    expect(visual.model).toBe(model.id);
    expect(visual.visualCount).toBe(1);
    expect(visual.estimateUsd).toBeGreaterThan(text.estimateUsd);
    await expect(
      quoteAtomikJob({ ...f.input, model: "anthropic/claude-opus-4.7" }, "owner", f.deps),
    ).rejects.toThrow("vision-capable");
    expect(f.calls()).toBe(0);
    expect(f.reservations()).toBe(0);
    expect(
      (await db().execute("SELECT * FROM workbench_atomik_jobs")).rows,
    ).toHaveLength(0);
  });
});

test("one paid job uses the persisted pixel payload even after the source draft changes", async () => {
  await runInTenant(workspace(), async () => {
    const f = await fixture();
    const prepared = await prepareAtomikJob(
      f.input,
      "owner",
      undefined,
      f.deps,
    );
    const saved = String(
      (
        await db().execute({
          sql: "SELECT provider_body FROM workbench_atomik_jobs WHERE id=?",
          args: [prepared.job.id],
        })
      ).rows[0].provider_body,
    );
    const content = JSON.parse(saved).messages[1].content;
    expect(content[2].type).toBe("image_url");
    expect(content[2].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(content[2].image_url.detail).toBe("low");
    expect(
      JSON.parse(content[0].text).selectedReferences[0].visualEvidence[0]
        .pixelsAttached,
    ).toBe(true);
    f.project.assets[0].url = "https://untrusted.example/changed.jpg";
    await db().execute({
      sql: "UPDATE workbench_projects SET body=? WHERE project_id=?",
      args: [JSON.stringify(f.project), f.project.id],
    });
    await prepareAtomikJob(f.input, "owner", undefined, f.deps);
    await runAtomikJob(prepared.job.id, "owner", f.deps);
    await runAtomikJob(prepared.job.id, "owner", f.deps);
    expect(f.payload()).toBe(saved);
    expect(f.calls()).toBe(1);
    expect(f.reservations()).toBe(1);
  });
});

test("durable browser recovery preserves exact sampled frame IDs and timestamps", () => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
  const videoFrames = atomikFrameTimes(6).map((timeSeconds, i) => ({
    assetId: "clip",
    uploadId: "frame-" + i,
    timeSeconds,
  }));
  const body = JSON.stringify({
    projectId: "p",
    requestId: "durable-original",
    request: "Review continuity",
    model: model.id,
    depth: "Quick",
    refs: ["clip"],
    maxCredits: 2,
    videoFrames,
  });
  persistPendingAtomik(storage, "scope", "p", body);
  const recovered = readPendingAtomik(storage, "scope", "p")!;
  expect(recovered.body).toBe(body);
  expect(atomikPendingInput(recovered).videoFrames).toEqual(videoFrames);
});
