import { redirect } from "next/navigation";

/** Audio is made at /make/audio now (§10). */
export default function Moved() {
  redirect("/make/audio");
}
