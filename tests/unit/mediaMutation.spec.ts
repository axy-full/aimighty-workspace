import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import type { BoardNode } from "../../lib/boards";
import type { Transaction, TransactionMode } from "@libsql/client";

const dir = mkdtempSync(path.join(tmpdir(), "particl-media-mutation-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

function workspace(name: string): TenantWorkspace {
  return {
    id: name,
    name,
    slug: name,
    legacy: true,
    dbUrl: `file:${path.join(dir, name + ".db")}`,
    dbToken: null,
    keys: {},
    usesPlatformKeys: false,
  } as TenantWorkspace;
}
type Handler = (
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;
async function route(file: string): Promise<Record<string, Handler>> {
  const dependencies: Record<string, unknown> = {
    "next/server": createRequire(path.resolve("package.json"))("next/server"),
    "@/lib/db": await import("../../lib/db"),
    "@/lib/archive": await import("../../lib/archive"),
    "@/lib/tenant": await import("../../lib/tenant"),
    "@/lib/mediaMutation": await import("../../lib/mediaMutation"),
    "@/lib/cast": await import("../../lib/cast"),
    "@/lib/shots": await import("../../lib/shots"),
    "@/lib/cache": await import("../../lib/cache"),
    "@/lib/workbench/request-scope":
      await import("../../lib/workbench/request-scope"),
    "@/lib/push": { sendChatPush: async () => {} },
    "@/lib/auth": {
      withTenant: (handler: Handler) => handler,
      requireUser: async () => ({ user: { id: "owner", name: "Owner" } }),
    },
  };
  const compiled = ts.transpileModule(
    readFileSync(path.resolve(file), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    },
  ).outputText;
  const compiledModule = { exports: {} as Record<string, Handler> };
  new Function("require", "module", "exports", compiled)(
    (name: string) => {
      if (!(name in dependencies)) throw new Error("Unexpected import " + name);
      return dependencies[name];
    },
    compiledModule,
    compiledModule.exports,
  );
  return compiledModule.exports;
}
async function call(handler: Handler, body: unknown, id = "existing") {
  const response = await handler(
    new Request("http://localhost/api/fixture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  if (!response.ok) throw new Error(JSON.stringify(await response.json()));
  return response;
}

type Writer = {
  name: string;
  kind: "upload" | "generation";
  prepare: () => Promise<() => Promise<unknown>>;
};
async function writers(): Promise<Writer[]> {
  const { db } = await import("../../lib/db");
  const { createIdentity, updateIdentity } =
    await import("../../lib/identities");
  const { createElement, addVersion } = await import("../../lib/elements");
  const { createBoard, saveBoard } = await import("../../lib/boards");
  const { createChat, addUserMessage, patchStep } =
    await import("../../lib/atomik");
  const { createShot } = await import("../../lib/shots");
  const chat = await route("app/api/chat/route.ts"),
    cast = await route("app/api/cast/route.ts"),
    castId = await route("app/api/cast/[id]/route.ts"),
    shot = await route("app/api/shots/[id]/route.ts");
  const identityInput = {
    name: "Identity",
    description: "",
    photos: [] as string[],
    projectId: null,
    userId: "owner",
  };
  return [
    {
      name: "chat attachment",
      kind: "upload",
      prepare: async () => () =>
        call(chat.POST, { text: "Source", uploadId: "source" }),
    },
    {
      name: "new cast",
      kind: "upload",
      prepare: async () => () =>
        call(cast.POST, { name: "Cast", uploadId: "source" }),
    },
    {
      name: "cast update",
      kind: "upload",
      prepare: async () => {
        await db().execute(
          "INSERT INTO cast_members(id,name,created_at) VALUES('existing','Cast',0)",
        );
        return () => call(castId.PATCH, { uploadId: "source" });
      },
    },
    {
      name: "new identity photos",
      kind: "upload",
      prepare: async () => () =>
        createIdentity({ ...identityInput, photos: ["source"] }),
    },
    ...(["photos", "cover"] as const).map((field): Writer => ({
      name: "identity " + field,
      kind: "upload",
      prepare: async () => {
        const identity = await createIdentity(identityInput);
        return () =>
          updateIdentity(
            identity.id,
            field === "photos"
              ? { photos: ["source"] }
              : { coverUploadId: "source" },
          );
      },
    })),
    ...(["upload", "generation"] as const).map((kind): Writer => ({
      name: "catalog " + kind,
      kind,
      prepare: async () => {
        const element = await createElement(
          { name: "Catalog", kind: "character" },
          "owner",
        );
        return () =>
          addVersion(
            element.attributes[0].id,
            kind === "upload" ? { uploadId: "source" } : { genId: "source" },
            { makeCurrent: true },
            "owner",
          );
      },
    })),
    {
      name: "catalog origin",
      kind: "generation",
      prepare: async () => () =>
        createElement(
          { name: "Origin", kind: "character", fromGenId: "source" },
          "owner",
        ),
    },
    {
      name: "board nested output",
      kind: "generation",
      prepare: async () => {
        const board = await createBoard("project", "Board");
        return () =>
          saveBoard(board.id, {
            nodes: [
              {
                id: "node",
                output: {
                  variants: [{ genId: "source", url: "/api/media/source" }],
                },
              } as BoardNode,
            ],
          });
      },
    },
    {
      name: "Atomik message",
      kind: "upload",
      prepare: async () => {
        const chatId = await createChat({
          userId: "owner",
          projectId: null,
          model: "fixture",
          agentMode: "ask",
        });
        return () =>
          addUserMessage(chatId, "Source", [
            {
              uploadId: "source",
              kind: "image",
              name: "Source",
              mime: "image/png",
            },
          ]);
      },
    },
    {
      name: "Atomik step params",
      kind: "upload",
      prepare: async () => {
        await db().execute(
          "INSERT INTO atomik_steps(id,chat_id,kind,title,prompt,model,params,refs,status,created_at,updated_at) VALUES('step','chat','audio','Step','','fixture','{}','[]','proposed',0,0)",
        );
        return () =>
          patchStep("step", { params: { sourceUploadId: "source" } });
      },
    },
    {
      name: "shot create setup",
      kind: "upload",
      prepare: async () => () =>
        createShot({
          projectId: null,
          createdBy: "owner",
          setup: { reference: "/api/uploads/source" },
        }),
    },
    {
      name: "shot update setup",
      kind: "upload",
      prepare: async () => {
        const existing = await createShot({
          projectId: null,
          createdBy: "owner",
        });
        return () =>
          call(
            shot.PATCH,
            { setup: { reference: "/api/uploads/source" } },
            existing.id,
          );
      },
    },
  ];
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Pause the first real commit, with no production test hook. The second caller
// is already in flight while the first still owns the database write lock.
async function interleave(
  first: () => Promise<unknown>,
  second: () => Promise<unknown>,
) {
  const { db } = await import("../../lib/db");
  const client = db(),
    transaction = client.transaction;
  const reached = deferred(),
    release = deferred();
  let gate = true,
    secondSettled = false;
  client.transaction = async (...args) => {
    const tx = await (
      transaction as (mode?: TransactionMode) => Promise<Transaction>
    ).call(client, args[0] as TransactionMode | undefined);
    if (gate) {
      gate = false;
      const commit = tx.commit.bind(tx);
      tx.commit = async () => {
        reached.resolve();
        await release.promise;
        await commit();
      };
    }
    return tx;
  };
  try {
    const a = first();
    await Promise.race([
      reached.promise,
      a.then(() => {
        throw new Error("Writer did not enter a write transaction");
      }),
    ]);
    const b = second().finally(() => {
      secondSettled = true;
    });
    const outcomes = Promise.allSettled([a, b]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondSettled).toBe(false);
    release.resolve();
    return await outcomes;
  } finally {
    release.resolve();
    client.transaction = transaction;
  }
}

const raceWriters = [
  "chat attachment",
  "new cast",
  "cast update",
  "new identity photos",
  "identity photos",
  "identity cover",
  "catalog upload",
  "catalog generation",
  "catalog origin",
  "board nested output",
  "Atomik message",
  "Atomik step params",
  "shot create setup",
  "shot update setup",
] as const;
// Each transaction ordering has its own timeout and failure report. A slow
// hosted filesystem must not exhaust a single budget shared by 28 races.
for (const writerName of raceWriters)
  for (const order of ["attach-first", "delete-first"] as const)
    test(`legacy media mutation: ${writerName}, ${order}`, async () => {
      const { runInTenant } = await import("../../lib/tenant");
      const { db } = await import("../../lib/db");
      const { workbenchReady, workbenchTransaction } =
        await import("../../lib/workbench/records");
      const { mediaBindingProblem } = await import("../../lib/mediaBindings");
      const { queueUploadDeletion, uploadReservationsReady } =
        await import("../../lib/uploadReservations");
      const { markGenerationDeletion, mediaDeletionReady } =
        await import("../../lib/mediaDeletion");
      const cases = await writers();
      expect(cases.map((writer) => writer.name)).toEqual([...raceWriters]);
      const writer = cases.find((writer) => writer.name === writerName)!;
      await runInTenant(
        workspace((writer.name + "-" + order).replaceAll(" ", "-")),
        async () => {
          await workbenchReady();
          await uploadReservationsReady();
          await mediaDeletionReady();
          await db().execute(
            "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES('owner','owner@example.test','Owner','admin','fixture',0)",
          );
          await db().execute(
            "INSERT INTO projects(id,name,created_at) VALUES('project','Project',0)",
          );
          if (writer.kind === "upload")
            await db().execute(
              "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at) VALUES('source','Source','image/png','png',1,'hash','fixture','image',0)",
            );
          else
            await db().execute(
              "INSERT INTO generations(id,model,prompt,params,status,stored_url,bytes,created_at,updated_at) VALUES('source','fixture','','{}','succeeded','fixture',1,0,0)",
            );
          const attach = await writer.prepare();
          const remove = () =>
            workbenchTransaction(async (tx) => {
              const problem = await mediaBindingProblem(
                tx,
                writer.kind,
                "source",
              );
              if (problem) throw new Error(problem);
              if (writer.kind === "upload")
                await queueUploadDeletion(tx, "owner", "source");
              else await markGenerationDeletion(tx, "source", 1);
            });
          const results =
            order === "attach-first"
              ? await interleave(attach, remove)
              : await interleave(remove, attach);
          expect(results.map((result) => result.status)).toEqual([
            "fulfilled",
            "rejected",
          ]);
          const rejection = results[1] as PromiseRejectedResult;
          expect(String(rejection.reason)).toMatch(
            order === "attach-first"
              ? /used by/
              : /referenced.*no longer available/,
          );
          const present = Number(
            (
              await db().execute(
                writer.kind === "upload"
                  ? "SELECT COUNT(*) n FROM uploads WHERE id='source'"
                  : "SELECT COUNT(*) n FROM generations WHERE id='source' AND deleted=0",
              )
            ).rows[0].n,
          );
          expect(present).toBe(order === "attach-first" ? 1 : 0);
          expect(
            Boolean(
              await workbenchTransaction((tx) =>
                mediaBindingProblem(tx, writer.kind, "source"),
              ),
            ),
          ).toBe(order === "attach-first");
        },
      );
    });

test("a missing source rolls back earlier attachment writes and the same ID in another tenant cannot satisfy it", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { mediaMutation, validateMediaSources } =
    await import("../../lib/mediaMutation");
  await runInTenant(workspace("foreign"), async () => {
    await ready();
    await db().execute(
      "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at) VALUES('foreign','File','image/png','png',1,'hash','fixture',0)",
    );
  });
  await runInTenant(workspace("rollback"), async () => {
    await ready();
    await expect(
      mediaMutation(async (tx) => {
        await tx.execute(
          "INSERT INTO cast_members(id,name,created_at) VALUES('rollback','Rollback',0)",
        );
        await validateMediaSources(tx, { uploadId: "foreign" });
      }),
    ).rejects.toThrow(/referenced upload/);
    expect(
      (await db().execute("SELECT COUNT(*) n FROM cast_members")).rows[0].n,
    ).toBe(0);
  });
});

test("actual image and video generation handlers reject a source deleted after resolution and replay the refusal without spending", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { workbenchReady, workbenchTransaction } =
    await import("../../lib/workbench/records");
  const { queueUploadDeletion, uploadReservationsReady } =
    await import("../../lib/uploadReservations");
  const { MODELS } = await import("../../lib/models");
  const { DEFAULT_LAYER } = await import("../../lib/platformLayer");
  const require = createRequire(path.resolve("package.json"));
  const source = readFileSync("lib/generationAdmission.ts", "utf8");
  const dependencies: Record<string, Record<string, unknown>> = {};
  const ast = ts.createSourceFile(
    "route.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of ast.statements)
    if (ts.isImportDeclaration(statement)) {
      const name = (statement.moduleSpecifier as ts.StringLiteral).text;
      dependencies[name] = name.startsWith("@/")
        ? require(path.resolve(name.slice(2) + ".ts"))
        : name.startsWith(".")
          ? require(path.resolve("lib", name + ".ts"))
          : require(name);
    }
  let gates = 0,
    paid = 0;
  const forbidden = () => {
    paid++;
    throw new Error("Paid provider boundary must not be called");
  };
  dependencies["@/lib/auth"] = {
    withTenant: (handler: Handler) => handler,
    requireRender: async () => ({ user: { id: "owner", role: "admin" } }),
  };
  dependencies["next/server"] = {
    ...dependencies["next/server"],
    after: forbidden,
  };
  dependencies["@/lib/providers"] = {
    ...dependencies["@/lib/providers"],
    providerConfigured: () => true,
  };
  dependencies["@/lib/allowance"] = {
    ...dependencies["@/lib/allowance"],
    allowanceCheck: async () => ({ ok: true }),
  };
  dependencies["@/lib/platform"] = {
    ...dependencies["@/lib/platform"],
    getPlatformLayer: async () => DEFAULT_LAYER,
  };
  dependencies["@/lib/rules"] = { effectiveRules: async () => [] };
  dependencies["@/lib/caps"] = { checkCap: async () => ({ allow: true }) };
  dependencies["@/lib/credits"] = {
    ...dependencies["@/lib/credits"],
    creditsApply: () => false,
  };
  dependencies["@/lib/limits"] = {
    ...dependencies["@/lib/limits"],
    checkQuota: async () => ({ allow: true }),
    checkLimits: async () => {
      gates++;
      // Both handlers have already read and accepted the real source row.
      await workbenchTransaction((tx) =>
        queueUploadDeletion(tx, "owner", "source"),
      );
      return {
        allow: false,
        why: "slots",
        standing: { running: 1 },
        limits: { concurrency: 1 },
      };
    },
  };
  dependencies["@/lib/generationRequests"] = {
    ...dependencies["@/lib/generationRequests"],
    reserveGenerationSpend: forbidden,
  };
  dependencies["@/lib/submitVideo"] = { submitVideoRow: forbidden };
  dependencies["@/lib/renderWork"] = { runInline: forbidden };
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const compiledService = {
    exports: {} as typeof import("../../lib/generationAdmission"),
  };
  new Function("require", "module", "exports", compiled)(
    (name: string) => dependencies[name],
    compiledService,
    compiledService.exports,
  );
  const routeSource = ts.transpileModule(
    readFileSync("app/api/generate/route.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  dependencies["@/lib/generationAdmission"] = compiledService.exports;
  dependencies["@/lib/admissionSupport"] = require(
    path.resolve("lib/admissionSupport.ts"),
  );
  const compiledModule = { exports: {} as { POST: Handler } };
  new Function("require", "module", "exports", routeSource)(
    (name: string) => dependencies[name],
    compiledModule,
    compiledModule.exports,
  );
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("External calls disabled for source-deletion regression");
  };
  try {
    for (const kind of ["image", "video"] as const)
      await runInTenant(
        workspace("generation-" + kind),
        async () => {
          await workbenchReady();
          await uploadReservationsReady();
          await db().execute(
            "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at) VALUES('source','Source','image/png','png',1,'hash','fixture','image',0)",
          );
          const model = MODELS.find(
            (model) =>
              model.kind === kind &&
              model.maxReferenceImages > 0 &&
              !model.stillTask &&
              (model.supportsTasks ?? ["generate"]).includes("generate"),
          )!;
          const request = () =>
            new Request("http://localhost/api/generate", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Key": "deleted-source-key",
              },
              body: JSON.stringify({
                model: model.id,
                prompt: "raw: Source regression",
                refine: false,
                references: [{ uploadId: "source", role: "reference_image" }],
              }),
            });
          const response = await compiledModule.exports.POST(request(), {
            params: Promise.resolve({ id: "unused" }),
          });
          expect(
            response.status,
            JSON.stringify(await response.clone().json()),
          ).toBe(409);
          expect(await response.json()).toMatchObject({
            error: expect.stringMatching(/referenced upload/),
          });
          expect(response.headers.get("Idempotency-Status")).toBe("complete");
          const priorGates = gates;
          const replay = await compiledModule.exports.POST(request(), {
            params: Promise.resolve({ id: "unused" }),
          });
          expect(replay.status).toBe(409);
          expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
          expect(gates).toBe(priorGates);
          expect(
            (await db().execute("SELECT COUNT(*) n FROM generations")).rows[0]
              .n,
          ).toBe(0);
          expect(
            (
              await db().execute(
                "SELECT generation_id FROM generation_requests",
              )
            ).rows[0].generation_id,
          ).toBeNull();
        },
        {
          user: {
            id: "owner",
            email: "owner@example.invalid",
            name: "Owner",
            role: "admin",
            owner: true,
            disabled: false,
            lastSeen: null,
            createdAt: 0,
          },
        },
      );
    expect(gates).toBe(3); // Image final admission; video early and final admission.
    expect(paid).toBe(0);
  } finally {
    globalThis.fetch = fetch;
  }
});
