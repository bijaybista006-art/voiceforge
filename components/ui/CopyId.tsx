"use client";

import { useState } from "react";
import { IconCheck } from "./Icons";

/**
 * An id you are meant to paste somewhere else — a workflow, an API call.
 *
 * Shown in full and in monospace, because the point is to copy it exactly,
 * and the whole thing is the button: nobody should have to select eight hex
 * characters by hand.
 */
export function CopyId({ id, label = "ID" }: { id: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be refused (an insecure origin, a denied
      // permission). The id is still on screen to select by hand.
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title="Copy this id"
      aria-label={`Copy ${label} ${id}`}
      className="group inline-flex max-w-full items-center gap-2 rounded-lg border border-line bg-surface2 px-2 py-1 text-left transition-colors hover:border-lineStrong"
    >
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-faint">
        {label}
      </span>
      <span className="truncate font-mono text-[11.5px] text-ink">{id}</span>
      <span className="shrink-0 text-[10.5px] font-medium text-muted group-hover:text-ink">
        {copied ? (
          <span className="inline-flex items-center gap-1 text-ready">
            <IconCheck className="h-3 w-3" />
            Copied
          </span>
        ) : (
          "Copy"
        )}
      </span>
    </button>
  );
}
