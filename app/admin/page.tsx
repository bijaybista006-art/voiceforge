import Link from "next/link";
import { AdminPage } from "@/components/admin/AdminShell";
import { isAuthConfigured } from "@/lib/server/auth";
import { getActiveSelection, listBackends } from "@/lib/server/backends";
import { isRedisConfigured } from "@/lib/server/redis";
import { listVoices } from "@/lib/server/voices";
import { IconAlert, IconArrowRight, IconCheck } from "@/components/ui/Icons";

export const dynamic = "force-dynamic";

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="glass-card px-5 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">{label}</p>
      <p className="mt-1.5 font-display text-2xl font-bold capitalize tracking-tight text-ink">
        {value}
      </p>
      <p className="mt-0.5 truncate text-[12.5px] text-muted">{detail}</p>
    </div>
  );
}

function SetupRow({
  ok,
  title,
  detail,
  how,
}: {
  ok: boolean;
  title: string;
  detail: string;
  how: string;
}) {
  return (
    <li className="flex gap-3.5 border-b border-line px-5 py-4 last:border-0">
      <span
        className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full ${
          ok ? "bg-ready/15 text-ready" : "bg-live/15 text-live"
        }`}
      >
        {ok ? <IconCheck className="h-3.5 w-3.5" /> : <IconAlert className="h-3.5 w-3.5" />}
      </span>
      <div className="min-w-0">
        <p className="text-[14px] font-semibold text-ink">
          {title}{" "}
          <span className={`ml-1 text-[12px] font-medium ${ok ? "text-ready" : "text-live"}`}>
            {ok ? "connected" : "not set up"}
          </span>
        </p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{detail}</p>
        {!ok ? <p className="mt-1.5 text-[12.5px] leading-relaxed text-faint">{how}</p> : null}
      </div>
    </li>
  );
}

export default async function AdminDashboard() {
  const auth = isAuthConfigured();
  const redis = isRedisConfigured();
  const remaining = [auth, redis].filter((x) => !x).length;

  const [backends, active, voices] = await Promise.all([
    listBackends(),
    getActiveSelection(),
    listVoices(),
  ]);
  const live = backends.filter((b) => b.health === "online" || b.health === "busy");

  return (
    <AdminPage title="Dashboard" description="What's running right now, and what's left to set up.">
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat
          label="Backends online"
          value={`${live.length}`}
          detail={live.length ? live.map((b) => b.provider).join(", ") : "nothing is running"}
        />
        <Stat
          label="Active selection"
          value={active === "auto" ? "Auto" : active}
          detail={active === "auto" ? "first healthy by priority" : "pinned to one provider"}
        />
        <Stat
          label="Voices"
          value={`${voices.length}`}
          detail={voices.find((v) => v.isDefault)?.name ?? "no default set"}
        />
      </div>

      <div className="glass-card overflow-hidden">
        <div className="border-b border-line bg-surface2 px-5 py-3.5">
          <h2 className="text-[13px] font-semibold text-ink">
            Setup
            {remaining > 0 ? (
              <span className="ml-2 rounded-full bg-live/15 px-2 py-0.5 text-[11px] font-medium text-live">
                {remaining} remaining
              </span>
            ) : (
              <span className="ml-2 rounded-full bg-ready/15 px-2 py-0.5 text-[11px] font-medium text-ready">
                all set
              </span>
            )}
          </h2>
        </div>
        <ul>
          <SetupRow
            ok={auth}
            title="Admin login"
            detail="Protects the studio and every admin page behind a password."
            how="Set ADMIN_PASSWORD and SESSION_SECRET in Vercel, then redeploy. Until both are set, the app stays open to everyone."
          />
          <SetupRow
            ok={redis}
            title="Supabase"
            detail="Stores settings, API keys, the backend registry, job history, voice clips and generated audio."
            how="Create a Supabase project, run supabase/migrations/0001_voiceforge_storage.sql in its SQL editor, then set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in Vercel and redeploy."
          />
        </ul>
      </div>

      {!auth ? (
        <div className="mt-4 flex gap-3 rounded-2xl border border-live/30 bg-liveSoft px-5 py-4">
          <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-live" />
          <p className="text-[13px] leading-relaxed text-ink">
            <strong>Your site is currently public.</strong> That&apos;s deliberate — the login gate
            only switches on once <code className="font-mono text-[12px]">ADMIN_PASSWORD</code> and{" "}
            <code className="font-mono text-[12px]">SESSION_SECRET</code> exist, so deploying this
            never locks you out before you&apos;re ready.
          </p>
        </div>
      ) : null}

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Link
          href="/admin/backends"
          className="glass-card group flex items-center gap-3 px-5 py-4 transition-shadow hover:shadow-lift"
        >
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-ink">Backends</p>
            <p className="mt-0.5 text-[13px] text-muted">Where generation runs. Connect Colab.</p>
          </div>
          <IconArrowRight className="h-4 w-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
        </Link>
        <Link
          href="/admin/voices"
          className="glass-card group flex items-center gap-3 px-5 py-4 transition-shadow hover:shadow-lift"
        >
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-ink">Voices</p>
            <p className="mt-0.5 text-[13px] text-muted">Your library. Clone once, use anywhere.</p>
          </div>
          <IconArrowRight className="h-4 w-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
        </Link>
        <Link
          href="/admin/settings"
          className="glass-card group flex items-center gap-3 px-5 py-4 transition-shadow hover:shadow-lift"
        >
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-ink">Settings</p>
            <p className="mt-0.5 text-[13px] text-muted">Defaults, retention and tokens.</p>
          </div>
          <IconArrowRight className="h-4 w-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
        </Link>
        <Link
          href="/"
          className="glass-card group flex items-center gap-3 px-5 py-4 transition-shadow hover:shadow-lift"
        >
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-ink">Studio</p>
            <p className="mt-0.5 text-[13px] text-muted">Text to speech and AI video.</p>
          </div>
          <IconArrowRight className="h-4 w-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>

      <p className="mt-6 text-[12.5px] leading-relaxed text-faint">
        API Keys and Jobs arrive in the next phase — that&apos;s what n8n and other automations will
        use. They&apos;re listed in the sidebar so the shape of the platform stays visible as it
        fills in.
      </p>
    </AdminPage>
  );
}
