import { publicPageMetadata } from "@/lib/site";

/* The page is a client component and cannot export metadata; this segment does. */
export const metadata = publicPageMetadata("Privacy & retention", "What Particl keeps, where it is kept, who can see it and for how long.");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
