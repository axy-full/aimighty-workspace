"use client";
import dynamic from "next/dynamic";

/**
 * The root 404's client side, split off. Next puts app/not-found.tsx into
 * every page's tree, so whatever it imports directly — the Suites header
 * and its stylesheets — is preloaded on every page, /login and /pricing
 * included. Through next/dynamic the 404's code and CSS come only with a 404,
 * its stylesheets written into that response (so nothing flashes unstyled).
 *
 * app/suites/error.tsx keeps a direct import on purpose: a page shown because
 * code failed to load must not need to load more code to show itself.
 */
const FaultPage = dynamic(() => import("./FaultPage").then((module) => module.FaultPage));

export function NotFoundView() {
  return <FaultPage kind="missing" />;
}
