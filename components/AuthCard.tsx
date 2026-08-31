"use client";

import Image from "next/image";
import logo from "@/public/aimighty-logo.png";

export function AuthCard({
  title, sub, children,
}: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="w-full max-w-[380px] rounded-[20px] bg-white shadow-[var(--shadow-pop)]">
      <div className="flex items-center gap-2.5 px-6 pt-6">
        <Image src={logo} alt="aimighty" priority
          className="h-[13px] w-auto select-none"
          style={{ filter: "brightness(1.28) saturate(1.04)" }} />
        <span className="pb-px text-[11px] font-semibold tracking-[.12em] text-mute">WORKSPACE</span>
      </div>

      <div className="p-6">
        <h1 className="text-[24px] font-bold tracking-[-0.02em]">{title}</h1>
        {sub && <p className="mt-1.5 text-[14px] leading-relaxed text-dim">{sub}</p>}
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1.5 block text-[13px] font-medium text-dim">{label}</span>
      {children}
    </label>
  );
}

export function Submit({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <button type="submit" disabled={busy}
      className="btn-render mt-2 h-11 w-full text-[16px]">
      {busy ? "…" : children}
    </button>
  );
}

export function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 rounded-[10px] bg-lift/8 px-3 py-2 text-[13.5px] leading-relaxed text-lift">
      {children}
    </p>
  );
}
