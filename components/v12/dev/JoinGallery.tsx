"use client";
import { useSearchParams } from "next/navigation";
import { useCompact } from "@/lib/shell/use-compact";
import { OverlayProvider, ToastProvider } from "../ui";
import { JoinProvider, useJoin } from "../join/JoinProvider";
import { JOIN_REASONS, isJoinReason } from "../join/join-model";
import "../v12.css";

/**
 * Test only (app/(test)/v12-join): the join sheet over an empty page, opened by the address the way the visitor screens
 * will open it (`?join=…&requested=1`), with a button per reason for the specs.
 */
export function JoinGallery() {
  const q = useSearchParams();
  const compact = useCompact();
  const join = q.get("join");
  const reason = isJoinReason(join) ? join : "start";
  return (
    <OverlayProvider>
      <ToastProvider bottom={24}>
        <JoinProvider compact={compact || q.get("phone") === "1"} back="/v12-join"
          initial={{ open: isJoinReason(join), reason, requested: q.get("requested") === "1", prompt: q.get("prompt") ?? "", detail: q.get("detail"),
            fields: { name: "", email: "", company: "", role: "", size: "", want: q.get("prompt") ?? "" } }}>
          <div className="v12" style={{ minHeight: "100dvh", padding: 24, background: "var(--gx-root)", color: "var(--gx-text)", fontFamily: "var(--gx-font)", fontSize: 13 }}>
            <Triggers />
          </div>
        </JoinProvider>
      </ToastProvider>
    </OverlayProvider>
  );
}

function Triggers() {
  const join = useJoin();
  return (
    <main style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <h1 style={{ width: "100%", fontSize: 20, margin: "0 0 8px" }}>Join sheet</h1>
      {JOIN_REASONS.map((r) => (
        <button key={r} type="button" className="v12-pill" data-testid={`open-${r}`} onClick={() => join?.openJoin(r)}>{r}</button>
      ))}
    </main>
  );
}
