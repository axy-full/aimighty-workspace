import { test, expect } from "@playwright/test";
import { LIBRARY_OPEN_EVENT, TRAY_TOGGLE_EVENT, requestTrayOpen, requestTrayToggle, trayListens, trayStops } from "../../lib/v12/useLibraryTray";

/**
 * A Library request made before the tray is on screen (lib/v12/useLibraryTray.ts). The tray's chunk loads on its own
 * (components/graphite/SuitesShell.tsx), so Make's Library button, the right-click menu and the board menu can be used
 * before any tray listens. CI run 39353368784 lost exactly that click: the request must wait for the tray, not vanish.
 */

test.describe.configure({ mode: "serial" });

const heard: string[] = [];
test.beforeAll(() => {
  const target = new EventTarget();
  for (const name of [TRAY_TOGGLE_EVENT, LIBRARY_OPEN_EVENT]) target.addEventListener(name, () => heard.push(name));
  (globalThis as { window?: unknown }).window = target;
});
test.afterAll(() => { delete (globalThis as { window?: unknown }).window; });
test.beforeEach(() => { heard.length = 0; });

test("a toggle asked for before any tray listens waits, and the first tray to mount opens on it, once", () => {
  requestTrayToggle();
  expect(heard).toEqual([]);
  expect(trayListens()).toBe(true);
  trayStops();
  expect(trayListens()).toBe(false);
  trayStops();
});

test("an open asked for before any tray listens waits too", () => {
  requestTrayOpen();
  expect(heard).toEqual([]);
  expect(trayListens()).toBe(true);
  trayStops();
});

test("two toggles before the tray mounts cancel out, as two presses of L would", () => {
  requestTrayToggle();
  requestTrayToggle();
  expect(trayListens()).toBe(false);
  trayStops();
});

test("an open then a toggle before the tray mounts leave it closed, as they would with the tray on screen", () => {
  requestTrayOpen();
  requestTrayToggle();
  expect(trayListens()).toBe(false);
  trayStops();
});

test("with a tray listening, requests go straight to it as events and nothing waits", () => {
  expect(trayListens()).toBe(false);
  requestTrayToggle();
  requestTrayOpen();
  expect(heard).toEqual([TRAY_TOGGLE_EVENT, LIBRARY_OPEN_EVENT]);
  trayStops();
  expect(trayListens()).toBe(false);
  trayStops();
});

test("a tray that unmounts stops taking requests directly: the next one waits for the next tray", () => {
  expect(trayListens()).toBe(false);
  trayStops();
  trayStops();
  requestTrayToggle();
  expect(heard).toEqual([]);
  expect(trayListens()).toBe(true);
  trayStops();
});
