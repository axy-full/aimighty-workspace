import { publicPageMetadata } from "@/lib/site";

/* The page is a client component and cannot export metadata; this segment does. */
export const metadata = publicPageMetadata("Sign in", "Sign in to your Particl workspace.");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
