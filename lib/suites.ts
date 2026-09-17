export type SuiteId = "particl" | "atomik" | "moleculr" | "subatomic";
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
    name: "Particl",
    description: "The production studio",
    color: "#D7D9DE",
  },
  {
    id: "atomik",
    name: "Atomik",
    description: "The production agent",
    color: "#F0B23E",
  },
  {
    id: "moleculr",
    name: "Moleculr",
    description: "The marketing studio",
    color: "#5CC8B4",
  },
  {
    id: "subatomic",
    name: "Subatomic",
    description: "The content factory",
    color: "#D48CF5",
  },
];

export const PAGES: Record<SuiteId, SuitePage[]> = {
  particl: [
    { id: "brief", label: "Brief" },
    { id: "script", label: "Script" },
    { id: "moodboard", label: "Look" },
    { id: "characters", label: "Cast" },
    { id: "elements", label: "Elements" },
    { id: "canvas", label: "Rig" },
    { id: "storyboard", label: "Boards" },
    { id: "assets", label: "Takes" },
    { id: "edit", label: "Edit" },
    { id: "export", label: "Deliver" },
  ],
  atomik: [
    { id: "runs", label: "Runs" },
    { id: "recipes", label: "Recipes" },
    { id: "approvals", label: "Approvals" },
    { id: "budget", label: "Budget" },
    { id: "models", label: "Models" },
  ],
  moleculr: [
    { id: "product", label: "Product" },
    { id: "cast", label: "Cast" },
    { id: "format", label: "Format" },
    { id: "variants", label: "Variants" },
    { id: "publish", label: "Publish" },
  ],
  subatomic: [
    { id: "trends", label: "Trends" },
    { id: "presets", label: "Presets" },
    { id: "factory", label: "Factory" },
    { id: "score", label: "Score" },
    { id: "schedule", label: "Schedule" },
  ],
};

/** Project always identifies the workbench draft, never its production mapping. */
export function suiteHref(
  suite: SuiteId,
  projectId?: string | null,
  page?: string,
) {
  const selected =
    PAGES[suite].find((item) => item.id === page)?.id ?? PAGES[suite][0].id;
  const query = new URLSearchParams(projectId ? { project: projectId } : {});
  if (suite === "particl") query.set("stage", selected);
  else {
    if (suite === "moleculr") query.set("suite", suite);
    query.set("page", selected);
  }
  return `${suite === "particl" || suite === "moleculr" ? "/workbench" : `/${suite}`}?${query}`;
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
  if (path === "/subatomic" || path.startsWith("/subatomic/"))
    return "subatomic";
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
