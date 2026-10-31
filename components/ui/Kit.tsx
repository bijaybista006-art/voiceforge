"use client";

/**
 * Small shared pieces of the UI v2 design system: status badges, skeletons,
 * tooltips, disclosures (Advanced / Details), copy buttons and page headers.
 * Everything styles itself through the theme tokens, so it works in both
 * themes with no per-theme classes.
 */

import { useId, useState, type ReactNode } from "react";
import { IconCheck, IconChevronDown, IconCopy, IconInfo } from "./Icons";

// --- status ------------------------------------------------------------------

export type StatusKind =
  | "online"
  | "busy"
  | "offline"
  | "disabled"
  | "unverified"
  | "testing"
  | "ready"
  // job states
  | "done"
  | "running"
  | "queued"
  | "error";

const STATUS: Record<StatusKind, { label: string; dot: string; wrap: string; pulse?: boolean }> = {
  online: { label: "Online", dot: "bg-ready", wrap: "border-ready/30 bg-readySoft text-ready" },
  ready: { label: "Ready", dot: "bg-ready", wrap: "border-ready/30 bg-readySoft text-ready" },
  busy: { label: "Busy", dot: "bg-live", wrap: "border-live/30 bg-liveSoft text-live", pulse: true },
  testing: { label: "Testing…", dot: "bg-audio", wrap: "border-audio/30 bg-audioSoft text-audio", pulse: true },
  unverified: { label: "Not verified", dot: "bg-live", wrap: "border-live/30 bg-liveSoft text-live" },
  offline: { label: "Offline", dot: "bg-faint", wrap: "border-line bg-surface2 text-muted" },
  disabled: { label: "Disabled", dot: "bg-faint", wrap: "border-line bg-surface2 text-faint" },
  done: { label: "Done", dot: "bg-ready", wrap: "border-ready/30 bg-readySoft text-ready" },
  running: { label: "Running", dot: "bg-live", wrap: "border-live/30 bg-liveSoft text-live", pulse: true },
  queued: { label: "Queued", dot: "bg-faint", wrap: "border-line bg-surface2 text-muted" },
  error: { label: "Failed", dot: "bg-danger", wrap: "border-danger/30 bg-dangerSoft text-danger" },
};

/** A status pill: the word carries the meaning, the dot only reinforces it. */
export function StatusBadge({ kind, label, title }: { kind: StatusKind; label?: string; title?: string }) {
  const s = STATUS[kind];
  return (
    <span
      title={title}
      data-status={kind}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold ${s.wrap}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${s.dot} ${s.pulse ? "animate-breathe" : ""}`} />
      {label ?? s.label}
    </span>
  );
}

// --- skeleton ----------------------------------------------------------------

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`shimmer relative overflow-hidden rounded-lg bg-surface3 ${className}`} />;
}

/** A card-shaped loading placeholder with a few text lines. */
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="glass-card space-y-3 p-5" role="status" aria-label="Loading">
      <Skeleton className="h-4 w-1/3" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={`h-3 ${i % 2 ? "w-2/3" : "w-full"}`} />
      ))}
    </div>
  );
}

// --- tooltip -----------------------------------------------------------------

/**
 * Explains a term on hover or keyboard focus. The trigger is a real button so
 * keyboard users reach it, and the text is linked with aria-describedby.
 */
export function Tooltip({ text, children }: { text: string; children?: ReactNode }) {
  const id = useId();
  return (
    <span className="group relative inline-flex align-middle">
      <button
        type="button"
        aria-describedby={id}
        className="inline-flex items-center text-faint transition-colors hover:text-ink focus-visible:text-ink"
      >
        {children ?? <IconInfo className="h-3.5 w-3.5" />}
        <span className="visually-hidden">More information</span>
      </button>
      <span
        role="tooltip"
        id={id}
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-max max-w-[260px] -translate-x-1/2 rounded-lg border border-line bg-surface px-3 py-2 text-left text-[12px] font-normal normal-case leading-snug tracking-normal text-ink opacity-0 shadow-lift transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

// --- disclosure --------------------------------------------------------------

/** A collapsible section ("Advanced", "Details"). Closed by default. */
export function Disclosure({
  title,
  hint,
  children,
  defaultOpen = false,
  className = "",
  id,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panel = useId();
  return (
    <div id={id} className={`rounded-xl border border-line bg-surface2/60 ${className}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold text-ink">{title}</span>
          {hint ? <span className="mt-0.5 block text-[12px] text-muted">{hint}</span> : null}
        </span>
        <IconChevronDown
          className={`h-4 w-4 shrink-0 text-faint transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </button>
      <div id={panel} hidden={!open} className="border-t border-line px-4 py-4">
        {children}
      </div>
    </div>
  );
}

// --- copy --------------------------------------------------------------------

export function CopyButton({ value, label = "Copy", className = "" }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      /* clipboard blocked: the text is still selectable next to the button */
    }
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[12.5px] font-medium text-ink transition-colors hover:border-lineStrong ${className}`}
    >
      {done ? <IconCheck className="h-3.5 w-3.5 text-ready" /> : <IconCopy className="h-3.5 w-3.5" />}
      {done ? "Copied" : label}
    </button>
  );
}

/** A copyable code block: the value is selectable, the button copies it. */
export function CopyBlock({ value, label }: { value: string; label?: string }) {
  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-xl border border-line bg-surface2 px-3.5 py-2.5 font-mono text-[11.5px] leading-relaxed text-ink">
        {value}
      </pre>
      <CopyButton value={value} label={label} />
    </div>
  );
}

// --- page header -------------------------------------------------------------

export function PageHeader({
  title,
  description,
  action,
  eyebrow,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 max-w-2xl">
        {eyebrow ? (
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{eyebrow}</p>
        ) : null}
        <h1 className="font-display text-[26px] font-bold leading-tight tracking-tight text-ink">{title}</h1>
        {description ? <div className="mt-1.5 text-[14px] leading-relaxed text-muted">{description}</div> : null}
      </div>
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
    </header>
  );
}

/** A labelled metric for dashboards. */
export function Stat({
  label,
  value,
  detail,
  tooltip,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tooltip?: string;
}) {
  return (
    <div className="glass-card min-w-0 px-5 py-4">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">
        {label}
        {tooltip ? <Tooltip text={tooltip} /> : null}
      </p>
      <div className="mt-1.5 font-display text-2xl font-bold tracking-tight text-ink [font-variant-numeric:tabular-nums]">
        {value}
      </div>
      {detail ? <div className="mt-0.5 truncate text-[12.5px] text-muted">{detail}</div> : null}
    </div>
  );
}
