"use client";
import { useShell } from "@/lib/shell/state";
import { Glyph, type GlyphName } from "./icons";

type TabId = "studio" | "gen" | "suites" | "assets" | "more";
const TABS: { id: TabId; label: string; glyph: GlyphName }[] = [
  { id: "studio", label: "Studio", glyph: "clap" },
  { id: "gen", label: "Gen", glyph: "spark" },
  { id: "suites", label: "Suites", glyph: "tag" },
  { id: "assets", label: "Assets", glyph: "stack" },
  { id: "more", label: "More", glyph: "panel" },
];

/**
 * The phone's glass tab bar (Particl Mobile.dc.html › tab bar), shown below
 * 768px only. Every tab is a route the shell already has: Studio and Gen are
 * their views (Studio opens its phone home, the stages as cards), Suites is
 * the last non-Studio suite (Business until one is chosen), Assets opens the
 * Library's Assets tab, More is Workspace. The
 * header's suite tablist stays the one place a suite is picked.
 */
export function TabBar() {
  const shell = useShell();
  const active: TabId = shell.libOpen ? "assets" : shell.view === "gen" ? "gen" : shell.view === "workspace" ? "more" : shell.view === "crew" || shell.suite.id !== "studio" ? "suites" : "studio";
  const go = (id: TabId) => {
    if (id === "studio") shell.goSuite("studio", "home");
    else if (id === "gen") shell.goGen();
    else if (id === "suites") shell.goSuite(shell.view === "suite" && shell.suite.id !== "studio" ? shell.suite.id : "business");
    else if (id === "assets") shell.openLibrary("assets");
    else shell.goWorkspace();
  };
  return (
    <nav className="gx-tabbar" aria-label="Tabs" data-testid="tabbar">
      {TABS.map((t) => (
        <button key={t.id} type="button" className="gx-tabbar-btn" aria-current={active === t.id ? "page" : undefined} onClick={() => go(t.id)} data-testid={`tabbar-${t.id}`}>
          <span className="gx-tabbar-glow" aria-hidden="true" />
          <Glyph name={t.glyph} size={22} className="gx-glyph" />
          <span className="gx-tabbar-label">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
