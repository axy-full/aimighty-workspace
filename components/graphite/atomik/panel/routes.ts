import type { ScreenModule } from "@/lib/shell/screens";

/**
 * Atomik's panel (stream 7): `&atomik=1` (the panel) and `&atomik=how` (Ask Atomik how), over any screen, with
 * `q` the words handed to it. Seeded by the shell (stream 1); stream 7 owns this file from here and flips `landed`
 * in the PR that lands AtomikPanel.
 */
export const ATOMIK_SCREEN: ScreenModule = {
  id: "atomik",
  landed: false,
  params: ["atomik", "q"],
  /* Old → new: Atomik's Agent page is the panel (over Home, once Home has landed). */
  rows: [{ from: "?suite=atomik&page=agent", to: "?atomik=1" }],
  fallback: [
    { from: "?atomik=1", to: "?suite=atomik&page=agent" },
    { from: "?atomik=how", to: "?suite=atomik&page=agent" },
  ],
};
