"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { confirmAction } from "@/lib/confirm";
import { JOB_KIND_LABEL, formatSeconds, jobKind, timeAgo } from "@/lib/jobView";
import { PROVIDER_LABEL } from "@/lib/routingView";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import {
  IconAlert,
  IconDownload,
  IconFilmSpark,
  IconRefresh,
  IconSparkle,
  IconTrash,
  IconVideo,
  IconWave,
} from "@/components/ui/Icons";
import { CopyButton, SkeletonCard, StatusBadge } from "@/components/ui/Kit";

/**
 * Admin → Jobs: every render, newest first, with the numbers an operator
 * wants (characters, pieces, audio length, GPU time, backend) and the full
 * error when something failed. Reads GET /api/admin/jobs and deletes with
 * DELETE /api/admin/jobs?id= — the same two calls as before the redesign.
 */

interface JobItem {
  index: number;
  duration: number;
  audioUrl?: string;
}

interface JobRow {
  id: string;
  status: "queued" | "running" | "done" | "error";
  mode?: "stitch" | "items";
  format?: string;
  voiceId?: string;
  source?: string;
  chars?: number;
  chunks?: number;
  backend?: string;
  createdAt: number;
  duration?: number;
  genSeconds?: number;
  audioUrl?: string;
  videoUrl?: string;
  kind?: string;
  progress?: number;
  stage?: string;
  items?: JobItem[];
  error?: string;
}

type StatusFilter = "all" | "active" | "done" | "error";

const FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "In progress" },
  { id: "done", label: "Done" },
  { id: "error", label: "Failed" },
];

function matches(f: StatusFilter, j: JobRow): boolean {
  if (f === "all") return true;
  if (f === "active") return j.status === "queued" || j.status === "running";
  return j.status === f;
}

type KindFilter = "all" | "tts" | "presenter" | "clip";

const KIND_FILTERS: Array<{ id: KindFilter; label: string }> = [
  { id: "all", label: "All types" },
  { id: "tts", label: "Narration" },
  { id: "presenter", label: "Presenter" },
  { id: "clip", label: "AI video" },
];

function matchesKind(f: KindFilter, j: JobRow): boolean {
  if (f === "all") return true;
  const k = jobKind(j.kind);
  // Old "video" renders were presenter-style video; group them with Presenter.
  return f === "presenter" ? k === "presenter" || k === "video" : k === f;
}

const POLL_MS = 30_000;

