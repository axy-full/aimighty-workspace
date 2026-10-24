import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { MAX_CHAT_BYTES, MAX_REFERENCE_BYTES, UPLOAD_CHUNK_BYTES, capSizeWords, uploadCapBytes, uploadCapProblem, uploadCapWords, uploadChunkLimit, uploadChunkProblem, uploadPurposeOf } from "../../lib/uploadCaps";
import * as reservations from "../../lib/uploadReservations";
import { uploadFile, type UploadedFile } from "../../lib/uploadClient";
import { claimUploadEnvelope } from "../../lib/uploadRecovery";
import { uploadFilesToProject } from "../../lib/workspace/library";
import { attachBrief, startFiles } from "../../components/graphite/home/attach-brief";
import { BriefFileError, briefReadable } from "../../components/graphite/home/brief-file";
import { MAX_PDF_BYTES } from "../../lib/workbench/screenplay";

/**
 * Attach a brief, upload first (owner, 24 Oct 2026, item 6): the size check is in the browser before any chunk goes up, with
 * the server's own caps (lib/uploadCaps.ts); the brief lands in the Library before the reader on this device sees it, a brief
 * over the reader's limits still lands and the reader's refusal says so, and Start files the stored brief without sending it
 * again. Uploads are mocked: no file here is really 2 GB (a fake File with its size set), and no byte of one is read.
 */

const GB = 1024 ** 3, MB = 1024 ** 2;

/** A File whose size is set without its bytes; reading any byte throws, so a check that reads one fails the test. */
function fakeFile(name: string, type: string, size: number): File {
  const file = new File(["%PDF-1.4"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  for (const read of ["arrayBuffer", "slice", "text", "stream", "bytes"])
    Object.defineProperty(file, read, { value: () => { throw new Error(`read ${read}`); } });
  return file;
}

const receipt = (id: string, filename: string): UploadedFile => ({
  id, filename, mime: "application/pdf", kind: "file", bytes: 1, width: null, height: null, durationS: null, sha256: "0".repeat(64), url: `/api/uploads/${id}`,
});

/** Every request the code under test sends, as "METHOD /path"; the library's reads answer empty, filings answer ok. */
function stubFetch() {
  const calls: string[] = [];
  const before = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (init?.method === "POST") return Response.json({ ok: true });
    return Response.json(url.searchParams.get("source") === "generations" ? { generations: [], nextPageCursor: null } : { uploads: [], nextCursor: null });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = before; } };
}

test("the caps: 2 GB for a brief or any file, 200 MB for a reference, one source for the browser and the server", () => {
  expect([MAX_CHAT_BYTES, MAX_REFERENCE_BYTES]).toEqual([2 * GB, 200 * MB]);
  expect([uploadCapBytes("chat"), uploadCapBytes("reference")]).toEqual([MAX_CHAT_BYTES, MAX_REFERENCE_BYTES]);
  /* The server's finish reads the same constants: re-exported, never typed twice. */
  expect([reservations.MAX_CHAT_BYTES, reservations.MAX_REFERENCE_BYTES]).toEqual([MAX_CHAT_BYTES, MAX_REFERENCE_BYTES]);
  const server = readFileSync("lib/uploadReservations.ts", "utf8");
  expect(server).toMatch(/from "\.\/uploadCaps"/);
  expect(server).toContain("throw new UploadError(uploadCapWords(input.purpose), 413)");
  /* Neither cap is typed again where uploads are checked (the 4 MB chunk and direct-upload sizes are not caps). */
  const typedCap = /\b(2\s*\*\s*1024\s*\*\s*1024\s*\*\s*1024|200\s*\*\s*1024\s*\*\s*1024|2048\s*:\s*200)\b/;
  for (const path of ["lib/uploadReservations.ts", "lib/uploadRecovery.ts", "lib/uploadClient.ts", "lib/storage.ts", "app/api/platform/route.ts"])
    expect(readFileSync(path, "utf8"), path).not.toMatch(typedCap);
  expect([capSizeWords(MAX_CHAT_BYTES), capSizeWords(MAX_REFERENCE_BYTES)]).toEqual(["2 GB", "200 MB"]);
  expect([uploadCapWords("chat"), uploadCapWords("reference")]).toEqual(["Files go up to 2 GB.", "References go up to 200 MB."]);
});

test("the pre-check at the boundaries: empty refused, the cap itself accepted, one byte over refused naming the cap", () => {
  for (const purpose of ["chat", "reference"] as const) {
    const cap = uploadCapBytes(purpose);
    expect(uploadCapProblem({ size: 0 }, purpose)).toBe("This file is empty.");
    expect(uploadCapProblem({ size: Number.NaN }, purpose)).toBe("This file is empty.");
    expect(uploadCapProblem({ size: 1 }, purpose)).toBeNull();
    expect(uploadCapProblem({ size: cap }, purpose)).toBeNull();
    expect(uploadCapProblem({ size: cap + 1 }, purpose)).toBe(uploadCapWords(purpose));
  }
  /* A 1 GB file is a fine brief and too big a reference. */
  expect(uploadCapProblem({ size: GB }, "chat")).toBeNull();
  expect(uploadCapProblem({ size: GB }, "reference")).toBe("References go up to 200 MB.");
});

