import { redirect } from "next/navigation";

/** The spend screen is Usage; this older address goes there. */
export default function DashboardPage() {
  redirect("/usage");
}
