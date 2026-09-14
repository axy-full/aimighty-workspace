"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthCard, Field, Submit, ErrorLine } from "@/components/AuthCard";
import "../../commercial.css";

type SignupAvailability = {
  email?: string;
  name?: string;
  open: boolean;
  reason?: string;
  error?: string;
};
const validPlan = (value: string | null) =>
  ["studio", "agency", "production"].includes(value || "") ? value! : "studio";
const billingPath = (plan: string, cadence: string) =>
  `/billing?plan=${encodeURIComponent(plan)}&cadence=${cadence}&onboarding=1`;
export default function SignupPage() {
  return (
    <Suspense
      fallback={
        <AuthCard title="Create your workspace">
          <p>Loading…</p>
        </AuthCard>
      }
    >
      <Signup />
    </Suspense>
  );
}
function Signup() {
  const router = useRouter(),
    params = useSearchParams(),
    code = params.get("invite") || "",
    verify = params.get("verify") || "";
  const plan = validPlan(params.get("plan")),
    cadence = params.get("cadence") === "annual" ? "annual" : "monthly";
  const next = billingPath(plan, cadence),
    login = "/login?next=" + encodeURIComponent(next);
  const [available, setAvailable] = useState<SignupAvailability | null>(null),
    [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [workspace, setWorkspace] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [accept, setAccept] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [sent, setSent] = useState(false),
    [notice, setNotice] = useState(""),
    [needsSignIn, setNeedsSignIn] = useState(false);
  const verification = useRef<{
    token: string;
    promise: Promise<Record<string, unknown>>;
  } | null>(null);
  useEffect(() => {
    let active = true;
    if (verify) {
      if (verification.current?.token !== verify)
        verification.current = {
          token: verify,
          promise: fetch("/api/auth/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: verify }),
          }).then(async (response) => {
            const data = await response.json();
            if (!response.ok)
              throw new Error(
                data.error || "This verification link could not be used.",
              );
            return data;
          }),
        };
      verification.current.promise
        .then((data) => {
          if (!active) return;
          const destination =
            typeof data.next === "string" && data.next.startsWith("/billing")
              ? data.next
              : billingPath(
                  validPlan(
                    typeof data.planId === "string" ? data.planId : null,
                  ),
                  data.cadence === "annual" ? "annual" : "monthly",
                );
          router.replace(destination);
          router.refresh();
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
      return () => {
        active = false;
      };
    }
    const controller = new AbortController();
    fetch(
      "/api/auth/signup" + (code ? "?code=" + encodeURIComponent(code) : ""),
      { signal: controller.signal },
    )
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "Sign-up is unavailable.");
        if (active) {
          setAvailable(data);
          if (data.name) setName(data.name);
          if (data.email) setEmail(data.email);
        }
      })
      .catch((e) => {
        if (active && !controller.signal.aborted) setError(e.message);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [code, verify, router]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!available?.open || busy) return;
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    setNeedsSignIn(false);
    try {
      const response = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(code ? { code } : {}),
          name,
          email,
          workspace,
          password,
          accept,
          planId: plan,
          cadence,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setNeedsSignIn(!!data.needsSignIn);
        throw new Error(data.error || "Your account could not be created.");
      }
      if (data.verificationRequired) {
        setSent(true);
        setNotice(
          data.message ||
            "Open the verification link in your email to continue.",
        );
        setPassword("");
        setConfirm("");
      } else {
        router.push(
          typeof data.next === "string" &&
            data.next.startsWith("/") &&
            !data.next.startsWith("//")
            ? data.next
            : "/workbench",
        );
        router.refresh();
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not reach Particl. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function resend() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/signup/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          data.error || "The verification email could not be sent.",
        );
      setNotice(
        data.message ||
          "If a verification is pending for this address, a new email is on its way.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }
  if (verify)
    return (
      <AuthCard
        title={error ? "Check your verification link" : "Verifying your email"}
        sub={
          error || "Your account will open as soon as verification completes."
        }
      >
        {error && (
          <div className="auth-actions">
            <Link href={`/signup?plan=${plan}&cadence=${cadence}`}>
              Return to sign up
            </Link>
            <Link href={login}>Sign in</Link>
          </div>
        )}
      </AuthCard>
    );
  if (sent)
    return (
      <AuthCard
        title="Check your email"
        sub={`We sent a verification link to ${email}.`}
      >
        <p role="status" className="auth-status">
          {notice}
        </p>
        <p className="auth-status">
          Your {plan} plan choice and {cadence} billing are saved. You will
          review checkout after verification. No payment has been taken.
        </p>
        {error && <ErrorLine>{error}</ErrorLine>}
        <div className="auth-actions">
          <button disabled={busy} onClick={() => void resend()}>
            {busy ? "Sending…" : "Resend verification email"}
          </button>
          <Link href={login}>Sign in</Link>
        </div>
      </AuthCard>
    );
  return (
    <AuthCard
      title="Create your studio workspace"
      sub={
        code
          ? "Accept your invitation and give your workspace a name."
          : "Start with your account. Verify your email, then review your plan and payment."
      }
    >
      {!code && (
        <div className="auth-plan-choice">
          <strong>{plan.charAt(0).toUpperCase() + plan.slice(1)}</strong> ·{" "}
          {cadence === "annual"
            ? "Annual billing · 20% discount"
            : "Monthly billing"}
          <br />
          <Link href="/pricing">Compare plans</Link>
        </div>
      )}
      {!available && !error && (
        <p role="status" className="auth-status">
          Checking account availability…
        </p>
      )}
      {available && !available.open && (
        <p role="status" className="auth-status">
          {available.reason ||
            "New accounts are not available yet. Please return when account registration opens."}
        </p>
      )}
      <form onSubmit={submit}>
        <Field label="Your name">
          <input
            required
            autoComplete="name"
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Work email">
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            readOnly={!!code}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Workspace name">
          <input
            required
            maxLength={100}
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            placeholder="Your studio or production house"
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            required
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Confirm password">
          <input
            type="password"
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <label className="mt-3 flex items-start gap-2 text-[13px] leading-relaxed text-dim">
          <input
            className="mt-1"
            type="checkbox"
            required
            checked={accept}
            onChange={(e) => setAccept(e.target.checked)}
          />
          <span>
            I agree to the{" "}
            <Link className="text-ink underline" href="/terms" target="_blank">
              terms
            </Link>{" "}
            and{" "}
            <Link className="text-ink underline" href="/policy" target="_blank">
              content policy
            </Link>
            . Read the{" "}
            <Link
              className="text-ink underline"
              href="/privacy"
              target="_blank"
            >
              privacy notice
            </Link>
            .
          </span>
        </label>
        <fieldset disabled={!available?.open || busy} className="mt-4">
          <Submit busy={busy}>
            {code ? "Create the workspace" : "Create account and verify email"}
          </Submit>
        </fieldset>
        {error && (
          <div role="alert">
            <ErrorLine>{error}</ErrorLine>
          </div>
        )}
        {needsSignIn && (
          <p className="auth-status">
            <Link href={login}>Sign in to continue with this plan</Link>
          </p>
        )}
      </form>
      <p className="auth-status">
        Already have an account? <Link href={login}>Sign in</Link>
      </p>
    </AuthCard>
  );
}
