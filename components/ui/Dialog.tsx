"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { IconX } from "./Icons";

export interface DialogProps {
  open: boolean;
  title: string;
  description?: string;
  onClose(): void;
  children: ReactNode;
  wide?: boolean;
}

export function Dialog({ open, title, description, onClose, children, wide }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(var(--overlay)/0.45)] p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`relative max-h-[86vh] w-full ${
          wide ? "max-w-2xl" : "max-w-md"
        } animate-fade-up overflow-y-auto rounded-2xl border border-line bg-surface p-6 shadow-lift`}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px hairline" />
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-base font-semibold text-ink">{title}</h2>
            {description ? (
              <p className="mt-1 text-[13px] leading-relaxed text-muted">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="-mr-1 -mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-faint transition-colors hover:bg-surface2 hover:text-ink"
          >
            <IconX className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
