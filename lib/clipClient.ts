"use client";

/**
 * What the studio needs for AI video clips (Wan): can a clip be made right
 * now, with what limits, and how is a running clip doing.
 *
 * Only talks to /api/gateway/clips — the browser never learns a backend URL
 * or the backend secret (same rule as voice and presenters).
 */

import { useCallback, useEffect, useState } from "react";

export interface ClipReadiness {
  ready: boolean;
  provider?: string;
  reason?: string;
  also?: string;
  /** What the backend that would take the clip advertised (backend/wan/settings.py). */
  limits?: { default_quality?: string; max_frames?: number; fps?: number };
}

export interface ClipSettings {
  prompt?: string;
  negative_prompt?: string;
  aspect?: "landscape" | "vertical";
  quality?: string;
  width?: number;
  height?: number;
  num_frames?: number;
  fps?: number;
  duration?: number;
  steps?: number;
  guidance?: number;
  seed?: number;
  profile?: string;
}

export interface ClipJob {
  job_id: string;
  status: "queued" | "running" | "done" | "error";
  stage: string | null;
  progress: number | null;
  backend: string | null;
  video_url: string | null;
  duration: number | null;
  gen_seconds: number | null;
  settings: ClipSettings | null;
  error: string | null;
}

export interface ClipRequest {
  prompt: string;
  negativePrompt?: string;
  aspect?: "landscape" | "vertical";
  quality?: "720p" | "480p";
  numFrames?: number;
  steps?: number;
  guidance?: number;
  seed?: number;
}

/** Readiness, loaded once and on demand. */
export function useClipStatus(): { status: ClipReadiness | null; failed: boolean; reload: () => void } {
  const [status, setStatus] = useState<ClipReadiness | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/gateway/clips", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setStatus((await res.json()) as ClipReadiness);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { status, failed, reload: () => void load() };
}

/** Start a clip. Throws with the server's own message when it cannot. */
export async function startClip(req: ClipRequest): Promise<ClipJob> {
  const res = await fetch("/api/gateway/clips", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const json = (await res.json().catch(() => ({}))) as Partial<ClipJob> & { error?: string };
  if (!res.ok || !json.job_id) throw new Error(json.error ?? "The clip could not be started.");
  return {
    job_id: json.job_id,
    status: json.status ?? "queued",
    stage: json.stage ?? null,
    progress: 0,
    backend: json.backend ?? null,
    video_url: null,
    duration: null,
    gen_seconds: null,
    settings: json.settings ?? null,
    error: null,
  };
}

/** One poll. Null when the clip no longer exists (swept by retention). */
export async function fetchClip(jobId: string): Promise<ClipJob | null> {
  const res = await fetch(`/api/gateway/clips/${encodeURIComponent(jobId)}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as ClipJob;
}

/** Ready-made prompts that suit YouTube b-roll, intros and Shorts. */
export const EXAMPLE_PROMPTS: Array<{ label: string; prompt: string; aspect?: "vertical" }> = [
  {
    label: "Mountain sunrise",
    prompt:
      "Aerial drone shot slowly flying over a misty mountain valley at sunrise, golden light breaking through clouds, cinematic, nature documentary style",
  },
  {
    label: "Circuit board",
    prompt:
      "Close-up of a glowing circuit board with tiny pulses of blue light traveling along the traces, shallow depth of field, slow camera push in, futuristic",
  },
  {
    label: "Morning coffee",
    prompt:
      "Slow motion shot of fresh coffee being poured into a white ceramic cup on a wooden table, steam rising, warm morning sunlight, cozy cafe atmosphere",
  },
  {
    label: "Rainy street (Shorts)",
    prompt:
      "A narrow cobblestone street in an old town at night, warm street lamps, light rain reflecting on the stones, camera walking forward slowly",
    aspect: "vertical",
  },
  {
    label: "Animated cat",
    prompt:
      "A small orange cat wearing a tiny backpack walks through a magical glowing forest, fireflies floating around, 3D animation style, soft lighting",
  },
];

/** The lengths the model can make (4k+1 frames at 24 fps). */
export const CLIP_LENGTHS: Array<{ frames: number; label: string }> = [
  { frames: 49, label: "2 seconds" },
  { frames: 81, label: "3.4 seconds" },
  { frames: 121, label: "5 seconds" },
];
