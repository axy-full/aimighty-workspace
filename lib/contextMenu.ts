import type { MenuItem } from "@/components/ui/Menu";

/**
 * The one context menu's items (docs/change-request-1.md §10): the same
 * ten, in the same order, on shots, takes and media, assets, canvas nodes
 * and references. An item a kind cannot do renders disabled, so the shape
 * never changes and the eye learns it once. Pure, so it is testable
 * without a DOM; `components/ui/ContextMenu.tsx` renders it.
 *
 *   Cut ⌘X · Copy ⌘C · Paste ⌘V · Duplicate ⌘D · Rename ↵ · Move to ▸ ·
 *   Share ▸ (copy link · add to review link) · Download · Open in Rig ⌘R · Delete ⌫
 */
export type ContextActions = {
  cut?: () => void;
  copy?: () => void;
  paste?: (() => void) | null;                    // null = nothing to paste here
  duplicate?: () => void;
  rename?: () => void;
  moveTo?: { open: boolean; onToggle: () => void; items: { label: string; note?: string; onSelect: () => void }[] };
  share?: { copyLink?: () => void; addToReview?: () => void; open: boolean; onToggle: () => void };
  download?: () => void;
  openInRig?: () => void;
  remove?: () => void;
  /** A one-line footnote under Delete, when the kind has one. */
  note?: string;
};

export const CONTEXT_ORDER = ["Cut", "Copy", "Paste", "Duplicate", "Rename", "Move to", "Share", "Download", "Open in Rig", "Delete"] as const;

const off = (label: string, keys?: string): MenuItem => ({ kind: "item", label, keys, disabled: true, onSelect: () => {} });

/** The ten items, in order, for any kind; missing actions render disabled. */
export function contextItems(a: ContextActions): MenuItem[] {
  const items: MenuItem[] = [
    a.cut ? { kind: "item", label: "Cut", keys: "⌘X", onSelect: a.cut } : off("Cut", "⌘X"),
    a.copy ? { kind: "item", label: "Copy", keys: "⌘C", onSelect: a.copy } : off("Copy", "⌘C"),
    a.paste ? { kind: "item", label: "Paste", keys: "⌘V", onSelect: a.paste } : off("Paste", "⌘V"),
    a.duplicate ? { kind: "item", label: "Duplicate", keys: "⌘D", onSelect: a.duplicate } : off("Duplicate", "⌘D"),
    a.rename ? { kind: "item", label: "Rename", keys: "↵", onSelect: a.rename } : off("Rename", "↵"),
    a.moveTo && a.moveTo.items.length ? { kind: "sub", label: "Move to", open: a.moveTo.open, onToggle: a.moveTo.onToggle, items: a.moveTo.items } : off("Move to ▸"),
    a.share && (a.share.copyLink || a.share.addToReview)
      ? { kind: "sub", label: "Share", open: a.share.open, onToggle: a.share.onToggle, items: [
          ...(a.share.copyLink ? [{ label: "Copy link", onSelect: a.share.copyLink }] : []),
          ...(a.share.addToReview ? [{ label: "Add to review link", onSelect: a.share.addToReview }] : []),
        ] }
      : off("Share ▸"),
    a.download ? { kind: "item", label: "Download", onSelect: a.download } : off("Download"),
    a.openInRig ? { kind: "item", label: "Open in Rig", keys: "⌘R", onSelect: a.openInRig } : off("Open in Rig", "⌘R"),
    { kind: "divider" },
    a.remove ? { kind: "item", label: "Delete", keys: "⌫", onSelect: a.remove } : off("Delete", "⌫"),
  ];
  if (a.note) items.push({ kind: "note", text: a.note });
  return items;
}
