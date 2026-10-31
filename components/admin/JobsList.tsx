"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDuration } from "@/lib/audio";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { IconAlert, IconDownload, IconSparkle, IconTrash } from "@/components/ui/Icons";

interface JobItem {
  index: number;
  duration: number;
  audioUrl?: string;
}

interface JobRow {
  id: string;
  status: "queued" | "running" | "done" | "error";
  mode: "stitch" | "items";
  format: string;
  voiceId: string;
  source: string;
  chars: number;
  chunks: number;
  backend?: string;
  createdAt: number;
  duration?: number;
  genSeconds?: number;
  audioUrl?: string;
  items?: JobItem[];
  error?: string;
}

const STATUS: Record<JobRow["status"], { dot: string; text: string; label: string }> = {
  queued: { dot: "bg-faint", text: "text-faint", label: "Queued" },
  running: { dot: "bg-live", text: "text-live", label: "Running" },
  done: { dot: "bg-ready", text: "text-ready", label: "Done" },
  error: { dot: "bg-danger", text: "text-danger", label: "Failed" },
};

function when(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function JobsList() {
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/jobs", { cache: "no-store" });
      if (res.ok) setJobs(((await res.json()) as { jobs: JobRow[] }).jobs);
    } catch {
      /* transient — the poll retries */
    }
  }, []);

  useEffect(() => {
    void load();
    // Polling only while someone is looking. Each refresh is a Redis read,
    // and a tab left open overnight used to spend tens of thousands of
    // commands a day showing a list nobody was watching — enough on its own
    // to exhaust a free database tier.
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

  async function remove(id: string) {
    if (!window.confirm("Delete this job and its audio?")) return;
    setBusy(true);
    try {
      await fetch(`/api/admin/jobs?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
    } catch {
      toast("Couldn't delete that job.", "error");
    } finally {
      setBusy(false);
    }
  }

  if (!jobs) {
    return <div className="glass-card px-5 py-8 text-center text-sm text-muted">Loading…</div>;
  }

  if (jobs.length === 0) {
    return (
      <div className="glass-card px-5 py-10 text-center">
        <span className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-brand-50 text-brand-600">
          <IconSparkle className="h-5 w-5" />
        </span>
        <p className="mt-3 text-[14px] font-medium text-ink">No jobs yet</p>
        <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-muted">
          Jobs created through the public API appear here, with audio you can play or download.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {jobs.map((job) => {
        const style = STATUS[job.status];
        return (
          <div key={job.id} className="glass-card overflow-hidden">
            <div className="flex flex-wrap items-start gap-4 px-5 py-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[11px] font-medium ${style.text}`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
                    {style.label}
                  </span>
                  <span className="text-[12px] text-muted">{when(job.createdAt)}</span>
                  {job.backend ? (
                    <span className="text-[12px] text-faint">{job.backend}</span>
                  ) : null}
                  {job.mode === "items" ? (
                    <span className="rounded-full bg-surface3 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-faint">
                      batch
                    </span>
                  ) : null}
                </div>

                <p className="mt-1.5 break-all font-mono text-[11px] text-faint">{job.id}</p>

                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
                  <span>{job.chars.toLocaleString()} chars</span>
                  <span>
                    {job.chunks} chunk{job.chunks === 1 ? "" : "s"}
                  </span>
                  {job.duration ? <span>{formatDuration(job.duration)} audio</span> : null}
                  {job.genSeconds ? <span>{Math.round(job.genSeconds)}s on GPU</span> : null}
                </div>

                {job.error ? (
                  <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed text-danger">
                    <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {job.error}
                  </p>
                ) : null}

                {job.audioUrl ? (
                  <audio src={job.audioUrl} controls preload="none" className="mt-3 h-9 w-full max-w-sm" />
                ) : null}

                {job.items && job.items.length > 1 ? (
                  <div className="mt-3 flex flex-col gap-1.5">
                    {job.items.map((item) => (
                      <div key={item.index} className="flex items-center gap-2">
                        <span className="w-6 shrink-0 font-mono text-[11px] text-faint">
                          {item.index + 1}
                        </span>
                        <audio
                          src={item.audioUrl}
                          controls
                          preload="none"
                          className="h-8 w-full max-w-sm"
                        />
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="flex shrink-0 gap-2">
                {job.audioUrl ? (
                  <a
                    href={job.audioUrl}
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
                  onClick={() => void remove(job.id)}
                  aria-label="Delete job"
                  className="grid h-8 w-8 place-items-center rounded-lg text-faint transition-colors hover:bg-dangerSoft hover:text-danger disabled:opacity-40"
                >
                  <IconTrash className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        );
      })}

      <div className="flex items-center gap-2 px-1">
        <p className="text-[12px] text-muted">Refreshes every 10 seconds.</p>
        <Button size="sm" className="ml-auto" onClick={() => void load()}>
          Refresh now
        </Button>
      </div>
    </div>
  );
}
