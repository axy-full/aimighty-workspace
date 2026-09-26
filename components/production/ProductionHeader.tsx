"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Stepper, CapBar, Chip, Mono, Segmented, STEPS } from "@/components/ui";
import { usePhone } from "@/lib/usePhone";
import { useMoney } from "@/lib/price";
import type { ProductionRow, ProjectRow } from "@/lib/productions";

/**
 * The production header (design/particl-v2/README.md §3; boards 10a, 7b):
 * 64px, `0 24px`, 28 apart, a .08 hairline. The breadcrumb — the production
 * at Outfit 500 15px `--ink-body`, `›` muted, the project at 600 17px —
 * over the format line in mono (`16:9 · 0:30 · 10 SHOTS · DUE FRI`); the
 * six-step stepper; `228 of 400 cr` over the 180×3 bar, right-aligned; and
 * the `3 need you` pill (34px, an 8px ink dot) when something is.
 *
 * Below 768 (design/particl-v2-mobile, boards M2 and M3) the same header is
 * the sticky block under `‹ Production`: `12px 16px 10px` over a .08 rule,
 * 10 apart — the project at 600 18/1.1 over its mono line (`phoneLine`
 * when the page has a better one than the format: M3's `0:30 · 2 APPR · 3
 * PICKED`); `228 of 400 cr` over the 110px bar; the stepper as 8px dots
 * joined by 16px hairlines with only the current step named (M2; M3 leaves
 * it out — `phoneStepper`), the `3 need you` pill after it; then the
 * `Shots · Media` segmented, full width (Boards and Approve wait for their
 * pages). The dock stays.
 */
export default function ProductionHeader({ production, project, runtime, phoneLine, phoneStepper = true }: {
  production: ProductionRow; project: ProjectRow; runtime?: string; phoneLine?: string; phoneStepper?: boolean;
}) {
  const format = [project.format || null, runtime ?? (project.runtimeSecs ? clock(project.runtimeSecs) : null), `${project.shots} shots`].filter(Boolean).join(" · ");
  /* The cap and its spend in the workspace's unit (lib/caps.ts enforces the same
     one): credits against the credit cap, dollars only on a workspace's own keys. */
  const money = useMoney();
  const cap = money.inCredits ? project.capCredits : project.capUsd;
  const spent = money.inCredits ? project.spentCredits : project.spentUsd;
  const phone = usePhone();
  const path = usePathname();
  const router = useRouter();
  if (phone) {
    const tab = path.endsWith("/shots") ? "shots" : "media";
    const base = `/productions/${production.id}/${project.id}`;
    return (
      <div className="flex flex-none flex-col gap-[10px] border-b border-border px-[16px] pb-[10px] pt-[12px]" data-production-header="">
        <div className="flex items-end justify-between gap-[12px]">
          <span className="flex min-w-0 flex-col gap-[4px]">
            <span className="truncate text-[18px] font-semibold leading-[1.1] text-ink">{project.name}</span>
            <Mono className="truncate">{phoneLine ?? format}</Mono>
          </span>
          {cap !== null && cap !== undefined && <CapBar spent={spent} cap={cap} placement="phone" className="flex-none" />}
        </div>
        {(phoneStepper || project.needYou > 0) && (
          <div className="flex items-center">
            {phoneStepper && STEPS.map((name, i) => (
              <span key={name} className="flex items-center">
                {i > 0 && <span aria-hidden="true" className="block h-px w-[16px] bg-border-mid" />}
                <span className="flex items-center gap-[5px] px-[4px]">
                  <span aria-hidden="true" className={`box-border block h-[8px] w-[8px] rounded-full ${i < project.step ? "bg-[rgba(245,246,248,.45)]" : i === project.step ? "bg-ink" : "border border-[rgba(245,246,248,.25)]"}`} />
                  {i === project.step && <span className="text-[12px] font-semibold leading-none text-ink">{name}</span>}
                </span>
              </span>
            ))}
            {project.needYou > 0 && <Chip variant="need" className="ml-auto max-md:text-[12px]">{project.needYou} need you</Chip>}
          </div>
        )}
        {/* Only the pages that exist: Boards and Approve had no page behind them, and did nothing. */}
        <Segmented label="Project" fill value={tab} onChange={(t) => router.push(`${base}/${t}`)}
          options={[{ value: "shots", label: "Shots" }, { value: "media", label: "Media" }]} />
      </div>
    );
  }
  return (
    <div className="flex h-[64px] flex-none items-center gap-[28px] border-b border-border px-[24px]">
      <span className="flex flex-col gap-[5px]">
        <span className="flex items-baseline gap-[8px]">
          <Link href={`/productions`} className="text-[15px] font-medium leading-none text-ink-body">{production.name}</Link>
          <span className="text-ink-muted">›</span>
          <span className="text-[17px] font-semibold leading-none text-ink">{project.name}</span>
        </span>
        <Mono>{format}</Mono>
      </span>
      <Stepper current={project.step} />
      <span className="ml-auto">
        {cap !== null && cap !== undefined && <CapBar spent={spent} cap={cap} placement="header" />}
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
