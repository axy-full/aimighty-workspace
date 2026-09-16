/** Keep the original Unicode filename without permitting header or path injection. */
export function attachmentDisposition(filename: string): string {
  const clean = filename.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim().slice(0, 200) || "original";
  const ascii = clean.replace(/[^\x20-\x7e]|[";]/g, "_");
  const encoded = encodeURIComponent(clean.toWellFormed()).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
