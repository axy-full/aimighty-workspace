"use client";

import { useEffect } from "react";

/**
 * The last wall. This one catches a throw in the ROOT layout, which means
 * everything else — the shell, the fonts, the providers — never ran. Next replaces the whole document with this, so it has to bring
 * its own <html> and <body>.
 *
 * It deliberately depends on nothing: no globals.css, no font variables, no
 * components. Every colour is written out, so this page renders correctly
 * even when the reason we are here is that the stylesheet or the font never
 * arrived — and it is written out DARK, because particl is dark (§4). A
 * failure page that flips to paper on a light system would be the one screen
 * that does not look like the product, at the one moment the reader is
 * already wondering what broke.
 */

const CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh;
    display: grid; place-items: center; padding: 24px;
    background: #1D1F24; color: #F5F6F8;
    font: 400 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .box { max-width: 46ch; text-align: center; }
  h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.02em; }
  p { margin: 10px 0 0; color: #9A9EA6; }
  .row { margin-top: 22px; display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
  button, a.btn {
    font: inherit; font-size: 14px; font-weight: 500;
    padding: 9px 18px; border-radius: 999px; border: 0; cursor: pointer;
    text-decoration: none; display: inline-block;
  }
  .primary { background: #007AFF; color: #fff; }
  .plain { background: rgba(255,255,255,.09); color: #F5F6F8; }
  .ref {
    margin-top: 18px; font-size: 12px; color: #767A82; word-break: break-word;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
`;

export default function GlobalError({
  error, reset,
}: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[particl] the app failed to start:", error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <div className="box">
          <h1>Particl didn&rsquo;t start</h1>
          <p>
            The app failed before it could draw anything. Your work is untouched —
            renders, projects and the ledger all live on the server, not in this page.
          </p>
          <div className="row">
            <button className="primary" onClick={reset}>Try again</button>
            {/* Deliberately a plain anchor: the root layout is what failed, so
                the router itself may not be mounted. This must be a full
                document load, not a client-side navigation. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a className="btn plain" href="/">Reload</a>
          </div>
          <p className="ref">
            {error.message}
            {error.digest ? ` · ref ${error.digest}` : ""}
          </p>
        </div>
      </body>
    </html>
  );
}