export function JobsList() {
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [kind, setKind] = useState<KindFilter>("all");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/jobs", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setJobs(((await res.json()) as { jobs: JobRow[] }).jobs);
      setFailed(false);
    } catch {
      // Transient: the next poll retries. Only say so if we have nothing to show.
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    // Polling only while someone is looking. Each refresh is a database read,
    // and a tab left open overnight used to spend tens of thousands of
    // commands a day showing a list nobody was watching — enough on its own
    // to exhaust a free database tier.
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id === null) id = setInterval(() => void load(), POLL_MS);
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

  // Each row's counts respect the other row's choice, so the numbers always
  // match what clicking would show.
  const kindCounts = useMemo(() => {
    const c = { all: 0, tts: 0, presenter: 0, clip: 0 } as Record<KindFilter, number>;
    for (const j of jobs ?? []) {
      if (!matches(filter, j)) continue;
      for (const f of KIND_FILTERS) if (matchesKind(f.id, j)) c[f.id] += 1;
    }
    return c;
  }, [jobs, filter]);

  const counts = useMemo(() => {
    const c = { all: 0, active: 0, done: 0, error: 0 } as Record<StatusFilter, number>;
    for (const j of jobs ?? []) {
      if (!matchesKind(kind, j)) continue;
      for (const f of FILTERS) if (matches(f.id, j)) c[f.id] += 1;
    }
    return c;
  }, [jobs, kind]);

  const shown = useMemo(
    () => (jobs ?? []).filter((j) => matches(filter, j) && matchesKind(kind, j)),
    [jobs, filter, kind]
  );

  async function remove(job: JobRow) {
    const ok = await confirmAction({
      title: "Delete this job?",
      body: `${JOB_KIND_LABEL[jobKind(job.kind)]} from ${timeAgo(job.createdAt)}. Its files are deleted too. This can't be undone.`,
      confirmLabel: "Delete job",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/jobs?id=${encodeURIComponent(job.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(String(res.status));
      toast("Job deleted.", "success");
      await load();
    } catch {
      toast("Couldn't delete that job. Try again in a moment.", "error");
    } finally {
      setBusy(false);
    }
  }

  if (!jobs) {
    return failed ? (
      <div className="glass-card px-5 py-6 text-[13.5px]">
        <p className="font-semibold text-ink">Couldn&apos;t load jobs.</p>
        <p className="mt-0.5 text-muted">Check the storage connection on the Dashboard, then refresh.</p>
        <Button size="sm" className="mt-3" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    ) : (
      <div className="grid gap-3" aria-busy="true">
        <SkeletonCard lines={2} />
        <SkeletonCard lines={2} />
        <SkeletonCard lines={2} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Job type">
        {KIND_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={kind === f.id}
            onClick={() => setKind(f.id)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors ${
              kind === f.id
                ? f.id === "tts"
                  ? "border-audio bg-audioSoft text-audio"
                  : f.id === "all"
                    ? "border-accent-600 bg-accent-50 text-accent-700"
                    : "border-video bg-videoSoft text-video"
                : "border-line bg-surface text-muted hover:border-lineStrong hover:text-ink"
            }`}
          >
            {f.label}
            <span className="font-mono text-[11px] opacity-70">{kindCounts[f.id]}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Job status">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors ${
                filter === f.id
                  ? "border-accent-600 bg-accent-50 text-accent-700"
                  : "border-line bg-surface text-muted hover:border-lineStrong hover:text-ink"
              }`}
            >
              {f.label}
              <span className="font-mono text-[11px] opacity-70">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <Button size="sm" className="ml-auto" onClick={() => void load().then(() => toast("Jobs refreshed.", "success"))}>
          <IconRefresh className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      {jobs.length === 0 ? (
        <div className="glass-card px-5 py-10 text-center">
          <span className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-accent-50 text-accent-700">
            <IconSparkle className="h-5 w-5" />
          </span>
          <p className="mt-3 text-[14px] font-semibold text-ink">No jobs yet</p>
          <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-muted">
            Narration, presenter clips and AI video made through the API or the studio appear here, with files you can
            play or download.
          </p>
        </div>
      ) : shown.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-lineStrong px-5 py-8 text-center text-[13px] text-muted">
          No jobs match this filter.
        </p>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Jobs">
          {shown.map((job) => (
            <JobCard key={job.id} job={job} busy={busy} onDelete={() => void remove(job)} />
          ))}
        </ul>
      )}

      <p className="px-1 text-[12px] text-faint">Refreshes every 30 seconds while this tab is open.</p>
    </div>
  );
}

function JobCard({ job, busy, onDelete }: { job: JobRow; busy: boolean; onDelete: () => void }) {
  const kind = jobKind(job.kind);
  const Icon = kind === "clip" ? IconFilmSpark : kind === "presenter" || kind === "video" ? IconVideo : IconWave;
  const isVideo = kind !== "tts";
  const fileUrl = job.videoUrl ?? job.audioUrl;
  const length = formatSeconds(job.duration);
  const backend = job.backend ? (PROVIDER_LABEL[job.backend as keyof typeof PROVIDER_LABEL] ?? job.backend) : null;

  const facts: string[] = [];
  if (typeof job.chars === "number" && job.chars > 0) facts.push(`${job.chars.toLocaleString()} chars`);
  if (typeof job.chunks === "number" && job.chunks > 0) facts.push(`${job.chunks} piece${job.chunks === 1 ? "" : "s"}`);
  if (length) facts.push(`${length} ${isVideo ? "video" : "audio"}`);
  if (job.genSeconds) facts.push(`${Math.round(job.genSeconds)} s on GPU`);
  if (job.source) facts.push(job.source === "studio" ? "from the studio" : "from the API");

  return (
    <li className="glass-card overflow-hidden" data-testid="job-card">
      <div className="flex flex-wrap items-start gap-3 px-5 py-4">
        <span
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${
            isVideo ? "bg-videoSoft text-video" : "bg-audioSoft text-audio"
          }`}
        >
          <Icon className="h-[18px] w-[18px]" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[14px] font-semibold text-ink">{JOB_KIND_LABEL[kind]}</p>
            <StatusBadge kind={job.status} />
            {job.mode === "items" ? (
              <span className="rounded-full bg-surface3 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-faint">
                batch
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-[12.5px] text-muted">
            <time dateTime={new Date(job.createdAt).toISOString()} title={new Date(job.createdAt).toLocaleString()}>
              {timeAgo(job.createdAt)}
            </time>
            {backend ? ` · ${backend}` : ""}
          </p>

          {facts.length ? (
            <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-muted">
              {facts.map((f) => (
                <span key={f}>{f}</span>
              ))}
            </p>
          ) : null}

          <p className="mt-1.5 flex items-center gap-1.5">
            <span className="break-all font-mono text-[11px] text-faint">{job.id}</span>
            <CopyButton value={job.id} label="Copy id" className="h-6 px-1.5 text-[11px]" />
          </p>

          {(job.status === "running" || job.status === "queued") && typeof job.progress === "number" ? (
            <div className="mt-3 max-w-sm">
              <div
                className="h-1.5 overflow-hidden rounded-full bg-surface3"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(job.progress)}
                aria-label="Progress"
              >
                <div className="h-full rounded-full bg-accent-500" style={{ width: `${Math.round(job.progress)}%` }} />
              </div>
              <p className="mt-1 text-[11.5px] text-muted">
                {Math.round(job.progress)}%{job.stage ? ` · ${job.stage}` : ""}
              </p>
            </div>
          ) : null}

          {job.error ? (
            <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-dangerSoft px-3 py-2 text-[12.5px] leading-relaxed text-danger">
              <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {job.error}
            </p>
          ) : null}

          {job.videoUrl ? (
            <video
              src={job.videoUrl}
              controls
              playsInline
              preload="metadata"
              className="mt-3 aspect-video w-full max-w-md rounded-xl bg-black object-contain"
            />
          ) : job.audioUrl ? (
            <audio src={job.audioUrl} controls preload="none" className="mt-3 h-9 w-full max-w-sm" />
          ) : null}

          {job.items && job.items.length > 1 ? (
            <div className="mt-3 flex flex-col gap-1.5">
              {job.items.map((item) => (
                <div key={item.index} className="flex items-center gap-2">
                  <span className="w-6 shrink-0 font-mono text-[11px] text-faint">{item.index + 1}</span>
                  <audio src={item.audioUrl} controls preload="none" className="h-8 w-full max-w-sm" />
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 gap-2">
          {fileUrl ? (
            <a
              href={fileUrl}
              download
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-ink transition-colors hover:border-lineStrong"
            >
              <IconDownload className="h-3.5 w-3.5" />
              Download
            </a>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={onDelete}
            aria-label={`Delete ${JOB_KIND_LABEL[kind].toLowerCase()} job`}
            title="Delete job"
            className="grid h-8 w-8 place-items-center rounded-lg text-faint transition-colors hover:bg-dangerSoft hover:text-danger disabled:opacity-40"
          >
            <IconTrash className="h-4 w-4" />
          </button>
        </div>
      </div>
    </li>
  );
}
