"use client";
import { useMemo } from "react";
import { useShell } from "@/lib/shell/state";
import { BOARD_GO_EVENT, handPaletteQuery, type BoardGoDetail } from "@/lib/shell/atomik-panel";
import type { HowAction } from "@/lib/shell/atomik-how";
import type { ControlPage, SettingsSection } from "@/lib/shell/palette";
import type { WorkspaceTabId } from "@/lib/shell/ia";
import type { MakeTool } from "@/lib/shell/make";

/**
 * Where ⌘K's rows and Atomik's offers go: each the same function the screen's own control calls (a header segment,
 * a rail entry, a menu item), so Atomik never has a second way to do a thing.
 */

/**
 * Settings' five sections on today's Workspace tabs, until stream 9's sections land (lib/shell/settings.ts): the nearest
 * tab for each. Spending rules and Connections have no tab of their own yet, so they open General.
 */
const SETTINGS_TAB: Record<SettingsSection, WorkspaceTabId> = { team: "people", credits: "credits", rules: "general", connections: "general", advanced: "engines" };

/** A same-page address change the shell reads as a navigation (its popstate listener). */
export function goSearch(search: string) {
  const url = window.location.pathname + search + window.location.hash;
  window.history.pushState(window.history.state, "", url);
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
}

export type Places = {
  home: () => void;
  region: (region: string) => void;
  control: (page: ControlPage) => void;
  settings: (section: SettingsSection) => void;
  library: () => void;
  make: (opts?: { tool?: MakeTool; prompt?: string }) => void;
  palette: (query: string) => void;
  /** An Atomik offer, as its button. */
  run: (action: HowAction) => void;
};

export function usePlaces(): Places {
  const shell = useShell();
  return useMemo<Places>(() => {
    const places: Places = {
      /* The header's Home segment does the same. */
      home: () => shell.goSuite("studio", shell.wide ? "stages" : "home"),
      region: (region) => {
        if (shell.view === "board") {
          window.dispatchEvent(new CustomEvent<BoardGoDetail>(BOARD_GO_EVENT, { detail: { region } }));
          return;
        }
        /* Off the board: the open project's board, landing on that region (the board's Atomik dock reads `region`). */
        const q = new URLSearchParams(window.location.search);
        for (const key of ["suite", "page", "sp", "kind", "frame"]) q.delete(key);
        q.set("view", "board");
        q.set("region", region);
        goSearch(`?${q.toString()}`);
      },
      control: (page) => shell.goSuite("atomik", page),
      settings: (section) => shell.goWorkspace(SETTINGS_TAB[section]),
      library: () => shell.openLibrary("assets"),
      make: (opts = {}) => {
        if (opts.prompt) shell.openMake({ prompt: opts.prompt });
        else shell.openMake(opts.tool);
      },
      palette: (query) => { handPaletteQuery(query); shell.setPalette(true); },
      run: (action) => {
        switch (action.kind) {
          case "library": return places.library();
          case "make": return places.make({ tool: action.tool });
          case "control": return places.control(action.page);
          case "settings": return places.settings(action.section);
          case "region": return places.region(action.region);
          case "palette": return places.palette(action.query);
          case "home": return places.home();
        }
      },
    };
    return places;
  }, [shell]);
}
