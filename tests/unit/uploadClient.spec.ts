import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

async function client(fetch: typeof globalThis.fetch) {
  const items = new Map<string, string>();
  const storage = {
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  };
  const locks = new Map<string, Promise<unknown>>();
  const lockedClaim = async <T>(key: string, fn: () => T) => {
    const next = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    locks.set(key, next);
    try {
      return await next;
    } finally {
      if (locks.get(key) === next) locks.delete(key);
    }
  };
  function module<T>(file: string, dependencies: Record<string, unknown>): T {
    const output = ts.transpileModule(
      readFileSync(path.resolve(file), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText;
    const mod = { exports: {} };
    new Function(
      "module",
      "exports",
      "require",
      "fetch",
      "localStorage",
      "window",
      output,
    )(
      mod,
      mod.exports,
      (name: string) => {
        if (!(name in dependencies))
          throw new Error("Unexpected import " + name);
        return dependencies[name];
      },
      fetch,
      storage,
      { dispatchEvent() {} },
    );
    return mod.exports as T;
  }
  const recovery = module<typeof import("../../lib/uploadRecovery")>(
    "lib/uploadRecovery.ts",
    { "./usePaidAction": { lockedClaim } },
  );
  const upload = module<typeof import("../../lib/uploadClient")>(
    "lib/uploadClient.ts",
    { "./uploadRecovery": recovery },
  );
  return { ...upload, ...recovery, items };
}

test("failed parallel chunks retain the immutable session and resume only missing chunks without automatic abort", async () => {
  const requests: { url: string; options: RequestInit }[] = [],
    pending: ((response: Response) => void)[] = [];
  let retry = false;
  const result = {
    id: "same-upload",
    kind: "image",
    url: "/api/uploads/same-upload",
  };
  const api = await client((async (url: string, options: RequestInit) => {
    requests.push({ url, options });
    if (url.includes("/session?"))
      return Response.json({
        state: "open",
        storedChunks: [1, 2],
        retryAfterMs: 0,
      });
    if (url.endsWith("/finish")) return Response.json(result);
    if (retry) return Response.json({ ok: true });
    return new Promise<Response>((resolve) => pending.push(resolve));
  }) as typeof fetch);
  const file = new File([new Uint8Array(11_000_000)], "large.mp4", {
    type: "video/mp4",
  });
  const scope = "particl-active-workspace-owner";
  const running = api
    .uploadFile(file, "reference", undefined, { scope })
    .catch((error) => error);
  await expect.poll(() => pending.length).toBe(3);
  pending[0](Response.json({ error: "Storage unavailable" }, { status: 503 }));
  pending[1](Response.json({ ok: true }));
  pending[2](Response.json({ ok: true }));
  expect((await running).message).toBe("Storage unavailable");
  expect(requests).toHaveLength(3);
  expect(requests.every((request) => request.options.method !== "DELETE")).toBe(
    true,
  );
  const entry = api.listUploadEnvelopes(scope)[0];
  expect(entry.storedChunks).toEqual([1, 2]);
  expect(entry.state).toBe("pending");
  expect([...api.items.values()][0].length).toBeLessThan(2000);
  await expect(
    api.resumeUpload(
      entry,
      new File([new Uint8Array(11_000_000)], "different.mp4", {
        type: "video/mp4",
      }),
    ),
  ).rejects.toThrow(/same file/);
  expect(requests).toHaveLength(3);
  retry = true;
  expect(await api.resumeUpload(entry, file)).toEqual(result);
  const chunks = requests.filter((request) => request.url.endsWith("/chunk"));
  expect(
    chunks.map((request) =>
      Number((request.options.body as FormData).get("index")),
    ),
  ).toEqual([0, 1, 2, 0, 3]);
  for (const request of chunks) {
    expect((request.options.body as FormData).get("session")).toBe(
      entry.session,
    );
    expect(request.options.headers).toMatchObject({
      "X-Workbench-Scope": scope,
    });
  }
  const finish = requests.find((request) => request.url.endsWith("/finish"))!;
  expect(JSON.parse(String(finish.options.body))).toMatchObject({
    session: entry.session,
    count: 4,
    filename: file.name,
    purpose: "reference",
  });
});

test("a forgotten expired session or completed receipt cannot silently start another server upload", async () => {
  const calls: string[] = [];
  const api = await client((async (url: string) => {
    calls.push(url);
    return Response.json({ error: "Unknown session" }, { status: 404 });
  }) as typeof fetch);
  const file = new File(["original bytes"], "original.bin", {
    type: "application/octet-stream",
  });
  for (const knownComplete of [false, true]) {
    const entry = await api.claimUploadEnvelope(
      `particl-active-${knownComplete}-owner`,
      file,
      "chat",
    );
    const key = api.uploadEnvelopeKey(entry.scope, entry.identity);
    api.items.set(
      key,
      JSON.stringify({
        ...entry,
        started: true,
        createdAt: knownComplete ? Date.now() : Date.now() - 2 * 86400_000,
        ...(knownComplete
          ? {
              state: "complete",
              result: {
                id: "already-stored",
                kind: "file",
                url: "/api/uploads/already-stored",
              },
            }
          : {}),
      }),
    );
    await expect(api.resumeUpload(entry, file)).rejects.toThrow(/expired/);
    expect(api.listUploadEnvelopes(entry.scope)[0].state).toBe("blocked");
  }
  expect(calls).toHaveLength(2);
  expect(calls.every((url) => url.includes("/session?"))).toBe(true);
});

test("corrupted recovery metadata cannot expose unsafe links or resume, and unfinished records remain intact", async () => {
  let requests = 0;
  const api = await client((async () => {
    requests++;
    throw new Error("No network request is allowed for corrupted metadata");
  }) as typeof fetch);
  const file = new File(["original bytes"], "original.bin", {
    type: "application/octet-stream",
  });
  const entry = await api.claimUploadEnvelope(
    "particl-active-workspace-owner",
    file,
    "chat",
  );
  const key = api.uploadEnvelopeKey(entry.scope, entry.identity);
  const pending = JSON.stringify(entry);
  const receipt = {
    id: "upl_original",
    kind: "file",
    url: "/api/uploads/upl_original",
  };
  const corrupted = [
    "{broken-json",
    ...[
      { state: "unknown" },
      { storedChunks: [0, 0] },
      { storedChunks: [-1] },
      { storedChunks: [entry.count] },
      { storedChunks: [0.5] },
      { createdAt: null },
      { updatedAt: "today" },
      { file: { ...entry.file, lastModified: null } },
      { state: "complete" },
      { result: { ...receipt, url: "javascript:alert(1)" } },
      { result: { ...receipt, url: "//external.example/file" } },
      { result: { ...receipt, url: "/api/uploads/some-other-id" } },
      { result: { ...receipt, url: receipt.url + "?redirect=external" } },
    ].map((patch) => JSON.stringify({ ...entry, ...patch })),
  ];
  for (const raw of corrupted) {
    api.items.set(key, raw);
    expect(() => api.listUploadEnvelopes(entry.scope)).toThrow(
      /Saved upload recovery data cannot be read/,
    );
    await expect(api.resumeUpload(entry)).rejects.toThrow(
      /Saved upload recovery data cannot be read/,
    );
    expect(api.items.get(key)).toBe(raw);
  }
  expect(requests).toBe(0);
  api.items.set(key, pending);
  expect(api.listUploadEnvelopes(entry.scope)).toEqual([entry]);
  api.items.set(
    key,
    JSON.stringify({ ...entry, state: "complete", result: receipt }),
  );
  expect(api.listUploadEnvelopes(entry.scope)[0].result).toEqual(receipt);
});

test("an unsafe finish response retains the original pending upload for a safe status recovery", async () => {
  const receipt = {
    id: "upl_original",
    kind: "file",
    url: "/api/uploads/upl_original",
  };
  const requests: string[] = [];
  const api = await client((async (url: string) => {
    requests.push(url);
    if (url.endsWith("/chunk")) return Response.json({ ok: true });
    if (url.endsWith("/finish"))
      return Response.json({ ...receipt, url: "javascript:alert(1)" });
    return Response.json({
      state: "committed",
      storedChunks: [0],
      retryAfterMs: 0,
      upload: receipt,
    });
  }) as typeof fetch);
  const scope = "particl-active-workspace-owner";
  await expect(
    api.uploadFile(new File(["original"], "original.bin"), "chat", undefined, {
      scope,
    }),
  ).rejects.toThrow(/upload response was incomplete/);
  const entry = api.listUploadEnvelopes(scope)[0];
  expect(entry.state).toBe("pending");
  expect(entry.result).toBeUndefined();
  expect(await api.resumeUpload(entry)).toEqual(receipt);
  expect(requests).toHaveLength(3);
  expect(requests[2]).toContain(encodeURIComponent(entry.session));
});

test("dropping in a file whose earlier upload was deleted or purged starts a new upload instead of refusing", async () => {
  const fresh = { id: "upl_new", kind: "file", url: "/api/uploads/upl_new" };
  for (const gone of ["removed", "purged"] as const) {
    const requests: { url: string; body?: unknown }[] = [];
    let firstSession = "";
    const api = await client((async (url: string, options: RequestInit = {}) => {
      requests.push({ url, body: options.body });
      if (url.includes("/session?")) {
        if (!url.includes(encodeURIComponent(firstSession)))
          throw new Error("A new upload asks for no status");
        return gone === "removed"
          ? Response.json({ state: "removed", storedChunks: [], retryAfterMs: 0 })
          : Response.json({ error: "Unknown session" }, { status: 404 });
      }
      if (url.endsWith("/chunk")) return Response.json({ ok: true });
      if (url.endsWith("/finish")) return Response.json(fresh);
      throw new Error("Unexpected request " + url);
    }) as typeof fetch);
    const scope = `particl-active-${gone}-owner`;
    const file = new File(["the same original"], "still.png", { type: "image/png" });
    const prior = await api.claimUploadEnvelope(scope, file, "chat");
    firstSession = prior.session;
    api.items.set(
      api.uploadEnvelopeKey(scope, prior.identity),
      JSON.stringify({
        ...prior,
        started: true,
        state: "complete",
        storedChunks: [0],
        result: { id: "upl_old", kind: "file", url: "/api/uploads/upl_old" },
      }),
    );
    expect(await api.uploadFile(file, "chat", undefined, { scope })).toEqual(fresh);
    const [entry, ...rest] = api.listUploadEnvelopes(scope);
    expect(rest).toHaveLength(0);
    expect(entry.session).not.toBe(prior.session);
    expect(entry).toMatchObject({ state: "complete", result: fresh });
    const finish = requests.find((request) => request.url.endsWith("/finish"))!;
    expect(JSON.parse(String(finish.body)).session).toBe(entry.session);
  }
});

test("a refused upload says why, stops holding a slot, and the same file is answered at once for a while", async () => {
  let finishes = 0, chunks = 0;
  const api = await client((async (url: string) => {
    if (url.endsWith("/chunk")) chunks++;
    if (url.includes("/session?"))
      return Response.json({ state: "aborted", storedChunks: [], retryAfterMs: 0 });
    if (url.endsWith("/chunk")) return Response.json({ ok: true });
    if (url.endsWith("/finish")) {
      finishes++;
      return Response.json({ error: "Unrecognised file." }, { status: 400 });
    }
    throw new Error("Unexpected request " + url);
  }) as typeof fetch);
  const scope = "particl-active-refusal-owner";
  const refused = new File(["not a picture"], "notes.webm", { type: "video/webm" });
  await expect(api.uploadFile(refused, "reference", undefined, { scope })).rejects.toThrow(/Unrecognised file/);
  const [entry] = api.listUploadEnvelopes(scope);
  expect(entry).toMatchObject({ state: "blocked", error: "Unrecognised file." });
  expect(entry.refusedAt).toBeGreaterThan(0);
  expect([finishes, chunks]).toEqual([1, 1]);
  // The same file again soon after: the refusal, with nothing sent again.
  await expect(api.uploadFile(refused, "reference", undefined, { scope })).rejects.toThrow(/Unrecognised file/);
  expect([finishes, chunks]).toEqual([1, 1]);
  // Later (a setting may have changed): the server is asked afresh, once.
  const key = api.uploadEnvelopeKey(scope, entry.identity);
  api.items.set(key, JSON.stringify({ ...JSON.parse(api.items.get(key)!), refusedAt: Date.now() - 11 * 60_000 }));
  await expect(api.uploadFile(refused, "reference", undefined, { scope })).rejects.toThrow(/Unrecognised file/);
  expect([finishes, chunks]).toEqual([2, 2]);
  expect(api.listUploadEnvelopes(scope)).toHaveLength(1);
  // Refused uploads never fill the browser's unfinished-upload slots.
  for (let n = 0; n < 32; n++) {
    const other = await api.claimUploadEnvelope(scope, new File([`refused ${n}`], `f${n}.bin`), "chat");
    api.items.set(api.uploadEnvelopeKey(scope, other.identity), JSON.stringify({ ...other, state: "blocked", error: "Unrecognised file." }));
  }
  await api.claimUploadEnvelope(scope, new File(["a new file"], "new.bin"), "chat");
  // Nor do they pile up: only the newest few ended records are kept.
  expect(api.listUploadEnvelopes(scope).filter((e) => e.state === "blocked").length).toBeLessThanOrEqual(10);
  // Live ones still count.
  for (let n = 0; n < 31; n++) await api.claimUploadEnvelope(scope, new File([`pending ${n}`], `p${n}.bin`), "chat");
  await expect(api.claimUploadEnvelope(scope, new File(["one more"], "more.bin"), "chat")).rejects.toThrow(/Resume or cancel/);
});

test("a finish that fails for the moment, not for the file, is sent again when the file is chosen again", async () => {
  let finishes = 0;
  const api = await client((async (url: string) => {
    if (url.includes("/session?"))
      return Response.json({ state: "aborted", storedChunks: [], retryAfterMs: 0 });
    if (url.endsWith("/chunk")) return Response.json({ ok: true });
    if (url.endsWith("/finish")) {
      finishes++;
      return finishes === 1
        ? Response.json({ error: "The upload could not finish." }, { status: 503 })
        : Response.json({ id: "upl_ok", kind: "file", url: "/api/uploads/upl_ok" });
    }
    throw new Error("Unexpected request " + url);
  }) as typeof fetch);
  const scope = "particl-active-outage-owner";
  const file = new File(["an original"], "clip.bin");
  await expect(api.uploadFile(file, "chat", undefined, { scope })).rejects.toThrow(/could not finish/);
  expect(api.listUploadEnvelopes(scope)[0].refusedAt).toBeUndefined();
  expect(await api.uploadFile(file, "chat", undefined, { scope })).toMatchObject({ id: "upl_ok" });
  expect(finishes).toBe(2);
});
