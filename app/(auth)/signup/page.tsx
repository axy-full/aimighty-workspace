"use client";

/**
 * Sign up, by invitation (board 12i): two cards, one POST.
 *
 * ACCOUNT asks who you are — a name, prefilled from the invitation, and one
 * password with a Show toggle in place of a second field. STUDIO asks what
 * to call the workspace, says what it comes with (the welcome grant read
 * from the server, never a literal), takes the policy acceptance on one
 * line, and opens it. Both cards feed the same POST /api/auth/signup the
 * one-form screen sent; the invitation still fixes the address.
 *
 * A new studio lands on Make with the starter production's cast in the
 * prompt (`?starter=1`), because the first render is the point.
 */
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthFrame, AuthChecking, Eyebrow, Title, Field, PasswordField, Note, Primary, ErrorLine, Links, AuthLink, AuthLinkButton, LINK } from "@/components/auth";
import { RequestAccessButton } from "@/components/RequestAccess";

export default function SignupPage() {
  return <Suspense fallback={<AuthChecking what="Checking the invitation" />}><Signup /></Suspense>;
}

type Invite = { email: string; name: string; open: boolean; grant: number | undefined };

function Signup() {
  const router = useRouter();
  const params = useSearchParams();
  const code = params.get("invite") ?? "";
  // No code, no form: decided at first render rather than in an effect.
  const [state, setState] = useState<Invite | { dead: string } | null>(
    () => (code ? null : { dead: "Sign-up is by invitation. Ask management for one." }));
  const [step, setStep] = useState<"account" | "studio">("account");
  const [name, setName] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [password, setPassword] = useState("");
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    let live = true;
    fetch(`/api/auth/signup?code=${encodeURIComponent(code)}`)
      .then(async (res) => {
        const j = await res.json().catch(() => ({}));
        if (!live) return;
        if (res.ok) {
          /* `grant` is the welcome grant the workspace will receive; read as
             a number or nothing, so an older server answers with no figure
             rather than "NaN credits". */
          const grant = typeof j.grant === "number" && Number.isFinite(j.grant) ? j.grant : undefined;
          setState({ email: j.email, name: j.name ?? "", open: Boolean(j.open), grant });
          setName(j.name ?? "");
        } else setState({ dead: j.error ?? "That invitation isn't valid." });
      })
      .catch(() => { if (live) setState({ dead: "Couldn't check the invitation. Try again." }); });
    return () => { live = false; };
  }, [code]);

  function next(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setStep("studio");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!state || !("email" in state)) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, name, email: state.email, workspace, password, accept }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Couldn't sign up");
      router.push("/make/video?starter=1");
      router.refresh();
    } catch (e) {
      const message = (e as Error).message;
      /* The server's word on the password arrives after the second card;
         it is about the first, so the first is where it is shown. */
      if (/password|characters|digits|too long/i.test(message)) setStep("account");
      setErr(message);
      setBusy(false);
    }
  }

  if (!state) return <AuthChecking what="Checking the invitation" />;
  if ("dead" in state) {
    return (
      <AuthFrame>
        <Eyebrow>Invite</Eyebrow>
        <Title>This invitation won&rsquo;t work</Title>
        <Note>{state.dead}</Note>
        <Links>
          <AuthLink href="/login">← Sign in instead</AuthLink>
          <RequestAccessButton className={LINK} label="Request an invite" />
        </Links>
      </AuthFrame>
    );
  }

  if (step === "account") {
    return (
      <AuthFrame onSubmit={next} data-onboarding="account">
        <Eyebrow>Account</Eyebrow>
        <Title>Who are you?</Title>
        <Field label="Your name" name="name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <PasswordField name="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <Primary>Continue</Primary>
        {!state.open && <ErrorLine>Sign-up isn&rsquo;t open on this deployment yet — contact management.</ErrorLine>}
        {err && <ErrorLine>{err}</ErrorLine>}
        <Links>
          <AuthLink href="/login">Sign in instead →</AuthLink>
        </Links>
      </AuthFrame>
    );
  }

  const grant = state.grant ?? 0;
  return (
    <AuthFrame onSubmit={submit} data-onboarding="studio">
      <Eyebrow>Studio</Eyebrow>
      <Title>Name your studio</Title>
      <Field label="Studio name" name="workspace" autoComplete="organization" required value={workspace} onChange={(e) => setWorkspace(e.target.value)} autoFocus />
      <Note>
        It comes ready: a demo production, the camera vocabulary, two recipes
        {grant > 0 ? <>, and <span className="font-medium text-ink">{grant.toLocaleString("en-US")} credits</span></> : null}.
      </Note>
      <label className="flex items-start gap-[10px] text-[13.5px] leading-[1.5] text-ink-body max-md:min-h-[44px]">
        <input type="checkbox" name="accept" checked={accept} onChange={(e) => setAccept(e.target.checked)}
          className="mt-[3px] h-[15px] w-[15px] flex-none accent-ink" />
        <span>
          I accept the <Link href="/policy" target="_blank" rel="noreferrer" className="text-ink underline underline-offset-[3px]">content policy</Link> and
          the <Link href="/terms" target="_blank" rel="noreferrer" className="text-ink underline underline-offset-[3px]">terms</Link>
        </span>
      </label>
      <Primary busy={busy} outlined={!accept} disabled={!accept}>Open the studio</Primary>
      {err && <ErrorLine>{err}</ErrorLine>}
      <Links>
        <AuthLinkButton onClick={() => { setErr(null); setStep("account"); }}>← Account</AuthLinkButton>
      </Links>
    </AuthFrame>
  );
}
