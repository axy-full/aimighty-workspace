"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import logo from "@/public/aimighty-logo.png";

const CRUMB: Record<string, string> = {
  "/": "compose", "/projects": "bins", "/all": "library",
  "/usage": "usage", "/team": "team",
};

type U = { name: string; email: string; role: string };

export default function TitleBar({ user }: { user: U }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const crumb =
    CRUMB[path] ?? (path.startsWith("/projects/") ? "bins/bin" : path.replace(/^\//, ""));

  const initials = user.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  async function signOut() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="app-title relative flex items-center gap-3 border-b border-line bg-chrome px-3">
      {/* Brand red is 2.1:1 on near-black — lift the mark so it reads. */}
      <Link href="/" title="Compose" className="group flex items-center gap-3">
        <Image src={logo} alt="aimighty" priority
          className="h-[15px] w-auto select-none"
          style={{ filter: "brightness(1.28) saturate(1.04)" }} />
        <span className="ptitle text-[11px] tracking-[.16em] text-mute transition-colors group-hover:text-dim">
          WORKSPACE
        </span>
      </Link>

      <span className="h-4 w-px bg-line" />
      <span className="font-mono text-[10.5px] tracking-wide text-dim">~/{crumb}</span>

      <div className="ml-auto flex items-center gap-3">
        <span className="hidden font-mono text-[10px] tracking-wider text-mute xl:block">
          MODELARK · AP-SOUTHEAST
        </span>
        <span className="hidden h-4 w-px bg-line xl:block" />
        <span className="hidden items-center gap-1.5 font-mono text-[10px] tracking-wider text-ok sm:flex">
          <span className="lamp lamp-live" />READY
        </span>
        <span className="h-4 w-px bg-line" />

        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 rounded-[8px] px-1.5 py-1 transition-colors hover:bg-panel2"
          title={`${user.name} · ${user.email}`}
        >
          <span className="grid h-[20px] w-[20px] place-items-center rounded-full bg-panel3 font-mono text-[9px] text-bone">
            {initials}
          </span>
          <span className="hidden font-mono text-[10px] text-dim md:block">{user.name}</span>
        </button>
      </div>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-2 top-[38px] z-50 w-[212px] border border-line bg-panel shadow-xl">
            <div className="border-b border-line px-3 py-2.5">
              <p className="truncate text-[12px] text-bone">{user.name}</p>
              <p className="truncate font-mono text-[9.5px] text-mute">{user.email}</p>
              <p className="lbl mt-1.5">{user.role}</p>
            </div>
            <button
              onClick={signOut} disabled={busy}
              className="w-full px-3 py-2 text-left font-mono text-[10.5px] tracking-wider text-dim hover:bg-panel2 hover:text-lift"
            >
              {busy ? "SIGNING OUT…" : "SIGN OUT"}
            </button>
          </div>
        </>
      )}
    </header>
  );
}
