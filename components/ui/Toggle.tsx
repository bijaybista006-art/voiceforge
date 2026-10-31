"use client";

import { useId } from "react";

/**
 * An on/off switch. Looks like a switch (a track and a knob), behaves like
 * one for assistive tech (role="switch" + aria-checked), and always carries a
 * visible text label so the state is never colour-only.
 */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
  id,
  tone = "brand",
  hideLabel = false,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  label: string;
  description?: string;
  disabled?: boolean;
  id?: string;
  tone?: "brand" | "video";
  hideLabel?: boolean;
}) {
  const on = tone === "video" ? "bg-accent-600" : "bg-brand-600";
  const uid = useId();
  const labelId = `${uid}-label`;
  const descId = `${uid}-desc`;
  return (
    <label
      className={`inline-flex items-start gap-2.5 ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
      title={description}
    >
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={hideLabel ? label : undefined}
        aria-labelledby={hideLabel ? undefined : labelId}
        aria-describedby={description && !hideLabel ? descId : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150 disabled:cursor-not-allowed ${
          checked ? on : "bg-lineStrong"
        }`}
      >
        <span
          aria-hidden
          className={`h-4 w-4 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.3)] transition-transform duration-150 ${
            checked ? "translate-x-[18px]" : "translate-x-0.5"
          }`}
        />
      </button>
      {hideLabel ? null : (
        <span className="min-w-0">
          <span id={labelId} className="block text-[13px] font-medium text-ink">
            {label}
          </span>
          {description ? (
            <span id={descId} className="mt-0.5 block text-[12px] leading-snug text-muted">
              {description}
            </span>
          ) : null}
        </span>
      )}
    </label>
  );
}
