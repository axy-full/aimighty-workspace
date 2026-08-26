"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";

/**
 * App-wide right-click menu, themed like the rest of the desk.
 *
 * Context decides the verbs:
 *  • text fields    → Cut / Copy / Paste / Delete on the selection
 *  • a clip         → Copy prompt / Cut clip / Delete clip
 *  • a project row  → Paste clip (moves the cut clip into it)
 *  • anywhere else  → Copy for a text selection, Paste into the focused field
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
  el.setSelectionRange(caret, caret);
}

export default function ContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: Item[] } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    function onContext(e: MouseEvent) {
      const t = e.target as HTMLElement;
      const items: Item[] = [];

      const field = isEditable(t) ? t : null;
      const clipEl = t.closest<HTMLElement>("[data-gen-id]");
      const projEl = t.closest<HTMLElement>("[data-project-target]");

      if (field) {
        const start = field.selectionStart ?? 0;
        const end = field.selectionEnd ?? 0;
        const sel = field.value.slice(start, end);
        const has = sel.length > 0;

        items.push(
          {
            kind: "item", label: "Cut", disabled: has === false,
            action: async () => {
              try { await navigator.clipboard.writeText(sel); } catch { /* still remove */ }
              setNativeValue(field, field.value.slice(0, start) + field.value.slice(end), start);
            },
          },
          {
            kind: "item", label: "Copy", disabled: !has,
            action: async () => { try { await navigator.clipboard.writeText(sel); } catch { /* blocked */ } },
          },
          {
            kind: "item", label: "Paste",
            action: async () => {
              try {
                const text = await navigator.clipboard.readText();
                if (!text) return;
                setNativeValue(field, field.value.slice(0, start) + text + field.value.slice(end), start + text.length);
              } catch { alert("The browser blocked clipboard access — use ⌘V."); }
            },
          },
          {
            kind: "item", label: "Delete", disabled: !has,
            action: () => setNativeValue(field, field.value.slice(0, start) + field.value.slice(end), start),
          },
        );
      } else if (clipEl) {
        const id = clipEl.dataset.genId!;
        const prompt = clipEl.dataset.genPrompt ?? "";
        const label = clipEl.dataset.genLabel ?? id.slice(-6).toUpperCase();
        items.push(
          {
            kind: "item", label: "Copy prompt", disabled: !prompt,
            action: async () => { try { await navigator.clipboard.writeText(prompt); } catch { /* blocked */ } },
          },
          {
            kind: "item", label: "Cut clip",
            action: () => { armedClip = { id, label }; },
          },
          { kind: "sep" },
          {
            kind: "item", label: "Delete clip", danger: true,
            action: async () => {
              if (!confirm(`Delete clip ${label}? Its cost stays on the ledger.`)) return;
              await fetch(`/api/jobs/${id}`, { method: "DELETE" });
            },
          },
        );
      } else if (projEl) {
        const target = projEl.dataset.projectTarget!;
        const name = projEl.dataset.projectName ?? "project";
        items.push({
          kind: "item",
          label: armedClip ? `Paste clip ${armedClip.label} into ${name}` : "Paste clip",
          disabled: !armedClip,
          action: async () => {
            if (!armedClip) return;
            await fetch(`/api/jobs/${armedClip.id}`, {
              method: "PATCH", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ projectId: target === "unfiled" ? null : target }),
            });
            armedClip = null;
          },
        });
      } else {
        const sel = window.getSelection()?.toString() ?? "";
        items.push(
          {
            kind: "item", label: "Copy", disabled: !sel,
            action: async () => { try { await navigator.clipboard.writeText(sel); } catch { /* blocked */ } },
          },
          { kind: "item", label: "Paste", disabled: true, action: () => {} },
        );
        if (armedClip) {
          items.push({ kind: "sep" }, {
            kind: "item", label: `Clip ${armedClip.label} is cut — right-click a project to paste`,
            disabled: true, action: () => {},
          });
        }
      }

      e.preventDefault();
      // Keep the menu on screen.
      const W = 260, H = items.length * 34 + 12;
      setMenu({
        x: Math.min(e.clientX, window.innerWidth - W - 8),
        y: Math.min(e.clientY, window.innerHeight - H - 8),
        items,
      });
    }

    function onClose() { setMenu(null); }

    document.addEventListener("contextmenu", onContext);
    window.addEventListener("resize", onClose);
    document.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("contextmenu", onContext);
      window.removeEventListener("resize", onClose);
      document.removeEventListener("scroll", onClose, true);
    };
  }, [router, pathname]);

  if (!menu) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-[90]"
        onClick={() => setMenu(null)}
        onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
      />
      <div
        ref={boxRef}
        style={{ left: menu.x, top: menu.y }}
        className="fixed z-[91] w-[240px] overflow-hidden rounded-[10px] border border-line bg-panel py-1 shadow-2xl"
      >
        {menu.items.map((it, i) =>
          it.kind === "sep" ? (
            <div key={i} className="mx-3 my-1 h-px bg-hair" />
          ) : (
            <button
              key={i}
              disabled={it.disabled}
              onClick={async () => { setMenu(null); await it.action(); }}
              className={`block w-full px-3.5 py-[7px] text-left text-[12.5px] transition-colors ${
                it.disabled ? "cursor-default text-mute/50"
                : it.danger ? "text-lift hover:bg-lift/10"
                : "text-bone/90 hover:bg-panel2"
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
