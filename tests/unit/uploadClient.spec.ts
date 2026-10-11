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

/** A server whose finish answers 202 and assembles in the background: the session reads `assembling` `polls` times, then `end`. */
function backgroundServer(
  end: Record<string, unknown>,
  options: { polls?: number; finish?: () => Response } = {},
) {
  const requests: { url: string; method: string; at: number }[] = [];
  let reads = 0;
  const fetch = (async (url: string, init: RequestInit = {}) => {
    requests.push({ url, method: init.method ?? "GET", at: Date.now() });
    if (url.endsWith("/chunk")) return Response.json({ ok: true });
    if (url.endsWith("/finish"))
      return options.finish?.() ?? Response.json({ state: "assembling", pollAfterMs: 100 }, { status: 202 });
    if (url.includes("/session?")) {
      if (!requests.some((request) => request.url.endsWith("/finish")) && !options.finish)
        return Response.json({ state: "open", storedChunks: [], retryAfterMs: 0 });
      return reads++ < (options.polls ?? 2)
        ? Response.json({ state: "assembling", storedChunks: [0], retryAfterMs: 1_199_000 })
        : Response.json({ storedChunks: [], retryAfterMs: 0, ...end });
    }
    throw new Error("Unexpected request " + url);
  }) as typeof globalThis.fetch;
  return { fetch, requests, reads: () => reads };
}
const receipt = { id: "upl_big", kind: "video", url: "/api/uploads/upl_big", filename: "big.mov", bytes: 11 };

test("a finish answered 202 is followed on the session until it is committed, with growing pauses", async () => {
  const server = backgroundServer({ state: "committed", upload: receipt });
  const api = await client(server.fetch);
  const scope = "particl-active-background-owner";
  const progress: number[] = [];
  const done = api.uploadFile(new File(["a long original"], "big.mov", { type: "video/quicktime" }), "chat", (pct) => progress.push(pct), { scope });
  await expect.poll(() => server.reads()).toBeGreaterThan(0);
  expect(api.listUploadEnvelopes(scope)[0].state).toBe("finishing");
  expect(await done).toEqual(receipt);
  expect(api.listUploadEnvelopes(scope)[0]).toMatchObject({ state: "complete", result: receipt });
  expect(progress.at(-1)).toBe(100);
  const finishes = server.requests.filter((request) => request.url.endsWith("/finish"));
  expect(finishes).toHaveLength(1);
  const polls = server.requests.filter((request) => request.url.includes("/session?") && request.at >= finishes[0].at);
  expect(polls).toHaveLength(3);
  // 100 ms, then 150 ms, then 225 ms: a backoff, not a busy loop.
  expect(polls[2].at - polls[1].at).toBeGreaterThanOrEqual(polls[1].at - polls[0].at);
  expect(polls[0].at - finishes[0].at).toBeGreaterThanOrEqual(90);
});

test("a background finish that fails ends the saved upload with the server's reason; a refusal is remembered", async () => {
  for (const [failure, refused] of [
    [{ error: "The upload could not finish. Its reserved storage will be released after cleanup. Try again shortly.", status: 503 }, false],
    [{ error: "The upload bytes do not match its chunks.", status: 400 }, true],
  ] as const) {
    const server = backgroundServer({ state: "aborting", failure });
    const api = await client(server.fetch);
    const scope = `particl-active-fail${failure.status}-owner`;
    await expect(api.uploadFile(new File(["bytes"], "clip.mov"), "chat", undefined, { scope })).rejects.toThrow(failure.error);
    const [entry] = api.listUploadEnvelopes(scope);
    expect(entry).toMatchObject({ state: "blocked", error: failure.error });
    expect(entry.refusedAt !== undefined).toBe(refused);
    expect(server.requests.filter((request) => request.url.endsWith("/finish"))).toHaveLength(1);
  }
});

