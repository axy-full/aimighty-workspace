import { SHELL_SUITES, WORKSPACE_TABS } from "@/lib/shell/ia";

/**
 * The public site's map: its tabs and the six places it describes. Copy is
 * the product's own (design/particl-site/README.md lists the sources);
 * prices are never written here — lib/marketing/prices.server.ts computes them.
 */

export type SiteSuiteId = "gen" | "studio" | "business" | "viral" | "atomik" | "workspace";

export type SiteSuite = {
  id: SiteSuiteId;
  href: string;
  tab: string;
  tag: string;
  name: string;
  blurb: string;
  pages: string[];
};

/* Studio's stages and Workspace's tabs are read from the shell, so the site
   cannot fall behind the product (ten stages since 24 September). */
const STUDIO_PAGES = SHELL_SUITES.find((suite) => suite.id === "studio")!.pages
  .filter((page) => !page.phoneOnly).map((page) => page.label);
const COUNT: Record<number, string> = { 8: "Eight", 9: "Nine", 10: "Ten", 11: "Eleven", 12: "Twelve" };

export const SITE_SUITES: SiteSuite[] = [
  { id: "gen", href: "/", tab: "Gen", tag: "01 Gen", name: "Gen",
    blurb: "Video, images, audio and 3D from one composer, reachable from every suite.",
    pages: ["Video", "Images", "Audio", "3D", "Results"] },
  { id: "studio", href: "/studio", tab: "Studio", tag: "02 Studio", name: "Production Studio",
    blurb: `The production studio. ${COUNT[STUDIO_PAGES.length] ?? STUDIO_PAGES.length} stages from brief to delivery.`,
    pages: STUDIO_PAGES },
  { id: "business", href: "/business", tab: "Business", tag: "03 Business", name: "Business Suite",
    blurb: "Build and grow your brand from one marketing studio.",
    pages: ["Product", "Brand", "Cast", "Format", "Variants", "Design", "Publish"] },
  { id: "viral", href: "/viral", tab: "Viral", tag: "04 Viral", name: "Viral Studio",
    blurb: "Recast motion and swap elements in footage you own.",
    pages: ["Motion Transfer", "Object Swap", "Shorts", "Sources", "Compare", "History"] },
  { id: "atomik", href: "/atomik", tab: "Atomik", tag: "05 Atomik", name: "Super Agent",
    blurb: "The production agent. Plans, prices and runs the work.",
    pages: ["Agent", "Runs", "Generate", "Recipes", "Builds", "Skills", "Models", "Approvals", "Budget"] },
  { id: "workspace", href: "/workspace", tab: "Workspace", tag: "06 Workspace", name: "Workspace",
    blurb: "One isolated tenant, one balance, every action attributed.",
    pages: WORKSPACE_TABS.map((tab) => tab.label) },
];

export const PRICING_HREF = "/pricing";
export const ACCESS_HREF = "#access";
export const SIGN_IN_HREF = "/login";
/* Where a member goes from the site: the Suites shell. */
export const APP_HREF = "/suites";

/** A screenshot of the product, served from public/marketing. */
export const shot = (name: string) => `/marketing/screens/${name}.jpg`;
