import { projectSchema } from "./studio-schema";
import type { Project } from "./studio";

const limit = 3_500_000;
const lifetime = 10 * 60 * 1000;
const visitor = "particl-active-visitor-visitor";
export function movieHandoffKey(token: string, scope: string) {
  if (!/^[a-f0-9-]{36}$/.test(token))
    throw new Error("Open the movie renderer from Delivery.");
  return `particl-movie-${scope === visitor ? "visitor" : "private"}:${token}`;
}
export function createMovieHandoff(project: Project, scope: string) {
  const token = crypto.randomUUID();
  const raw = JSON.stringify({ project, scope, createdAt: Date.now() });
  if (raw.length > limit)
    throw new Error("The project exceeds the 3.5 MB export snapshot limit.");
  for (let i = sessionStorage.length - 1; i >= 0; i--) {
    const key = sessionStorage.key(i);
    if (key?.startsWith("particl-movie-")) sessionStorage.removeItem(key);
  }
  sessionStorage.setItem(movieHandoffKey(token, scope), raw);
  return `/workbench/movie?snapshot=${encodeURIComponent(token)}`;
}
export function readMovieHandoff(raw: string | null, scope: string): Project {
  if (!raw || raw.length > limit)
    throw new Error(
      "This export snapshot is unavailable. Return to Delivery and open the movie renderer again.",
    );
  const value = JSON.parse(raw);
  if (value.scope !== scope)
    throw new Error(
      "This export belongs to another account or workspace. Return to your current workbench.",
    );
  if (
    !Number.isFinite(value.createdAt) ||
    value.createdAt > Date.now() ||
    Date.now() - value.createdAt > lifetime
  )
    throw new Error(
      "This export snapshot expired. Return to Delivery to export the latest edit.",
    );
  return projectSchema.parse(value.project) as Project;
}