test("the chunk route's cap: an index at or past ceil(cap ÷ chunk), or bytes past the cap, is refused; an in-cap upload is not", () => {
  expect(UPLOAD_CHUNK_BYTES).toBe(3_500_000);
  expect([uploadChunkLimit("chat"), uploadChunkLimit("reference")]).toEqual([614, 60]);
  expect(reservations.MAX_UPLOAD_CHUNKS).toBe(uploadChunkLimit("chat"));
  for (const purpose of ["chat", "reference"] as const) {
    const limit = uploadChunkLimit(purpose), cap = uploadCapBytes(purpose);
    /* Every chunk of a file exactly at the cap, sliced the browser's way, is admitted: the last one included. */
    const count = Math.ceil(cap / UPLOAD_CHUNK_BYTES), lastBytes = cap - (count - 1) * UPLOAD_CHUNK_BYTES;
    expect(count).toBe(limit);
    expect(uploadChunkProblem({ index: limit - 1, bytes: lastBytes, sessionBytes: cap - lastBytes, purpose })).toBeNull();
    expect(uploadChunkProblem({ index: limit, bytes: 1, sessionBytes: 0, purpose })).toBe(uploadCapWords(purpose));
    expect(uploadChunkProblem({ index: 0, bytes: 2, sessionBytes: cap - 1, purpose })).toBe(uploadCapWords(purpose));
  }
  /* A chunk that names no kind is held to the largest cap, as the route always did. */
  expect(uploadChunkProblem({ index: 613, bytes: 1, sessionBytes: 0 })).toBeNull();
  expect(uploadChunkProblem({ index: 614, bytes: 1, sessionBytes: 0 })).toBe("Files go up to 2 GB.");
  expect([uploadPurposeOf("chat"), uploadPurposeOf("reference"), uploadPurposeOf("other"), uploadPurposeOf(null)]).toEqual(["chat", "reference", null, null]);
  /* The browser names its kind on every chunk it sends; the route reads it. */
  expect(readFileSync("lib/uploadClient.ts", "utf8")).toContain('form.append("purpose", current.purpose);');
  expect(readFileSync("app/api/uploads/chunk/route.ts", "utf8")).toContain('purpose: uploadPurposeOf(form?.get("purpose"))');
});

test("the upload client refuses a file over its cap before it hashes a byte or sends a request", async () => {
  const net = stubFetch();
  try {
    const scope = "particl-active-ws1-user1";
    await expect(uploadFile(fakeFile("huge.pdf", "application/pdf", 2 * GB + 1), "chat", undefined, { scope })).rejects.toThrow("Files go up to 2 GB.");
    await expect(uploadFile(fakeFile("huge.mov", "video/quicktime", 200 * MB + 1), "reference", undefined, { scope })).rejects.toThrow("References go up to 200 MB.");
    await expect(uploadFile(fakeFile("empty.pdf", "application/pdf", 0), "chat", undefined, { scope })).rejects.toThrow("This file is empty.");
    await expect(claimUploadEnvelope(scope, fakeFile("huge.pdf", "application/pdf", 3 * GB), "chat")).rejects.toThrow("Files go up to 2 GB.");
    /* At the cap itself the check passes and the client goes on to hash the bytes (here, a read that throws). */
    await expect(uploadFile(fakeFile("edge.pdf", "application/pdf", 2 * GB), "chat", undefined, { scope })).rejects.toThrow(/^read /);
    expect(net.calls).toEqual([]);
  } finally {
    net.restore();
  }
});

test("Attach a brief: the file lands in the Library first, then the reader fills the box", async () => {
  const order: string[] = [];
  const file = fakeFile("treatment.pdf", "application/pdf", 2 * MB);
  const progress: number[] = [];
  const done = await attachBrief(file, {
    save: async (f, onProgress) => { order.push(`save ${f.name}`); onProgress(50); onProgress(100); return receipt("up_brief", f.name); },
    read: async (f) => { order.push(`read ${f.name}`); return { text: "INT. LIGHTHOUSE - NIGHT", cut: false }; },
    signal: new AbortController().signal,
    onProgress: (pct) => progress.push(pct),
    onSaved: () => order.push("saved"),
  });
  expect(order).toEqual(["save treatment.pdf", "saved", "read treatment.pdf"]);
  expect(progress).toEqual([50, 100]);
  expect(done).toEqual({ upload: receipt("up_brief", "treatment.pdf"), text: "INT. LIGHTHOUSE - NIGHT", cut: false, note: null });
});

