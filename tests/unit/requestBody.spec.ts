import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";
import * as requestBody from "../../lib/requestBody";
import * as accountDb from "../../lib/accountDb";
import { PipelineError } from "../../lib/pipeline/schema";
import { atomikRequestSchema } from "../../lib/workbench/atomik-server";

function streamed(
  chunks: Uint8Array[],
  headers?: HeadersInit,
  failCancel = false,
) {
  let reads = 0,
    cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[reads++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
        if (failCancel) throw new Error("Broken upstream cleanup");
      },
    },
    { highWaterMark: 0 },
  );
  const req = new Request("http://localhost/api/test", {
    method: "POST",
    body: stream,
    duplex: "half",
    headers,
  } as RequestInit);
  return { req, reads: () => reads, cancelled: () => cancelled };
}
const bytes = (text: string) => new TextEncoder().encode(text);

test("byte limits preserve complete UTF-8 split across chunks, including the exact boundary", async () => {
  const text = JSON.stringify({ name: "映画 🎥", padding: "x".repeat(20) });
  const body = bytes(text);
  const input = streamed(Array.from(body, (byte) => new Uint8Array([byte])));
  expect(await requestBody.readBoundedText(input.req, body.byteLength)).toBe(
    text,
  );
  expect(input.req.body?.locked).toBe(false);
  const exact = JSON.stringify({
    name: "x".repeat(8192 - bytes(JSON.stringify({ name: "" })).byteLength),
  });
  expect(bytes(exact).length).toBe(8192);
  expect(
    await accountDb.accountJson(
      new Request("http://localhost", { method: "POST", body: exact }),
    ),
  ).toEqual(JSON.parse(exact));
});

for (const headers of [undefined, { "Content-Length": "1" }]) {
  test(`oversized ${headers ? "under-declared" : "chunked"} input cancels before reading its tail even when cancellation rejects`, async () => {
    const input = streamed(
      [new Uint8Array(4096), new Uint8Array(4097), new Uint8Array(1_000_000)],
      headers,
      true,
    );
    await expect(
      requestBody.readBoundedText(input.req, 8192),
    ).rejects.toMatchObject({ status: 413 });
    expect(input.reads()).toBe(2);
    expect(input.cancelled()).toBe(true);
    expect(input.req.body?.locked).toBe(false);
  });
}

test("declared oversize cancels without pulling; multi-byte account text is measured in bytes", async () => {
  const input = streamed([bytes("{}")], { "Content-Length": "8193" });
  await expect(accountDb.accountJson(input.req)).rejects.toMatchObject({
    status: 413,
  });
  expect(input.reads()).toBe(0);
  expect(input.cancelled()).toBe(true);
  await expect(
    accountDb.accountJson(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ name: "漢".repeat(2800) }),
      }),
    ),
  ).rejects.toMatchObject({ status: 413 });
});

