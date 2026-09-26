"use client";

import { useEffect, useRef, useState } from "react";
import { useProject } from "@/lib/projectContext";
import { useSession } from "@/lib/session";
import { appAlert, appConfirm, appPrompt } from "./dialog";
import { announceChange } from "@/lib/changes";
import { confirmDeleteProject } from "@/lib/deleteProject";

/**
 * App-wide right-click menu, themed like the rest of the desk. On touch
 * screens (where iOS never fires `contextmenu`) a long-press on a clip or a
 * project row opens the same menu.
 *
 * Context decides the verbs:
 *  • text fields    → Cut / Copy / Paste / Delete on the selection (mouse
 *                     only — native selection handles fields on touch)
 *  • a clip         → Rename / Copy prompt / Cut clip / Move to project… / Delete
 *  • a project row  → Rename / Paste clip (moves the cut clip into it) / Delete
 *  • a text selection → Copy
 *  • anywhere else  → the browser's own menu (links, pictures, video)
 */

type Item =
  | { kind: "item"; label: string; action: () => void | Promise<void>; disabled?: boolean; danger?: boolean }
  | { kind: "sep" };

/** The one clip "on the clipboard" for cut→paste moves. */
let armedClip: { id: string; label: string } | null = null;

function isEditable(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  return Boolean(
    el && (el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLInputElement &&
        /^(text|search|url|email|password|number)$/.test(el.type)))
  );
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string, caret: number) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  if (el instanceof HTMLTextAreaElement || /^(text|search|url|password)$/.test(el.type)) el.setSelectionRange(caret, caret);
}

async function moveClip(genId: string, projectId: string | null) {
  try {
    const res = await fetch(`/api/jobs/${genId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "The clip wasn't moved");
    announceChange();
  } catch (e) {
    // The wall refreshes either way, so a silent failure looks exactly like
    // a move that quietly undid itself.
    await appAlert("The clip wasn't moved", (e as Error).message);
  }
}

/** Rename a project in place, wherever its card or row happens to be. */
export async function renameProject(projectId: string, current: string): Promise<boolean> {
  const next = await appPrompt("Rename project", current, "e.g. Nike AW26");
  if (next === null || !next.trim() || next.trim() === current) return false;
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: next.trim() }),
  });
  if (!res.ok) {
    await appAlert("Couldn't rename the project", (await res.json().catch(() => ({}))).error);
    return false;
  }
  announceChange();
  return true;
}

/** Ask for a name and save it. Empty clears the name; Cancel changes nothing. */
export async function renameClip(genId: string, current: string, scope: string | null | undefined): Promise<void> {
  const next = await appPrompt(
    current ? "Rename clip" : "Name this clip",
    current, "Hero close-up",
    "Shown on the wall and in search in place of the clip id. Leave it empty to clear the name."
  );
  if (next === null || next.trim() === current) return;
  const res = await fetch(`/api/jobs/${genId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope ?? "visitor" },
    body: JSON.stringify({ title: next }),
  });
  if (!res.ok) { await appAlert("Could not save the name"); return; }
  announceChange();
}

