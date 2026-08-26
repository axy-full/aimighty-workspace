"use client";

import Image from "next/image";
import logo from "@/public/aimighty-logo.png";

export function AuthCard({
  title, sub, children,
}: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="w-full max-w-[380px] border border-line bg-panel">
      <div className="flex items-center gap-2.5 border-b border-line bg-chrome px-4 py-3">
        <Image src={logo} alt="aimighty" priority
          className="h-[14px] w-auto select-none"
          style={{ filter: "brightness(1.28) saturate(1.04)" }} />
        <span className="ptitle text-[10.5px] tracking-[.16em] text-mute">WORKSPACE</span>
      </div>

      <div className="p-4">
        <h1 className="ptitle text-[15px] tracking-tight text-bone">{title}</h1>
        {sub && <p className="mt-1 text-[12px] leading-relaxed text-mute">{sub}</p>}
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
      className="ptitle mt-1 h-9 w-full rounded-[8px] bg-red text-[12px] tracking-[.1em] text-white transition-colors hover:bg-lift disabled:bg-panel3 disabled:text-mute">
      {busy ? "…" : children}
    </button>
  );
}

export function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 border border-lift/30 bg-lift/8 px-2.5 py-1.5 font-mono text-[10.5px] leading-relaxed text-lift">
      {children}
    </p>
  );
}
