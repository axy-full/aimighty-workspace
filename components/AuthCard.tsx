"use client";

import Image from "next/image";
import logo from "@/public/aimighty-logo.png";

export function AuthCard({
  title, sub, children,
}: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="w-full max-w-[380px] rounded-[16px] border border-line bg-panel shadow-[var(--shadow)]">
      <div className="flex items-center gap-2.5 border-b border-hair px-5 py-3.5">
        <Image src={logo} alt="aimighty" priority
          className="h-[13px] w-auto select-none"
          style={{ filter: "brightness(1.28) saturate(1.04)" }} />
        <span className="pb-px text-[10px] font-bold tracking-[.14em] text-dim">WORKSPACE</span>
      </div>

      <div className="p-5">
        <h1 className="ptitle text-[16px] text-bone">{title}</h1>
        {sub && <p className="mt-1 text-[12px] leading-relaxed text-dim">{sub}</p>}
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="lbl mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}

export function Submit({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <button type="submit" disabled={busy}
      className="btn-render mt-1 h-9 w-full text-[12.5px]">
      {busy ? "…" : children}
    </button>
  );
}

export function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 rounded-[8px] bg-lift/8 px-2.5 py-1.5 font-mono text-[10.5px] leading-relaxed text-lift">
      {children}
    </p>
  );
}
