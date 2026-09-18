import type { Project } from '../workbench/studio';
import { sameDraftContent } from '../workbench/draft-request';

function stable(value: unknown): string {
  return JSON.stringify(value, (_, part) => part && typeof part === 'object' && !Array.isArray(part) ? Object.fromEntries(Object.entries(part).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))) : part);
}
/** Accept append-only server asset registration without replacing newer local
 * scene edits. Other remote changes remain a visible revision conflict. */
export function mergeRegisteredAstraAssets(base: Project, current: Project, remote: Project): Project {
  if (base.id !== current.id || current.id !== remote.id) throw new Error('Return to the render’s project to load its saved outputs.');
  if (!sameDraftContent({ ...base, assets: [] }, { ...remote, assets: [] })) throw new Error('This project also changed in another session. Keep your current edits and resolve the project conflict before loading outputs.');
  const previous = new Map(base.assets.map(asset => [asset.id, asset]));
  const latest = new Map(remote.assets.map(asset => [asset.id, asset]));
  for (const [id, asset] of previous) if (stable(latest.get(id)) !== stable(asset)) throw new Error('An existing asset changed in another session. Your current edits have been kept.');
  const local = new Map(current.assets.map(asset => [asset.id, asset]));
  for (const asset of remote.assets.filter(asset => !previous.has(asset.id))) {
    if (local.has(asset.id) && stable(local.get(asset.id)) !== stable(asset)) throw new Error('A saved output conflicts with a local asset. Your current edits have been kept.');
    local.set(asset.id, asset);
  }
  if (local.size > 500) throw new Error('The project asset limit was reached. The render originals remain available in the library.');
  return { ...current, assets: [...local.values()], productionProjectId: remote.productionProjectId, shotMappings: remote.shotMappings };
}
