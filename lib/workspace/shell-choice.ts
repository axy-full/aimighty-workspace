/**
 * The names of the shell choice, on their own (lib/workspace/switchover.ts
 * re-exports them): proxy.ts reads the cookie on every public-site request and
 * must not bundle the switch-over's page maps to do it.
 */

/** `?shell=legacy` asks for the old shell; `?shell=new` cancels that. */
export const SHELL_PARAM = "shell";
export const LEGACY_SHELL = "legacy";
export const NEW_SHELL = "new";

/**
 * The choice is remembered, because the old shell's own links (suiteHref)
 * carry no `shell` param — without a cookie, the second click would bounce
 * the person back out of the surface they just asked for.
 *
 * The name carries the release: a "previous workspace" choice remembered
 * before the Suites cut-over (`particl_shell`) must not keep anyone — a phone
 * especially — on the old site now. A fresh `?shell=legacy` writes this one.
 */
export const SHELL_COOKIE = "particl_shell_suites";
