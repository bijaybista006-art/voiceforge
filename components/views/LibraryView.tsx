"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { JOB_KIND_LABEL, formatSeconds, jobKind, timeAgo, type JobKind } from "@/lib/jobView";
import { toast } from "@/lib/toast";
import { useIsAdmin } from "../studio/StudioContext";
import { Button } from "../ui/Button";
import { IconDownload, IconFilmSpark, IconLibrary, IconRefresh, IconVideo, IconWave } from "../ui/Icons";
import { PageHeader, SkeletonCard, StatusBadge } from "../ui/Kit";

/**
 * My Library: everything that has been made, newest first, to play again or
 * download. Reads the same job history the admin Jobs page uses
 * (GET /api/admin/jobs — the studio sits behind the same login), shown in
 * plain words. Read-only: deleting stays an admin action on Admin → Jobs.
 */

interface JobRow {
  id: string;
  status: "queued" | "running" | "done" | "error";
  source: string;
  backend?: string;
  createdAt: number;
  duration?: number;
  audioUrl?: string;
  videoUrl?: string;
  kind?: string;
  progress?: number;
  stage?: string;
  format?: string;
  items?: Array<{ index: number; duration: number; audioUrl?: string }>;
  error?: string;
}

type Filter = "all" | "audio" | "presenter" | "clip";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "Everything" },
  { id: "audio", label: "Narration" },
  { id: "presenter", label: "Presenter clips" },
  { id: "clip", label: "AI video" },
];

function matches(filter: Filter, kind: JobKind): boolean {
  if (filter === "all") return true;
  if (filter === "audio") return kind === "tts";
  if (filter === "presenter") return kind === "presenter" || kind === "video";
  return kind === "clip";
}

/** Files live on another origin, where a plain download link only opens them. */
async function download(url: string, name: string) {
  try {
    const blob = await (await fetch(url)).blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

function extension(url: string, fallback: string): string {
  const m = /\.([a-z0-9]{2,4})(?:\?|$)/i.exec(url);
  return m ? m[1].toLowerCase() : fallback;
}

export function LibraryView() {
  const isAdmin = useIsAdmin();
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/jobs", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setJobs(((await res.json()) as { jobs: JobRow[] }).jobs);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(
    () => (jobs ?? []).filter((j) => matches(filter, jobKind(j.kind))),
    [jobs, filter]
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:py-10">
      <PageHeader
        title="My Library"
        description="Everything you've made, newest first. Play it again or download it."
        action={
          <Button
            size="sm"
            onClick={() => {
              void load().then(() => toast("Library updated.", "success"));
            }}
          >
            <IconRefresh className="h-3.5 w-3.5" />
            Refresh
          </Button>
        }
      />

      <div className="mb-5 flex flex-wrap gap-2" role="tablist" aria-label="Show">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={`rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
              filter === f.id
                ? "border-brand-600 bg-brand-50 text-brand-700"
                : "border-line bg-surface text-muted hover:border-lineStrong hover:text-ink"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {failed ? (
        <div className="glass-card px-5 py-6 text-[13.5px] text-ink">
          <p className="font-semibold">Couldn&apos;t load your library.</p>
          <p className="mt-0.5 text-muted">Check your connection, then press Refresh.</p>
        </div>
      ) : jobs === null ? (
        <div className="grid gap-4" aria-busy="true">
          <SkeletonCard lines={2} />
          <SkeletonCard lines={2} />
          <SkeletonCard lines={2} />
        </div>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-lineStrong px-6 py-12 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-surface3 text-muted">
            <IconLibrary className="h-6 w-6" />
          </span>
          <p className="text-[15px] font-semibold text-ink">
            {jobs.length === 0 ? "Nothing here yet" : "Nothing of this kind yet"}
          </p>
          <p className="max-w-sm text-[13.5px] text-muted">
            Clips and narrations you make show up here, ready to play and download.
          </p>
          <div className="mt-1 flex flex-wrap justify-center gap-2">
            <Link href="/studio/speech" className="text-[13.5px] font-semibold text-audio hover:underline">
              Make narration
            </Link>
            <span className="text-faint">·</span>
            <Link href="/studio/ai-video" className="text-[13.5px] font-semibold text-video hover:underline">
              Make an AI clip
            </Link>
          </div>
        </div>
      ) : (
        <ul className="grid gap-4" aria-label="Your files">
          {shown.map((j) => (
            <LibraryItem key={j.id} job={j} isAdmin={isAdmin} />
          ))}
        </ul>
      )}
    </div>
  );
}

function LibraryItem({ job, isAdmin }: { job: JobRow; isAdmin: boolean }) {
  const kind = jobKind(job.kind);
  const Icon = kind === "clip" ? IconFilmSpark : kind === "presenter" || kind === "video" ? IconVideo : IconWave;
  const isVideo = kind !== "tts";
  const url = isVideo ? job.videoUrl : (job.audioUrl ?? job.items?.find((i) => i.audioUrl)?.audioUrl);
  const length = formatSeconds(job.duration);
  const name = `${kind === "clip" ? "ai-clip" : kind === "tts" ? "narration" : "presenter"}-${job.id.slice(0, 8)}.${
    url ? extension(url, isVideo ? "mp4" : (job.format ?? "mp3")) : "mp4"
  }`;

  return (
    <li className="glass-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-5 py-4">
        <span
          className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${
            isVideo ? "bg-videoSoft text-video" : "bg-audioSoft text-audio"
          }`}
        >
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] font-semibold text-ink">{JOB_KIND_LABEL[kind]}</p>
          <p className="text-[12.5px] text-muted">
            {timeAgo(job.createdAt)}
            {length ? ` · ${length}` : ""}
            {job.items && job.items.length > 1 ? ` · ${job.items.length} separate clips` : ""}
            {isAdmin && job.backend ? ` · ${job.backend}` : ""}
          </p>
        </div>
        <StatusBadge kind={job.status} />
        {job.status === "done" && url ? (
          <Button size="sm" onClick={() => void download(url, name)} aria-label={`Download ${JOB_KIND_LABEL[kind]}`}>
            <IconDownload className="h-3.5 w-3.5" />
            Download
          </Button>
        ) : null}
      </div>

      {job.status === "done" && url ? (
        <div className="border-t border-line bg-surface2/60 px-5 py-4">
          {isVideo ? (
            <video
              src={url}
              controls
              playsInline
              preload="metadata"
              className="aspect-video max-h-[360px] w-full rounded-xl bg-black object-contain"
            />
          ) : (
            <audio src={url} controls preload="none" className="w-full" />
          )}
        </div>
      ) : job.status === "running" || job.status === "queued" ? (
        <p className="border-t border-line px-5 py-3 text-[13px] text-muted">
          Still being made{typeof job.progress === "number" ? ` (${Math.round(job.progress)}%)` : ""}. Refresh in a
          little while.
        </p>
      ) : job.status === "error" ? (
        <p className="border-t border-line px-5 py-3 text-[13px] text-muted">
          This one didn&apos;t finish{isAdmin && job.error ? `: ${job.error}` : ". Try making it again."}
        </p>
      ) : null}
    </li>
  );
}
