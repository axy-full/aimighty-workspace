/** − value + on #1C1C1F buttons (hover #28282D), clamped to [min, max]. */
export function Stepper({
  label,
  value,
  min,
  max,
  step = 1,
  format = (n) => String(n),
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (n: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="pxw-stepper">
      <span className="pxw-stepper-label">{label}</span>
      <span className="pxw-stepper-controls">
        <button type="button" className="pxw-stepper-btn" aria-label={`Decrease ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - step))}>−</button>
        <span className="pxw-stepper-value" aria-live="polite">{format(value)}</span>
        <button type="button" className="pxw-stepper-btn" aria-label={`Increase ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + step))}>+</button>
      </span>
    </div>
  );
}
