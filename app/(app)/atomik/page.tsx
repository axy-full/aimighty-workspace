import { redirect } from "next/navigation";

/** Atomik opens on its first stage; the agent itself is the rail (design/particl-v2 §5). */
export default function AtomikIndex() {
  redirect("/atomik/ideas");
}