export default function ContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: Item[] } | null>(null);
  const ctx = useProject();
  const { requestScope } = useSession();
  const projectsRef = useRef(ctx.projects);
  const ctxRef = useRef(ctx);
  // The menu is wired once; the captured scope is read through a ref so a
  // workspace change after mount is what the server sees, not the first one.
  const scopeRef = useRef(requestScope);
  useEffect(() => { projectsRef.current = ctx.projects; ctxRef.current = ctx; scopeRef.current = requestScope; }, [ctx, requestScope]);

  // A long-press opens the menu while the finger is still down; the lift-off
  // click that follows must not immediately dismiss it (or press an item).
  // Consume-next-click semantics — a wall-clock window would let a slow lift
  // through and eat a fast intentional tap.
  const swallowNextClick = useRef(false);

  useEffect(() => {
    /** Build the verbs for whatever is under the pointer and show the menu.
     *  `touch` skips the text-field and plain-selection branches — native
     *  selection handles those better on phones. Returns whether it opened. */
    function openFor(t: HTMLElement, x: number, y: number, touch = false): boolean {
      // A v2 surface that draws its own right-click menu (the Shots grid, §7) owns the click.
      if (t.closest("[data-owns-menu]")) return false;
      const items: Item[] = [];

      const field = !touch && isEditable(t) ? t : null;
      const clipEl = t.closest<HTMLElement>("[data-gen-id]");
      const projEl = t.closest<HTMLElement>("[data-project-target]");

      if (field) {
        const start = field.selectionStart ?? 0;
        const end = field.selectionEnd ?? 0;
        const sel = field.value.slice(start, end);
        const has = sel.length > 0;
        const writable = !field.readOnly && !field.disabled;

        items.push(
          {
            kind: "item", label: "Cut", disabled: !has || !writable,
            action: async () => {
              try { await navigator.clipboard.writeText(sel); } catch { await appAlert("Clipboard blocked", "The text was kept. Use the keyboard shortcut to cut it."); return; }
              setNativeValue(field, field.value.slice(0, start) + field.value.slice(end), start);
            },
          },
          {
            kind: "item", label: "Copy", disabled: !has,
            action: async () => { try { await navigator.clipboard.writeText(sel); } catch { /* blocked */ } },
          },
          {
            kind: "item", label: "Paste", disabled: !writable,
            action: async () => {
              try {
                const text = await navigator.clipboard.readText();
                if (!text) return;
                setNativeValue(field, field.value.slice(0, start) + text + field.value.slice(end), start + text.length);
              } catch { appAlert("Clipboard blocked", "The browser blocked clipboard access — use ⌘V."); }
            },
          },
          {
            kind: "item", label: "Delete", disabled: !has || !writable,
            action: () => setNativeValue(field, field.value.slice(0, start) + field.value.slice(end), start),
          },
        );
      } else if (clipEl) {
        const id = clipEl.dataset.genId!;
        const promptText = clipEl.dataset.genPrompt ?? "";
        const label = clipEl.dataset.genLabel ?? id.slice(-6).toUpperCase();
        const title = clipEl.dataset.genTitle ?? "";
        items.push(
          {
            kind: "item", label: title ? "Rename…" : "Name this clip…",
            action: () => renameClip(id, title, scopeRef.current),
          },
          {
            kind: "item", label: "Copy prompt", disabled: !promptText,
            action: async () => { try { await navigator.clipboard.writeText(promptText); } catch { /* blocked */ } },
          },
          {
            kind: "item", label: "Cut take",
            action: () => { armedClip = { id, label }; },
          },
        );
        // Direct move targets — the only clip-filing path that exists on
        // phones (the rail's paste rows are desktop-only).
        const projs = projectsRef.current;
        if (projs.length) {
          items.push({ kind: "sep" });
          for (const p of projs.slice(0, 8)) {
            items.push({
              kind: "item", label: `Move to ${p.name}`,
              action: () => moveClip(id, p.id),
            });
          }
          items.push({
            kind: "item", label: "Move to Unfiled",
            action: () => moveClip(id, null),
          });
        }
        items.push(
          { kind: "sep" },
          {
            kind: "item", label: "Delete clip", danger: true,
            action: async () => {
              if (!(await appConfirm(`Delete clip ${label}?`, "Its cost stays on the ledger.", { confirmLabel: "Delete", danger: true }))) return;
              const res = await fetch(`/api/jobs/${id}`, { method: "DELETE", headers: { "X-Workbench-Scope": scopeRef.current ?? "visitor" } });
              if (!res.ok) { await appAlert("The clip wasn't deleted", `The server answered ${res.status}.`); return; }
              announceChange();
            },
          },
        );
      } else if (projEl) {
        const target = projEl.dataset.projectTarget!;
        const name = projEl.dataset.projectName ?? "project";
        if (target !== "unfiled") {
          items.push({
            kind: "item", label: "Rename…",
            action: async () => {
              if (await renameProject(target, name)) ctxRef.current.refreshProjects();
            },
          }, { kind: "sep" });
        }
        items.push({
          kind: "item",
          label: armedClip ? `Paste clip ${armedClip.label} into ${name}` : "Paste clip",
          disabled: !armedClip,
          action: async () => {
            if (!armedClip) return;
            await moveClip(armedClip.id, target === "unfiled" ? null : target);
            armedClip = null;
          },
        });
        if (target !== "unfiled") {
          const count = Number(projEl.dataset.projectCount ?? "") || null;
          items.push({ kind: "sep" }, {
            kind: "item", label: "Delete project…", danger: true,
            action: async () => {
              if (!(await confirmDeleteProject(target, name, count))) return;
              const c = ctxRef.current;
              if (c.selection === target) c.setSelection("all");
              c.refreshProjects();
            },
          });
        }
      } else if (!touch) {
        /* Anywhere else the browser's own menu is the better one: a link, a
           picture or a video keeps Open in new tab and Save as. Ours opens
           only for a text selection, where it adds the desk's Copy (and the
           reminder of a cut clip). */
        const sel = window.getSelection()?.toString() ?? "";
        if (sel && !t.closest("a[href], img, video, audio, canvas")) {
          items.push({
            kind: "item", label: "Copy",
            action: async () => { try { await navigator.clipboard.writeText(sel); } catch { /* blocked */ } },
          });
          if (armedClip) {
            items.push({ kind: "sep" }, {
              kind: "item", label: `Clip ${armedClip.label} is cut — right-click a project to paste`,
              disabled: true, action: () => {},
            });
          }
        }
      }

      if (!items.length) return false;

      // Keep the menu on screen (it also scrolls if taller than the screen).
      const W = 260, H = items.length * 34 + 12;
      setMenu({
        x: Math.max(8, Math.min(x, window.innerWidth - W - 8)),
        y: Math.max(8, Math.min(y, window.innerHeight - H - 8)),
        items,
      });
      return true;
    }

    function onContext(e: MouseEvent) {
      cancelPress(); // Android long-press fires contextmenu — one path only.
      // Android's contextmenu carries pointerType "touch": there, only clips
      // and project rows get our menu — if nothing opened, leave the event
      // alone so native long-press text selection keeps working.
      const touch = (e as PointerEvent).pointerType === "touch";
      const opened = openFor(e.target as HTMLElement, e.clientX, e.clientY, touch);
      // Nothing of ours to offer: the browser's menu stays.
      if (opened) e.preventDefault();
    }

    // Long-press recognizer for iOS (and any browser without touch
    // contextmenu). Movement or lift cancels; only clips and project rows
    // respond, so scrolling and native text selection stay untouched.
    let pressTimer: number | null = null;
    let pressX = 0, pressY = 0;
    function cancelPress() {
      if (pressTimer != null) { clearTimeout(pressTimer); pressTimer = null; }
    }
    function onPointerDown(e: PointerEvent) {
      // A fresh press means any armed swallow belonged to a click that never
      // arrived — clear it so it can't eat this tap.
      swallowNextClick.current = false;
      if (e.pointerType !== "touch") return;
      const t = e.target as HTMLElement;
      if (isEditable(t)) return;
      if (!t.closest("[data-gen-id],[data-project-target]")) return;
      pressX = e.clientX; pressY = e.clientY;
      cancelPress();
      pressTimer = window.setTimeout(() => {
        pressTimer = null;
        swallowNextClick.current = true;
        try { navigator.vibrate?.(10); } catch { /* not everywhere */ }
        openFor(t, pressX, pressY, true);
      }, 550);
    }
    function onPointerMove(e: PointerEvent) {
      if (pressTimer != null &&
          (Math.abs(e.clientX - pressX) > 10 || Math.abs(e.clientY - pressY) > 10)) {
        cancelPress();
      }
    }

    // The tap that ends a long-press produces a click — swallow it once so
    // the freshly opened menu survives, however long the finger lingered.
    function onDocClick(e: MouseEvent) {
      if (swallowNextClick.current) {
        swallowNextClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      }
    }

    function onClose() { setMenu(null); }

    document.addEventListener("contextmenu", onContext);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", cancelPress, true);
    document.addEventListener("pointercancel", cancelPress, true);
    document.addEventListener("click", onDocClick, true);
    window.addEventListener("resize", onClose);
    document.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("contextmenu", onContext);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerup", cancelPress, true);
      document.removeEventListener("pointercancel", cancelPress, true);
      document.removeEventListener("click", onDocClick, true);
      window.removeEventListener("resize", onClose);
      document.removeEventListener("scroll", onClose, true);
      cancelPress();
    };
  }, []);

  if (!menu) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-[90]"
        onClick={() => setMenu(null)}
        onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
      />
      <div
        style={{ left: menu.x, top: menu.y }}
        className="menu-pop fixed z-[91] max-h-[calc(100dvh-16px)] w-[248px] !bottom-auto overflow-y-auto overscroll-contain"
      >
        {menu.items.map((it, i) =>
          it.kind === "sep" ? (
            <div key={i} className="mx-3 my-1 h-px bg-hair" />
          ) : (
            <button
              key={i}
              disabled={it.disabled}
              onClick={async () => { setMenu(null); await it.action(); }}
              className={`menu-item ${
                it.disabled ? "cursor-default !text-mute"
                : it.danger ? "!text-lift" : ""
              }`}
            >
              {it.label}
            </button>
          )
        )}
      </div>
    </>
  );
}
