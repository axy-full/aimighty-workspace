import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import "./management.css";

export type ManagementTab = "workspace" | "team" | "credits" | "usage";
const destinations: { id: ManagementTab; label: string; href: string }[] = [
  { id: "workspace", label: "Workspace", href: "/settings" },
  { id: "team", label: "People", href: "/team" },
  { id: "credits", label: "Plans & credits", href: "/billing" },
  { id: "usage", label: "Usage", href: "/usage" },
];

export default function ManagementPage({
  tab,
  title,
  description,
  workspace,
  actions,
  children,
}: {
  tab: ManagementTab;
  title: string;
  description: string;
  workspace?: string | null;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="management">
      <div className="management-topline">
        <span>{workspace || "Your workspace"}</span>
        <Link href="/workbench">
          Back to studio <ArrowUpRight size={14} />
        </Link>
      </div>
      <header className="management-heading">
        <div>
          <span className="management-kicker">WORKSPACE MANAGEMENT</span>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {actions && <div className="management-actions">{actions}</div>}
      </header>
      <nav className="management-nav" aria-label="Workspace management">
        {destinations.map((item) => (
          <Link
            key={item.id}
            href={item.href}
            aria-current={tab === item.id ? "page" : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="management-body">{children}</div>
    </div>
  );
}

export function ManagementCard({
  title,
  description,
  action,
  children,
  className = "",
  id,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`management-card ${className}`}>
      {title && (
        <div className="management-card-heading">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
export function ManagementNotice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={`management-notice ${error ? "is-error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
export function ManagementStat({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="management-stat">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}
