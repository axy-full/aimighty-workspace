"use client";
import { useRef, useState, useSyncExternalStore } from "react";
import { Dialog, IconButton, Kbd, Menu, OverlayProvider, Pill, Popover, Segment, Sheet, ToastProvider, Tooltip, useOverlay, useOverlayStack, useTabTitle, useToast } from "../ui";
import "../v12.css";

/**
 * Test only (app/(test)/v12-primitives, a 404 outside a local mock server): every shared piece of the new interface
 * once, for tests/primitives-v12-workbench.spec.ts. The "tool", "selection" and "drawer" toggles stand in for the
 * screens that will register those layers, so the Esc order can be walked in a browser.
 */
export function PrimitivesGallery() {
  return (
    <OverlayProvider>
      <ToastProvider bottom={24}>
        <div className="v12" style={{ minHeight: "100dvh", padding: 24, background: "var(--gx-root)", color: "var(--gx-text)", fontFamily: "var(--gx-font)", fontSize: 13 }}>
          <Gallery />
        </div>
      </ToastProvider>
    </OverlayProvider>
  );
}

const glyph = (d: string) => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d={d} stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg>;

function Layer({ layer, label }: { layer: "tool" | "selection" | "drawer"; label: string }) {
  const [on, setOn] = useState(false);
  useOverlay(layer, on, () => setOn(false));
  return <Pill size="sm" selected={on} onClick={() => setOn(!on)} data-testid={`layer-${layer}`}>{label}{on ? " · on" : ""}</Pill>;
}

function StackReadout() {
  const stack = useOverlayStack();
  const text = useSyncExternalStore(
    (notify) => stack?.subscribe(notify) ?? (() => {}),
    () => stack?.list().map((e) => e.layer).join(",") ?? "",
    () => "",
  );
  return <p data-testid="v12-stack" style={{ color: "var(--gx-text-sec)" }}>Open: {text || "nothing"}</p>;
}

