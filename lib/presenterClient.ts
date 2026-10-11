"use client";

/**
 * What the studio needs to know about presenter video: which presenters
 * exist, and whether anything connected can render each kind right now.
 *
 * One read of the admin endpoint, shared by the Home card and the Presenter
 * Video page. There is deliberately no URL to paste and no local state to
 * keep in sync — presenters and backends both live on the server, exactly as
 * voices do.
 */

import { useCallback, useEffect, useState } from "react";
import type { PresenterKind, PresenterView } from "./types";

export interface PresenterReadinessInfo {
  ready: boolean;
  provider?: string;
  reason?: string;
}

export interface PresenterStatus {
  presenters: PresenterView[];
  readiness: Record<PresenterKind, PresenterReadinessInfo>;
  hint: string | null;
}

export function usePresenterStatus(): {
  status: PresenterStatus | null;
  failed: boolean;
  reload: () => void;
} {
  const [status, setStatus] = useState<PresenterStatus | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/presenters", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setStatus((await res.json()) as PresenterStatus);
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

/** True when at least one kind of presenter could be rendered right now. */
export function anyPresenterReady(status: PresenterStatus | null): boolean {
  return Boolean(status && (status.readiness.recording.ready || status.readiness.image.ready));
}
