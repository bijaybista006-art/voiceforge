"use client";

/**
 * Admin → Backends (UI v2).
 *
 * What the page has to make obvious, in this order:
 *   1. Which GPU is serving requests right now, and whether it's healthy.
 *   2. How routing works: a fixed order, first healthy wins (that is the
 *      server's real rule — see lib/routingView.ts).
 *   3. Each backend: status, GPU, models, usage, on/off switches, Test
 *      connection, Remove (confirmed), and a collapsible Details section.
 *   4. Step-by-step setup for anything not connected yet.
 *   5. The old "Active backend" pin and priority order, kept reachable but
 *      labelled honestly: the server stores them and routing doesn't use them.
 *
 * Every request is what the previous page sent: same endpoints, same methods,
 * same JSON bodies (pinned by e2e/backends.spec.ts).
 */

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { confirmAction } from "@/lib/confirm";
import { notebookLinks, type NotebookLinks } from "@/lib/notebookLinks";
import {
  PROVIDER_LABEL,
  ROUTING_ORDER,
  servingClips,
  servingPresenter,
  servingVoice,
  usableHealth,
} from "@/lib/routingView";
import { toast } from "@/lib/toast";
import type { ActiveBackend, BackendProvider, BackendView } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  IconAlert,
  IconArrowRight,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconClock,
  IconFilmSpark,
  IconLink,
  IconServer,
  IconTrash,
  IconVideo,
  IconWave,
} from "@/components/ui/Icons";
import { CopyBlock, Disclosure, SkeletonCard, StatusBadge, Tooltip } from "@/components/ui/Kit";
import { Toggle } from "@/components/ui/Toggle";

interface Payload {
  backends: BackendView[];
  active: ActiveBackend;
  /** Absent only from a server older than this page. */
  notebooks?: NotebookLinks;
  storageConnected: boolean;
  registrationTokenSet: boolean;
  backendSecretSet: boolean;
}

const FALLBACK_NOTEBOOKS: NotebookLinks = notebookLinks({});

const PROVIDER_BLURB: Record<BackendProvider, string> = {
  colab: "Free T4 GPU. Starts from a notebook and connects itself.",
  kaggle: "Free T4 GPUs, 30 hours a week. Same notebook as Colab.",
  custom: "Any server of your own that speaks the VoiceForge backend contract.",
  modal: "Always available, paid per second, scales to zero. Used last.",
};

/**
 * The per-backend feature switches (absent = on). `videoEnabled` is the
 * Presenter switch — its name predates AI video and stored rows keep it.
 */
const FEATURE_SWITCHES = [
  {
    field: "voiceEnabled",
    label: "Voice",
    hint: "Narration. Off: voice goes to the next backend in the order.",
  },
  {
    field: "videoEnabled",
    label: "Presenter",
    hint: "Lip-synced presenter clips. Off: they go to the next backend.",
  },
  {
    field: "clipsEnabled",
    label: "AI video",
    hint: "Wan clips. Off: they go to the next backend; a notebook skips the 25 GB download.",
  },
] as const;

