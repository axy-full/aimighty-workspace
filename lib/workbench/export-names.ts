import type { Project } from "./studio";

/**
 * The project with each render-backed asset carrying its template name (R9),
 * so every file an export writes, and every EDL/XML line that points at it,
 * reads like the workspace's downloads. Two assets that land on the same name
 * get _2, _3 so the package never collides. If the names cannot be read, the
 * export keeps its previous names rather than failing.
 */
export async function withExportNames(p: Project): Promise<Project> {
  const ids = [...new Set(p.assets.map((a) => a.generationId).filter((id): id is string => !!id && /^[A-Za-z0-9_-]{1,100}$/.test(id)))];
  if (!ids.length) return p;
  let names: Record<string, string>;
  try {
    const response = await fetch("/api/workbench/export-names", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generationIds: ids }),
    });
    if (!response.ok) return p;
    names = ((await response.json()) as { names?: Record<string, string> }).names ?? {};
  } catch {
    return p;
  }
  const used = new Map<string, number>();
  return {
    ...p,
    assets: p.assets.map((asset) => {
      const base = asset.generationId ? names[asset.generationId] : undefined;
      if (!base) return asset;
      const seen = (used.get(base.toLowerCase()) ?? 0) + 1;
      used.set(base.toLowerCase(), seen);
      return { ...asset, exportName: seen === 1 ? base : `${base}_${seen}` };
    }),
  };
}
