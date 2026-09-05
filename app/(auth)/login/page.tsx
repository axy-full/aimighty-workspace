"use client";

/**
 * /login is the same screen as /welcome — the handoff combines them — so
 * whoever is sent here to sign in also sees what they are signing in to.
 */
import WelcomeSignIn from "@/components/WelcomeSignIn";

export default function LoginPage() {
  return <WelcomeSignIn />;
}
