import type { ReactNode } from "react";

export type SegmentOption<T extends string> = {
  id: T;
  label: ReactNode;
  /** A mono count after the label (e.g. Media uploads). */
  count?: ReactNode;
};

/**
 * Segmented control: #0E0E10 container, selected item #212126 / #F5F5F7,
 * inactive #8A8A90. `fill` stretches items across the container.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  border = "control",
  fill = false,
  className = "",
  itemClassName = "",
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  border?: "control" | "field";
  fill?: boolean;
  className?: string;
  itemClassName?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={["pxw-seg", border === "field" && "pxw-seg--field", fill && "pxw-seg--fill", className].filter(Boolean).join(" ")}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`pxw-seg-item ${itemClassName}`.trim()}
          aria-pressed={option.id === value}
          onClick={() => onChange(option.id)}
        >
          <span>{option.label}</span>
          {option.count !== undefined && option.count !== null && option.count !== "" ? option.count : null}
        </button>
      ))}
    </div>
  );
}
