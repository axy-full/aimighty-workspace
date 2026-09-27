import { publicPageMetadata } from "@/lib/site";

/* The page is a client component and cannot export metadata; this segment does. */
export const metadata = publicPageMetadata("Welcome", "A production studio for generated film. Sign in, or ask for an invitation.");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
