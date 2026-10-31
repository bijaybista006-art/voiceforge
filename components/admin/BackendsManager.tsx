"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "@/lib/toast";
import type { ActiveBackend, BackendProvider, BackendView } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconLink,
  IconRefresh,
  IconServer,
  IconSparkle,
  IconTrash,
} from "@/components/ui/Icons";

interface Payload {
  backends: BackendView[];
  active: ActiveBackend;
  storageConnected: boolean;
  registrationTokenSet: boolean;
  backendSecretSet: boolean;
}

const PROVIDER_LABEL: Record<BackendProvider, string> = {
  modal: "Modal",
  colab: "Google Colab",
  kaggle: "Kaggle",
  custom: "Custom URL",
};

const PROVIDER_BLURB: Record<BackendProvider, string> = {
  modal: "Always available, scales to zero. Auto-deployed from GitHub.",
  colab: "Free T4. Registers itself when you Run All.",
  kaggle: "Free T4, 30h/week. Same notebook as Colab.",
  custom: "Any URL that speaks the backend contract.",
};

const HEALTH_STYLE: Record<BackendView["health"], { dot: string; text: string; label: string }> = {
  online: { dot: "bg-ready", text: "text-ready", label: "Online" },
  busy: { dot: "bg-live", text: "text-live", label: "Busy" },
  offline: { dot: "bg-faint", text: "text-faint", label: "Offline" },
  disabled: { dot: "bg-faint", text: "text-faint", label: "Disabled" },
  // Amber, not green and not grey: it is enabled and will be used, but
  // nothing has ever answered here, so it is a claim rather than a backend.
  unverified: { dot: "bg-live", text: "text-live", label: "Unverified" },
};

/**
 * One-click reopen. Colab's /github/ route loads the notebook straight from
 * this repo, so reconnecting after a session dies is a click plus Run All
 * rather than hunting for the file.
 */
const REPO = "bijaybista006-art/voiceforge";
const NOTEBOOK = "colab/voiceforge_server.ipynb";
const COLAB_URL = `https://colab.research.google.com/github/${REPO}/blob/main/${NOTEBOOK}`;
const KAGGLE_URL = `https://www.kaggle.com/kernels/welcome?src=https://github.com/${REPO}/blob/main/${NOTEBOOK}`;

/**
 * The per-backend feature switches (absent = on). `videoEnabled` is the
 * Presenter switch — its name predates AI video and stored rows keep it.
 */
const FEATURE_SWITCHES = [
  {
    field: "voiceEnabled",
    label: "Voice",
    hint: "Narration (text to speech). Off: voice goes to the next backend in the order.",
  },
  {
    field: "videoEnabled",
    label: "Presenter",
    hint: "Lip-synced presenter clips. Off: presenter clips go to the next backend.",
  },
  {
    field: "clipsEnabled",
    label: "AI video",
    hint: "Wan text-to-video clips. Off: clips go to the next backend, and a notebook skips the ~25 GB install.",
  },
] as const;

