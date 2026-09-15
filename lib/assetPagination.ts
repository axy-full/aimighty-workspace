/** Shared, bounded keyset pagination for the workspace's private asset lists. */
export type AssetCursor = { createdAt: number; id: string };

export class AssetQueryError extends Error {}

export function assetCursor(value: AssetCursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function parseAssetCursor(raw: string | null): AssetCursor | null {
  if (raw === null) return null;
  if (!raw || raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw))
    throw new AssetQueryError("Invalid asset page cursor.");
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    if (Buffer.from(decoded).toString("base64url") !== raw) throw new Error();
    const value = JSON.parse(decoded);
    if (
      !value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 ||
      typeof value.id !== "string" || !value.id || value.id.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(value.id)
    ) throw new Error();
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    throw new AssetQueryError("Invalid asset page cursor.");
  }
}

export function assetPageQuery(params: URLSearchParams, defaultLimit: number) {
  const single = (key: string) => {
    if (params.getAll(key).length > 1)
      throw new AssetQueryError(`Supply only one ${key} parameter.`);
    return params.get(key);
  };
  const rawLimit = single("limit");
  if (rawLimit !== null && (!/^[1-9]\d{0,2}$/.test(rawLimit) || Number(rawLimit) > 500))
    throw new AssetQueryError("Choose an asset page size between 1 and 500.");
  const search = single("q") ?? "";
  if (search.length > 200 || /[\u0000-\u001f\u007f]/.test(search))
    throw new AssetQueryError("Search must be at most 200 characters without control characters.");
  return {
    limit: rawLimit === null ? defaultLimit : Number(rawLimit),
    search: search.trim(),
    cursor: parseAssetCursor(single("cursor")),
  };
}
