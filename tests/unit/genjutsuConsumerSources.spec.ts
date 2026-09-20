import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import type { ConsumerGenjutsuInput } from "../../lib/higgsfield-consumer/genjutsu-contract";
const dir = mkdtempSync(path.join(tmpdir(), "consumer-genjutsu-sources-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.ENGINE_MOCK = "1";
const nodeRequire = createRequire(path.resolve("package.json"));
function load<T>(file: string, overrides: Record<string, unknown>): T {
  const out = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", out)(
    (name: string) =>
      name in overrides
        ? overrides[name]
        : nodeRequire(
            name.startsWith("@/")
              ? path.resolve(`${name.slice(2)}.ts`)
              : name.startsWith(".")
                ? path.resolve(path.dirname(file), `${name}.ts`)
                : name,
          ),
    loaded,
    loaded.exports,
  );
  return loaded.exports as T;
}
const input: ConsumerGenjutsuInput = {
  variant: "motion-transfer",
  resolution: "1080p",
  prompt: "Preserve the product",
  source: { uploadId: "video" },
  references: [{ uploadId: "still" }],
};
let sequence = 0;
async function fixture(
  run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>,
) {
  const f = await setup();
  return f.tenant.runInTenant(f.workspace, async () => {
    await f.database.ready();
    await f.database
      .db()
      .execute(
        "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES('owner-draft','owner','draft','Test','{}',1,0)",
      );
    for (const [id, kind] of [
      ["video", "video"],
      ["still", "image"],
    ])
      await f.database
        .db()
        .execute({
          sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at) VALUES(?,?,? ,?,1000,'fixture-sha',?,?,0)",
          args: [
            id,
            id,
            kind === "video" ? "video/mp4" : "image/png",
            kind === "video" ? "mp4" : "png",
            `/api/uploads/${id}`,
            kind,
          ],
        });
    return run(f);
  });
}
async function setup() {
  const tenant = await import("../../lib/tenant"),
    database = await import("../../lib/db"),
    jobs = await import("../../lib/higgsfield-consumer/jobs"),
    sources = await import("../../lib/higgsfield-consumer/genjutsu-sources"),
    bindings = await import("../../lib/mediaBindings");
  const id = `source-${++sequence}`;
  const workspace = {
    id,
    slug: id,
    name: id,
    dbUrl: `file:${path.join(dir, `${id}.db`)}`,
    dbToken: null,
    legacy: true,
    keys: {},
    ownerId: "owner",
    usesPlatformKeys: false,
    createdAt: 0,
  } as TenantWorkspace;
  const request = {
    userId: "owner",
    draftId: "draft",
    quoteKey: randomUUID(),
    sourceIndex: 0,
    request: input,
    workspaceId: randomUUID(),
    connectionGeneration: randomUUID(),
  };
  return { tenant, database, jobs, sources, bindings, workspace, request };
}
test("real ledger checks sources in creation/dispatch and source deletion pins quoted/active jobs", async () =>
  fixture(async (f) => {
    const params = {
      model: "hf_mult_motion_control",
      prompt: input.prompt,
      resolution: input.resolution,
      medias: [
        { value: randomUUID(), role: "video_references" },
        { value: randomUUID(), role: "image_references" },
      ],
      count: 1,
      use_unlim: false,
    };
    const create = () =>
      f.jobs.createConsumerJob({
        userId: "owner",
        draftId: "draft",
        workflow: "genjutsu",
        connectedOwnerId: "owner",
        connectionGeneration: f.request.connectionGeneration,
        higgsfieldWorkspaceId: f.request.workspaceId,
        idempotencyKey: randomUUID(),
        payload: { input, params },
        quoteCredits: 75,
        quoteExpiresAt: Date.now() + 60000,
        originalAssetIds: ["upload:video", "upload:still"],
      });
    const { job } = await create();
    const records = await import("../../lib/workbench/records");
    expect(
      await records.workbenchTransaction((tx) =>
        f.bindings.mediaBindingProblem(tx, "upload", "video"),
      ),
    ).toContain("active quote or job");
    // Simulate an out-of-band deletion; final dispatch validation still refuses.
    await f.database.db().execute("DELETE FROM uploads WHERE id='still'");
    await expect(f.jobs.claimConsumerDispatch(job)).rejects.toMatchObject({
      code: "source_unavailable",
    });
    await expect(create()).rejects.toMatchObject({
      code: "source_unavailable",
    });
    expect((await f.jobs.getConsumerJob(job))?.status).toBe("quoted");
    await expect(
      f.jobs.getConsumerJob({ ...job, userId: "other" }),
    ).resolves.toBeNull();
  }));
