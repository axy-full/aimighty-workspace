"use client";

import ParticlLockup from "./ParticlMark";

/** Shared form panel for first-run, recovery and invitation screens. */
export function AuthCard({
  title, sub, children,
}: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="auth-page grid min-h-dvh place-items-center px-5 py-10">
      <div className="auth-card w-full max-w-[400px] rounded-[10px] border border-line bg-panel">
        <div className="flex items-center px-6 pt-6">
          <ParticlLockup size={22} />
        </div>
        <div className="p-6">
          <h1 className="page-h1 !text-[26px]">{title}</h1>
          {sub && <p className="page-sub">{sub}</p>}
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="wl-field mb-4 block">
      {label.toUpperCase()}
      {children}
    </label>
  );
}

export function Submit({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <button type="submit" disabled={busy} className="btn-primary mt-1 !h-[46px] w-full justify-center !text-[14px]">
      {busy ? "…" : children}
    </button>
  );
}

export function ErrorLine({ children }: { children: React.ReactNode }) {
  return <p className="rail-help mt-3 text-lift">{children}</p>;
}
