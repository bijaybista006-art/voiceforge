"use client";

import Link from "next/link";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/Button";
import { IconAlert } from "@/components/ui/Icons";
import { useIsAdmin } from "./StudioContext";

/**
 * Shown on a studio page when no GPU is online. Plain words, no addresses or
 * GPU names; the admin also gets a way to the Backends page to fix it.
 */
export function GpuOfflineNotice({ what = "generate" }: { what?: string }) {
  const connect = useApp((s) => s.connect);
  const connecting = useApp((s) => s.connecting);
  const isAdmin = useIsAdmin();

  return (
    <div
      role="status"
      data-testid="gpu-offline-notice"
      className="flex flex-wrap items-start gap-3 rounded-2xl border border-line bg-surface px-5 py-4 shadow-card"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-surface3 text-muted">
        <IconAlert className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold text-ink">No GPU is running right now</p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted">
          You can write and set everything up now; you&apos;ll be able to {what} as soon as a GPU comes online. This
          page checks again automatically.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void connect()} disabled={connecting}>
          {connecting ? "Checking…" : "Check again"}
        </Button>
        {isAdmin ? (
          <Link
            href="/admin/backends"
            className="inline-flex h-8 items-center rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-ink transition-colors hover:border-lineStrong"
          >
            Start a GPU
          </Link>
        ) : null}
      </div>
    </div>
  );
}
