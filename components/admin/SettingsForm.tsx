"use client";

import { useState } from "react";
import { LANGUAGES, MODEL_INFO } from "@/lib/config";
import { formatPronunciations, parsePronunciations } from "@/lib/normalize";
import { toast } from "@/lib/toast";
import type { ModelId } from "@/lib/types";
import type { PlatformSettings } from "@/lib/server/redis";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-line px-5 py-4 last:border-0 sm:grid sm:grid-cols-[220px_minmax(0,1fr)] sm:items-start sm:gap-6">
      <div className="mb-2 sm:mb-0">
        <p className="text-[13.5px] font-semibold text-ink">{label}</p>
        {hint ? <p className="mt-0.5 text-[12.5px] leading-snug text-muted">{hint}</p> : null}
      </div>
      <div className="max-w-sm">{children}</div>
    </div>
  );
}

export function SettingsForm({
  initial,
  canSave,
}: {
  initial: PlatformSettings;
  canSave: boolean;
}) {
  const [values, setValues] = useState<PlatformSettings>(initial);
  // Edited as plain text and parsed on the way out, so a half-typed line is
  // never "invalid" while you are still typing it.
  const [pronunciationText, setPronunciationText] = useState(() =>
    formatPronunciations(initial.pronunciations)
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  function patch(next: Partial<PlatformSettings>) {
    setValues((v) => ({ ...v, ...next }));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast(data.error ?? "Couldn't save settings.", "error");
        return;
      }
      setDirty(false);
      toast("Settings saved.", "success");
    } catch {
      toast("Couldn't reach the server.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="glass-card overflow-hidden">
      <Field
        label="Default model"
        hint="Used by the studio and the public API when a request doesn't name one."
      >
        <Select
          value={values.defaultModel}
          onChange={(e) => patch({ defaultModel: e.target.value as ModelId })}
        >
          {(Object.keys(MODEL_INFO) as ModelId[]).map((id) => (
            <option key={id} value={id}>
              {MODEL_INFO[id].name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Default language" hint="Nepali uses its own fine-tuned model, with a Hindi fallback.">
        <Select
          value={values.defaultLanguage}
          onChange={(e) => patch({ defaultLanguage: e.target.value })}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Audio retention"
        hint="Generated audio is deleted from storage after this many days."
      >
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            max={365}
            value={values.retentionDays}
            onChange={(e) =>
              patch({ retentionDays: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })
            }
            className="w-28 font-mono tabular-nums"
          />
          <span className="text-[13px] text-muted">days</span>
        </div>
      </Field>

      <Field
        label="Kaggle notebook URL"
        hint="Shown in the Backends connect dialog once that page exists."
      >
        <Input
          type="url"
          placeholder="https://www.kaggle.com/code/…"
          value={values.kaggleNotebookUrl}
          onChange={(e) => patch({ kaggleNotebookUrl: e.target.value })}
          className="font-mono text-xs"
        />
      </Field>

      <div className="border-b border-line px-5 py-4">
        <p className="text-[13.5px] font-semibold text-ink">Pronunciations</p>
        <p className="mt-0.5 max-w-2xl text-[12.5px] leading-snug text-muted">
          English words the voice says wrongly, and how to write them so it says them right. One
          per line, as <code className="font-mono">word = spoken form</code>. Spell the spoken form
          the way it sounds, using ordinary words. A word in capitals, like{" "}
          <code className="font-mono">IT</code>, only matches in capitals. Applies to the studio and
          the API; your entries override the built-in ones.
        </p>
        <textarea
          value={pronunciationText}
          rows={7}
          spellCheck={false}
          placeholder={"Copilot = co-pilot\nAI = ay eye\nAzure = azh-er\nSQL = sequel"}
          onChange={(e) => {
            setPronunciationText(e.target.value);
            patch({ pronunciations: parsePronunciations(e.target.value) });
          }}
          className="mt-3 w-full max-w-2xl resize-y rounded-xl border border-line bg-white px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed text-ink outline-none transition-colors placeholder:text-faint focus:border-brand-600"
        />
        <p className="mt-1.5 text-[12px] text-faint">
          {Object.keys(values.pronunciations ?? {}).length} of 200 entries. Takes effect on the
          next thing you generate.
        </p>
      </div>

      <div className="flex items-center justify-between gap-4 bg-surface2 px-5 py-3.5">
        <p className="text-[12.5px] text-muted">
          {!canSave
            ? "Connect Upstash Redis to save changes."
            : dirty
              ? "You have unsaved changes."
              : "All changes saved."}
        </p>
        <Button variant="primary" disabled={!canSave || saving || !dirty} onClick={() => void save()}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}
