import { MOLECULR_FORMATS, type MoleculrBrief } from "../workbench/moleculr";
import { MOLECULR_SECTIONS } from "../suites";
import type { CanvasNode, Project } from "../workbench/studio";
import { graphEdges } from "./rig-graph";
import { isShotNode } from "./shots";
import {
  CARD_STATE,
  cardChips,
  cardState,
  groupNote,
  specFor,
  type CardState,
  type SpecFacts,
} from "./spec-cards";
import type { PageId, RigView } from "./types";

/**
 * Which of the phone's templates a page uses, and the derivations each one
 * needs (05-mobile, "Page templates").
 *
 * Everything here is pure, so a template's derivation is unit-tested without a
 * browser, and every figure comes from the same source the desktop page reads:
 * the shot list from lib/workspace/shots.ts, the flow from the real draft
 * graph, the rows from the spec-card config the desktop spec pages render, the
 * accordion from the saved Marketing brief. Nothing here holds content of its
 * own, so the two surfaces cannot drift.
 */

export type MobileTemplate = "shots" | "flow" | "cards" | "rows" | "accordion" | "form" | "edit";

/**
 * The six templates plus Edit & Sound's own layout, by page id.
 *
 * `shorts` is not in 05-mobile (it arrived after the design) and `generate` is
 * the ninth Atomik page the owner kept; both are spec-card pages on the
 * desktop, so both take the rows template rather than inventing a seventh.
 */
export const MOBILE_TEMPLATES: Record<PageId, MobileTemplate> = {
  rig: "shots",
  cast: "cards",
  takes: "cards",
  edit: "edit",
  marketing: "accordion",
  motion: "form",
  swap: "form",
  brief: "rows",
  boards: "rows",
  astra: "rows",
  deliver: "rows",
  agent: "rows",
  runs: "rows",
  generate: "rows",
  recipes: "rows",
  builds: "rows",
  skills: "rows",
  models: "rows",
  approvals: "rows",
  budget: "rows",
  shorts: "rows",
  sources: "rows",
  compare: "rows",
  history: "rows",
};

/** Rig's second tab is the flow; every other page has one template. */
export function templateFor(page: PageId, rigView: RigView = "list"): MobileTemplate {
  const template = MOBILE_TEMPLATES[page];
  return template === "shots" && rigView === "graph" ? "flow" : template;
}

/* ── Rows (Brief, Boards, Astra, Deliver, the Atomik pages, Sources,
      Compare, History) ──────────────────────────────────────────────────── */

export type MobileRow = {
  /** The card's own key, so React and the tests can name a row. */
  id: string;
  /** The 36px mono lead chip: the card's place in its group, or ✦ for the plan's own card. */
  lead: string;
  name: string;
  sub: string;
  /** Right-aligned mono value: the card's first counted chip, else its state. */
  value: string;
  state: CardState;
  /** The working tool this row opens on the desktop, when it has one. */
  tool?: string;
};

export type MobileRowGroup = { title: string; note: string; rows: MobileRow[] };

/** The plan's own card carries the agent's mark instead of an index. */
const PLAN_LEAD = "✦";

/**
 * The page's rows, from the same `SPEC_PAGES` groups and the same
 * `cardState` / `cardChips` the desktop spec cards render. A card's state
 * tints its lead chip; its first chip is the row's value, and with no chip the
 * row shows the state word rather than a blank.
 */
export function mobileRowGroups(page: PageId, facts: SpecFacts): MobileRowGroup[] {
  const spec = specFor(page);
  if (!spec) return [];
  return spec.groups.map((group) => ({
    title: group.title,
    note: groupNote(group, facts),
    rows: group.cards.map((card, i): MobileRow => {
      const state = cardState(card, facts);
      const chips = cardChips(card, facts);
      return {
        id: card.name,
        lead: card.plan ? PLAN_LEAD : String(i + 1).padStart(2, "0"),
        name: card.name,
        sub: card.desc,
        value: chips[0] ?? CARD_STATE[state].label.toLowerCase(),
        state,
        ...(card.tool ? { tool: card.tool } : {}),
      };
    }),
  }));
}

