"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  IconAlert,
  IconCheck,
  IconKey,
  IconLink,
  IconTrash,
} from "@/components/ui/Icons";

interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
  rateLimitPerMinute?: number;
  monthlyCharQuota?: number;
  charsThisMonth: number;
  revoked: boolean;
}

interface Payload {
  keys: ApiKeyView[];
  storageConnected: boolean;
  defaultRateLimit: number;
}

function when(ts?: number): string {
  if (!ts) return "never";
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(ts).toLocaleDateString();
}

export function KeysManager() {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [rateLimit, setRateLimit] = useState("");
  const [quota, setQuota] = useState("");
  /** The one and only time the full key is visible. */
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/keys", { cache: "no-store" });
      if (res.ok) setData((await res.json()) as Payload);
    } catch {
      toast("Couldn't load API keys.", "error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          ...(rateLimit ? { rateLimitPerMinute: Number(rateLimit) } : {}),
          ...(quota ? { monthlyCharQuota: Number(quota) } : {}),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { key?: string; error?: string };
      if (!res.ok || !json.key) {
        toast(json.error ?? "Couldn't create that key.", "error");
        return;
      }
      setFreshKey(json.key);
      setName("");
      setRateLimit("");
      setQuota("");
      await load();
    } catch {
      toast("Couldn't reach the server.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: ApiKeyView) {
    if (!window.confirm(`Revoke "${key.name}"? Anything using it stops working immediately.`)) {
      return;
    }
    setBusy(true);
    try {
      await fetch(`/api/admin/keys?id=${encodeURIComponent(key.id)}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return <div className="glass-card px-5 py-8 text-center text-sm text-muted">Loading…</div>;
  }

  return (
    <div className="flex flex-col gap-5">
      {!data.storageConnected ? (
        <div className="flex gap-3 rounded-2xl border border-live/30 bg-liveSoft px-5 py-4">
          <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-live" />
          <p className="text-[13px] leading-relaxed text-ink">
            <strong>Storage isn&apos;t connected.</strong> Add the Supabase env vars in Vercel,
$1then redeploy. Keys are stored there.
          </p>
        </div>
      ) : null}

      {freshKey ? (
        <div className="glass-card overflow-hidden border-brand-600/40">
          <div className="border-b border-line bg-brand-50 px-5 py-3.5">
            <h2 className="text-[13px] font-semibold text-brand-700">
              Copy this key now — it won&apos;t be shown again
            </h2>
            <p className="mt-0.5 text-[12.5px] text-muted">
              Only a SHA-256 hash is stored, so it can&apos;t be recovered. Lost one? Revoke it and
              make another.
            </p>
          </div>
          <div className="flex items-center gap-2 px-5 py-4">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-xl border border-line bg-surface2 px-3.5 py-2.5 font-mono text-[12px] text-ink">
              {freshKey}
            </code>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(freshKey);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <IconCheck className="h-3.5 w-3.5" /> : <IconLink className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button size="sm" onClick={() => setFreshKey(null)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}

      <div className="glass-card overflow-hidden">
        <div className="border-b border-line bg-surface2 px-5 py-3.5">
          <h2 className="text-[13px] font-semibold text-ink">Create a key</h2>
          <p className="mt-0.5 text-[12.5px] text-muted">
            One per integration, so you can revoke n8n without breaking anything else.
          </p>
        </div>
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-3">
          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium text-muted" htmlFor="k-name">
              Name
            </label>
            <Input
              id="k-name"
              value={name}
              maxLength={60}
              placeholder="n8n"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium text-muted" htmlFor="k-rate">
              Requests / minute
            </label>
            <Input
              id="k-rate"
              type="number"
              min={1}
              value={rateLimit}
              placeholder={String(data.defaultRateLimit)}
              onChange={(e) => setRateLimit(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium text-muted" htmlFor="k-quota">
              Characters / month
            </label>
            <Input
              id="k-quota"
              type="number"
              min={0}
              value={quota}
              placeholder="unlimited"
              onChange={(e) => setQuota(e.target.value)}
            />
          </div>
        </div>
        <div className="flex items-center gap-3 border-t border-line bg-surface2 px-5 py-3">
          <p className="text-[12px] text-muted">Blank limits mean the platform default.</p>
          <Button
            variant="primary"
            size="sm"
            className="ml-auto"
            disabled={!name.trim() || busy || !data.storageConnected}
            onClick={() => void create()}
          >
            {busy ? "Creating…" : "Create key"}
          </Button>
        </div>
      </div>

      {data.keys.length === 0 ? (
        <div className="glass-card px-5 py-10 text-center">
          <span className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-brand-50 text-brand-600">
            <IconKey className="h-5 w-5" />
          </span>
          <p className="mt-3 text-[14px] font-medium text-ink">No API keys yet</p>
          <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-muted">
            Create one to call VoiceForge from n8n or any other automation.
          </p>
        </div>
      ) : (
        <div className="glass-card overflow-hidden">
          <div className="border-b border-line bg-surface2 px-5 py-3.5">
            <h2 className="text-[13px] font-semibold text-ink">Your keys</h2>
          </div>
          <div className="divide-y divide-line">
            {data.keys.map((k) => (
              <div key={k.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[14px] font-semibold text-ink">{k.name}</p>
                    {k.revoked ? (
                      <span className="rounded-full bg-dangerSoft px-2 py-0.5 text-[11px] font-semibold text-danger">
                        revoked
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 font-mono text-[11.5px] text-faint">{k.prefix}…</p>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
                    <span>created {when(k.createdAt)}</span>
                    <span>last used {when(k.lastUsedAt)}</span>
                    <span>
                      {k.charsThisMonth.toLocaleString()}
                      {k.monthlyCharQuota
                        ? ` / ${k.monthlyCharQuota.toLocaleString()}`
                        : ""}{" "}
                      chars this month
                    </span>
                    <span>{k.rateLimitPerMinute ?? data.defaultRateLimit}/min</span>
                  </div>
                </div>
                {!k.revoked ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void revoke(k)}
                    aria-label={`Revoke ${k.name}`}
                    className="grid h-8 w-8 place-items-center rounded-lg text-faint transition-colors hover:bg-dangerSoft hover:text-danger disabled:opacity-40"
                  >
                    <IconTrash className="h-4 w-4" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
