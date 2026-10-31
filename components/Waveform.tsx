"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PcmAudio } from "@/lib/audio";

export interface TrimRange {
  start: number; // seconds
  end: number;
}

export interface WaveformProps {
  pcm: PcmAudio;
  trim: TrimRange;
  onTrimChange(trim: TrimRange): void;
  height?: number;
}

const HANDLE_HIT_PX = 14;
const MIN_REGION_SEC = 1;

/** Canvas waveform with draggable (and keyboard-adjustable) trim handles. */
export function Waveform({ pcm, trim, onTrimChange, height = 96 }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const dragging = useRef<"start" | "end" | null>(null);

  const durationSec = pcm.samples.length / pcm.sampleRate;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const { samples } = pcm;
    const startX = (trim.start / durationSec) * width;
    const endX = (trim.end / durationSec) * width;
    const mid = height / 2;
    const samplesPerPx = samples.length / width;
    // Canvas can't use CSS classes: read the theme's tokens at draw time so
    // the waveform is legible in light and dark.
    const css = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const colors = {
      trim: `rgb(${token("--audio", "37 99 235")})`,
      rest: `rgb(${token("--faint", "148 163 184")} / 0.45)`,
      handle: `rgb(${token("--ink", "15 23 42")})`,
    };

    for (let x = 0; x < width; x++) {
      const from = Math.floor(x * samplesPerPx);
      const to = Math.min(samples.length, Math.floor((x + 1) * samplesPerPx) + 1);
      let min = 0;
      let max = 0;
      for (let i = from; i < to; i++) {
        if (samples[i] < min) min = samples[i];
        if (samples[i] > max) max = samples[i];
      }
      const inTrim = x >= startX && x <= endX;
      ctx.fillStyle = inTrim ? colors.trim : colors.rest;
      const y0 = mid + min * (mid - 3);
      const y1 = mid + max * (mid - 3);
      ctx.fillRect(x, y1, 1, Math.max(1, y0 - y1));
    }

    // trim handles — a hairline plus a rounded grip
    for (const x of [startX, endX]) {
      ctx.fillStyle = colors.handle;
      ctx.fillRect(Math.round(x) - 1, 0, 2, height);
      ctx.beginPath();
      ctx.roundRect(Math.round(x) - 3.5, mid - 11, 7, 22, 3.5);
      ctx.fill();
    }
  }, [pcm, trim, width, height, durationSec]);

  const xToSec = useCallback(
    (clientX: number) => {
      const rect = wrapRef.current!.getBoundingClientRect();
      const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
      return (x / rect.width) * durationSec;
    },
    [durationSec]
  );

  const applyTrim = useCallback(
    (which: "start" | "end", sec: number) => {
      if (which === "start") {
        onTrimChange({
          start: Math.min(Math.max(0, sec), trim.end - MIN_REGION_SEC),
          end: trim.end,
        });
      } else {
        onTrimChange({
          start: trim.start,
          end: Math.max(Math.min(durationSec, sec), trim.start + MIN_REGION_SEC),
        });
      }
    },
    [trim, durationSec, onTrimChange]
  );

  const onPointerDown = (e: React.PointerEvent) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const startX = (trim.start / durationSec) * rect.width;
    const endX = (trim.end / durationSec) * rect.width;
    const nearStart = Math.abs(x - startX) <= HANDLE_HIT_PX;
    const nearEnd = Math.abs(x - endX) <= HANDLE_HIT_PX;
    if (!nearStart && !nearEnd) return;
    dragging.current =
      nearStart && nearEnd ? (x < (startX + endX) / 2 ? "start" : "end") : nearStart ? "start" : "end";
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    applyTrim(dragging.current, xToSec(e.clientX));
  };

  const onPointerUp = () => {
    dragging.current = null;
  };

  const handleKey = (which: "start" | "end") => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 1 : 0.1;
    const current = which === "start" ? trim.start : trim.end;
    if (e.key === "ArrowLeft") {
      applyTrim(which, current - step);
      e.preventDefault();
    } else if (e.key === "ArrowRight") {
      applyTrim(which, current + step);
      e.preventDefault();
    }
  };

  return (
    <div>
      <div
        ref={wrapRef}
        className="relative w-full cursor-ew-resize touch-none rounded-xl border border-line bg-surface2"
        style={{ height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} aria-hidden />
        {/* keyboard-reachable trim handles */}
        <div
          role="slider"
          tabIndex={0}
          aria-label="Trim start"
          aria-valuemin={0}
          aria-valuemax={durationSec}
          aria-valuenow={trim.start}
          aria-valuetext={`${trim.start.toFixed(1)} seconds`}
          onKeyDown={handleKey("start")}
          className="absolute top-0 h-full w-2 -translate-x-1/2"
          style={{ left: `${(trim.start / durationSec) * 100}%` }}
        />
        <div
          role="slider"
          tabIndex={0}
          aria-label="Trim end"
          aria-valuemin={0}
          aria-valuemax={durationSec}
          aria-valuenow={trim.end}
          aria-valuetext={`${trim.end.toFixed(1)} seconds`}
          onKeyDown={handleKey("end")}
          className="absolute top-0 h-full w-2 -translate-x-1/2"
          style={{ left: `${(trim.end / durationSec) * 100}%` }}
        />
      </div>
      <p className="mt-2 font-mono text-[11px] tabular-nums text-faint">
        {trim.start.toFixed(1)}s – {trim.end.toFixed(1)}s
        <span className="text-line"> / </span>
        {durationSec.toFixed(1)}s
      </p>
    </div>
  );
}
