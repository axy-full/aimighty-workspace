import type { KeyBinding, KeyEventLike } from "./keys";

/**
 * Rig's keys, added to the shell keymap through its `bindings` seam:
 * G generates the selected shot, ←/→ walk the shot list, Space plays the
 * take. Like every single-key binding they bail while the person is typing
 * (resolveKey's guard), and only claim keys on the Rig page.
 */

const plainKey = (e: KeyEventLike) => !e.metaKey && !e.ctrlKey && !e.altKey;
const prevent = (e: KeyEventLike) => (e as unknown as { preventDefault?: () => void }).preventDefault?.();

export function rigBindings(rig: { generate: () => void; select: (id: string) => void }, patch: (playing: boolean) => void): KeyBinding<void>[] {
  return [
    {
      id: "rig-generate",
      match: (e, ctx) => ctx.state.view === "studio" && ctx.state.page === "rig" && plainKey(e) && e.key.toLowerCase() === "g",
      action: (e) => { prevent(e); rig.generate(); },
      hint: (ctx) => (ctx.state.view === "studio" && ctx.state.page === "rig" ? { key: "G", label: "generate" } : null),
    },
    {
      id: "rig-arrows",
      match: (e, ctx) => ctx.state.view === "studio" && ctx.state.page === "rig" && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !!ctx.state.lists.shots?.length,
      action: (e, ctx) => {
        prevent(e);
        const list = ctx.state.lists.shots ?? [];
        const at = list.findIndex((s) => s.id === ctx.state.selId);
        const next = at < 0 ? 0 : Math.max(0, Math.min(list.length - 1, at + (e.key === "ArrowRight" ? 1 : -1)));
        if (list[next]) rig.select(list[next].id);
      },
      hint: (ctx) => (ctx.state.view === "studio" && ctx.state.page === "rig" ? { key: "← →", label: "item" } : null),
    },
    {
      id: "rig-play",
      match: (e, ctx) => ctx.state.view === "studio" && ctx.state.page === "rig" && ctx.state.selKind === "shot" && e.key === " ",
      action: (e, ctx) => { prevent(e); patch(!ctx.state.playing); },
    },
  ];
}