test("durable import receipt is reused after lost quote response, exact grant/wallet/input remain immutable", async () =>
  fixture(async (f) => {
    let imported = 0;
    const remote = randomUUID();
    const perform = async () => {
      imported++;
      return remote;
    };
    expect(await f.sources.resolveConsumerMediaImport(f.request, perform)).toBe(
      remote,
    );
    expect(await f.sources.resolveConsumerMediaImport(f.request, perform)).toBe(
      remote,
    );
    expect(imported).toBe(1);
    for (const patch of [
      { workspaceId: randomUUID() },
      { connectionGeneration: randomUUID() },
      { request: { ...input, prompt: "Changed" } },
    ])
      await expect(
        f.sources.resolveConsumerMediaImport(
          { ...f.request, ...patch },
          perform,
        ),
      ).rejects.toMatchObject({ code: "import_changed" });
    expect(imported).toBe(1);
    expect(
      JSON.stringify(
        (
          await f.database
            .db()
            .execute("SELECT * FROM higgsfield_consumer_media_imports")
        ).rows,
      ),
    ).not.toContain("https:");
    const records = await import("../../lib/workbench/records");
    expect(
      await records.workbenchTransaction((tx) =>
        f.bindings.mediaBindingProblem(tx, "upload", "video"),
      ),
    ).toContain("transferred");
  }));
test("concurrent and ambiguous imports cannot replay a permanent claim", async () =>
  fixture(async (f) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let imported = 0;
    await f.sources.consumerMediaImportsReady();
    const first = f.sources.resolveConsumerMediaImport(f.request, async () => {
      imported++;
      await gate;
      return randomUUID();
    });
    await expect
      .poll(async () =>
        Number(
          (
            await f.database
              .db()
              .execute(
                "SELECT COUNT(*) n FROM higgsfield_consumer_media_imports",
              )
          ).rows[0]?.n ?? 0,
        ),
      )
      .toBe(1);
    await expect(
      f.sources.resolveConsumerMediaImport(f.request, async () => {
        imported++;
        return randomUUID();
      }),
    ).rejects.toMatchObject({ code: "import_uncertain" });
    release();
    await first;
    expect(imported).toBe(1);
    const failed = { ...f.request, quoteKey: randomUUID() };
    await expect(
      f.sources.resolveConsumerMediaImport(failed, async () => {
        throw Error("lost remote response");
      }),
    ).rejects.toThrow();
    await expect(
      f.sources.resolveConsumerMediaImport(failed, async () => {
        imported++;
        return randomUUID();
      }),
    ).rejects.toMatchObject({ code: "import_uncertain" });
    expect(imported).toBe(1);
  }));
test("actual source inspection owns duration and import bounds, never derivative metadata", async () =>
  fixture(async (f) => {
    let seconds = 4;
    const inspected: string[] = [];
    const source = load<
      typeof import("../../lib/higgsfield-consumer/genjutsu-sources")
    >("lib/higgsfield-consumer/genjutsu-sources.ts", {
      "@/lib/videoMetadata.server": {
        inspectOriginalVideo: async (ref: { id: string }) => {
          inspected.push(ref.id);
          return { seconds, width: 1920, height: 1080, firstTimestamp: 0 };
        },
      },
    });
    expect(
      (await source.resolveConsumerGenjutsuSources(input)).source.seconds,
    ).toBe(4);
    seconds = 30;
    expect(
      (await source.resolveConsumerGenjutsuSources(input)).source.seconds,
    ).toBe(30);
    for (const bad of [3.99, 30.01]) {
      seconds = bad;
      await expect(
        source.resolveConsumerGenjutsuSources(input),
      ).rejects.toMatchObject({ code: "source_limits" });
    }
    seconds = 15;
    await f.database
      .db()
      .execute("UPDATE uploads SET bytes=52428801 WHERE id='video'");
    await expect(
      source.resolveConsumerGenjutsuSources(input),
    ).rejects.toMatchObject({ code: "source_limits" });
    expect(inspected).toEqual(["video", "video", "video", "video"]);
  }));