test("malformed UTF-8 and interrupted streams return a client error and release the reader", async () => {
  for (const malformed of [
    new Uint8Array([0xff]),
    new Uint8Array([0xe6, 0xbc]),
  ]) {
    const input = streamed([bytes('{"name":"'), malformed, bytes('"}')]);
    await expect(accountDb.accountJson(input.req)).rejects.toMatchObject({
      status: 400,
    });
    expect(input.req.body?.locked).toBe(false);
  }
  const input = new Request("http://localhost", {
    method: "POST",
    body: new ReadableStream({
      pull(c) {
        c.error(new Error("disconnected"));
      },
    }),
    duplex: "half",
  } as RequestInit);
  await expect(accountDb.accountJson(input)).rejects.toMatchObject({
    status: 400,
  });
  expect(input.body?.locked).toBe(false);
  for (const body of ["null", "[]", "1", '"form"', "{", ""]) {
    await expect(
      accountDb.accountJson(
        new Request("http://localhost", { method: "POST", body }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  }
});

/** Run real route admission with downstream spies; malformed requests must never reach them. */
function route(file: string) {
  const calls: string[] = [];
  const blocked = (name: string) => () => {
    calls.push(name);
    throw new Error(`Unexpected downstream work: ${name}`);
  };
  const auth = { user: { id: "user" } };
  const mocks: Record<string, unknown> = {
    "@/lib/requestBody": requestBody,
    "@/lib/accountDb": accountDb,
    "@/lib/auth": {
      withTenant: (handler: unknown) => handler,
      requireSession: async () => auth,
      requireUser: async () => auth,
      requireRender: async () => auth,
      sourceKey: blocked("sourceKey"),
      sourceLocked: blocked("rate-limit"),
      findByEmail: blocked("account-lookup"),
    },
    "@/lib/recovery": {
      recoveryRoute: (handler: unknown) => handler,
      reserveRecoveryContinuation: blocked("continuation"),
    },
    "@/lib/accountSecurity": {
      completePasswordLogin: blocked("password-login"),
    },
    "@/lib/teamInvitations": {
      repairPendingMemberships: blocked("membership-repair"),
    },
    "next/server": { after: blocked("after"), NextResponse: Response },
    "next/headers": { cookies: blocked("cookies") },
    "@/lib/db": { db: blocked("database") },
    "@/lib/pipeline/store": { pipelineStore: blocked("pipeline-store") },
    "@/lib/pipeline/service": {
      publicRun: blocked("public-run"),
      quotePipelineStage: blocked("quote"),
    },
    "@/lib/pipeline/schema": { PipelineError },
    "@/lib/pipeline/executor": { advancePipelineRun: blocked("advance") },
    "@/lib/pipeline/actor": { withPipelineActor: blocked("actor") },
    "@/lib/models": { MODELS: [] },
    "@/lib/elevenlabs": { SPEECH_MODELS: [] },
    "@/lib/providers": { PROVIDERS: [] },
    "@/lib/tenant": {
      currentTenant: () => ({ workspace: { id: "workspace" } }),
      requireTenant: blocked("tenant"),
      runWithStore: blocked("tenant-run"),
    },
    "@/lib/credits": { creditsApply: () => ({}) },
    "@/lib/workbench/atomik-response": {
      atomikPublicResponse: (value: unknown) => value,
    },
    "@/lib/workbench/atomik-server": {
      atomikRequestSchema,
      quoteAtomikJob: blocked("quote"),
      prepareAtomikJob: blocked("prepare"),
      runAtomikJob: blocked("run"),
    },
    zod: { z },
  };
  const compiled = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exports: {
    POST?: (
      request: Request,
      context: { params: Promise<{ id: string }> },
    ) => Promise<Response>;
  } = {};
  vm.runInNewContext(compiled, {
    exports,
    Response,
    URL,
    console,
    require: (name: string) => {
      if (!(name in mocks)) throw new Error(`Unexpected dependency: ${name}`);
      return mocks[name];
    },
  });
  return {
    post: (req: Request) =>
      exports.POST!(req, { params: Promise.resolve({ id: "run" }) }),
    calls,
  };
}

for (const [file, limit] of [
  ["app/api/auth/login/route.ts", 8192],
  ["app/api/workbench/atomik/route.ts", 20000],
  ["app/api/pipelines/route.ts", 1_000_000],
  ["app/api/pipelines/[id]/route.ts", 4096],
] as const) {
  test(`${file} rejects streamed oversize and invalid JSON before account, store, quote or generation work`, async () => {
    const harness = route(file);
    const input = streamed([
      bytes('{"padding":"'),
      new Uint8Array(limit).fill(97),
      bytes('"}'),
    ]);
    expect((await harness.post(input.req)).status).toBe(413);
    expect(input.cancelled()).toBe(true);
    expect(input.reads()).toBe(2);
    const unicode = JSON.stringify({
      padding: "漢".repeat(Math.ceil(limit / 3)),
    });
    expect(
      (
        await harness.post(
          new Request("http://localhost/api/test", {
            method: "POST",
            body: unicode,
          }),
        )
      ).status,
    ).toBe(413);
    for (const body of ["null", "[]", "1", "{"]) {
      expect(
        (
          await harness.post(
            new Request("http://localhost/api/test", { method: "POST", body }),
          )
        ).status,
      ).toBe(400);
    }
    expect(harness.calls).toEqual([]);
  });
}
