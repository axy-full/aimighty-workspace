import Link from "next/link";
import ParticlLockup from "@/components/ParticlMark";

export default function CommercialLayout({
  children,
  account = false,
}: {
  children: React.ReactNode;
  account?: boolean;
}) {
  return (
    <div className="commercial">
      <header className="commercial-header">
        <Link href="/workbench" aria-label="Particl studio">
          <ParticlLockup size={24} />
        </Link>
        <nav aria-label="Account navigation">
          <Link href="/workbench">Studio</Link>
          <Link href="/pricing">Plans</Link>
          <Link href={account ? "/settings" : "/login"}>
            {account ? "Account" : "Sign in"}
          </Link>
        </nav>
      </header>
      <main className="commercial-main">{children}</main>
      <footer className="commercial-footer">
        <span>Particl · Your production, together.</span>
        <nav aria-label="Legal">
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/policy">Content policy</Link>
        </nav>
      </footer>
    </div>
  );
}