test("a finish whose lease lapsed with nothing published is sent again, identically, and a 409 while another finishes is followed", async () => {
  let finishes = 0;
  const server = backgroundServer({ state: "prepared", storedChunks: [0] }, {
    polls: 1,
    finish: () => ++finishes === 1
      ? Response.json({ state: "assembling", pollAfterMs: 100 }, { status: 202 })
      : Response.json(receipt),
  });
  const api = await client(server.fetch);
  const scope = "particl-active-lapsed-owner";
  expect(await api.uploadFile(new File(["bytes"], "clip.mov"), "chat", undefined, { scope })).toEqual(receipt);
  expect(server.requests.filter((request) => request.url.endsWith("/finish"))).toHaveLength(2);

  // Another tab is finishing the same upload: this one follows it instead of failing.
  let sent = 0;
  const busy = backgroundServer({ state: "committed", upload: receipt }, {
    polls: 2,
    finish: () => (sent++, Response.json({ error: "This upload is still finishing. Try again shortly." }, { status: 409 })),
  });
  const other = await client(busy.fetch);
  expect(await other.uploadFile(new File(["bytes"], "clip.mov"), "chat", undefined, { scope })).toEqual(receipt);
  expect(sent).toBe(1);
});

test("after a reload mid-finish, the saved 'finishing' upload follows the server to its receipt without sending anything", async () => {
  const server = backgroundServer({ state: "committed", upload: receipt }, { polls: 1, finish: () => { throw new Error("nothing is sent"); } });
  const api = await client(server.fetch);
  const scope = "particl-active-reload-owner";
  const file = new File(["a long original"], "big.mov", { type: "video/quicktime" });
  const saved = await api.claimUploadEnvelope(scope, file, "chat");
  const key = api.uploadEnvelopeKey(scope, saved.identity);
  const finishing = { ...saved, started: true, state: "finishing", storedChunks: [0] };
  api.items.set(key, JSON.stringify(finishing));
  expect(await api.followFinishing(api.listUploadEnvelopes(scope)[0])).toEqual(receipt);
  expect(api.listUploadEnvelopes(scope)[0]).toMatchObject({ state: "complete", result: receipt });
  // Following again finds nothing left to follow.
  expect(await api.followFinishing(api.listUploadEnvelopes(scope)[0])).toBeNull();

  // Resume (no file needed) on a record whose finish is still assembling polls too, and sends no finish.
  const again = backgroundServer({ state: "committed", upload: receipt }, { polls: 1, finish: () => { throw new Error("nothing is sent"); } });
  const resumed = await client(again.fetch);
  const entry = await resumed.claimUploadEnvelope(scope, file, "chat");
  resumed.items.set(resumed.uploadEnvelopeKey(scope, entry.identity), JSON.stringify({ ...entry, started: true, state: "pending", storedChunks: [0] }));
  expect(await resumed.resumeUpload(resumed.listUploadEnvelopes(scope)[0])).toEqual(receipt);
  expect(again.requests.every((request) => request.url.includes("/session?"))).toBe(true);
  // Check status on a failed background finish says why and ends the record.
  const failed = backgroundServer({ state: "aborted", failure: { error: "Storage is full.", status: 507 } }, { polls: 0, finish: () => { throw new Error("nothing is sent"); } });
  const checked = await client(failed.fetch);
  const third = await checked.claimUploadEnvelope(scope, file, "chat");
  checked.items.set(checked.uploadEnvelopeKey(scope, third.identity), JSON.stringify({ ...third, started: true, state: "finishing", storedChunks: [0] }));
  expect((await checked.checkUpload(checked.listUploadEnvelopes(scope)[0])).failure?.status).toBe(507);
  expect(checked.listUploadEnvelopes(scope)[0]).toMatchObject({ state: "blocked", error: "Storage is full." });
  expect(checked.listUploadEnvelopes(scope)[0].refusedAt).toBeUndefined();
});