function Gallery() {
  const toast = useToast();
  const [view, setView] = useState<"canvas" | "list" | "strip">("canvas");
  const [menu, setMenu] = useState(false);
  const [pop, setPop] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [join, setJoin] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [ready, setReady] = useState(0);
  const [picked, setPicked] = useState("");
  const [undone, setUndone] = useState(0);
  const menuButton = useRef<HTMLButtonElement>(null);
  const popButton = useRef<HTMLButtonElement>(null);
  const [inner, setInner] = useState(false);
  const innerButton = useRef<HTMLButtonElement>(null);
  useTabTitle(ready);

  const row = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginBottom: 20 } as const;
  return (
    <main>
      <h1 style={{ fontSize: "var(--gx-fs-h1)", letterSpacing: "var(--gx-ls-h1)", margin: "0 0 20px" }}>Shared pieces</h1>

      <section style={row} aria-label="Tooltips">
        <Tooltip name="Home" line="Your boards and what needs you." shortcut={["G H", "⌘1"]}>
          <button type="button" className="v12-seg-btn" data-testid="tip-target">Home</button>
        </Tooltip>
        <IconButton tooltip={{ name: "Download", line: "The full-resolution original of this take.", price: "Free" }} data-testid="icon-download">
          {glyph("M8 2v9M4 7l4 4 4-4M3 14h10")}
        </IconButton>
        <IconButton tooltip={{ name: "Select", line: "Select, move and resize cards.", shortcut: "V" }} pressed data-testid="icon-select">
          {glyph("M3 2l9 5-4 1-1 4z")}
        </IconButton>
        <span style={{ marginLeft: "auto" }}>
          <IconButton tooltip={{ name: "At the edge", line: "This tooltip flips and slides to stay on screen." }} data-testid="icon-edge">
            {glyph("M3 8h10")}
          </IconButton>
        </span>
      </section>

      <section style={row} aria-label="Pills and keys">
        <Pill dot tone="warning" data-testid="pill-activity" onClick={() => {}}>2 need you · 3 running</Pill>
        <Pill dot pulse tone="accent">3 running</Pill>
        <Pill size="sm" selected onClick={() => {}}>Video</Pill>
        <Pill size="sm" onClick={() => {}}>Images</Pill>
        <Pill tone="success" dot>Approved</Pill>
        <Kbd keys="⌘K" /><Kbd keys={["G", "H"]} />
      </section>

      <section style={row} aria-label="Segment">
        <Segment label="View" value={view} onChange={setView} options={[
          { id: "canvas", label: "Canvas", tooltip: { name: "Canvas", line: "Free cards you can move, group and annotate." } },
          { id: "list", label: "List", tooltip: { name: "List", line: "The shot list." } },
          { id: "strip", label: "Strip", tooltip: { name: "Strip", line: "Timeline with durations · space plays." } },
        ]} />
        <span data-testid="segment-value">{view}</span>
      </section>

      <section style={row} aria-label="Menus and dialogs">
        <button ref={menuButton} type="button" className="v12-pill" data-testid="open-menu" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>Board menu</button>
        <Menu open={menu} onClose={() => setMenu(false)} anchor={menuButton} label="Board menu" items={[
          { id: "rename", label: "Rename", onSelect: () => setPicked("rename") },
          { id: "dup", label: "Duplicate", shortcut: "⌘D", onSelect: () => setPicked("duplicate") },
          { id: "sep", separator: true },
          { id: "remove", label: "Remove", tone: "danger", onSelect: () => setPicked("remove") },
        ]} />
        <button ref={popButton} type="button" className="v12-pill" data-testid="open-popover" onClick={() => setPop((v) => !v)}>New tab</button>
        <Popover open={pop} onClose={() => setPop(false)} anchor={popButton} label="New tab" width={260}>
          <p style={{ margin: 6 }}>Boards and kinds.</p>
          <button type="button" className="v12-menu-item" onClick={() => { setPop(false); setDialog(true); }} data-testid="popover-to-dialog">Open a dialog</button>
        </Popover>
        <button type="button" className="v12-pill" data-testid="open-dialog" onClick={() => setDialog(true)}>Dialog</button>
        <button type="button" className="v12-pill" data-testid="open-join" onClick={() => setJoin(true)}>Join sheet</button>
        <button type="button" className="v12-pill" data-testid="open-sheet" onClick={() => setSheet(true)}>Bottom sheet</button>
        <span data-testid="menu-picked">{picked}</span>
      </section>
      <Dialog open={dialog} onClose={() => setDialog(false)} label="Rename board" title="Rename board"
        footer={<button type="button" className="v12-pill" onClick={() => setDialog(false)}>Done</button>}>
        <input aria-label="Board name" defaultValue="Dune Studies" data-testid="dialog-input" style={{ width: "100%", height: 32, padding: "0 10px", background: "var(--gx-input)", border: "1px solid var(--gx-input-border)", borderRadius: 8, color: "var(--gx-text)" }} />
        <button ref={innerButton} type="button" className="v12-pill" style={{ marginTop: 12 }} data-testid="dialog-menu" onClick={() => setInner((v) => !v)}>More</button>
        <Menu open={inner} onClose={() => setInner(false)} anchor={innerButton} label="More" items={[{ id: "copy", label: "Copy link", onSelect: () => setPicked("copy") }]} />
      </Dialog>
      <Dialog open={join} onClose={() => setJoin(false)} label="Join" title="Join Particl to keep going" layer="join" scrim="join" closeTip="Close · your text stays in the bar">
        <p style={{ margin: 0 }}>Particl is invite-only.</p>
      </Dialog>
      <Sheet open={sheet} onClose={() => setSheet(false)} label="Sheet" title="Bottom sheet">
        <p style={{ margin: 0 }}>A sheet from the bottom edge.</p>
      </Sheet>

      <section style={row} aria-label="Layers">
        <Layer layer="tool" label="Arm a tool" />
        <Layer layer="selection" label="Select a card" />
        <Layer layer="drawer" label="Open a drawer" />
        <StackReadout />
      </section>

      <section style={row} aria-label="Toasts and title">
        <button type="button" className="v12-pill" data-testid="toast-plain" onClick={() => toast({ text: "Board renamed" })}>Toast</button>
        <button type="button" className="v12-pill" data-testid="toast-undo" onClick={() => toast({ text: "Shot 3 removed", action: { label: "Undo", run: () => setUndone((n) => n + 1) } })}>Toast with Undo</button>
        <button type="button" className="v12-pill" data-testid="toast-view" onClick={() => toast({ text: "Shot 3 is ready", action: { label: "View", run: () => setPicked("view") } })}>Toast with View</button>
        <span data-testid="undone">{undone}</span>
        <button type="button" className="v12-pill" data-testid="ready-more" onClick={() => setReady((n) => n + 1)}>One more ready</button>
        <button type="button" className="v12-pill" data-testid="ready-none" onClick={() => setReady(0)}>Seen them all</button>
      </section>
    </main>
  );
}
