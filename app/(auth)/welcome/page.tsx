"use client";

/**
 * Particl's front door: what it is, and the way in — one screen. The
 * opening animation plays here and nowhere else.
 */
import ParticlIntro from "@/components/ParticlIntro";
import WelcomeSignIn from "@/components/WelcomeSignIn";

export default function WelcomePage() {
  return (
    <>
      <ParticlIntro />
      <WelcomeSignIn />
    </>
  );
}
