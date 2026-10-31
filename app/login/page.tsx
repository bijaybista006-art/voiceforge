"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { IconAlert, IconArrowRight, IconWave } from "@/components/ui/Icons";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Sign in failed.");
        return;
      }
      router.replace(params.get("next") || "/");
      router.refresh();
    } catch {
      setError("Couldn't reach the server. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm">
      <h1 className="font-display text-2xl font-bold tracking-tight text-ink">Welcome back</h1>
      <p className="mt-1.5 text-sm text-muted">Sign in to your VoiceForge studio.</p>

      <label htmlFor="password" className="mt-8 block text-[13px] font-medium text-ink">
        Password
      </label>
      <div className="relative mt-1.5">
        <input
          id="password"
          type={show ? "text" : "password"}
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••••"
          className="h-11 w-full rounded-xl border border-line bg-surface pl-3.5 pr-20 text-sm text-ink transition-colors hover:border-lineStrong focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15"
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-muted transition-colors hover:bg-surface3 hover:text-ink"
        >
          {show ? "Hide" : "Show"}
        </button>
      </div>

      {error ? (
        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-danger/30 bg-dangerSoft px-3.5 py-3">
          <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <p className="text-[13px] leading-relaxed text-ink">{error}</p>
        </div>
      ) : null}

      <button
        type="submit"
        disabled={busy || !password}
        className="mt-6 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 text-sm font-semibold text-white shadow-[0_4px_14px_-4px_rgba(37,99,235,.5)] transition-all hover:bg-[rgb(29_78_216)] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
      >
        {busy ? "Signing in…" : "Sign in"}
        {!busy ? <IconArrowRight className="h-4 w-4" /> : null}
      </button>

      <p className="mt-6 text-[12px] leading-relaxed text-faint">
        The password is the <code className="font-mono">ADMIN_PASSWORD</code> environment
        variable in your Vercel project. Change it there and redeploy.
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen">
      {/* Branding panel — mirrors Tech Notebook's split login */}
      <div className="relative hidden overflow-hidden bg-gradient-to-br from-slate-950 via-brand-950 to-slate-900 lg:flex lg:w-[45%] xl:w-1/2">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-20 -top-20 h-[400px] w-[400px] rounded-full bg-brand-500/10 blur-3xl" />
          <div className="absolute -bottom-10 -right-14 h-[500px] w-[500px] rounded-full bg-accent-500/10 blur-3xl" />
          <div
            className="absolute inset-0 opacity-[0.04]"
            style={{
              backgroundImage:
                "linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px)",
              backgroundSize: "48px 48px",
            }}
          />
        </div>

        <div className="relative z-10 flex w-full flex-col justify-between p-12 xl:p-16">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-brand-400 to-accent-500 shadow-xl shadow-brand-500/30">
              <IconWave className="h-5 w-5 text-white" />
            </span>
            <span className="text-xl font-bold tracking-tight text-white">VoiceForge</span>
          </div>

          <div>
            <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-brand-400">
              Voice &amp; video platform
            </p>
            <h2 className="mb-6 text-4xl font-bold leading-[1.15] text-white xl:text-5xl">
              Your voice,
              <br />
              <span className="gradient-text">on your own GPU.</span>
            </h2>
            <p className="max-w-md text-[15px] leading-relaxed text-slate-400">
              Long-form narration and presenter video, generated on GPUs you control.
              No subscription, no API key, nothing leaves your session.
            </p>
          </div>

          <p className="text-[12px] text-slate-500">Single admin account · session lasts 12 hours</p>
        </div>
      </div>

      {/* Form */}
      <div className="flex flex-1 items-center justify-center bg-bg px-6 py-12">
        <div className="w-full max-w-sm">
          {/* compact brand for narrow screens */}
          <div className="mb-10 flex items-center gap-2.5 lg:hidden">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-500">
              <IconWave className="h-4 w-4 text-white" />
            </span>
            <span className="font-display text-lg font-bold text-ink">VoiceForge</span>
          </div>
          <Suspense fallback={<div className="text-sm text-muted">Loading…</div>}>
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
