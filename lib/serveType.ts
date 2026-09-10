/**
 * What a stored file may be served AS.
 *
 * An upload's `mime` is not evidence. On the chat path the client named it —
 * the route validated the SHAPE of the string (`type/subtype`) and nothing
 * about its meaning — while `kind` was sniffed from three bytes of the head.
 * So a file beginning `GIF89a` and continuing as HTML could be stored as
 * `kind: "image"` with `mime: "text/html"`, and the media route echoed that
 * straight back with no `Content-Disposition`, rendering it inline on the
 * app's own origin. Stored XSS, from any member seat.
 *
 * `X-Content-Type-Options: nosniff` was already set and did not help: it
 * stops a browser guessing a type OTHER than the declared one, so against a
 * declared `text/html` it guarantees the very rendering it looks like it
 * prevents.
 *
 * So the rule here is an allowlist, not a filter. A type is inline-safe
 * because it appears below, not because it fails to look dangerous — the
 * blocklist version of this has to anticipate `text/html`, `image/svg+xml`,
 * `application/xhtml+xml`, `text/xml`, and whatever a browser decides to
 * render next year.
 *
 * Note `image/svg+xml` is deliberately ABSENT. An SVG is a document that can
 * carry script, and it is the one image type a browser will execute.
 */

const INLINE_SAFE = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/avif",
  "video/mp4", "video/webm", "video/quicktime",
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/webm", "audio/ogg", "audio/mp4", "audio/aac",
]);

/** Is this type one a browser may render in place without becoming a page? */
export const inlineSafe = (mime: string | null | undefined): boolean =>
  INLINE_SAFE.has(String(mime ?? "").toLowerCase().split(";")[0].trim());

export type Serving = { contentType: string; inline: boolean };

/**
 * How to serve a row: its own type when that type is inline-safe, and an
 * opaque download otherwise.
 *
 * `kind` is not consulted, on purpose. It was sniffed from the head of the
 * file, so it is exactly as forgeable as the rest, and it was the pairing of
 * a sniffed `kind` with a declared `mime` that opened this in the first
 * place. One question decides it: may a browser render this type?
 */
export function servingFor(mime: string | null | undefined): Serving {
  const m = String(mime ?? "").toLowerCase().split(";")[0].trim();
  return inlineSafe(m) ? { contentType: m, inline: true } : { contentType: "application/octet-stream", inline: false };
}
