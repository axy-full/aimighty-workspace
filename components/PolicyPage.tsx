"use client";

import Link from "next/link";
import { usePageTitle } from "@/lib/usePageTitle";

/** A page of plain sentences: the policies, read without signing in. */
export function PolicyPage({ title, intro, updated, children }: { title: string; intro: string; updated: string; children: React.ReactNode }) {
  usePageTitle(title);
  return (
    <div className="screen">
      <div className="mx-auto w-full max-w-[720px] pb-12">
        <div className="mt-6 flex flex-wrap gap-x-4 gap-y-1 text-[14px]">
          <Link href="/policy" className="text-blue">Content policy</Link>
          <Link href="/terms" className="text-blue">Terms</Link>
          <Link href="/privacy" className="text-blue">Privacy &amp; retention</Link>
          <Link href="/report" className="text-blue">Report content</Link>
        </div>
        <h1 className="h1 mt-3">{title}</h1>
        <p className="mt-3 max-w-[62ch] text-[15px] text-dim">{intro}</p>
        <div className="policy mt-6">{children}</div>
        <p className="mt-10 text-[12px] text-mute">Last changed {updated}. Changes are made here, on the page, with the date.</p>
      </div>
    </div>
  );
}

export function P({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card mt-4 px-5 py-4">
      <p className="grouplabel">{title}</p>
      <div className="mt-2 flex flex-col gap-2 text-[14.5px] leading-relaxed text-dim">{children}</div>
    </section>
  );
}
