"use client";

import { useEffect, useState } from "react";
import { Shell, type ViewId } from "@/components/Shell";
import { HomeView } from "@/components/views/HomeView";
import { SpeechView } from "@/components/views/SpeechView";
import { VideoView } from "@/components/views/VideoView";
import { Toaster } from "@/components/ui/Toast";
import { useApp } from "@/lib/store";

export default function Studio() {
  const hydrate = useApp((s) => s.hydrate);
  const hydrated = useApp((s) => s.hydrated);
  const generating = useApp((s) => s.queue.running && !s.queue.paused);
  const [view, setView] = useState<ViewId>("home");

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Don't let a closed tab silently nuke a run.
  useEffect(() => {
    if (!generating) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [generating]);

  return (
    <>
      <Shell view={view} onViewChange={setView}>
        {!hydrated ? (
          <div className="flex h-full items-center justify-center py-24 text-sm text-muted">
            Loading your session…
          </div>
        ) : view === "home" ? (
          <HomeView onNavigate={setView} />
        ) : view === "speech" ? (
          <SpeechView />
        ) : (
          <VideoView />
        )}
      </Shell>
      <Toaster />
    </>
  );
}