test("Attach a brief over 20 MB still lands in the Library; the reader is not run, and says so in words", async () => {
  const order: string[] = [];
  const steps = {
    save: async (f: File) => { order.push(`save ${f.name}`); return receipt("up_big", f.name); },
    read: async (f: File): Promise<{ text: string; cut: boolean }> => { order.push(`read ${f.name}`); return { text: "never", cut: false }; },
    signal: new AbortController().signal,
  };
  expect(briefReadable({ name: "a.pdf", type: "application/pdf", size: MAX_PDF_BYTES })).toBe(true);
  expect(briefReadable({ name: "a.pdf", type: "application/pdf", size: MAX_PDF_BYTES + 1 })).toBe(false);
  for (const size of [MAX_PDF_BYTES + 1, 1.5 * GB, 2 * GB]) {
    order.length = 0;
    const done = await attachBrief(fakeFile("bible.pdf", "application/pdf", size), steps);
    expect(order).toEqual(["save bible.pdf"]);
    expect(done).toEqual({ upload: receipt("up_big", "bible.pdf"), text: null, cut: false, note: "Saved to Library. Read once document reading ships." });
  }
  /* A text file past the reader's 2 MB lands the same way. */
  order.length = 0;
  expect((await attachBrief(fakeFile("notes.txt", "text/plain", 3 * MB), steps)).note).toBe("Saved to Library. Read once document reading ships.");
  expect(order).toEqual(["save notes.txt"]);
});

test("Attach a brief the reader refuses (scanned, 400+ pages, no text) is still in the Library, and says so", async () => {
  const done = await attachBrief(fakeFile("scan.pdf", "application/pdf", 5 * MB), {
    save: async (f) => receipt("up_scan", f.name),
    read: async () => { throw new BriefFileError("This PDF has no text to read. Use one with text, or a text file."); },
    signal: new AbortController().signal,
  });
  expect(done).toEqual({ upload: receipt("up_scan", "scan.pdf"), text: null, cut: false, note: "Saved to Library. Read once document reading ships." });
});

test("Attach a brief over 2 GB, or not a brief, is refused in words before anything is uploaded or read", async () => {
  const touched: string[] = [];
  const steps = {
    save: async (f: File) => { touched.push(`save ${f.name}`); return receipt("never", f.name); },
    read: async (f: File) => { touched.push(`read ${f.name}`); return { text: "", cut: false }; },
    signal: new AbortController().signal,
  };
  await expect(attachBrief(fakeFile("huge.pdf", "application/pdf", 2 * GB + 1), steps)).rejects.toThrow(new BriefFileError("Files go up to 2 GB."));
  await expect(attachBrief(fakeFile("brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", MB), steps)).rejects.toThrow("Use a PDF or text file.");
  await expect(attachBrief(fakeFile("empty.txt", "text/plain", 0), steps)).rejects.toThrow("This file is empty.");
  expect(touched).toEqual([]);
});

test("Attach a brief whose upload fails says why and reads nothing", async () => {
  const touched: string[] = [];
  await expect(attachBrief(fakeFile("brief.pdf", "application/pdf", MB), {
    save: async () => { throw new Error("Upload request failed (503). Resume it from Uploads."); },
    read: async (f) => { touched.push(`read ${f.name}`); return { text: "x", cut: false }; },
    signal: new AbortController().signal,
  })).rejects.toThrow("Upload request failed (503). Resume it from Uploads.");
  expect(touched).toEqual([]);
});

test("Start files the stored brief into the new project without uploading it again; a brief not up yet goes with the references", async () => {
  const brief = fakeFile("treatment.pdf", "application/pdf", 30 * MB);
  const look = fakeFile("look.webp", "image/webp", MB);
  const stored = receipt("up_brief", "treatment.pdf");
  expect(startFiles(null, [look])).toEqual([look]);
  expect(startFiles({ file: brief, upload: stored }, [look])).toEqual([{ file: brief, stored }, look]);
  expect(startFiles({ file: brief, upload: null }, [])).toEqual([brief]);

  const net = stubFetch();
  try {
    const added = await uploadFilesToProject("particl-active-ws1-user1", "project-1", startFiles({ file: brief, upload: stored }, []));
    expect(added).toEqual({ ids: ["upload:up_brief"], uploads: [stored], notes: [] });
    /* One filing, then the Library read again: no upload session, chunk or finish. */
    expect(net.calls.filter((call) => call.includes("/api/uploads"))).toEqual([]);
    expect(net.calls.filter((call) => call.startsWith("POST"))).toEqual(["POST /api/workbench/library"]);
  } finally {
    net.restore();
  }
});

test("the attach flow is free: no price, charge or paid route in it", () => {
  for (const path of ["components/graphite/home/attach-brief.ts", "lib/uploadCaps.ts"]) {
    const src = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src, path).not.toMatch(/\bcr\b|credit|price|quote|charge|spend|\/api\/(generate|jobs|audio)/i);
  }
});
