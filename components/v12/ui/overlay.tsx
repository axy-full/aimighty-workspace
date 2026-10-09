"use client";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createOverlayStack, type OverlayLayer, type OverlayStack } from "./overlay-stack";

/**
 * The overlay stack on the page (components/v12/ui/overlay-stack.ts has the order). OverlayProvider listens for Esc and
 * for pointer-down once, for every layer under it; useOverlay() registers one layer while it is open.
 *
 * Esc is read in the capture phase and stopped only when it closed something here, so with nothing open it reaches
 * today's handlers untouched, and it never reaches a render: a render is not a layer.
 */

const OverlayContext = createContext<OverlayStack | null>(null);

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [stack] = useState(createOverlayStack);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      if (stack.escape().length) { event.preventDefault(); event.stopPropagation(); }
    };
    const onPointer = (event: PointerEvent) => { stack.pointerDown(event.target); };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => { window.removeEventListener("keydown", onKey, true); document.removeEventListener("pointerdown", onPointer, true); };
  }, [stack]);
  return <OverlayContext.Provider value={stack}>{children}</OverlayContext.Provider>;
}

/** The stack itself, for a screen that needs to ask what is open (null outside the provider). */
export function useOverlayStack(): OverlayStack | null {
  return useContext(OverlayContext);
}

type Refs = ReadonlyArray<RefObject<Element | null> | undefined>;

/**
 * Registers a layer while `open`. `onClose` runs on Esc (when this layer is the top-most) and, with `outside`, on a
 * pointer-down outside every element in `refs` (the panel and the control that opened it).
 */
export function useOverlay(layer: OverlayLayer, open: boolean, onClose: () => void, options: { refs?: Refs; outside?: boolean } = {}) {
  const stack = useContext(OverlayContext);
  const close = useRef(onClose);
  const refs = useRef(options.refs ?? []);
  useEffect(() => { close.current = onClose; refs.current = options.refs ?? []; });
  const outside = options.outside ?? layer === "menu";
  useEffect(() => {
    if (!stack || !open) return;
    return stack.open({
      layer,
      outside,
      close: () => close.current(),
      contains: (node) => node instanceof Node && refs.current.some((ref) => ref?.current?.contains(node) ?? false),
    });
  }, [stack, open, layer, outside]);
}

/**
 * Where tooltips, menus, dialogs and toasts draw: one fixed layer at the end of <body>, carrying the .v12 scope so the
 * new interface's rules reach it (components/v12/v12.css) and the page's overflow never clips it.
 */
let portalRoot: HTMLElement | null = null;
export function v12PortalRoot(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  if (portalRoot && portalRoot.isConnected) return portalRoot;
  portalRoot = document.createElement("div");
  portalRoot.className = "v12 v12-portal";
  portalRoot.dataset.testid = "v12-portal";
  document.body.appendChild(portalRoot);
  return portalRoot;
}
