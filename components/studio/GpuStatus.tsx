"use client";

import { useApp } from "@/lib/store";

export type GpuState = "ready" | "busy" | "offline";

/** Pure: the one-word status the studio shows, from what the store knows. */
export function gpuState(backend: { connected: boolean; health?: string }, generating: boolean): GpuState {
  if (!backend.connected) return "offline";
  if (generating || backend.health === "busy") return "busy";
  return "ready";
}

const COPY: Record<GpuState, { label: string; hint: string; wrap: string; dot: string }> = {
  ready: {
    label: "Ready",
    hint: "A GPU is online and free. Generation starts right away.",
    wrap: "border-ready/30 bg-readySoft text-ready",
    dot: "bg-ready",
  },
  busy: {
    label: "Busy",
    hint: "The GPU is working. New requests wait their turn.",
    wrap: "border-live/30 bg-liveSoft text-live",
    dot: "bg-live animate-breathe",
  },
  offline: {
    label: "Offline",
    hint: "No GPU is running right now. Generation will start once one comes online.",
    wrap: "border-line bg-surface2 text-muted",
    dot: "border border-faint",
  },
};

/** The studio's whole view of the GPU: Ready / Busy / Offline. No URLs, no GPU models. */
export function GpuStatus() {
  const backend = useApp((s) => s.backend);
  const generating = useApp((s) => s.queue.running && !s.queue.paused);
  const state = gpuState(backend, generating);
  const c = COPY[state];
  return (
    <span
      role="status"
      title={c.hint}
      data-testid="gpu-status"
      data-state={state}
      className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-xl border px-3 text-[13px] font-semibold ${c.wrap}`}
    >
      <span aria-hidden className={`h-2 w-2 rounded-full ${c.dot}`} />
      <span className="hidden sm:inline">GPU</span>
      {c.label}
      <span className="visually-hidden">. {c.hint}</span>
    </span>
  );
}
