import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

/** Label (11.5px #7A7A80) over a control. */
export function Field({ label, children, className = "" }: { label: string; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={className}>
      <label className="pxw-field-label" htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`pxw-input ${className}`.trim()} {...rest} />;
}

export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`pxw-select ${className}`.trim()} {...rest}>
      {children}
    </select>
  );
}
