import { redirect } from "next/navigation";

/** Generate is the landing page now. This keeps old links and anything
 *  bookmarked at /generate working rather than 404ing. */
export default function GenerateRedirect() {
  redirect("/");
}
