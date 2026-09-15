import { test, expect } from "@playwright/test";
import { resolveGenInput, inputAsReference, referenceIdentity } from "../../lib/genAssetInput";
import { DRAG_TYPE, readDrag, startUploadDrag, type DraggedAsset } from "../../lib/dnd";
import type { UploadedFile } from "../../lib/uploadClient";

const scope = "particl-active-workspace-user";
const upload: UploadedFile = {
  id: "upl_original", filename: "Original.png", mime: "image/png", kind: "image",
  bytes: 2048, width: 640, height: 480, durationS: null, sha256: "a".repeat(64),
  url: "https://untrusted.invalid/never-fetch-this",
};
function mocked(body: unknown, calls: { url: string; options?: RequestInit }[], status = 200): typeof fetch {
  return async (url, options) => { calls.push({ url: String(url), options }); return Response.json(body, { status }); };
}

test("uploaded drops re-resolve only their identity in the scoped workspace and retain original metadata", async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  const asset = await resolveGenInput({ kind: "upload", upload: { ...upload, kind: "video", filename: "Spoofed" } }, scope, mocked({ upload }, calls));
  expect(calls).toEqual([{ url: "/api/uploads/upl_original/metadata", options: { cache: "no-store", headers: { "X-Workbench-Scope": scope } } }]);
  expect(asset).toMatchObject({ name: "Original.png", kind: "image", width: 640, height: 480, bytes: 2048, url: "/api/uploads/upl_original", origin: "upload" });
  expect(referenceIdentity(inputAsReference(asset, "first_frame"))).toEqual({ uploadId: "upl_original" });
});

test("generated drops use a completed saved generation and preserve genId without upload or provider submission", async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  const asset = await resolveGenInput("generation:gen_video", scope, mocked({ generation: { id: "gen_video", kind: "video", status: "succeeded", storedUrl: "https://provider.invalid/private", prompt: "Hero take", params: { duration: 7.5 } } }, calls));
  expect(calls.map((call) => call.url)).toEqual(["/api/jobs/gen_video?sync=0"]);
  expect(asset).toMatchObject({ origin: "generation", kind: "video", url: "/api/media/gen_video", seconds: 7.5 });
  const ref = inputAsReference(asset, "reference_video");
  expect(referenceIdentity(ref)).toEqual({ genId: "gen_video" });
  expect(ref.durationS).toBe(7.5);
});

for (const identity of ["upl_original", "upload:upl_original"]) {
  test(`initial reference ${identity} resolves an individual upload outside the first listing page`, async () => {
    const calls: { url: string; options?: RequestInit }[] = [];
    expect((await resolveGenInput(identity, scope, mocked({ upload }, calls))).id).toBe("upl_original");
    expect(calls[0].url).toBe("/api/uploads/upl_original/metadata");
  });
}

test("malformed identities and signed-out input never make requests", async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  const transport = mocked({}, calls);
  for (const id of ["https://attacker.invalid/a", "../other", "generation:../../secret", "upload:a?b=1", "", "a".repeat(161)])
    await expect(resolveGenInput(id, scope, transport)).rejects.toThrow(/identity/);
  await expect(resolveGenInput("upl_original", "", transport)).rejects.toThrow(/Sign in/);
  expect(calls).toHaveLength(0);
});

test("missing, unfinished and unavailable media cannot become visual references", async () => {
  for (const generation of [null, { id: "gen_video", status: "running", storedUrl: "original", kind: "video" }, { id: "gen_video", status: "succeeded", storedUrl: null, kind: "video" }, { id: "different", status: "succeeded", storedUrl: "original", kind: "image" }])
    await expect(resolveGenInput("generation:gen_video", scope, mocked({ generation }, []))).rejects.toThrow(/completed/);
  await expect(resolveGenInput("upload:upl_original", scope, mocked({ error: "This workspace changed." }, [], 409))).rejects.toThrow("This workspace changed.");
  await expect(resolveGenInput("upload:upl_original", scope, mocked({ upload: { ...upload, id: "other" } }, []))).rejects.toThrow(/verified/);
  const audio = await resolveGenInput("generation:gen_audio", scope, mocked({ generation: { id: "gen_audio", kind: "audio", status: "succeeded", storedUrl: "saved" } }, []));
  expect(() => inputAsReference(audio, "reference_image")).toThrow(/image or video/);
});

test("upload drag roundtrips alongside legacy cast payloads and rejects non-Particl data", () => {
  const values = new Map<string, string>();
  const event = { dataTransfer: { setData: (key: string, value: string) => values.set(key, value), getData: (key: string) => values.get(key) || "", effectAllowed: "" } } as unknown as React.DragEvent;
  startUploadDrag(event, upload);
  expect(event.dataTransfer.effectAllowed).toBe("copy");
  expect(readDrag(event)).toEqual({ kind: "upload", upload });
  const cast: DraggedAsset = { kind: "cast", castId: "hero", name: "Hero", uploadId: upload.id };
  values.set(DRAG_TYPE, JSON.stringify(cast));
  expect(readDrag(event)).toEqual(cast);
  values.set(DRAG_TYPE, "not-json");
  expect(readDrag(event)).toBeNull();
  expect(referenceIdentity({ id: "old-upload" })).toEqual({ uploadId: "old-upload" });
});
