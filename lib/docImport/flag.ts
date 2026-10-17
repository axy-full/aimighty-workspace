/**
 * The document importer's switch. DOC_IMPORT_ENABLED=1 (or true / on) turns
 * it on; anything else, unset included, is off, in every environment. Off,
 * the Inngest route does not register the import function, nothing can be
 * queued, and a delivered event returns without reading a byte.
 */
export function docImportEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.DOC_IMPORT_ENABLED?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}
