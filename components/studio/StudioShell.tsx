"use client";

import { useEffect, type ReactNode } from "react";
import { AppShell, SectionSwitch, type NavSection } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/Badge";
import { IconFilmSpark, IconHome, IconLibrary, IconVideo, IconWave } from "@/components/ui/Icons";
import { SkeletonCard } from "@/components/ui/Kit";
import { HEALTH_POLL_MS } from "@/lib/config";
import { useApp } from "@/lib/store";
import { GpuStatus } from "./GpuStatus";
import { StudioProvider } from "./StudioContext";

/**
 * The studio frame: creation tools only. No admin pages in this navigation;
 * the single "Go to Admin" switch appears only for the admin (see
 * StudioContext). Owns what the old single-page studio owned: loading the
 * session, the leave-page guard while generating, and keeping the GPU status
 * fresh.
 */
export function StudioShell({ isAdmin, children }: { isAdmin: boolean; children: ReactNode }) {
  const hydrate = useApp((s) => s.hydrate);
  const hydrated = useApp((s) => s.hydrated);
  const connect = useApp((s) => s.connect);
  const generating = useApp((s) => s.queue.running && !s.queue.paused);
  const queueRunning = useApp((s) => s.queue.running);
  const doneCount = useApp((s) => s.project.chunks.filter((c) => c.status === "done").length);
  const totalCount = useApp((s) => s.project.chunks.length);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Don't let a closed tab silently end a run.
  useEffect(() => {
    if (!generating) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [generating]);

  // A GPU can come online at any moment: keep the status pill honest, but
  // only while the tab is visible (each check is a storage read).
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const tick = () => void connect({ silent: true });
    const sync = () => {
      if (document.visibilityState === "visible") {
        if (id === null) id = setInterval(tick, HEALTH_POLL_MS);
      } else if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      if (id !== null) clearInterval(id);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [connect]);

  const sections: NavSection[] = [
    {
      label: "Create",
      items: [
        { href: "/studio", label: "Home", Icon: IconHome },
        {
          href: "/studio/speech",
          label: "Text to Speech",
          Icon: IconWave,
          badge: queueRunning ? (
            <Badge tone="live" dot pulse>
              {doneCount}/{totalCount}
            </Badge>
          ) : undefined,
        },
        { href: "/studio/presenter", label: "Presenter Video", Icon: IconVideo, video: true },
        { href: "/studio/ai-video", label: "AI Video", Icon: IconFilmSpark, video: true },
      ],
    },
    {
      label: "Your work",
      items: [{ href: "/studio/library", label: "My Library", Icon: IconLibrary }],
    },
  ];

  return (
    <StudioProvider value={{ isAdmin }}>
      <AppShell
        section="studio"
        sections={sections}
        headerExtra={
          <>
            <GpuStatus />
            {isAdmin ? <SectionSwitch to="admin" /> : null}
          </>
        }
        sidebarFooter={
          <p className="px-2 text-[11.5px] leading-relaxed text-faint">
            Runs on GPUs you control. Your voices and presenters are saved once and used everywhere.
          </p>
        }
      >
        {hydrated ? (
          children
        ) : (
          <div className="mx-auto grid w-full max-w-5xl gap-4 px-4 py-8 sm:px-6" aria-busy="true">
            <span className="visually-hidden">Loading your session…</span>
            <SkeletonCard lines={2} />
            <SkeletonCard lines={4} />
          </div>
        )}
      </AppShell>
    </StudioProvider>
  );
}
