import type { Plan, Project } from "./studio";

export const MARKETING_TASKS = [
  {
    id: "kit",
    name: "Campaign kit",
    description: "Strategy, creative, copy and launch plan",
    request:
      "Create a complete campaign kit: positioning and audience insight, a campaign concept, three distinct hooks with finished ad copy and CTAs, channel adaptations, asset-to-deliverable mapping, and a phased launch plan with a measurement checklist.",
  },
  {
    id: "strategy",
    name: "Strategy",
    description: "Positioning, audience and creative routes",
    request:
      "Develop a campaign strategy with positioning, audience insight, the offer and message hierarchy, three distinct creative routes, recommended channel roles, and a testable measurement plan. Explain the tradeoffs and recommend one route.",
  },
  {
    id: "copy",
    name: "Hooks & copy",
    description: "Ready-to-edit ad and social variants",
    request:
      "Write finished campaign copy: three distinct hooks, primary ad text, headlines, CTAs, and short social captions. Label every variant and intended audience/channel. Include a short video ad script with visual direction and spoken copy. Do not only describe copy to write later.",
  },
  {
    id: "channels",
    name: "Channel versions",
    description: "Adapt the idea to each placement",
    request:
      "Adapt the campaign for each channel in the marketing brief. Produce finished copy and creative direction for each, suggest aspect ratios and durations as editable recommendations, and map selected assets to the adaptations. If no channels are given, suggest a small set and label that assumption. Do not claim to have checked current platform specifications.",
  },
  {
    id: "launch",
    name: "Launch plan",
    description: "Content calendar, handoffs and measurement",
    request:
      "Produce a practical launch and content plan with relative timing, channels, finished post copy or content angles, deliverables, dependencies, suggested owner roles, and a measurement checklist. Use relative days unless actual dates are supplied. Label proposed budgets and targets as assumptions, never as promised results.",
  },
] as const;
export type MarketingTask = (typeof MARKETING_TASKS)[number]["id"];

export function marketingRequest(task: MarketingTask, instructions: string) {
  const selected =
    MARKETING_TASKS.find((item) => item.id === task) ?? MARKETING_TASKS[0];
  return `${selected.request}\nUse the saved project marketing brief and production context. Deliver usable material in clearly labeled sections, with assumptions and missing inputs called out. Each output step should contain a complete section, not a task to execute later.${instructions.trim() ? `\nAdditional creative direction:\n${instructions.trim().slice(0, 6000)}` : ""}`;
}

export function isMarketingPlan(plan: Plan) {
  return plan.role === "marketing" || plan.role === "Marketing Studio";
}

export function marketingMarkdown(project: Project, plan: Plan) {
  const assets = [...project.assets, ...(project.sharedAssets ?? [])];
  const refs = plan.refs.map(
    (id) =>
      assets.find((asset) => asset.id === id)?.name ??
      `${id} (no longer in project)`,
  );
  return `# ${project.name} / Marketing Studio\n\nRun: ${plan.id}\nModel: ${plan.model}\nDetail: ${plan.depth}${plan.effort ? `\nReasoning effort: ${plan.effort}` : ""}\n\n## Request\n\n${plan.request}\n\n## Summary\n\n${plan.summary}\n\n${plan.steps.map((step, index) => `## Section ${index + 1}\n\n${step}`).join("\n\n")}\n\n## Selected references\n\n${refs.length ? refs.map((name) => `- ${name}`).join("\n") : "No assets selected."}\n`;
}

// Spreadsheet applications execute formula-like cells unless they are escaped.
function csvCell(value: string) {
  const safe =
    /^[\s]*[=+@-]/.test(value) || /^[\t\r]/.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}
export function marketingCsv(project: Project, plan: Plan) {
  return [
    "project,run,section,content",
    ...[plan.summary, ...plan.steps].map((text, index) =>
      [project.name, plan.id, index ? String(index) : "Summary", text]
        .map(csvCell)
        .join(","),
    ),
  ].join("\r\n");
}