function ago(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

/** When something last answered — the honest liveness figure for each kind of backend. */
function lastSeen(b: BackendView): string {
  // A notebook heartbeats, so time-since-heartbeat is real liveness. A
  // hand-added URL never does, so the only figure is when it last answered.
  if (b.selfRegistered === false) {
    return b.secondsSinceReached === null ? "never reached" : `last answered ${ago(b.secondsSinceReached)}`;
  }
  return `last heartbeat ${ago(b.secondsSinceHeartbeat)}`;
}

export function BackendsManager({ appUrl }: { appUrl: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /** Pasted URLs, per provider — Modal and Custom each have their own field. */
  const [urlDrafts, setUrlDrafts] = useState<Partial<Record<BackendProvider, string>>>({});
  /** The last Test result per backend, shown on its card. */
  const [tests, setTests] = useState<Partial<Record<BackendProvider, { ok: boolean; text: string }>>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/backends", { cache: "no-store" });
      if (res.ok) {
        setData((await res.json()) as Payload);
        setFailed(false);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true); /* transient — the poll retries */
    }
  }, []);

  useEffect(() => {
    void load();
    // A notebook can come online at any moment, so this polls — but only
    // while the tab is visible, every 30 s (each refresh is a storage read).
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

  async function patch(body: unknown, label: string, success?: string) {
    setBusy(label);
    try {
      const res = await fetch("/api/admin/backends", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast(json.error ?? "That didn't work. Try again in a moment.", "error");
        return false;
      }
      if (success) toast(success, "success");
      await load();
      return true;
    } catch {
      toast("Couldn't reach the server. Check your connection and try again.", "error");
      return false;
    } finally {
      setBusy(null);
    }
  }

  /**
   * Swap this backend's stored priority with its neighbour's. Same requests
   * as the previous page, but routing does not read priority — see "Saved
   * preferences".
   */
  async function move(provider: BackendProvider, delta: -1 | 1) {
    if (!data) return;
    const list = [...data.backends].sort((a, b) => a.priority - b.priority);
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
      toast("Couldn't save that order. Try again.", "error");
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
      if (json.ok) {
        setTests((t) => ({ ...t, [provider]: { ok: true, text: `Responded in ${json.latencyMs} ms.` } }));
        toast(`${PROVIDER_LABEL[provider]} responded in ${json.latencyMs} ms.`, "success");
      } else {
        const text = json.error ?? "No response.";
        setTests((t) => ({ ...t, [provider]: { ok: false, text } }));
        toast(text, "error");
      }
      await load();
    } catch {
      toast("Couldn't reach the server. Check your connection and try again.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function forget(provider: BackendProvider) {
    const ok = await confirmAction({
      title: `Remove ${PROVIDER_LABEL[provider]}?`,
      body:
        provider === "colab" || provider === "kaggle"
          ? "It disappears from this list. A notebook that is still running adds itself back at its next heartbeat, so stop the notebook first to remove it for good."
          : "Its address and settings are deleted and requests stop going there. You can add it again at any time.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setBusy(`forget-${provider}`);
    try {
      await fetch(`/api/admin/backends?provider=${provider}`, { method: "DELETE" });
      toast(`${PROVIDER_LABEL[provider]} removed.`, "success");
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (!data) {
    return failed ? (
      <div className="glass-card flex items-start gap-3 px-5 py-5 text-[13.5px] text-ink">
        <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
        <div>
          <p className="font-semibold">Couldn&apos;t load your backends.</p>
          <p className="mt-0.5 text-muted">Check that you&apos;re signed in, then reload the page.</p>
        </div>
      </div>
    ) : (
      <div className="grid gap-4">
        <SkeletonCard lines={2} />
        <SkeletonCard lines={4} />
        <SkeletonCard lines={4} />
      </div>
    );
  }

  const registered = new Set(data.backends.map((b) => b.provider));
  const missing = ROUTING_ORDER.filter((p) => !registered.has(p));
  const setupIncomplete = !data.storageConnected || !data.registrationTokenSet || !data.backendSecretSet;
  const notebooks = data.notebooks ?? FALLBACK_NOTEBOOKS;
  const voice = servingVoice(data.backends);

  return (
    <div className="flex flex-col gap-6">
      {setupIncomplete ? (
        <div className="flex gap-3 rounded-2xl border border-live/30 bg-liveSoft px-5 py-4">
          <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-live" />
          <div className="text-[13px] leading-relaxed text-ink">
            <p className="font-semibold">Finish setup before backends can connect</p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-muted">
              {!data.storageConnected ? (
                <li>
                  Add the <strong>Supabase</strong> settings in Vercel, then redeploy. Connected backends are
                  stored there.
                </li>
              ) : null}
              {!data.registrationTokenSet ? (
                <li>
                  Set <code className="font-mono text-[12px]">REGISTRATION_TOKEN</code> in Vercel. It stops
                  strangers pointing your app at their machine.
                </li>
              ) : null}
              {!data.backendSecretSet ? (
                <li>
                  Set <code className="font-mono text-[12px]">BACKEND_SECRET</code>: the shared password the
                  app sends to your GPU.
                </li>
              ) : null}
            </ul>
          </div>
        </div>
      ) : null}

      <ServingNow backends={data.backends} />

      <RoutingExplainer backends={data.backends} servingProvider={voice?.provider ?? null} />

      {/* ---------- connected backends ---------- */}
      <section aria-labelledby="connected-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="connected-heading" className="font-display text-[17px] font-semibold text-ink">
            Connected backends
          </h2>
          <span className="text-[12.5px] text-muted">Refreshes every 30 seconds</span>
        </div>
        {data.backends.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-lineStrong px-6 py-8 text-center">
            <p className="text-[14px] font-semibold text-ink">No backends connected yet</p>
            <p className="mx-auto mt-1 max-w-md text-[13px] text-muted">
              Start a free Colab or Kaggle notebook, or add Modal. Step-by-step instructions are below.
            </p>
          </div>
        ) : (
          data.backends.map((b) => (
            <BackendCard
              key={b.provider}
              b={b}
              serving={voice?.provider === b.provider}
              busy={busy}
              testing={busy === `test-${b.provider}`}
              lastTest={tests[b.provider]}
              notebooks={notebooks}
              onToggleEnabled={() =>
                void patch(
                  { provider: b.provider, enabled: !b.enabled },
                  "toggle",
                  `${PROVIDER_LABEL[b.provider]} ${b.enabled ? "disabled" : "enabled"}.`
                )
              }
              onToggleFeature={(field, on) => void patch({ provider: b.provider, [field]: !on }, `toggle-${field}`)}
              onTest={() => void test(b.provider)}
              onRemove={() => void forget(b.provider)}
            />
          ))
        )}
      </section>

      {/* ---------- not connected ---------- */}
      {missing.length > 0 ? (
        <section aria-labelledby="add-heading" className="flex flex-col gap-4">
          <h2 id="add-heading" className="font-display text-[17px] font-semibold text-ink">
            Add a backend
          </h2>
          <div className="grid gap-4 xl:grid-cols-2">
            {missing.map((p) => (
              <SetupCard
                key={p}
                provider={p}
                appUrl={appUrl}
                tokenSet={data.registrationTokenSet}
                notebooks={notebooks}
                draft={urlDrafts[p] ?? ""}
                onDraft={(v) => setUrlDrafts((d) => ({ ...d, [p]: v }))}
                busy={busy}
                onAdd={async () => {
                  const url = (urlDrafts[p] ?? "").trim();
                  if (await patch({ provider: p, url }, p, `${PROVIDER_LABEL[p]} added.`)) {
                    setUrlDrafts((d) => ({ ...d, [p]: "" }));
                  }
                }}
              />
            ))}
          </div>
        </section>
      ) : null}

      {/* Always reachable: reconnecting a notebook after its session ends. */}
      {registered.has("colab") || registered.has("kaggle") ? (
        <Disclosure
          title="Restart a Colab or Kaggle notebook"
          hint="Free notebooks stop after a few hours. Open yours again and press Run All."
        >
          <NotebookSteps appUrl={appUrl} tokenSet={data.registrationTokenSet} notebooks={notebooks} />
        </Disclosure>
      ) : null}

      <LegacyPreferences
        data={data}
        busy={busy}
        onPin={(opt) => void patch({ active: opt }, `active-${opt}`)}
        onMove={(p, d) => void move(p, d)}
      />
    </div>
  );
}

// --- serving now -------------------------------------------------------------

function ServingNow({ backends }: { backends: BackendView[] }) {
  const voice = servingVoice(backends);
  const presenter = servingPresenter(backends);
  const clips = servingClips(backends);

  return (
    <section
      aria-labelledby="serving-heading"
      data-testid="serving-now"
      className={`overflow-hidden rounded-2xl border bg-surface shadow-card ${
        voice ? "border-ready/30" : "border-live/40"
      }`}
    >
      <div className="flex flex-wrap items-center gap-4 px-5 py-5 sm:px-6">
        <span
          className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl ${
            voice ? "bg-readySoft text-ready" : "bg-liveSoft text-live"
          }`}
        >
          <IconServer className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <p id="serving-heading" className="text-[11px] font-semibold uppercase tracking-[0.13em] text-faint">
            Serving requests now
          </p>
          {voice ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <p className="font-display text-[22px] font-bold leading-tight text-ink">
                {PROVIDER_LABEL[voice.provider]}
              </p>
              <StatusBadge kind={voice.health} />
              {voice.gpu ? <span className="font-mono text-[12px] text-muted">{voice.gpu}</span> : null}
            </div>
          ) : (
            <>
              <p className="mt-1 font-display text-[22px] font-bold leading-tight text-ink">No GPU is serving</p>
              <p className="mt-1 text-[13px] text-muted">
                Nothing is online, so new narration can&apos;t start. Start a notebook or add Modal below.
              </p>
            </>
          )}
        </div>
      </div>
      <dl className="grid border-t border-line bg-surface2/60 sm:grid-cols-3">
        {(
          [
            ["Voice", IconWave, voice],
            ["Presenter video", IconVideo, presenter],
            ["AI video", IconFilmSpark, clips],
          ] as const
        ).map(([label, Icon, b]) => (
          <div key={label} className="flex items-center gap-2.5 border-line px-5 py-3 sm:border-r sm:px-6 sm:last:border-r-0">
            <Icon className="h-4 w-4 shrink-0 text-faint" />
            <dt className="text-[12.5px] text-muted">{label}</dt>
            <dd className="ml-auto truncate text-[13px] font-semibold text-ink">
              {b ? PROVIDER_LABEL[b.provider] : <span className="font-medium text-faint">Not available</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// --- routing -----------------------------------------------------------------

function RoutingExplainer({
  backends,
  servingProvider,
}: {
  backends: BackendView[];
  servingProvider: BackendProvider | null;
}) {
  const byProvider = new Map(backends.map((b) => [b.provider, b]));
  return (
    <section aria-labelledby="routing-heading" className="glass-card px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="routing-heading" className="text-[14px] font-semibold text-ink">
          How requests are routed
        </h2>
        <span className="rounded-md bg-brand-50 px-1.5 py-0.5 text-[11px] font-semibold text-brand-700">Auto</span>
      </div>
      <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted">
        Auto means every request goes to the first backend in this order that is online and has that feature
        switched on. Free GPUs come first; Modal (paid) is only used when the others can&apos;t take the job.
      </p>
      <ol className="mt-3 flex flex-wrap items-center gap-2" aria-label="Routing order">
        {ROUTING_ORDER.map((p, i) => {
          const b = byProvider.get(p);
          const on = b ? usableHealth(b.health) : false;
          return (
            <li key={p} className="flex items-center gap-2">
              {i > 0 ? <IconArrowRight className="h-3.5 w-3.5 text-faint" /> : null}
              <span
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12.5px] font-medium ${
                  servingProvider === p
                    ? "border-ready/40 bg-readySoft text-ink"
                    : b
                      ? "border-line bg-surface2 text-ink"
                      : "border-dashed border-line text-faint"
                }`}
              >
                <span className="font-mono text-[11px] text-faint">{i + 1}</span>
                {PROVIDER_LABEL[p]}
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 rounded-full ${on ? "bg-ready" : b ? "bg-faint" : "border border-faint"}`}
                />
                <span className="visually-hidden">{b ? (on ? "online" : "offline") : "not connected"}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// --- one backend -------------------------------------------------------------

function BackendCard({
  b,
  serving,
  busy,
  testing,
  lastTest,
  notebooks,
  onToggleEnabled,
  onToggleFeature,
  onTest,
  onRemove,
}: {
  b: BackendView;
  serving: boolean;
  busy: string | null;
  testing: boolean;
  lastTest?: { ok: boolean; text: string };
  notebooks: NotebookLinks;
  onToggleEnabled(): void;
  onToggleFeature(field: (typeof FEATURE_SWITCHES)[number]["field"], on: boolean): void;
  onTest(): void;
  onRemove(): void;
}) {
  const label = PROVIDER_LABEL[b.provider];
  const notebookUrl =
    b.provider === "colab" ? notebooks.colab.mine : b.provider === "kaggle" ? notebooks.kaggle.mine : null;
  const minutes = b.gpuSecondsMonth ? Math.round(b.gpuSecondsMonth / 60) : 0;

  return (
    <article
      data-testid={`backend-${b.provider}`}
      aria-label={label}
      className={`glass-card overflow-hidden ${serving ? "ring-1 ring-ready/40" : ""}`}
    >
      <div className="flex flex-wrap items-start gap-4 px-5 py-5 sm:px-6">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
          <IconServer className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-[16px] font-semibold text-ink">{label}</h3>
            <StatusBadge kind={testing ? "testing" : b.health} />
            {serving ? (
              <span className="rounded-full bg-readySoft px-2 py-0.5 text-[11px] font-semibold text-ready">
                Serving now
              </span>
            ) : null}
          </div>
          <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-muted">
            <div className="flex gap-1.5">
              <dt className="text-faint">GPU</dt>
              <dd className="text-ink">{b.gpu || "not reported"}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-faint">Models</dt>
              <dd className="text-ink">{b.models.length ? b.models.join(", ") : "none loaded"}</dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt className="flex items-center gap-1 text-faint">
                This month
                <Tooltip text="GPU minutes VoiceForge has used on this backend this month. Paid backends bill for this time." />
              </dt>
              <dd className="text-ink [font-variant-numeric:tabular-nums]">{minutes} GPU-min</dd>
            </div>
            <div className="flex items-center gap-1 text-faint">
              <IconClock className="h-3 w-3" />
              <span>{lastSeen(b)}</span>
            </div>
            {b.system?.diskFreeGb !== undefined ? (
              <div className="flex gap-1.5" data-testid="disk-free">
                <dt className="text-faint">Disk</dt>
                <dd className={b.system.diskFreeGb < 15 ? "font-medium text-danger" : "text-ink"}>
                  {Math.round(b.system.diskFreeGb)} GB free
                  {b.system.diskTotalGb ? ` of ${Math.round(b.system.diskTotalGb)}` : ""}
                </dd>
              </div>
            ) : null}
            {b.system?.gpus?.length ? (
              <div className="flex gap-1.5" data-testid="gpu-memory">
                <dt className="flex items-center gap-1 text-faint">
                  GPU memory
                  <Tooltip text="In use right now, per GPU, from the notebook's last heartbeat. The voice model keeps about 3 GB loaded." />
                </dt>
                <dd className="text-ink [font-variant-numeric:tabular-nums]">
                  {b.system.gpus
                    .map((g) => `${(g.usedMb / 1024).toFixed(1)} / ${(g.totalMb / 1024).toFixed(0)} GB`)
                    .join(" · ")}
                </dd>
              </div>
            ) : null}
          </dl>
          {lastTest ? (
            <p className={`mt-2 text-[12.5px] ${lastTest.ok ? "text-ready" : "text-danger"}`}>
              {lastTest.ok ? "Test passed. " : "Test failed. "}
              <span className="text-muted">{lastTest.text}</span>
            </p>
          ) : null}
          {b.wanNote && b.clipsEnabled !== false && b.enabled ? (
            <p
              data-testid="wan-note"
              className={`mt-2 text-[12.5px] ${/still installing/i.test(b.wanNote) ? "text-live" : "text-danger"}`}
            >
              AI video: {b.wanNote.replace(/^it is /, "")}
            </p>
          ) : null}
          {!lastTest && b.lastReachError ? (
            <p className="mt-2 text-[12.5px] text-live">Last attempt failed: {b.lastReachError}</p>
          ) : null}
          {b.selfRegistered === false && b.secondsSinceReached === null ? (
            <p className="mt-2 text-[12.5px] text-muted">
              Nothing has answered at this address yet. Test the connection before relying on it.
            </p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto">
          {notebookUrl ? (
            <a
              href={notebookUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-ink transition-colors hover:border-lineStrong"
            >
              <IconLink className="h-3.5 w-3.5" />
              Open notebook
            </a>
          ) : null}
          <Button size="sm" disabled={busy !== null} onClick={onTest}>
            {testing ? "Testing…" : "Test connection"}
          </Button>
          <Button size="sm" variant="danger" disabled={busy !== null} onClick={onRemove} aria-label={`Remove ${label}`}>
            <IconTrash className="h-3.5 w-3.5" />
            Remove
          </Button>
        </div>
      </div>

      <div className="grid gap-4 border-t border-line bg-surface2/60 px-5 py-4 sm:grid-cols-2 sm:px-6 xl:grid-cols-4">
        <Toggle
          checked={b.enabled}
          onChange={onToggleEnabled}
          disabled={busy !== null}
          label="Enabled"
          description={b.enabled ? "Can receive work." : "Turned off: gets no work at all."}
        />
        {FEATURE_SWITCHES.map((f) => {
          const on = b[f.field] !== false;
          return (
            <Toggle
              key={f.field}
              checked={on}
              onChange={() => onToggleFeature(f.field, on)}
              disabled={busy !== null || !b.enabled}
              label={f.label}
              description={f.hint}
            />
          );
        })}
      </div>

      <div className="border-t border-line px-2 py-1 sm:px-3">
        <Disclosure title="Details" hint="Addresses, connection type and technical notes" className="border-0 bg-transparent">
          <dl className="grid gap-x-6 gap-y-3 text-[12.5px] sm:grid-cols-[160px_minmax(0,1fr)]">
            <dt className="text-faint">Address</dt>
            <dd className="break-all font-mono text-ink">{b.url}</dd>
            <dt className="text-faint">How it connects</dt>
            <dd className="text-ink">
              {b.selfRegistered === false ? "Added by hand (no heartbeat)" : "Connects itself and sends a heartbeat"}
            </dd>
            {b.presenterUrl ? (
              <>
                <dt className="text-faint">Presenter address</dt>
                <dd className="break-all font-mono text-ink">{b.presenterUrl}</dd>
              </>
            ) : null}
            {b.presenterNote ? (
              <>
                <dt className="text-faint">Presenter note</dt>
                <dd className="text-ink">{b.presenterNote}</dd>
              </>
            ) : null}
            {b.wanUrl ? (
              <>
                <dt className="text-faint">AI video address</dt>
                <dd className="break-all font-mono text-ink">{b.wanUrl}</dd>
              </>
            ) : null}
            {b.wanNote ? (
              <>
                <dt className="text-faint">AI video note</dt>
                <dd className="text-ink">{b.wanNote}</dd>
              </>
            ) : null}
            {b.version ? (
              <>
                <dt className="text-faint">Server version</dt>
                <dd className="font-mono text-ink">{b.version}</dd>
              </>
            ) : null}
            <dt className="text-faint">Capabilities</dt>
            <dd className="text-ink">
              {[...(b.capabilities ?? []), ...(b.presenterCapabilities ?? []), ...(b.wanCapabilities ?? [])].join(", ") ||
                "none reported"}
            </dd>
          </dl>
        </Disclosure>
      </div>
    </article>
  );
}

// --- setup (not connected) ----------------------------------------------------

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-50 font-mono text-[11.5px] font-semibold text-brand-700">
        {n}
      </span>
      <div className="min-w-0 flex-1 text-[13px] leading-relaxed text-muted">{children}</div>
    </li>
  );
}

const PRIMARY_LINK =
  "inline-flex h-9 items-center gap-1.5 rounded-xl bg-brand-600 px-4 text-[13px] font-semibold text-white transition-colors hover:bg-[rgb(29_78_216)]";
const QUIET_LINK = "font-medium text-brand-700 underline underline-offset-2";

function SetupCard({
  provider,
  appUrl,
  tokenSet,
  notebooks,
  draft,
  onDraft,
  busy,
  onAdd,
}: {
  provider: BackendProvider;
  appUrl: string;
  tokenSet: boolean;
  notebooks: NotebookLinks;
  draft: string;
  onDraft(v: string): void;
  busy: string | null;
  onAdd(): void;
}) {
  const label = PROVIDER_LABEL[provider];
  const inputId = `add-url-${provider}`;
  return (
    <article
      data-testid={`setup-${provider}`}
      aria-label={`Set up ${label}`}
      className="flex min-w-0 flex-col rounded-2xl border border-dashed border-lineStrong bg-surface/60 p-5"
    >
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-surface3 text-muted">
          <IconServer className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-[15px] font-semibold text-ink">{label}</h3>
          <p className="mt-0.5 text-[12.5px] text-muted">{PROVIDER_BLURB[provider]}</p>
        </div>
        <StatusBadge kind="offline" label="Not connected" />
      </div>

      <ol className="mt-4 flex flex-col gap-3">
        {provider === "colab" || provider === "kaggle" ? (
          <NotebookStepsList provider={provider} appUrl={appUrl} tokenSet={tokenSet} notebooks={notebooks} />
        ) : (
          <>
            <Step n={1}>
              {provider === "modal" ? (
                <>
                  Deploy the backend. A push to <code className="font-mono text-[12px]">main</code> does it
                  automatically, or run this once:
                  <div className="mt-2">
                    <CopyBlock value="modal deploy modal/voiceforge_modal.py" />
                  </div>
                </>
              ) : (
                <>Run any server that speaks the VoiceForge backend contract, reachable over https.</>
              )}
            </Step>
            <Step n={2}>
              <label htmlFor={inputId}>
                Paste its address{provider === "modal" ? " (the one ending in -api.modal.run)" : ""}:
              </label>
              <div className="mt-2 flex flex-wrap gap-2">
                <Input
                  id={inputId}
                  type="url"
                  placeholder={provider === "modal" ? "https://…--voiceforge-api.modal.run" : "https://your-backend…"}
                  value={draft}
                  onChange={(e) => onDraft(e.target.value)}
                  className="min-w-0 flex-1 font-mono text-xs"
                />
                <Button variant="primary" disabled={!draft.trim() || busy !== null} onClick={onAdd}>
                  Add {label}
                </Button>
              </div>
            </Step>
            <Step n={3}>Press Test connection on its card to check that it answers.</Step>
          </>
        )}
      </ol>
    </article>
  );
}

function NotebookStepsList({
  provider,
  appUrl,
  tokenSet,
  notebooks,
}: {
  provider: "colab" | "kaggle";
  appUrl: string;
  tokenSet: boolean;
  notebooks: NotebookLinks;
}) {
  const mine = provider === "colab" ? notebooks.colab.mine : notebooks.kaggle.mine;
  const fresh = provider === "colab" ? notebooks.colab.fresh : notebooks.kaggle.fresh;
  const name = provider === "colab" ? "Colab" : "Kaggle";
  const snippet = `VOICEFORGE_APP_URL = "${appUrl}"\nREGISTRATION_TOKEN = "<your REGISTRATION_TOKEN>"`;
  return (
    <>
      <Step n={1}>
        Open the notebook{provider === "kaggle" ? " and set GPU T4 x2 and Internet on" : " with a T4 GPU"}.
        <div className="mt-2 flex flex-wrap gap-2">
          <a href={mine ?? fresh} target="_blank" rel="noreferrer" className={PRIMARY_LINK}>
            <IconLink className="h-3.5 w-3.5" />
            {mine ? `Open my ${name} notebook` : `Open in ${name}`}
          </a>
        </div>
        <p className="mt-1.5 text-[12px]">
          {mine ? (
            <>
              Your saved copy, from{" "}
              <Link href="/admin/settings" className={QUIET_LINK}>
                Settings
              </Link>
              . Take a{" "}
              <a href={fresh} target="_blank" rel="noreferrer" className={QUIET_LINK}>
                fresh copy
              </a>{" "}
              only when the notebook says a newer one exists.
            </>
          ) : (
            <>
              Then save it ({provider === "colab" ? "File → Save a copy in Drive" : "Save Version → Quick Save"}) and
              paste its address into{" "}
              <Link href="/admin/settings" className={QUIET_LINK}>
                Settings
              </Link>{" "}
              to open it in one click next time.
            </>
          )}
        </p>
      </Step>
      <Step n={2}>
        First time only: store these as{" "}
        {provider === "colab" ? "Colab secrets (key icon, Notebook access on)" : "Kaggle secrets (Add-ons → Secrets, ticked)"}
        , together with <code className="font-mono text-[12px]">BACKEND_SECRET</code>.
        <div className="mt-2">
          <CopyBlock value={snippet} />
        </div>
        {!tokenSet ? (
          <p className="mt-1.5 text-[12px] text-live">
            Set REGISTRATION_TOKEN in Vercel first: connections are refused without it.
          </p>
        ) : null}
      </Step>
      <Step n={3}>
        Press <strong className="text-ink">Run All</strong>. No restart needed. After a few minutes it shows up above
        as Online.
      </Step>
    </>
  );
}

function NotebookSteps({ appUrl, tokenSet, notebooks }: { appUrl: string; tokenSet: boolean; notebooks: NotebookLinks }) {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      {(["colab", "kaggle"] as const).map((p) => (
        <div key={p} className="min-w-0">
          <p className="mb-3 text-[13px] font-semibold text-ink">{PROVIDER_LABEL[p]}</p>
          <ol className="flex flex-col gap-3">
            <NotebookStepsList provider={p} appUrl={appUrl} tokenSet={tokenSet} notebooks={notebooks} />
          </ol>
        </div>
      ))}
    </div>
  );
}

// --- legacy preferences --------------------------------------------------------

function LegacyPreferences({
  data,
  busy,
  onPin,
  onMove,
}: {
  data: Payload;
  busy: string | null;
  onPin(opt: ActiveBackend): void;
  onMove(provider: BackendProvider, delta: -1 | 1): void;
}) {
  const byPriority = [...data.backends].sort((a, b) => a.priority - b.priority);
  return (
    <Disclosure
      id="saved-preferences"
      title="Saved preferences (don't change routing)"
      hint="A pinned backend and a priority order from earlier versions, kept for your records."
    >
      <div className="flex flex-col gap-5">
        <p className="flex gap-2 rounded-xl bg-brand-50 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink">
          <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-brand-700" />
          Routing always follows the order above: the first healthy backend wins. Both settings below are still
          saved when you change them, but nothing that routes requests reads them.
        </p>

        <div>
          <p className="mb-2 text-[13px] font-semibold text-ink">Pinned backend</p>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Pinned backend">
            {(["auto", ...ROUTING_ORDER] as ActiveBackend[]).map((opt) => {
              const selected = data.active === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={busy !== null}
                  onClick={() => onPin(opt)}
                  className={`inline-flex items-center gap-1 rounded-xl border px-3 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-50 ${
                    selected
                      ? "border-brand-600 bg-brand-50 text-brand-700"
                      : "border-line bg-surface text-muted hover:border-lineStrong hover:text-ink"
                  }`}
                >
                  {selected ? <IconCheck className="h-3.5 w-3.5" /> : null}
                  {opt === "auto" ? "Auto" : PROVIDER_LABEL[opt as BackendProvider]}
                </button>
              );
            })}
          </div>
        </div>

        {byPriority.length > 1 ? (
          <div>
            <p className="mb-2 text-[13px] font-semibold text-ink">Priority order</p>
            <ol className="flex flex-col gap-2">
              {byPriority.map((b, i) => (
                <li key={b.provider} className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
                  <span className="font-mono text-[12px] text-faint">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                    {PROVIDER_LABEL[b.provider]}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null || i === 0}
                    onClick={() => onMove(b.provider, -1)}
                    aria-label={`Move ${PROVIDER_LABEL[b.provider]} up`}
                  >
                    <IconChevronUp className="h-3.5 w-3.5" />
                    Move up
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null || i === byPriority.length - 1}
                    onClick={() => onMove(b.provider, 1)}
                    aria-label={`Move ${PROVIDER_LABEL[b.provider]} down`}
                  >
                    <IconChevronDown className="h-3.5 w-3.5" />
                    Move down
                  </Button>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    </Disclosure>
  );
}
