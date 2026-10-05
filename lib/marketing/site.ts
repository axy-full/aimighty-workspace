import { SHELL_SUITES } from "@/lib/shell/ia";

/**
 * The public site's map: its tabs and the six places it describes. The ids
 * are the code's; every word a visitor reads uses the product's names
 * (design/particl-graphite/README.md § 7). Prices are never written here —
 * lib/marketing/prices.server.ts computes them.
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

/* The UI names for stages whose code names are older (README § 7). */
const STAGE_NAMES: Record<string, string> = { Astra: "3D blocking", Rig: "Board" };

/* Studio's stages are read from the shell, so the site cannot fall behind the
   product (ten since 24 September). */
const STUDIO_PAGES = SHELL_SUITES.find((suite) => suite.id === "studio")!.pages
  .filter((page) => !page.phoneOnly).map((page) => STAGE_NAMES[page.label] ?? page.label);
const COUNT: Record<number, string> = { 8: "Eight", 9: "Nine", 10: "Ten", 11: "Eleven", 12: "Twelve" };

/* In the order the header shows them; Settings is reached from the footer and the strip. */
export const SITE_SUITES: SiteSuite[] = [
  { id: "studio", href: "/studio", tab: "Studio", tag: "01 Studio", name: "Studio",
    blurb: `A film or an ad on one board. ${COUNT[STUDIO_PAGES.length] ?? STUDIO_PAGES.length} stages from brief to delivery.`,
    pages: STUDIO_PAGES },
  { id: "business", href: "/business", tab: "Ads", tag: "02 Ads", name: "Ads",
    blurb: "Product, brand and cast, then image ads that keep every reference.",
    pages: ["Product", "Brand", "Cast", "Format", "Variants", "Design", "Publish"] },
  { id: "viral", href: "/viral", tab: "Social", tag: "03 Social", name: "Social",
    blurb: "Recast motion and swap elements in footage you own.",
    pages: ["Motion transfer", "Object swap", "Sources", "Compare", "History"] },
  { id: "gen", href: "/", tab: "Make", tag: "04 Make", name: "Make",
    blurb: "Video, images and audio from one composer, reachable from every screen.",
    pages: ["Video", "Images", "Audio", "Results"] },
  { id: "atomik", href: "/atomik", tab: "Atomik", tag: "05 Atomik", name: "Atomik",
    blurb: "The production agent. Plans the work and waits for a person to approve it.",
    pages: ["Agent", "Approvals", "Activity", "Recipes", "Crew review", "Connections", "Models"] },
  { id: "workspace", href: "/workspace", tab: "Settings", tag: "06 Settings", name: "Settings",
    blurb: "Your team, plan and credits, and security. Every action attributed.",
    pages: ["Team", "Plan & credits", "Advanced", "Security"] },
];

/** The header's tabs: every place but Settings, which sits behind the avatar in the app. */
export const NAV_SUITES = SITE_SUITES.filter((suite) => suite.id !== "workspace");

export { PRICING_HREF, ACCESS_HREF, SIGN_UP_HREF, SIGN_IN_HREF, APP_HREF } from "./links";

/** A screenshot of the product, served from public/marketing. */
export const shot = (name: string) => `/marketing/screens/${name}.jpg`;
