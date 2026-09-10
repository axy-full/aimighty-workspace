"use client";

import Link from "next/link";
import { Stepper, CapBar, Chip, Mono } from "@/components/ui";
import type { ProductionRow, ProjectRow } from "@/lib/productions";

/**
 * The production header (design/particl-v2/README.md §3; boards 10a, 7b):
 * 64px, `0 24px`, 28 apart, a .08 hairline. The breadcrumb — the production
 * at Outfit 500 15px `--ink-body`, `›` muted, the project at 600 17px —
 * over the format line in mono (`16:9 · 0:30 · 10 SHOTS · DUE FRI`); the
 * six-step stepper; `228 of 400 cr` over the 180×3 bar, right-aligned; and
 * the `3 need you` pill (34px, an 8px ink dot) when something is.
 */
export default function ProductionHeader({ production, project, runtime }: { production: ProductionRow; project: ProjectRow; runtime?: string }) {
  const format = [project.format || null, runtime ?? (project.runtimeSecs ? clock(project.runtimeSecs) : null), `${project.shots} shots`].filter(Boolean).join(" · ");
  const cap = project.capCredits ?? project.capUsd;
  return (
    <div className="flex h-[64px] flex-none items-center gap-[28px] border-b border-border px-[24px] max-md:h-auto max-md:flex-wrap max-md:gap-[12px] max-md:px-[16px] max-md:py-[12px]">
      <span className="flex flex-col gap-[5px]">
        <span className="flex items-baseline gap-[8px]">
          <Link href={`/productions`} className="text-[15px] font-medium leading-none text-ink-body">{production.name}</Link>
          <span className="text-ink-muted">›</span>
          <span className="text-[17px] font-semibold leading-none text-ink">{project.name}</span>
        </span>
        <Mono>{format}</Mono>
      </span>
      <span className="max-md:hidden"><Stepper current={project.step} /></span>
      <span className="md:hidden"><Stepper current={project.step} compact /></span>
      <span className="ml-auto">
        {cap !== null && cap !== undefined && <CapBar spent={project.capCredits !== null ? project.spentCredits : project.spentUsd} cap={cap} placement="header" />}
      </span>
      {project.needYou > 0 && <Chip variant="needHeader">{project.needYou} need you</Chip>}
    </div>
  );
}

/** `0:30` from seconds. */
export function clock(secs: number): string {
  const m = Math.floor(secs / 60), s = Math.round(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
