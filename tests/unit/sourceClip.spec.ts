import { test, expect } from "@playwright/test";
import { uploadSource, resolutionOfHeight, uploadSourceParams } from "../../lib/sourceClip";
import { sourceProblem, getTask } from "../../lib/tasks";

const vid = (id: string, extra: Record<string, unknown> = {}) => ({ id, filename: `${id}.mp4`, mime: "video/mp4", kind: "video" as const, bytes: 1, width: 1280, height: 720, durationS: 8, sha256: "", url: "", base64Bytes: 0, role: "reference_video" as const, verified: true, ...extra });
const img = (id: string) => ({ ...vid(id), kind: "image" as const, mime: "image/png", role: "reference_image" as const });

/** An uploaded clip is a source (the edit fix): the tray's one video, when a locked task is on and no render is chosen. */
test("the tray's one video is the source; none or two is not; a chosen render wins", () => {
  const edit = { id: "edit", gen: null };
  expect(uploadSource(edit, [vid("a"), img("b")])?.id).toBe("a");
  expect(uploadSource(edit, [img("b")])).toBeNull();
  expect(uploadSource(edit, [vid("a"), vid("c")])).toBeNull();
  expect(uploadSource({ id: "edit", gen: { id: "g1" } }, [vid("a")])).toBeNull();
  expect(uploadSource(null, [vid("a")])).toBeNull();
});

test("the vendor's rules read an upload by its height and length, and speak to an upload as one", () => {
  expect(resolutionOfHeight(1080)).toBe("1080p");
  expect(resolutionOfHeight(720)).toBe("720p");
  expect(resolutionOfHeight(480)).toBe("480p");
  expect(resolutionOfHeight(null)).toBeUndefined();
  expect(uploadSourceParams({ durationS: 8.26, height: 720 })).toEqual({ duration: 8.3, resolution: "720p" });
  expect(uploadSourceParams({ durationS: null, height: null })).toEqual({});
  const edit = getTask("edit");
  expect(sourceProblem(edit, { duration: 8, resolution: "720p" }, "upload")).toBeNull();
  expect(sourceProblem(edit, { duration: 8, resolution: "1080p" }, "upload")).toContain("Upload a 720p version");
  expect(sourceProblem(edit, { duration: 8, resolution: "1080p" })).toContain("Render it again at 720p");
  expect(sourceProblem(edit, { duration: 2, resolution: "720p" }, "upload")).toContain("at least 4 seconds");
});
