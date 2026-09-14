"use client";

import { type ReactElement, useRef } from "react";
import { ContextMenu, DropdownMenu } from "radix-ui";
import { MoreHorizontal } from "lucide-react";
import styles from "./action-menu.module.css";

export type StudioAction = {
  label: string;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
};

/** The same commands back right-click, long-press, keyboard and the visible menu. */
export function ActionMenu({
  children,
  label,
  actions,
  onOpen,
  onPoint,
}: {
  children: ReactElement;
  label: string;
  actions: StudioAction[];
  onOpen?: () => void;
  onPoint?: (point: { x: number; y: number }) => void;
}) {
  const touchPress = useRef(false);
  const swallowClick = useRef(false);
  return (
    <ContextMenu.Root
      onOpenChange={(open) => {
        if (open) {
          swallowClick.current = touchPress.current;
          onOpen?.();
        }
      }}
    >
      <ContextMenu.Trigger
        asChild
        data-owns-menu
        onPointerDown={event => {
          touchPress.current = event.pointerType === "touch" || event.pointerType === "pen";
          swallowClick.current = false;
          onPoint?.({ x: event.clientX, y: event.clientY });
          event.stopPropagation();
        }}
        onClickCapture={event => {
          if (!swallowClick.current) return;
          swallowClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
        onContextMenu={(event) => {
          touchPress.current = ["touch", "pen"].includes((event.nativeEvent as PointerEvent).pointerType);
          onPoint?.({ x: event.clientX, y: event.clientY });
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if (
            event.target !== event.currentTarget ||
            !(
              event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10")
            )
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          event.currentTarget.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: rect.left + Math.min(24, rect.width / 2),
              clientY: rect.top + Math.min(24, rect.height / 2),
            }),
          );
        }}
      >
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className={styles.menu}
          aria-label={label}
          collisionPadding={8}
          onPointerDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
          onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}
        >
          <ContextMenu.Label className={styles.label}>
            {label}
          </ContextMenu.Label>
          {actions.map((action) => (
            <ContextMenu.Item
              key={action.label}
              className={styles.item}
              data-danger={action.danger || undefined}
              disabled={action.disabled}
              onSelect={action.run}
            >
              {action.label}
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function ActionDropdown({
  label,
  actions,
  className,
}: {
  label: string;
  actions: StudioAction[];
  className?: string;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={className} aria-label={label}>
          <MoreHorizontal size={17} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
      <DropdownMenu.Content
        className={styles.menu}
        aria-label={label}
        collisionPadding={8}
        sideOffset={4}
        onPointerDown={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()}
        >
          {actions.map((action) => (
            <DropdownMenu.Item
              key={action.label}
              className={styles.item}
              data-danger={action.danger || undefined}
              disabled={action.disabled}
              onSelect={action.run}
            >
              {action.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