/** The intro paragraph above the rows — the desktop page's own. */
export function mobileRowIntro(page: PageId): string {
  return specFor(page)?.intro ?? "";
}

/* ── Flow (Rig's second tab) ─────────────────────────────────────────────── */

export type FlowStep = {
  id: string;
  /** The scene the flow is read around: the blue border, the ring and the pin. */
  scene: boolean;
  /**
   * The wire leaving this card downwards: blue while the chain is still
   * feeding the scene, grey once it is past it, and absent on the last card.
   */
  wire: "blue" | "grey" | null;
};

/**
 * The desktop node graph as one vertical chain (05-mobile, "Flow"): the
 * selected scene's inputs, the scene, then what the scene feeds, then anything
 * else on the graph. The order and the membership are the real draft's — the
 * same nodes and the same links `graphEdges` draws on the desktop — so the
 * phone shows the graph, not a picture of one.
 *
 * `selId` is the shot the workspace has selected; with none, the first shot
 * node on the graph is the scene, which is what the desktop canvas centres on.
 */
export function flowChain(nodes: readonly CanvasNode[], selId: string | null): FlowStep[] {
  if (!nodes.length) return [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const scene = (selId && byId.get(selId) && isShotNode(byId.get(selId)!) ? byId.get(selId)! : nodes.find(isShotNode)) ?? null;
  if (!scene) return nodes.map((node, i) => ({ id: node.id, scene: false, wire: i === nodes.length - 1 ? null : "grey" }));

  const edges = graphEdges(nodes);
  const inputs = edges.filter((edge) => edge.target === scene.id).map((edge) => edge.source);
  const downstream = edges.filter((edge) => edge.source === scene.id).map((edge) => edge.target);
  const order: string[] = [];
  const push = (id: string) => {
    if (byId.has(id) && !order.includes(id)) order.push(id);
  };
  /* Draft order inside each band, so two runs of the same graph read the same. */
  for (const node of nodes) if (inputs.includes(node.id)) push(node.id);
  push(scene.id);
  for (const node of nodes) if (downstream.includes(node.id)) push(node.id);
  for (const node of nodes) push(node.id);

  const sceneAt = order.indexOf(scene.id);
  return order.map((id, i) => ({
    id,
    scene: id === scene.id,
    wire: i === order.length - 1 ? null : i < sceneAt ? "blue" : "grey",
  }));
}

/* ── Accordion (Marketing Studio) ────────────────────────────────────────── */

export type MarketingSectionState = "done" | "active" | "idle";
export type MarketingFieldRow = { name: string; sub: string; value: string };
export type MarketingSection = {
  id: string;
  title: string;
  /** One line on what the section holds — the product's own description of it. */
  sub: string;
  state: MarketingSectionState;
  rows: MarketingFieldRow[];
};

const NONE = "—";
const n = (value: number) => value.toLocaleString("en-US");
const set = (text: string | null | undefined) => (text && text.trim() ? "saved" : NONE);

/** The section reads done when every row has a value, active when some do. */
function stateOf(rows: MarketingFieldRow[]): MarketingSectionState {
  const filled = rows.filter((row) => row.value !== NONE).length;
  if (!filled) return "idle";
  return filled === rows.length ? "done" : "active";
}

const SECTION_SUB: Record<string, string> = {
  product: "Details and your own originals",
  brand: "Voice and identity every variant inherits",
  cast: "Your own images, or a locked identity",
  format: "Nine creative formats",
  variants: "Each binding is a generation node",
  design: "Layout and treatment across the set",
  publish: "Leads to review and delivery",
};

/**
 * Marketing Studio's seven sections (lib/suites.ts MOLECULR_SECTIONS — the
 * same seven the desktop flow shows), each expanded to its own field rows,
 * every value read from the saved Marketing brief on the draft. A field the
 * brief does not hold reads "—" rather than a guess.
 */
export function marketingSections(project: Project | null): MarketingSection[] {
  const brief = (project?.moleculr ?? null) as MoleculrBrief | null;
  const format = MOLECULR_FORMATS.find((item) => item.id === brief?.format) ?? null;
  const variants = brief?.variants ?? [];
  const bound = variants.filter((variant) => variant.generation?.modelId).length;
  const kit = brief?.brandKit ?? null;
  const rowsFor = (id: string): MarketingFieldRow[] => {
    switch (id) {
      case "product":
        return [
          { name: "Name & offer", sub: "What is being sold", value: set(brief?.productName) },
          { name: "Product images", sub: "Your own originals, stored byte-identical", value: brief?.productAssetIds?.length ? n(brief.productAssetIds.length) : NONE },
          { name: "Product URL", sub: "A saved reference, never a scrape", value: set(brief?.productUrl) },
          { name: "Description", sub: "Carried into every variant", value: set(brief?.productDescription) },
        ];
      case "brand":
        return [
          { name: "Brand", sub: "The name every variant inherits", value: set(kit?.name || brief?.productBrand) },
          { name: "Voice", sub: "How the copy sounds", value: set(kit?.voice) },
          { name: "Palette", sub: "Colours the set holds to", value: kit?.colors?.length ? n(kit.colors.length) : NONE },
          { name: "Type", sub: "The pairing the set locks", value: kit?.font ?? NONE },
          { name: "Logo", sub: "Kept as your own original", value: kit?.logoAssetId ? "saved" : NONE },
        ];
      case "cast":
        return [
          { name: "Presenter images", sub: "Uploaded originals", value: brief?.castAssetIds?.length ? n(brief.castAssetIds.length) : NONE },
          { name: "From production", sub: "Reuse a locked identity from Cast", value: variants.some((variant) => variant.generation?.soulIdentityId) ? "bound" : NONE },
        ];
      case "format":
        return [
          { name: "Format", sub: format ? format.description : "One of nine creative formats", value: format ? format.label : NONE },
          { name: "Aspect", sub: "Documented ratios only", value: brief?.creative?.aspect ?? variants.find((variant) => variant.generation?.ratio)?.generation?.ratio ?? NONE },
          { name: "Quality", sub: "Set on the image engine", value: brief?.marketing?.quality ?? NONE },
        ];
      case "variants":
        return [
          { name: "Hooks", sub: "Opening lines written against the brief", value: brief?.hooks?.length ? n(brief.hooks.length) : NONE },
          { name: "Bindings", sub: "Product × presenter × hook × format", value: variants.length ? n(variants.length) : NONE },
          { name: "Accepted engines", sub: "A variant is priced once its engine is accepted", value: bound ? `${n(bound)} of ${n(variants.length)}` : NONE },
        ];
      case "design":
        return [
          { name: "Layout", sub: "Applied set-wide", value: brief?.creative?.templateId ? "saved" : NONE },
          { name: "Poster", sub: "One frame, one clear message", value: brief?.poster ? "saved" : NONE },
          { name: "Notes", sub: "Carried into the variants", value: set(brief?.notes) },
        ];
      default:
        return [
          { name: "Review", sub: "Approve the set before export", value: bound ? "ready" : NONE },
          { name: "Export", sub: "Originals and masters", value: bound ? "ready" : NONE },
          { name: "Scheduling", sub: "No posting provider is connected", value: "not connected" },
        ];
    }
  };
  return MOLECULR_SECTIONS.map((section) => {
    const rows = rowsFor(section.id);
    return { id: section.id, title: section.label, sub: SECTION_SUB[section.id] ?? "", state: stateOf(rows), rows };
  });
}

/** One open at a time: the section tapped, or none when it was already open. */
export function toggleSection(open: string | null, id: string): string | null {
  return open === id ? null : id;
}

/* ── A primary that cannot run says why ──────────────────────────────────── */

/**
 * The reason a page's pinned primary is blocked, for the cases the phone owns:
 * no project open, a page whose plan no backend can run yet, and a page whose
 * work belongs to a screen that is not this one. Null means it can run.
 *
 * The rule this encodes (05-mobile, and the brief): a page with no runnable
 * primary must SAY WHY rather than pin a dead button.
 */
export function primaryBlockedReason(input: {
  projectOpen: boolean;
  runnable: boolean | undefined;
  /** What the action needs before it can start, e.g. "Choose a shot". */
  needs?: string | null;
}): string | null {
  if (!input.projectOpen) return "Open a project to run this stage.";
  if (input.runnable === false) return "Not runnable yet on this project.";
  return input.needs ?? null;
}
