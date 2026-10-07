"use client";
import { useMemo } from "react";
import { useShell } from "@/lib/shell/state";
import { runBoardCommand } from "@/lib/board/commands";
import type { RegionId } from "@/lib/board/types";
import { handAtomik, handPaletteQuery } from "@/lib/shell/atomik-panel";
import type { HowAction } from "@/lib/shell/atomik-how";
import type { ControlPage, SettingsSection } from "@/lib/shell/palette";
import type { MakeTool } from "@/lib/shell/make";

/**
 * Where ⌘K's rows and Atomik's offers go: each the same function the screen's own control calls (a header segment,
 * a rail entry, a menu item), so Atomik never has a second way to do a thing.
 */

export type Places = {
  home: () => void;
  region: (region: string) => void;
  control: (page: ControlPage) => void;
  settings: (section: SettingsSection) => void;
  library: () => void;
  make: (opts?: { tool?: MakeTool; prompt?: string }) => void;
  palette: (query: string) => void;
  /** Hands words to Atomik's panel and opens it (⌘K's Ask, Settings' "Ask Atomik"). */
  ask: (text: string, opts?: { send?: boolean; approved?: number | null }) => void;
  /** An Atomik offer, as its button. */
  run: (action: HowAction) => void;
};

export function usePlaces(): Places {
  const shell = useShell();
  return useMemo<Places>(() => {
    const places: Places = {
      /* The header's Home segment does the same. */
      home: () => shell.goHome(),
      /* A board open on screen glides there (the board's own command); anywhere else the open project's board opens at that region. */
      region: (region) => { if (!(shell.screen?.startsWith("board") && runBoardCommand({ name: "glide", to: region as RegionId }))) shell.goBoard({ region }); },
      control: (page) => shell.goControlRoom(page),
      /* Settings' five sections: the screen, or the page that holds a section today (lib/shell/settings.ts rows). */
      settings: (section) => shell.goWorkspace(section),
      /* The Library is the board's rail drawer: a board on screen opens it; Home, the control room and Settings have none, so the
         project's board opens with it out. Only a page of the old layout (no screen of its own) still holds the Library column. */
      library: () => {
        if (!shell.screen) { shell.openLibrary("assets"); return; }
        if (!runBoardCommand({ name: "library" })) shell.goBoard({ drawer: "library" });
      },
      make: (opts = {}) => {
        if (opts.prompt) shell.openMake({ prompt: opts.prompt });
        else shell.openMake(opts.tool);
      },
      palette: (query) => { handPaletteQuery(query); shell.setPalette(true); },
      ask: (text, opts) => { handAtomik(text, opts); shell.openAtomik("panel"); },
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
