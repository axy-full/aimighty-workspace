import type { Locator, Page } from "@playwright/test";

/**
 * The open project's name, wherever the shell draws it. `project-name` is the old page head's test id (ProjectHead, mounted only by
 * the layout of Studio's pages); Home, the board and an address that only opens Make (`?make=…` is Make over Home) draw no page head,
 * so the name is the header's own project segment. The header is mounted at every desktop width; compact widths mount the phone's own
 * app instead, and a spec for those uses the phone's test ids (tests/helpers/shellMode.ts).
 */
export const projectName = (page: Page): Locator => page.locator('[data-suite-tab="project"] .gx-seg-label');