function ago(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export function BackendsManager({ appUrl }: { appUrl: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Pasted URLs, per provider — Modal and Custom each have their own field. */
  const [urlDrafts, setUrlDrafts] = useState<Partial<Record<BackendProvider, string>>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/backends", { cache: "no-store" });
      if (res.ok) setData((await res.json()) as Payload);
    } catch {
      /* transient — the poll will retry */
    }
  }, []);

  useEffect(() => {
    void load();
    // A notebook can come online at any moment, so this still polls — but
    // only while the tab is visible, and every 30s rather than 15s. Each
    // refresh is a Redis read against a quota that a background tab can
    // quietly drain.
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id === null) id = setInterval(() => void load(), 30_000);
    };
    const stop = () => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void load();
        start();
      } else {
        stop();
      }
    };
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  async function patch(body: unknown, label: string) {
    setBusy(label);
    try {
      const res = await fetch("/api/admin/backends", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast(json.error ?? "That didn't work.", "error");
        return false;
      }
      await load();
      return true;
    } catch {
      toast("Couldn't reach the server.", "error");
      return false;
    } finally {
      setBusy(null);
    }
  }

  /**
   * Swap this backend's priority with its neighbour's. Working off the
   * displayed order (already sorted by priority) means the two writes can't
   * disagree about what "next" meant.
   */
  async function move(provider: BackendProvider, delta: -1 | 1) {
    if (!data) return;
    const list = data.backends;
    const from = list.findIndex((b) => b.provider === provider);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= list.length) return;

    const reordered = [...list];
    [reordered[from], reordered[to]] = [reordered[to], reordered[from]];

    setBusy("reorder");
    try {
      // Renumber from zero so repeated swaps can't drift into ties.
      for (const [index, b] of reordered.entries()) {
        if (b.priority === index) continue;
        await fetch("/api/admin/backends", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: b.provider, priority: index }),
        });
      }
      await load();
    } catch {
      toast("Couldn't reorder those.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function test(provider: BackendProvider) {
    setBusy(`test-${provider}`);
    try {
      const res = await fetch("/api/admin/backends/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; latencyMs?: number };
      if (json.ok) toast(`${PROVIDER_LABEL[provider]} responded in ${json.latencyMs}ms.`, "success");
      else toast(json.error ?? "No response.", "error");
    } catch {
      toast("Couldn't reach the server.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function forget(provider: BackendProvider) {
    if (!window.confirm(`Forget the ${PROVIDER_LABEL[provider]} backend?`)) return;
    setBusy(`forget-${provider}`);
    try {
      await fetch(`/api/admin/backends?provider=${provider}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (!data) {
    return <div className="glass-card px-5 py-8 text-center text-sm text-muted">Loading…</div>;
  }

  const registered = new Set(data.backends.map((b) => b.provider));
  const missing = (["modal", "colab", "kaggle", "custom"] as BackendProvider[]).filter(
    (p) => !registered.has(p)
  );
  const setupIncomplete = !data.storageConnected || !data.registrationTokenSet;

  return (
    <div className="flex flex-col gap-5">
      {setupIncomplete ? (
        <div className="flex gap-3 rounded-2xl border border-live/30 bg-liveSoft px-5 py-4">
          <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-live" />
          <div className="text-[13px] leading-relaxed text-ink">
            <p className="font-semibold">Finish setup before backends can register</p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-muted">
              {!data.storageConnected ? (
                <li>
                  Add the <strong>Supabase</strong> env vars in Vercel, then
$1redeploy. Registrations are stored there.
                </li>
              ) : null}
              {!data.registrationTokenSet ? (
                <li>
                  Set <code className="font-mono text-[12px]">REGISTRATION_TOKEN</code> in Vercel.
                  It stops strangers pointing your app at their machine.
                </li>
              ) : null}
              {!data.backendSecretSet ? (
                <li>
                  Set <code className="font-mono text-[12px]">BACKEND_SECRET</code> — the shared
                  secret the app sends to your GPU.
                </li>
              ) : null}
            </ul>
          </div>
        </div>
      ) : null}

      {/* active selection */}
      <div className="glass-card overflow-hidden">
        <div className="border-b border-line bg-surface2 px-5 py-3.5">
          <h2 className="text-[13px] font-semibold text-ink">Active backend</h2>
          <p className="mt-0.5 text-[12.5px] text-muted">
            Auto uses the first healthy backend in the order below, and falls back automatically
            when one dies.
          </p>
          {data.backends.length > 1 ? (
            <p className="mt-1.5 text-[12px] text-faint">
              Order:{" "}
              {data.backends.map((b, i) => (
                <span key={b.provider}>
                  {i > 0 ? " → " : ""}
                  <span className={b.enabled ? "text-muted" : "line-through"}>
                    {PROVIDER_LABEL[b.provider]}
                  </span>
                </span>
              ))}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2 px-5 py-4">
          {(["auto", "modal", "colab", "kaggle", "custom"] as ActiveBackend[]).map((opt) => {
            const selected = data.active === opt;
            const label = opt === "auto" ? "Auto" : PROVIDER_LABEL[opt as BackendProvider];
            return (
              <button
                key={opt}
                type="button"
                disabled={busy !== null}
                onClick={() => void patch({ active: opt }, `active-${opt}`)}
                className={`rounded-xl border px-3.5 py-2 text-[13px] font-medium transition-colors disabled:opacity-50 ${
                  selected
                    ? "border-brand-600 bg-brand-50 text-brand-700"
                    : "border-line bg-white text-muted hover:border-lineStrong hover:text-ink"
                }`}
              >
                {selected ? <IconCheck className="mr-1 inline h-3.5 w-3.5" /> : null}
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* registered backends */}
      {data.backends.map((b, i) => {
        const style = HEALTH_STYLE[b.health];
        return (
          <div key={b.provider} className="glass-card overflow-hidden">
            <div className="flex flex-wrap items-start gap-4 px-5 py-4">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
                <IconServer className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[15px] font-semibold text-ink">
                    {PROVIDER_LABEL[b.provider]}
                  </h3>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[11px] font-medium ${style.text}`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
                    {style.label}
                  </span>
                  {data.active === b.provider ? (
                    <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700">
                      active
                    </span>
                  ) : null}
                  <span className="rounded-full bg-surface3 px-2 py-0.5 text-[11px] font-medium text-faint">
                    {data.active === "auto"
                      ? i === 0
                        ? "1st choice"
                        : i === data.backends.length - 1
                          ? "last resort"
                          : `${i + 1}${i === 1 ? "nd" : i === 2 ? "rd" : "th"} choice`
                      : `order ${i + 1}`}
                  </span>
                </div>
                <p className="mt-1 break-all font-mono text-[11.5px] text-faint">{b.url}</p>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
                  {b.gpu ? <span>{b.gpu}</span> : null}
                  {b.models.length ? <span>{b.models.join(", ")}</span> : null}
                  <span className="inline-flex items-center gap-1">
                    <IconClock className="h-3 w-3" />
                    {/*
                      A notebook heartbeats, so time-since-heartbeat is real
                      liveness. A hand-added URL never does, so the only
                      honest figure is when something last answered it.
                    */}
                    {b.selfRegistered === false
                      ? b.secondsSinceReached === null
                        ? "never reached"
                        : `reached ${ago(b.secondsSinceReached)}`
                      : ago(b.secondsSinceHeartbeat)}
                  </span>
                  {b.provider === "modal" && b.gpuSecondsMonth ? (
                    <span>{Math.round(b.gpuSecondsMonth / 60)} GPU-min this month</span>
                  ) : null}
                </div>
                {b.lastReachError ? (
                  <p className="mt-2 text-[12px] text-live">
                    Last attempt failed: {b.lastReachError}
                  </p>
                ) : null}
                {b.selfRegistered === false && b.secondsSinceReached === null ? (
                  <p className="mt-2 text-[12px] text-muted">
                    Nothing has answered at this address yet. Press Test before relying on it —
                    jobs will still be sent here when the notebooks are down.
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {/* Reordering is how you say "only use Modal when the free
                    GPUs are down" — Auto walks this list top to bottom. */}
                <div className="flex items-center overflow-hidden rounded-lg border border-line">
                  <button
                    type="button"
                    disabled={busy !== null || i === 0}
                    onClick={() => void move(b.provider, -1)}
                    aria-label={`Move ${PROVIDER_LABEL[b.provider]} earlier`}
                    title="Try this one earlier"
                    className="grid h-8 w-7 place-items-center text-faint transition-colors hover:bg-surface2 hover:text-ink disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <span className="w-px self-stretch bg-line" />
                  <button
                    type="button"
                    disabled={busy !== null || i === data.backends.length - 1}
                    onClick={() => void move(b.provider, 1)}
                    aria-label={`Move ${PROVIDER_LABEL[b.provider]} later`}
                    title="Try this one later"
                    className="grid h-8 w-7 place-items-center text-faint transition-colors hover:bg-surface2 hover:text-ink disabled:opacity-30"
                  >
                    ↓
                  </button>
                </div>
                <Button size="sm" disabled={busy !== null} onClick={() => void test(b.provider)}>
                  {busy === `test-${b.provider}` ? "Testing…" : "Test"}
                </Button>
                <Button
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void patch({ provider: b.provider, enabled: !b.enabled }, "toggle")}
                >
                  {b.enabled ? "Disable" : "Enable"}
                </Button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void forget(b.provider)}
                  aria-label={`Forget ${PROVIDER_LABEL[b.provider]}`}
                  className="grid h-8 w-8 place-items-center rounded-lg text-faint transition-colors hover:bg-dangerSoft hover:text-danger disabled:opacity-40"
                >
                  <IconTrash className="h-4 w-4" />
                </button>
              </div>
            </div>
            {/* Per-feature switches. Each only keeps this backend out of that
                one kind of work; Disable above still turns the whole backend
                off. Order stays Colab → Kaggle → Modal for every feature. */}
            <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface2/60 px-5 py-2.5">
              <span className="mr-1 text-[11.5px] font-medium uppercase tracking-[0.08em] text-faint">
                Use for
              </span>
              {FEATURE_SWITCHES.map((f) => {
                const on = b[f.field] !== false;
                return (
                  <button
                    key={f.field}
                    type="button"
                    role="switch"
                    aria-checked={on}
                    disabled={busy !== null || !b.enabled}
                    title={f.hint}
                    onClick={() => void patch({ provider: b.provider, [f.field]: !on }, `toggle-${f.field}`)}
                    className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-colors disabled:opacity-40 ${
                      on
                        ? "border-brand-600/30 bg-brand-50 text-brand-700"
                        : "border-line bg-white text-faint line-through decoration-faint/60"
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`h-2 w-2 rounded-full ${on ? "bg-ready" : "border border-faint"}`}
                    />
                    {f.label}
                    <span className="sr-only">{on ? " on" : " off"}</span>
                  </button>
                );
              })}
              {!b.enabled ? (
                <span className="text-[11.5px] text-faint">Enable the backend to change these.</span>
              ) : null}
            </div>
          </div>
        );
      })}

      {/* not-yet-registered providers */}
      {missing.length > 0 ? (
        <div className="glass-card overflow-hidden">
          <div className="border-b border-line bg-surface2 px-5 py-3.5">
            <h2 className="text-[13px] font-semibold text-ink">Not connected yet</h2>
          </div>
          <div className="divide-y divide-line">
            {missing.map((p) => (
              <div key={p} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium text-ink">{PROVIDER_LABEL[p]}</p>
                  <p className="mt-0.5 text-[12.5px] text-muted">{PROVIDER_BLURB[p]}</p>
                </div>
                {/* Modal and Custom take a URL you paste: Modal's is permanent
                    and printed by `modal deploy`, so it never self-registers.
                    Colab and Kaggle do register themselves. */}
                {p === "custom" || p === "modal" ? (
                  <div className="flex w-full gap-2 sm:w-auto">
                    <Input
                      type="url"
                      placeholder={
                        p === "modal" ? "https://…--api.modal.run" : "https://your-backend…"
                      }
                      value={urlDrafts[p] ?? ""}
                      onChange={(e) =>
                        setUrlDrafts((d) => ({ ...d, [p]: e.target.value }))
                      }
                      className="min-w-0 flex-1 font-mono text-xs sm:w-72"
                    />
                    <Button
                      size="sm"
                      disabled={!(urlDrafts[p] ?? "").trim() || busy !== null}
                      onClick={async () => {
                        const url = (urlDrafts[p] ?? "").trim();
                        if (await patch({ provider: p, url }, p)) {
                          setUrlDrafts((d) => ({ ...d, [p]: "" }));
                        }
                      }}
                    >
                      Add
                    </Button>
                  </div>
                ) : (
                  <span className="text-[12px] text-faint">Registers itself — see below</span>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <ConnectInstructions appUrl={appUrl} tokenSet={data.registrationTokenSet} />
    </div>
  );
}

function ConnectInstructions({ appUrl, tokenSet }: { appUrl: string; tokenSet: boolean }) {
  const [copied, setCopied] = useState(false);
  const snippet = `VOICEFORGE_APP_URL = "${appUrl}"\nREGISTRATION_TOKEN = "<your REGISTRATION_TOKEN>"`;

  return (
    <div className="glass-card overflow-hidden">
      <div className="border-b border-line bg-surface2 px-5 py-3.5">
        <h2 className="text-[13px] font-semibold text-ink">Connect Colab or Kaggle</h2>
        <p className="mt-0.5 text-[12.5px] text-muted">
          One Run All — no restart, nothing to copy. The notebook registers its own URL.
        </p>
      </div>
      <ol className="space-y-3 px-5 py-4 text-[13px] leading-relaxed text-muted">
        <li className="flex gap-3">
          <span className="font-mono text-[11px] text-faint">1</span>
          <div className="min-w-0 flex-1">
            <span>
              Open the notebook and turn on a <strong>T4 GPU</strong> (Kaggle: also switch Internet
              on).
            </span>
            <div className="mt-2 flex flex-wrap gap-2">
              <a
                href={COLAB_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-[13px] font-medium text-ink transition-colors hover:border-lineStrong"
              >
                <IconLink className="h-3.5 w-3.5" />
                Open in Colab
              </a>
              <a
                href={KAGGLE_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-[13px] font-medium text-ink transition-colors hover:border-lineStrong"
              >
                <IconLink className="h-3.5 w-3.5" />
                Open in Kaggle
              </a>
            </div>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="font-mono text-[11px] text-faint">2</span>
          <div className="min-w-0 flex-1">
            <span>Paste these two values into Cell 0:</span>
            <div className="mt-2 flex items-start gap-2">
              <pre className="min-w-0 flex-1 overflow-x-auto rounded-xl border border-line bg-surface2 px-3.5 py-2.5 font-mono text-[11.5px] text-ink">
                {snippet}
              </pre>
              <Button
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(snippet);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <IconCheck className="h-3.5 w-3.5" /> : <IconLink className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            {!tokenSet ? (
              <p className="mt-1.5 text-[12px] text-live">
                Set REGISTRATION_TOKEN in Vercel first — registration is rejected without it.
              </p>
            ) : null}
          </div>
        </li>
        <li className="flex gap-3">
          <span className="font-mono text-[11px] text-faint">3</span>
          <span>
            <strong>Run All</strong> — no &ldquo;Restart session&rdquo; needed. Once the models load (a
            few minutes) it appears above as <span className="font-medium text-ready">Online</span>.
            Leave the tab open: the last cell keeps running.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="font-mono text-[11px] text-faint">4</span>
          <span>
            <strong>Next time, reopen your saved copy</strong> instead of clicking the buttons
            above (Colab: <em>File → Save a copy in Drive</em> once; Kaggle keeps it in{" "}
            <em>Your Work</em>). The platform then remembers its access to your secrets, so it stops
            asking. The notebook prints a notice when a newer version is available here.
          </span>
        </li>
      </ol>
      <div className="flex items-center gap-2 border-t border-line bg-surface2 px-5 py-3">
        <IconSparkle className="h-3.5 w-3.5 text-faint" />
        <p className="text-[12px] text-muted">
          This page refreshes itself every 15 seconds.
        </p>
        <IconRefresh className="ml-auto h-3.5 w-3.5 text-faint" />
      </div>
    </div>
  );
}
