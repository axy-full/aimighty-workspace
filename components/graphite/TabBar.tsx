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
 * Every tab is a place the shell already has. Home is Home; Record is the open project's board; Make is its panel; Atomik is
 * Atomik's control room. Settings sit behind the avatar, and the Library is the board's drawer, so neither is a tab. Every other
 * place (the Ads and Social boards, Settings aside) keeps the board's tab lit.
 */
export function TabBar() {
  const shell = useShell();
  const active: TabId | null = shell.make ? "make"
    : shell.view === "workspace" ? null
    : shell.suite.id === "atomik" ? "atomik"
    : shell.screen === "home" ? "home" : "record";
  const go = (id: TabId) => {
    if (id === "home") shell.goHome();
    else if (id === "record") shell.goProject();
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
