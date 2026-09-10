import { test, expect } from "@playwright/test";
import { servingFor, inlineSafe } from "../../lib/serveType";

/**
 * A stored file's `mime` is not evidence (app/api/uploads/[id]/route.ts).
 *
 * The chat upload path let the client name the type — only its SHAPE was
 * checked — while `kind` was sniffed from three bytes of the head. So a file
 * beginning `GIF89a` and continuing as HTML could be stored as
 * `kind: "image"` with `mime: "text/html"`, and the media route echoed that
 * back with no Content-Disposition: stored XSS on the app's own origin, from
 * a member seat, reachable with a read-only API token.
 */
test("the types a browser may render in place are an allowlist", () => {
  for (const m of ["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4", "audio/mpeg"]) {
    expect(servingFor(m), m).toEqual({ contentType: m, inline: true });
  }
});

test("anything that can become a page leaves as a download", () => {
  for (const m of ["text/html", "application/xhtml+xml", "text/xml", "application/xml",
                   "text/javascript", "application/javascript", "text/plain", "application/pdf"]) {
    const s = servingFor(m);
    expect(s.inline, `${m} must not be inline`).toBe(false);
    expect(s.contentType, `${m} must not be echoed back`).toBe("application/octet-stream");
  }
});

test("SVG is not an image for this purpose", () => {
  /* The one image type a browser will execute: an SVG is a document that can
     carry script, so it is deliberately absent from the allowlist even
     though it is unquestionably an image. */
  expect(inlineSafe("image/svg+xml")).toBe(false);
  expect(servingFor("image/svg+xml").contentType).toBe("application/octet-stream");
});

test("an allowlist, not a blocklist — nonsense fails closed", () => {
  /* The blocklist version of this has to anticipate every type a browser
     might one day decide to render. This one only has to recognise the few
     it actually serves. */
  for (const m of [null, undefined, "", "nonsense", "IMAGE/PNG text/html", "../../etc/passwd"]) {
    expect(servingFor(m as string).inline, String(m)).toBe(false);
  }
});

test("a parameter does not smuggle a type past the check", () => {
  // "image/png; charset=utf-8" is still a png; the parameter is dropped.
  expect(servingFor("image/png; charset=utf-8")).toEqual({ contentType: "image/png", inline: true });
  // ...and case does not matter.
  expect(servingFor("IMAGE/PNG")).toEqual({ contentType: "image/png", inline: true });
  // ...but a dangerous type with a parameter is still dangerous.
  expect(servingFor("text/html; charset=utf-8").inline).toBe(false);
});
