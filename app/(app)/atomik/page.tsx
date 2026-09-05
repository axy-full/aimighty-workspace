import { redirect } from "next/navigation";

/** Atomik opens on its first stage. The agent lives at /atomik/agent. */
export default function AtomikIndex() {
  redirect("/atomik/ideas");
}
