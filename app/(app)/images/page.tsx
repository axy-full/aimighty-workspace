import { redirect } from "next/navigation";

/** Stills are made at /make/images now (§10). */
export default function Moved() {
  redirect("/make/images");
}
