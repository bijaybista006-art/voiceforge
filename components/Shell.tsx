"use client";

import type { ReactNode } from "react";
import { useApp } from "@/lib/store";
import { ConnectionsControl } from "./Connections";
import { Badge } from "./ui/Badge";
import { IconFilmSpark, IconHome, IconVideo, IconWave } from "./ui/Icons";

export type ViewId = "home" | "speech" | "video" | "clips";

const NAV: Array<{ id: ViewId; label: string; short: string; Icon: typeof IconHome }> = [
  { id: "home", label: "Home", short: "Home", Icon: IconHome },
  { id: "speech", label: "Text to Speech", short: "Speech", Icon: IconWave },
  { id: "video", label: "Presenter Video", short: "Video", Icon: IconVideo },
  { id: "clips", label: "AI Video", short: "AI Video", Icon: IconFilmSpark },
];

/** Both video tools share the video accent (violet); speech is blue. */
const isVideoView = (id: ViewId) => id === "video" || id === "clips";

function NavItem({
  id,
  label,
  Icon,
  active,
  onSelect,
  badge,
}: {
  id: ViewId;
  label: string;
  Icon: typeof IconHome;
  active: boolean;
  onSelect(id: ViewId): void;
  badge?: ReactNode;
}) {
  const accent = isVideoView(id) ? "text-video" : id === "speech" ? "text-audio" : "text-ink";
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      aria-current={active ? "page" : undefined}
      className={`group relative flex w-full items-center gap-3 rounded-xl py-2.5 pl-3.5 pr-3 text-[13.5px] font-medium transition-colors duration-150 ${
        active ? "bg-surface2 text-ink" : "text-muted hover:bg-surface2/50 hover:text-ink"
      }`}
    >
      {/* active marker — a shape, so the state isn't carried by colour alone */}
      <span
        aria-hidden
        className={`absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full transition-all ${
          active ? (isVideoView(id) ? "bg-video" : "bg-audio") : "bg-transparent"
        }`}
      />
      <Icon className={`h-[18px] w-[18px] ${active ? accent : "text-faint group-hover:text-muted"}`} />
      <span className="flex-1 text-left">{label}</span>
      {badge}
    </button>
  );
}

export function Shell({
  view,
  onViewChange,
  children,
}: {
  view: ViewId;
  onViewChange(v: ViewId): void;
  children: ReactNode;
}) {
  const queueRunning = useApp((s) => s.queue.running);
  const doneCount = useApp((s) => s.project.chunks.filter((c) => c.status === "done").length);
  const totalCount = useApp((s) => s.project.chunks.length);

  const speechBadge = queueRunning ? (
    <Badge tone="live" dot pulse>
      {doneCount}/{totalCount}
    </Badge>
  ) : null;

  return (
    <div className="flex min-h-screen flex-col lg:h-screen lg:flex-row">
      {/* ---------- sidebar (desktop) ---------- */}
      <aside className="relative hidden w-[244px] shrink-0 flex-col border-r border-line bg-surface/50 lg:flex">
        {/* brand — sits on its own bar so it lines up with the top bar */}
        <div className="flex h-[61px] items-center gap-2.5 border-b border-line px-5">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 text-white shadow-lg shadow-brand-500/20">
            <IconWave className="h-4 w-4" />
          </span>
          <span className="gradient-text text-[17px]">VoiceForge</span>
        </div>

        <nav className="flex flex-col gap-0.5 px-3 py-4" aria-label="Main">
          <p className="mb-1 px-3 text-[10.5px] font-semibold uppercase tracking-[0.13em] text-faint">
            Workspace
          </p>
          {NAV.map((n) => (
            <NavItem
              key={n.id}
              {...n}
              active={view === n.id}
              onSelect={onViewChange}
              badge={n.id === "speech" ? speechBadge : undefined}
            />
          ))}
        </nav>

        <p className="mt-auto border-t border-line px-5 py-4 text-[11px] leading-relaxed text-faint">
          Runs on GPUs you control. Voices and presenters are stored once and used by every backend.
        </p>
      </aside>

      {/* ---------- main ---------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-[61px] items-center gap-3 border-b border-line bg-bg/85 px-4 backdrop-blur-xl sm:px-6">
          <span className="flex items-center gap-2 lg:hidden">
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 text-white">
              <IconWave className="h-4 w-4" />
            </span>
            <span className="gradient-text text-base">VoiceForge</span>
          </span>
          <div className="ml-auto">
            <ConnectionsControl />
          </div>
        </header>

        {/* mobile nav */}
        <nav
          aria-label="Main"
          className="sticky top-[61px] z-20 flex gap-1 border-b border-line bg-bg/90 px-3 py-2 backdrop-blur lg:hidden"
        >
          {NAV.map(({ id, short, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => onViewChange(id)}
              aria-current={view === id ? "page" : undefined}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[13px] font-medium transition-colors ${
                view === id ? "bg-surface2 text-ink" : "text-muted"
              }`}
            >
              <Icon className="h-4 w-4" />
              <span className="truncate">{short}</span>
            </button>
          ))}
        </nav>

        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
