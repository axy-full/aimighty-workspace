"use client";
import { useShell } from "@/lib/shell/state";
import { Glyph, type GlyphName } from "./icons";

type TabId = "home" | "record" | "make" | "atomik";
const TABS: { id: TabId; label: string; glyph: GlyphName }[] = [
  { id: "home", label: "Home", glyph: "home" },
  { id: "record", label: "Record", glyph: "doc" },
  { id: "make", label: "Make", glyph: "spark" },
  { id: "atomik", label: "Atomik", glyph: "atom" },
];

/**
 * The phone's floating tab bar, below 768px, on every phone screen: Home · Record · Make · Atomik, as the design's phone
 * frames draw it (design/particl-graphite/README.md § 3.6). It hides only over a full-screen review (the take previewer) and
 * a plan's approval (the Atomik sheet): components/graphite/shell.css.
 *
 * Every tab is a place the shell already has. Home is the phone's "Where to?"; Record is the open project's own page, today's
 * nearest to the design's project record — the Studio overview (its stages, what is running, its latest takes), until the
 * record itself ships; Make is its panel; Atomik is Atomik's suite. Settings sit behind the avatar, and the Library behind the page
 * head's Library button, so neither is a tab. A page that is not one of the four keeps the tab it belongs to lit: every other
 * Studio page, Business, Viral and Crew are the project's.
 */
export function TabBar() {
  const shell = useShell();
  const onHome = shell.view === "suite" && shell.suite.id === "studio" && shell.page.id === "home";
  const active: TabId | null = shell.make ? "make"
    : shell.view === "workspace" ? null
    : shell.view === "crew" ? "record"
    : shell.suite.id === "atomik" ? "atomik"
    : onHome ? "home" : "record";
  const go = (id: TabId) => {
    if (id === "home") shell.goSuite("studio", "home");
    else if (id === "record") shell.goSuite("studio", "stages");
    else if (id === "make") shell.openMake();
    else shell.goSuite("atomik");
  };
  return (
    <nav className="gx-tabbar" aria-label="Tabs" data-testid="tabbar">
      {TABS.map((t) => (
        <button key={t.id} type="button" className="gx-tabbar-btn" aria-current={active === t.id ? "page" : undefined} onClick={() => go(t.id)} data-destination={`tab:${t.id}`} data-testid={`tabbar-${t.id}`}>
          <Glyph name={t.glyph} size={22} className="gx-glyph" />
          <span className="gx-tabbar-label">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
