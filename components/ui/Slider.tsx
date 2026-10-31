"use client";

import { useId } from "react";

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange(value: number): void;
  hint?: string;
  format?(value: number): string;
  disabled?: boolean;
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  hint,
  format = (v) => v.toFixed(2),
  disabled,
}: SliderProps) {
  const id = useId();
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-medium text-ink">
          {label}
        </label>
        <span className="rounded-md bg-surface3 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-muted">
          {format(value)}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        // Track is painted with a gradient so the filled portion reads clearly.
        style={{
          background: `linear-gradient(90deg, var(--brand) ${pct}%, rgb(var(--line-strong)) ${pct}%)`,
        }}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full accent-[rgb(37_99_235)] disabled:cursor-not-allowed disabled:opacity-40 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-audio [&::-webkit-slider-thumb]:shadow-[0_1px_4px_rgba(15,23,42,.3)]"
      />
      {hint ? <p className="mt-1.5 text-[11.5px] leading-snug text-faint">{hint}</p> : null}
    </div>
  );
}
