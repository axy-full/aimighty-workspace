import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { db, ready } from "../../lib/db";
import { runInTenant, type TenantWorkspace } from "../../lib/tenant";
import { seedProject, type Project } from "../../lib/workbench/studio";
import { saveSchema } from "../../lib/workbench/studio-schema";
import { EMPTY_MOLECULR } from "../../lib/workbench/moleculr";
import { referenceAdBinding } from "../../lib/workbench/reference-ad";
import {
  referenceAdFrameTimes,
  applyReferenceAdAnalysis,
  assertReferenceAnalysisSource,
  referenceAdAnalysisSchema,
  referenceAnalysisInstructions,
  type ReferenceAdAnalysis,
} from "../../lib/workbench/reference-ad-analysis";
import { loadAtomikReferences } from "../../lib/workbench/atomik-references";
import {
  atomikRequestSchema,
  quoteAtomikJob,
  prepareAtomikJob,
  runAtomikJob,
  listAtomikJobs,
  type AtomikDependencies,
} from "../../lib/workbench/atomik-server";
import {
  atomikPendingInput,
  persistPendingAtomik,
  readPendingAtomik,
} from "../../lib/workbench/atomik-pending-request";
import type { CatalogModel } from "../../lib/catalog";

const directory = mkdtempSync(path.join(tmpdir(), "reference-ad-analysis-"));
const ownedFiles: string[] = [];
test.afterAll(async () => {
  await Promise.all(ownedFiles.map((file) => rm(file, { force: true })));
  await rm(directory, { recursive: true, force: true });
});
function workspace(): TenantWorkspace {
  const id = randomUUID();
  return {
    id,
    slug: "unit",
    name: "Unit",
    legacy: false,
    dbUrl: "file:" + path.join(directory, id + ".db"),
    dbToken: null,
    keys: { gateway: "never-sent-fixture" },
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
const model: CatalogModel = {
  id: "anthropic/claude-sonnet-4.6",
  name: "Vision",
  owner: "anthropic",
  type: "language",
  description: "",
  inputModalities: ["text", "image"],
  contextWindow: 200000,
  maxTokens: 8192,
  pricing: { input: 0.0000001, output: 0.0000003 },
};
const result = {
  summary: "A restrained product reveal in sampled frames.",
  beats: [
    {
      sampleIndex: 0,
      observation: "A dark opening composition.",
      adaptation: "Introduce our bottle in a similarly clear silhouette.",
    },
    {
      sampleIndex: 11,
      observation: "A lighter final sample.",
      adaptation: "Close with the supplied product fact.",
    },
  ],
  camera: "Centred framing; camera movement is not established.",
  pacing:
    "A tonal progression is inferred between samples; cut timing is unknown.",
  colors: ["dark blue", "warm white"],
  direction:
    "Reveal our bottle in a clear silhouette, then end on its verified product fact.",
  uncertainties: ["Audio and events between samples have not been assessed."],
};
function projectFixture(): Project {
  const id = "reference-" + randomUUID();
  const asset = {
    ...seedProject().assets[0],
    id,
    uploadId: id,
    generationId: undefined,
    url: "/api/uploads/" + id,
    kind: "video" as const,
    mime: "video/mp4",
    durationS: 1.5,
    name: "Original ad",
  };
  return {
    ...seedProject(),
    id: "draft-" + randomUUID(),
    productionProjectId: "production-" + randomUUID(),
    assets: [asset],
    moleculr: {
      ...EMPTY_MOLECULR,
      productName: "Our bottle",
      referenceAd: {
        assetId: id,
        notes: "Keep this manual observation.",
        direction: "Existing direction.",
      },
    },
  };
}
function savedAnalysis(project: Project): ReferenceAdAnalysis {
  const source = referenceAdBinding(project, project.moleculr!.referenceAd!)!;
  return referenceAdAnalysisSchema.parse({
    projectId: project.id,
    jobId: randomUUID(),
    model: model.id,
    createdAt: new Date().toISOString(),
    evidence: {
      source,
      durationSeconds: 1.5,
      samples: referenceAdFrameTimes(1.5).map((timeSeconds, index) => ({
        uploadId: "frame-" + index,
        timeSeconds,
        sha256: String(index % 10).repeat(64),
      })),
    },
    result,
  });
}
async function fixture() {
  await ready();
  const project = projectFixture(),
    bytes = await readFile("tests/fixtures/astra-source.mp4");
  const image = await sharp({
    create: { width: 640, height: 360, channels: 3, background: "#294568" },
  })
    .jpeg()
    .toBuffer();
  const write = async (id: string, data: Buffer, ext: string, kind: string) => {
    const file = path.join(process.cwd(), ".data", "uploads", id + "." + ext);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
    ownedFiles.push(file);
    await db().execute({
      sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,duration_s,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      args: [
        id,
        id,
        kind === "video" ? "video/mp4" : "image/jpeg",
        ext,
        data.length,
        "fixture",
        file,
        kind,
        kind === "video" ? 1.5 : null,
        Date.now(),
      ],
    });
  };
  await write(project.assets[0].uploadId!, bytes, "mp4", "video");
  const videoFrames = referenceAdFrameTimes(1.5).map((timeSeconds) => ({
    assetId: project.assets[0].id,
    uploadId: randomUUID(),
    timeSeconds,
    durationSeconds: 1.5,
  }));
  for (const frame of videoFrames)
    await write(frame.uploadId, image, "jpg", "image");
  await db().execute({
    sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)",
    args: [
      "owner:" + project.id,
      "owner",
      project.id,
      project.name,
      JSON.stringify(project),
      Date.now(),
    ],
  });
  const input = atomikRequestSchema.parse({
    projectId: project.id,
    requestId: randomUUID(),
    request: "Analyze the reference for our product.",
    role: "marketing",
    model: "auto",
    depth: "Considered",
    effort: "auto",
    refs: [project.assets[0].id],
    referenceAd: referenceAdBinding(project, project.moleculr!.referenceAd!),
    videoFrames,
    maxCredits: 0,
  });
  let calls = 0,
    reservations = 0,
    wire = "";
  const deps: Partial<AtomikDependencies> = {
    models: async () => [model],
    allowance: async () => ({ ok: true }),
    limits: async () => ({
      allow: true,
      limits: { concurrency: 3, rendersPerHour: 30, storageBytes: 1e9 },
      standing: { running: 0, startedLastHour: 0, usedBytes: 0 },
    }),
    reserve: async () => {
      reservations++;
    },
    meter: async () => {},
    assertFunding: async () => {},
    auth: async () => ({}),
    run: async (request) => {
      calls++;
      wire = request.body;
      return {
        ok: true,
        status: 200,
        text: JSON.stringify({
          choices: [{ message: { content: JSON.stringify(result) } }],
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
    wire: () => JSON.parse(wire),
  };
}

test("bounded sample times are strictly ordered and reject long, unknown and unsafe durations", () => {
  for (const seconds of [0.1, 1.5, 60]) {
    const times = referenceAdFrameTimes(seconds);
    expect(times).toHaveLength(12);
    expect(times[0]).toBeGreaterThan(0);
    expect(times[11]).toBeLessThan(seconds);
    expect(
      times.every((time, index) => index === 0 || time > times[index - 1]),
    ).toBe(true);
  }
  for (const seconds of [0, 0.09, 60.01, NaN, Infinity])
    expect(() => referenceAdFrameTimes(seconds)).toThrow();
  expect(referenceAnalysisInstructions()).toContain("untrusted evidence");
  expect(referenceAnalysisInstructions()).toContain("virality scores");
});

test("reviewed application retains the original and manual notes and survives project serialization", () => {
  const project = projectFixture(),
    original = structuredClone(project.assets),
    analysis = savedAnalysis(project);
  const applied = applyReferenceAdAnalysis(
    project,
    project.moleculr!.referenceAd!,
    analysis,
    "My reviewed matching direction.",
  );
  expect(applied.notes).toBe("Keep this manual observation.");
  expect(applied.direction).toBe("My reviewed matching direction.");
  expect(project.assets).toEqual(original);
  const roundtrip = saveSchema.parse({
    revision: 1,
    project: {
      ...project,
      moleculr: { ...project.moleculr, referenceAd: applied },
    },
  }).project;
  expect(roundtrip.moleculr?.referenceAd?.analysis).toEqual(analysis);
  for (const changed of [
    { ...project, id: "other-project" },
    { ...project, assets: [] },
    {
      ...project,
      assets: [{ ...project.assets[0], uploadId: "different-original" }],
    },
  ])
    expect(() =>
      applyReferenceAdAnalysis(
        changed,
        project.moleculr!.referenceAd!,
        analysis,
      ),
    ).toThrow();
  expect(() =>
    applyReferenceAdAnalysis(
      project,
      { ...project.moleculr!.referenceAd!, assetId: "other" },
      analysis,
    ),
  ).toThrow();
  expect(() =>
    assertReferenceAnalysisSource(project, {
      ...analysis.evidence.source,
      sourceKey: "https://foreign.example/file",
    }),
  ).toThrow();
});

test("quote inspects the retained original, prices all 12 visuals and durable analysis executes once with recorded evidence", async () => {
  await runInTenant(workspace(), async () => {
    const h = await fixture();
    const quote = await quoteAtomikJob(h.input, "owner", h.deps);
    expect(quote.visualCount).toBe(12);
    expect(quote.estimateUsd).toBeGreaterThan(
      12 * 8192 * Number(model.pricing!.input),
    );
    expect(h.calls()).toBe(0);
    expect(h.reservations()).toBe(0);
    const first = await prepareAtomikJob(h.input, "owner", undefined, h.deps),
      duplicate = await prepareAtomikJob(h.input, "owner", undefined, h.deps);
    expect(duplicate.scheduled).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);
    await runAtomikJob(first.job.id, "owner", h.deps);
    await runAtomikJob(first.job.id, "owner", h.deps);
    expect(h.calls()).toBe(1);
    expect(h.reservations()).toBe(1);
    expect(h.wire().referenceAnalysisEvidence).toBeUndefined();
    expect(
      h.wire().response_format.json_schema.schema.properties.beats.items
        .properties.sampleIndex,
    ).toEqual({ type: "integer" });
    expect(JSON.stringify(h.wire().response_format)).not.toMatch(
      /minLength|maxLength|minimum|maximum|\$schema/,
    );
    expect(
      h
        .wire()
        .messages[1].content.filter(
          (part: { type: string }) => part.type === "image_url",
        ),
    ).toHaveLength(12);
    const job = (
      await listAtomikJobs("owner", h.project.id, { meter: h.deps.meter! })
    )[0];
    expect(job.status).toBe("succeeded");
    const analysis = job.plan!.referenceAdAnalysis!;
    expect(analysis.evidence.source).toEqual(h.input.referenceAd);
    expect(analysis.evidence.samples).toHaveLength(12);
    expect(analysis.evidence.samples[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(analysis.result).toEqual(result);
    expect(h.project.assets[0].uploadId).toBe(h.input.refs[0]);
  });
});

test("spoofed duration, cross-tenant source, default-cap bypass and changed binding fail before paid admission", async () => {
  const ws = workspace();
  await runInTenant(ws, async () => {
    const h = await fixture();
    await expect(
      quoteAtomikJob(
        {
          ...h.input,
          videoFrames: h.input.videoFrames!.map((frame) => ({
            ...frame,
            durationSeconds: 3,
          })),
        },
        "owner",
        h.deps,
      ),
    ).rejects.toThrow("sampled times");
    await expect(
      quoteAtomikJob({ ...h.input, referenceAd: undefined }, "owner", h.deps),
    ).rejects.toThrow("at most six");
    await expect(
      prepareAtomikJob(
        { ...h.input, maxCredits: undefined },
        "owner",
        undefined,
        h.deps,
      ),
    ).rejects.toThrow("credit estimate");
    await expect(
      quoteAtomikJob(
        {
          ...h.input,
          referenceAd: { ...h.input.referenceAd!, sourceKey: "changed" },
        },
        "owner",
        h.deps,
      ),
    ).rejects.toThrow("original changed");
    await expect(
      loadAtomikReferences(
        h.project,
        h.input.refs,
        "owner",
        h.input.videoFrames,
        {
          inspectVideo: async () => ({
            width: 720,
            height: 1280,
            seconds: 61,
            firstTimestamp: 0,
          }),
        },
        h.input.referenceAd,
      ),
    ).rejects.toThrow("60 seconds");
    await runInTenant(workspace(), async () => {
      await ready();
      await expect(
        loadAtomikReferences(
          h.project,
          h.input.refs,
          "owner",
          h.input.videoFrames,
          {},
          h.input.referenceAd,
        ),
      ).rejects.toThrow("unavailable");
    });
    expect(h.calls()).toBe(0);
    expect(h.reservations()).toBe(0);
  });
});

test("funding refusal prevents analysis and an excessive reported cost stays uncertain without another provider call", async () => {
  await runInTenant(workspace(), async () => {
    const h = await fixture();
    h.deps.assertFunding = async () => {
      throw new Error("Funding unavailable");
    };
    const first = await prepareAtomikJob(h.input, "owner", undefined, h.deps);
    await runAtomikJob(first.job.id, "owner", h.deps);
    expect(h.calls()).toBe(0);
    const failed = (
      await listAtomikJobs("owner", h.project.id, { meter: h.deps.meter! })
    )[0];
    expect(failed.status).toBe("failed");
    expect(failed.costUsd).toBe(0);
    h.deps.assertFunding = async () => {};
    let calls = 0;
    h.deps.run = async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        text: JSON.stringify({
          choices: [{ message: { content: JSON.stringify(result) } }],
          usage: { cost: 99 },
        }),
      };
    };
    const second = await prepareAtomikJob(
      { ...h.input, requestId: randomUUID() },
      "owner",
      undefined,
      h.deps,
    );
    await runAtomikJob(second.job.id, "owner", h.deps);
    await runAtomikJob(second.job.id, "owner", h.deps);
    const saved = (
      await listAtomikJobs("owner", h.project.id, { meter: h.deps.meter! })
    ).find((job) => job.id === second.job.id)!;
    expect(saved.status).toBe("uncertain");
    expect(saved.costUsd).toBeNull();
    expect(saved.plan).toBeNull();
    expect(calls).toBe(1);
  });
});

test("12-frame reference mode keeps the exact paid recovery body including source and timestamps", () => {
  const project = projectFixture(),
    analysis = savedAnalysis(project),
    map = new Map<string, string>(),
    storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
    };
  const body = JSON.stringify({
    projectId: project.id,
    requestId: randomUUID(),
    request: "Review",
    model: model.id,
    depth: "Considered",
    effort: "auto",
    refs: [project.assets[0].id],
    referenceAd: analysis.evidence.source,
    maxCredits: 15,
    videoFrames: analysis.evidence.samples.map((sample) => ({
      assetId: project.assets[0].id,
      uploadId: sample.uploadId,
      timeSeconds: sample.timeSeconds,
      durationSeconds: 1.5,
    })),
  });
  persistPendingAtomik(storage, "scope", project.id, body);
  const saved = readPendingAtomik(storage, "scope", project.id)!;
  expect(saved.body).toBe(body);
  expect(atomikPendingInput(saved).videoFrames).toHaveLength(12);
  expect(() =>
    atomikPendingInput({
      ...saved,
      body: JSON.stringify({ ...JSON.parse(body), referenceAd: undefined }),
    }),
  ).toThrow("cannot be verified");
});

test("a dual-ID asset inspects the same canonical generation used by preview and evidence, never the inherited upload", async () => {
  await runInTenant(workspace(), async () => {
    const h = await fixture(),
      generationId = randomUUID();
    await db().execute({
      sql: "INSERT INTO generations(id,model,prompt,params,status,kind,bytes,stored_url,created_at,updated_at) VALUES(?,'mock','','{}','succeeded','video',100,'/api/media/original',?,?)",
      args: [generationId, Date.now(), Date.now()],
    });
    const project = {
      ...h.project,
      assets: [{ ...h.project.assets[0], generationId }],
    };
    const binding = referenceAdBinding(project, project.moleculr!.referenceAd)!;
    expect(binding.sourceKey).toBe(JSON.stringify({ genId: generationId }));
    let inspected = 0;
    const loaded = await loadAtomikReferences(
      project,
      h.input.refs,
      "owner",
      h.input.videoFrames,
      {
        inspectVideo: async (source) => {
          inspected++;
          expect(source.id).toBe(generationId);
          expect(source.fromGeneration).toBe(true);
          expect(source.ext).toBe("mp4");
          return { width: 720, height: 1280, seconds: 1.5, firstTimestamp: 0 };
        },
      },
      binding,
    );
    expect(inspected).toBe(1);
    expect(loaded.images).toHaveLength(12);
  });
});
