"use client";
import { useEffect, useRef } from "react";
import type { RegionId } from "./types";

/*
 * The board's commands (⌘K, Atomik's palette, the right-click menu): what a person can do to the board's view and its
 * free cards, said by name. The board on screen listens; with none open, `runBoardCommand` says so (false) and the
 * caller opens the board first. Each runs the same code as its button, so a command and a click can never differ.
 */
export type BoardCommand =
  | { name: "tidy" }
  | { name: "fit" }
  | { name: "list" | "board" }
  /** The rail's Library drawer (the board's own Library: the project's files, draggable onto a shot). */
  | { name: "library" }
  | { name: "glide"; to: RegionId };

/**
 * The commands the new interface's right-click menus send (redesign A3, components/v12/menus/MenuHost.tsx); nothing
 * else sends them, so today's board behaves as before for every workspace without the new interface. Each runs the
 * code its key or click runs: select a card as a click does, take the selected cards off as ⌫ does, pick a tool as its
 * key does, and select every card.
 */
export type BoardMenuCommand =
  | { name: "select"; card: string | null; add?: boolean }
  | { name: "remove" }
  | { name: "tool"; tool: "select" | "note" | "text" | "image" | "video" | "audio" | "upload" }
  | { name: "select-all" };

type Handler = (command: BoardCommand | BoardMenuCommand) => boolean;
const handlers = new Set<Handler>();

/** Runs a command on the board on screen; false when no board is open (or it could not do it just now). */
export function runBoardCommand(command: BoardCommand | BoardMenuCommand): boolean {
  let ran = false;
  for (const handler of [...handlers]) ran = handler(command) || ran;
  return ran;
}

/** The board's side: `handler` takes commands while this component is mounted. */
export function useBoardCommands(handler: Handler) {
  const latest = useRef(handler);
  useEffect(() => { latest.current = handler; });
  useEffect(() => {
    const listener: Handler = (command) => latest.current(command);
    handlers.add(listener);
    return () => { handlers.delete(listener); };
  }, []);
}
