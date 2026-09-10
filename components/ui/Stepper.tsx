import Mono from "./Mono";

/**
 * The six-step stepper (design/particl-v2/README.md §1, §3; boards 10a and
 * 7a): every project walks Brief · Shots · Boards · Takes · Approve ·
 * Deliver. In a production header: 9px dots joined by 26×1 hairlines at
 * .14, each step `gap 7px, padding 0 8px`, labels Outfit 500 13px in
 * `--ink-body`, the current one 600 in ink; done and current dots filled
 * ink, upcoming a 1.5px outline at .3. On a project tile (7a): 8px dots
 * 4px apart — done at .45 ink, current ink, upcoming a 1px outline at .25
 * — then the current step's name in mono.
 */
export const STEPS = ["Brief", "Shots", "Boards", "Takes", "Approve", "Deliver"] as const;
export type StepName = (typeof STEPS)[number];

type Props = {
  /** Index into STEPS of the step the project is on. */
  current: number;
  /** Dots and the current step's name only (project tiles). */
  compact?: boolean;
  className?: string;
};

export default function Stepper({ current, compact = false, className = "" }: Props) {
  const at = Math.max(0, Math.min(STEPS.length - 1, current));
  const dot = (i: number, px: number) => (
    <span aria-hidden="true" className={`block flex-none rounded-full ${
      i <= at ? "bg-ink" : "border-[1.5px] border-[rgba(245,246,248,.3)]"}`} style={{ width: px, height: px }} />
  );
  if (compact) {
    return (
      <span className={`flex items-center gap-[8px] ${className}`} aria-label={`Step ${at + 1} of ${STEPS.length}: ${STEPS[at]}`}>
        <span className="flex gap-[4px]">
          {STEPS.map((name, i) => (
            <span key={name} aria-hidden="true" className={`block h-[8px] w-[8px] flex-none rounded-full ${
              i < at ? "bg-[rgba(245,246,248,.45)]" : i === at ? "bg-ink" : "border border-[rgba(245,246,248,.25)]"}`} />
          ))}
        </span>
        <Mono>{STEPS[at]}</Mono>
      </span>
    );
  }
  return (
    <ol className={`flex items-center ${className}`} aria-label={`Step ${at + 1} of ${STEPS.length}: ${STEPS[at]}`}>
      {STEPS.map((name, i) => (
        <li key={name} className="flex items-center" aria-current={i === at ? "step" : undefined}>
          {i > 0 && <span aria-hidden="true" className="block h-px w-[26px] bg-border-mid" />}
          <span className="flex items-center gap-[7px] px-[8px]">
            {dot(i, 9)}
            <span className={`text-[13px] leading-none ${i === at ? "font-semibold text-ink" : "font-medium text-ink-body"}`}>{name}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
