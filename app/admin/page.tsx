import Link from "next/link";
import { AdminPage } from "@/components/admin/AdminShell";
import {
  IconAlert,
  IconArrowRight,
  IconCheck,
  IconFilmSpark,
  IconKey,
  IconMic,
  IconScript,
  IconServer,
  IconSettings,
  IconSparkle,
  IconVideo,
  IconWave,
} from "@/components/ui/Icons";
import { StatusBadge, Stat } from "@/components/ui/Kit";
import { JOB_KIND_LABEL, formatSeconds, jobKind, timeAgo } from "@/lib/jobView";
import { PROVIDER_LABEL, servingClips, servingPresenter, servingVoice, usableHealth } from "@/lib/routingView";
import { isAuthConfigured } from "@/lib/server/auth";
import { listBackends } from "@/lib/server/backends";
import { listJobs } from "@/lib/server/jobs";
import { listPresenters } from "@/lib/server/presenters";
import { isRedisConfigured } from "@/lib/server/redis";
import { listVoices } from "@/lib/server/voices";

export const dynamic = "force-dynamic";

/**
 * Admin dashboard: what's serving and how healthy it is, what ran recently,
 * GPU time this month, the libraries, and the way into every admin page.
 * Read-only server reads; nothing here changes state.
 */

function SetupRow({ ok, title, detail, how }: { ok: boolean; title: string; detail: string; how: string }) {
  return (
    <li className="flex gap-3.5 border-b border-line px-5 py-4 last:border-0">
      <span
        className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full ${
          ok ? "bg-readySoft text-ready" : "bg-liveSoft text-live"
        }`}
      >
        {ok ? <IconCheck className="h-3.5 w-3.5" /> : <IconAlert className="h-3.5 w-3.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold text-ink">
          {title}{" "}
          <span className={`ml-1 text-[12px] font-medium ${ok ? "text-ready" : "text-live"}`}>
            {ok ? "connected" : "not set up"}
          </span>
        </p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{detail}</p>
        {!ok ? <p className="mt-1.5 text-[12.5px] leading-relaxed text-faint [overflow-wrap:anywhere]">{how}</p> : null}
      </div>
    </li>
  );
}

const QUICK_LINKS = [
  { href: "/admin/backends", label: "Backends", detail: "GPUs, routing and setup", Icon: IconServer },
  { href: "/admin/voices", label: "Voices", detail: "Your voice library", Icon: IconMic },
  { href: "/admin/presenters", label: "Presenters", detail: "Faces for presenter clips", Icon: IconVideo },
  { href: "/admin/training", label: "Training data", detail: "Clips for fine-tuning", Icon: IconWave },
  { href: "/admin/keys", label: "API Keys", detail: "For n8n and scripts", Icon: IconKey },
  { href: "/admin/jobs", label: "Jobs", detail: "Every render and its result", Icon: IconSparkle },
  { href: "/admin/api", label: "API & n8n", detail: "Copy-ready examples", Icon: IconScript },
  { href: "/admin/settings", label: "Settings", detail: "Defaults and notebooks", Icon: IconSettings },
];

export default async function AdminDashboard() {
  const auth = isAuthConfigured();
  const storage = isRedisConfigured();
  const remaining = [auth, storage].filter((x) => !x).length;

  const [backends, voices, presenters, jobs] = await Promise.all([
    listBackends(),
    listVoices(),
    listPresenters(),
    listJobs(8),
  ]);
  const voice = servingVoice(backends);
  const presenter = servingPresenter(backends);
  const clips = servingClips(backends);
  const online = backends.filter((b) => usableHealth(b.health) && b.health !== "unverified");
  const gpuMinutes = Math.round(backends.reduce((sum, b) => sum + (b.gpuSecondsMonth ?? 0), 0) / 60);
  const defaultVoice = voices.find((v) => v.isDefault);

  return (
    <AdminPage title="Dashboard" description="What's running right now, what ran recently, and what's left to set up." wide>
      {/* ---------- serving ---------- */}
      <section
        aria-labelledby="dash-serving"
        className={`mb-6 overflow-hidden rounded-2xl border bg-surface shadow-card ${voice ? "border-ready/30" : "border-live/40"}`}
      >
        <div className="flex flex-wrap items-center gap-4 px-5 py-5 sm:px-6">
          <span
            className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl ${voice ? "bg-readySoft text-ready" : "bg-liveSoft text-live"}`}
          >
            <IconServer className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <p id="dash-serving" className="text-[11px] font-semibold uppercase tracking-[0.13em] text-faint">
              Active GPU
            </p>
            {voice ? (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <p className="font-display text-[22px] font-bold leading-tight text-ink">{PROVIDER_LABEL[voice.provider]}</p>
                <StatusBadge kind={voice.health} />
                {voice.gpu ? <span className="font-mono text-[12px] text-muted">{voice.gpu}</span> : null}
              </div>
            ) : (
              <p className="mt-1 font-display text-[22px] font-bold leading-tight text-ink">No GPU is serving</p>
            )}
            <p className="mt-1 text-[13px] text-muted">
              Presenter clips: {presenter ? PROVIDER_LABEL[presenter.provider] : "not available"} · AI video:{" "}
              {clips ? PROVIDER_LABEL[clips.provider] : "not available"}
            </p>
          </div>
          <Link
            href="/admin/backends"
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-line bg-surface px-3.5 text-[13px] font-semibold text-ink transition-colors hover:border-lineStrong"
          >
            Manage backends
            <IconArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </section>

      {/* ---------- numbers ---------- */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="GPU minutes this month"
          value={gpuMinutes.toLocaleString()}
          detail="across all backends"
          tooltip="Time VoiceForge kept a GPU busy this month, added up over every backend. Modal bills for its share."
        />
        <Stat
          label="Backends online"
          value={`${online.length} of ${backends.length}`}
          detail={online.length ? online.map((b) => PROVIDER_LABEL[b.provider]).join(", ") : "nothing is running"}
        />
        <Stat label="Voices" value={voices.length} detail={defaultVoice ? `Default: ${defaultVoice.name}` : "no default set"} />
        <Stat
          label="Presenters"
          value={presenters.length}
          detail={presenters.find((p) => p.isDefault)?.name ?? "none yet"}
        />
      </div>

      <div className="mb-6 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* ---------- recent jobs ---------- */}
        <section aria-labelledby="dash-jobs" className="glass-card overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
            <h2 id="dash-jobs" className="text-[14px] font-semibold text-ink">
              Recent jobs
            </h2>
            <Link href="/admin/jobs" className="text-[13px] font-medium text-brand-700 hover:underline">
              All jobs
            </Link>
          </div>
          {jobs.length === 0 ? (
            <p className="px-5 py-8 text-center text-[13px] text-muted">
              Nothing has run yet. Jobs from the studio and the API appear here.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {jobs.map((j) => {
                const kind = jobKind(j.kind);
                const Icon = kind === "clip" ? IconFilmSpark : kind === "presenter" || kind === "video" ? IconVideo : IconWave;
                const length = formatSeconds(j.duration);
                return (
                  <li key={j.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface3 text-muted">
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-medium text-ink">{JOB_KIND_LABEL[kind]}</p>
                      <p className="truncate text-[12px] text-muted">
                        {timeAgo(j.createdAt)}
                        {j.backend ? ` · ${PROVIDER_LABEL[j.backend]}` : ""}
                        {length ? ` · ${length}` : ""}
                        {j.source && j.source !== "studio" ? " · API" : ""}
                      </p>
                    </div>
                    <StatusBadge kind={j.status} title={j.error} />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* ---------- setup ---------- */}
        <section aria-labelledby="dash-setup" className="glass-card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-line px-5 py-3.5">
            <h2 id="dash-setup" className="text-[14px] font-semibold text-ink">
              Setup
            </h2>
            {remaining > 0 ? (
              <span className="rounded-full bg-liveSoft px-2 py-0.5 text-[11px] font-semibold text-live">
                {remaining} remaining
              </span>
            ) : (
              <span className="rounded-full bg-readySoft px-2 py-0.5 text-[11px] font-semibold text-ready">all set</span>
            )}
          </div>
          <ul>
            <SetupRow
              ok={auth}
              title="Admin login"
              detail="Protects the studio and every admin page behind a password."
              how="Set ADMIN_PASSWORD and SESSION_SECRET in Vercel, then redeploy. Until both are set, the app stays open to everyone."
            />
            <SetupRow
              ok={storage}
              title="Supabase"
              detail="Stores settings, keys, backends, jobs, voices and generated files."
              how="Create a Supabase project, run supabase/migrations/0001_voiceforge_storage.sql in its SQL editor, then set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in Vercel and redeploy."
            />
          </ul>
        </section>
      </div>

      {!auth ? (
        <div className="mb-6 flex gap-3 rounded-2xl border border-live/30 bg-liveSoft px-5 py-4">
          <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-live" />
          <p className="text-[13px] leading-relaxed text-ink">
            <strong>Your site is currently public.</strong> That&apos;s deliberate: the login only switches on once{" "}
            <code className="font-mono text-[12px]">ADMIN_PASSWORD</code> and{" "}
            <code className="font-mono text-[12px]">SESSION_SECRET</code> exist, so deploying never locks you out
            before you&apos;re ready.
          </p>
        </div>
      ) : null}

      {/* ---------- quick links ---------- */}
      <section aria-labelledby="dash-links">
        <h2 id="dash-links" className="mb-3 text-[11px] font-semibold uppercase tracking-[0.13em] text-faint">
          Quick links
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {QUICK_LINKS.map(({ href, label, detail, Icon }) => (
            <Link
              key={href}
              href={href}
              className="glass-card group flex items-center gap-3 px-4 py-3.5 transition-shadow hover:shadow-lift"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent-50 text-accent-700">
                <Icon className="h-[18px] w-[18px]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-semibold text-ink">{label}</span>
                <span className="block truncate text-[12px] text-muted">{detail}</span>
              </span>
              <IconArrowRight className="h-4 w-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
            </Link>
          ))}
        </div>
      </section>
    </AdminPage>
  );
}