test("a background refusal is remembered from when it was first read, and after the memory the same file starts afresh", async () => {
  const fresh = { id: "upl_fresh", kind: "file", url: "/api/uploads/upl_fresh" };
  let first = "", finishes = 0;
  const api = await client((async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/chunk")) return Response.json({ ok: true });
    if (url.endsWith("/finish")) {
      const { session } = JSON.parse(String(init.body));
      finishes++;
      if (!first) {
        first = session;
        return Response.json({ state: "assembling", pollAfterMs: 100 }, { status: 202 });
      }
      return Response.json(fresh);
    }
    if (url.includes("/session?"))
      return url.includes(encodeURIComponent(first)) && first
        ? Response.json({ state: "aborted", storedChunks: [], retryAfterMs: 0, failure: { error: "Unrecognised file.", status: 415 } })
        : Response.json({ state: "open", storedChunks: [], retryAfterMs: 0 });
    throw new Error("Unexpected request " + url);
  }) as typeof fetch);
  const scope = "particl-active-memory-owner";
  const file = new File(["refused bytes"], "odd.bin");
  await expect(api.uploadFile(file, "chat", undefined, { scope })).rejects.toThrow("Unrecognised file.");
  const [entry] = api.listUploadEnvelopes(scope);
  expect(entry).toMatchObject({ state: "blocked", error: "Unrecognised file." });
  const key = api.uploadEnvelopeKey(scope, entry.identity);
  // Remembered as of the first read: later reads do not move it on.
  const longAgo = Date.now() - 11 * 60_000;
  api.items.set(key, JSON.stringify({ ...JSON.parse(api.items.get(key)!), refusedAt: longAgo }));
  await api.checkUpload(api.listUploadEnvelopes(scope)[0]);
  await api.checkUpload(api.listUploadEnvelopes(scope)[0]);
  expect(api.listUploadEnvelopes(scope)[0].refusedAt).toBe(longAgo);
  // Past the memory, the same file is a fresh upload, not the old refusal.
  expect(await api.uploadFile(file, "chat", undefined, { scope })).toEqual(fresh);
  const [again] = api.listUploadEnvelopes(scope);
  expect(again.session).not.toBe(first);
  expect(again).toMatchObject({ state: "complete", result: fresh });
  expect(finishes).toBe(2);
});

test("following a reloaded finish holds no lock while it polls, and one that ends with nothing published turns to Resume", async () => {
  const scope = "particl-active-follow-owner";
  const file = new File(["a long original"], "big.mov", { type: "video/quicktime" });
  const saved = async (api: Awaited<ReturnType<typeof client>>) => {
    const entry = await api.claimUploadEnvelope(scope, file, "chat");
    api.items.set(api.uploadEnvelopeKey(scope, entry.identity), JSON.stringify({ ...entry, started: true, state: "finishing", storedChunks: [0] }));
    return api.listUploadEnvelopes(scope)[0];
  };
  // Still assembling: Cancel goes through at once, and the follow then stops.
  let deletes = 0;
  const busy = await client((async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/chunk") && init.method === "DELETE") return (deletes++, Response.json({ ok: true }));
    if (url.includes("/session?")) return Response.json({ state: "assembling", storedChunks: [0], retryAfterMs: 1_000_000 });
    throw new Error("Unexpected request " + url);
  }) as typeof fetch);
  const entry = await saved(busy);
  const following = busy.followFinishing(entry);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const lock = busy.withUploadLock(busy.uploadRunLock(entry), async () => "free");
  expect(await Promise.race([lock, new Promise((resolve) => setTimeout(() => resolve("held"), 500))])).toBe("free");
  await busy.dismissUpload(entry);
  expect(deletes).toBe(1);
  expect(await following).toBeNull();
  expect(busy.listUploadEnvelopes(scope)).toHaveLength(0);

  // Prepared, or a lease that lapsed with nothing published: the record offers Resume upload.
  for (const end of [
    [{ state: "prepared", storedChunks: [0], retryAfterMs: 0 }],
    [{ state: "assembling", storedChunks: [0], retryAfterMs: 1_000 }, { state: "assembling", storedChunks: [0], retryAfterMs: 0 }],
  ]) {
    let read = 0;
    const api = await client((async (url: string) => {
      if (url.includes("/session?")) return Response.json(end[Math.min(read++, end.length - 1)]);
      throw new Error("Nothing is sent: " + url);
    }) as typeof fetch);
    expect(await api.followFinishing(await saved(api))).toBe("resume");
    expect(api.listUploadEnvelopes(scope)[0].state).toBe("pending");
  }
});
