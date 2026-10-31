"use client";

import { useEffect, useState } from "react";
import { applyTheme, readThemePref, setThemePref, type ThemePref } from "@/lib/theme";
import { IconMonitor, IconMoon, IconSun } from "./Icons";

const OPTIONS: Array<{ value: ThemePref; label: string; Icon: typeof IconSun }> = [
  { value: "light", label: "Light", Icon: IconSun },
  { value: "dark", label: "Dark", Icon: IconMoon },
  { value: "system", label: "System", Icon: IconMonitor },
];

/**
 * Three-way theme switch (Light / Dark / System), shown in both headers.
 * A radio group: arrow keys move between options, the choice is remembered,
 * and "System" follows the OS live.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  // Starts as "system" on the server; the real choice is read after mount
  // (the inline head script has already applied it, so nothing flashes).
  const [pref, setPref] = useState<ThemePref>("system");

  useEffect(() => {
    setPref(readThemePref());
  }, []);

  // While on System, follow the OS when it switches.
  useEffect(() => {
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [pref]);

  function choose(next: ThemePref) {
    setPref(next);
    setThemePref(next);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = OPTIONS.findIndex((o) => o.value === pref);
    const next = OPTIONS[(i + (e.key === "ArrowRight" ? 1 : OPTIONS.length - 1)) % OPTIONS.length];
    choose(next.value);
    (e.currentTarget.querySelector(`[data-value="${next.value}"]`) as HTMLButtonElement | null)?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={onKeyDown}
      className={`inline-flex items-center gap-0.5 rounded-xl border border-line bg-surface2 p-0.5 ${className}`}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const on = pref === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={label}
            title={`${label} theme`}
            data-value={value}
            tabIndex={on ? 0 : -1}
            onClick={() => choose(value)}
            className={`grid h-7 w-7 place-items-center rounded-lg transition-colors ${
              on ? "bg-surface text-ink shadow-card" : "text-faint hover:text-ink"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}
