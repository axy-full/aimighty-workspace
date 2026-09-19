export type SuiteId = "particl" | "atomik" | "moleculr" | "subatomik";
export type RoomId =
  "projects" | "production" | "make" | "library" | "workspace";
export type SuitePage = { id: string; label: string };

export const SUITES: {
  id: SuiteId;
  name: string;
  description: string;
  color: string;
}[] = [
  {
    id: "particl",
    name: "Particl Production Studio",
    description: "The production studio",
    color: "#D7D9DE",
  },
  {
    id: "atomik",
    name: "Atomik Super Agent",
    description: "The production agent",
    color: "#F0B23E",
  },
  {
    id: "moleculr",
    name: "Moleculr Business Suite",
    description: "Build and grow your brand",
    color: "#5CC8B4",
  },
  {
    id: "subatomik",
    name: "Subatomik Viral Studio",
    description: "The viral studio",
    color: "#D48CF5",
  },
];

/**
 * Retired Particl stage IDs. Saved projects, old links and agent tools may
 * still name them; each one opens the visible stage that now holds its panel.
 */
export const PARTICL_STAGE_ALIASES: Record<string, string> = {
  script: "brief",
  moodboard: "storyboard",
  elements: "characters",
};

/** Moleculr keeps every former page as an in-page section of Marketing Studio. */
export const MOLECULR_SECTIONS: SuitePage[] = [
  { id: "product", label: "Product" },
  { id: "brand", label: "Brand" },
  { id: "cast", label: "Cast" },
  { id: "format", label: "Format" },
  { id: "variants", label: "Variants" },
  { id: "design", label: "Design" },
  { id: "publish", label: "Publish" },
];

export const PAGES: Record<SuiteId, SuitePage[]> = {
  particl: [
    { id: "brief", label: "Brief & Script" },
    { id: "storyboard", label: "Boards" },
    { id: "characters", label: "Cast & Elements" },
    { id: "astra-blender", label: "Astra" },
    { id: "canvas", label: "Rig" },
    { id: "assets", label: "Takes" },
    { id: "edit", label: "Edit & Sound" },
    { id: "export", label: "Deliver" },
  ],
  atomik: [
    { id: "runs", label: "Runs" },
    { id: "generate", label: "Generate" },
    { id: "recipes", label: "Recipes" },
    { id: "approvals", label: "Approvals" },
    { id: "budget", label: "Budget" },
    { id: "models", label: "Models" },
  ],
  moleculr: [{ id: "marketing", label: "Marketing Studio" }],
  subatomik: [
    { id: "motion-transfer", label: "Motion Transfer" },
    { id: "object-swap", label: "Object Swap" },
    { id: "shorts", label: "Shorts" },
  ],
};

/** Resolve a Particl stage ID or one of its retired aliases to a visible stage. */
export function particlStage(page: string | null | undefined): string | null {
  if (!page) return null;
  if (PAGES.particl.some((item) => item.id === page)) return page;
  return PARTICL_STAGE_ALIASES[page] ?? null;
}

/** Resolve a Moleculr page or former page to its Marketing Studio section. */
export function moleculrSection(page: string | null | undefined): string | null {
  return page && MOLECULR_SECTIONS.some((item) => item.id === page) ? page : null;
}

/** Project always identifies the workbench draft, never its production mapping. */
export function suiteHref(
  suite: SuiteId,
  projectId?: string | null,
  page?: string,
) {
  const section = suite === "moleculr" ? moleculrSection(page) : null;
  const selected =
    (suite === "particl" ? particlStage(page) : null) ??
    PAGES[suite].find((item) => item.id === page)?.id ??
    PAGES[suite][0].id;
  const query = new URLSearchParams(projectId ? { project: projectId } : {});
  if (suite === "particl") query.set("stage", selected);
  else {
    if (suite === "moleculr") query.set("suite", suite);
    query.set("page", selected);
  }
  return `${suite === "particl" || suite === "moleculr" ? "/workbench" : `/${suite}`}?${query}${section ? `#${section}` : ""}`;
}

export function roomHref(room: RoomId, projectId?: string | null) {
  if (room === "projects") return "/";
  if (room === "production") return suiteHref("particl", projectId);
  if (room === "make")
    return projectId
      ? `/generate?${new URLSearchParams({ project: projectId })}`
      : "/generate";
  if (room === "workspace") return "/settings";
  return `/library?${new URLSearchParams({ all: "1", ...(projectId ? { project: projectId } : {}) })}`;
}

export function suiteForRoute(
  path: string,
  query: Pick<URLSearchParams, "get">,
): SuiteId {
  if (path === "/atomik" || path.startsWith("/atomik/")) return "atomik";
  if (path === "/subatomik" || path.startsWith("/subatomik/") || path === "/subatomic" || path.startsWith("/subatomic/"))
    return "subatomik";
  if (path === "/workbench" && query.get("suite") === "moleculr")
    return "moleculr";
  return "particl";
}

export function roomForRoute(path: string): RoomId {
  if (path === "/") return "projects";
  if (/^\/(generate|make)(\/|$)/.test(path)) return "make";
  if (path === "/library") return "library";
  if (/^\/(settings|team|billing|usage|statements|account)(\/|$)/.test(path))
    return "workspace";
  return "production";
}
