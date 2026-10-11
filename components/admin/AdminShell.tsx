"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import {
  IconArrowRight,
  IconHome,
  IconImage,
  IconKey,
  IconLink,
  IconMic,
  IconScript,
  IconSettings,
  IconSparkle,
  IconVideo,
  IconWave,
} from "@/components/ui/Icons";

/**
 * Admin chrome — mirrors Tech Notebook's layout: fixed white sidebar with a
 * gradient logo badge, uppercase section headers, and Windows-11 style links
 * whose active state is a tinted pill plus a left accent bar.
 */

interface NavItem {
  href: string;
  label: string;
  Icon: typeof IconHome;
  /** Pages that don't exist until a later phase are shown but disabled. */
  soon?: boolean;
}

const PLATFORM: NavItem[] = [
  { href: "/admin", label: "Dashboard", Icon: IconHome },
  { href: "/admin/backends", label: "Backends", Icon: IconLink },
  { href: "/admin/voices", label: "Voices", Icon: IconMic },
  { href: "/admin/assets", label: "Assets", Icon: IconImage },
  { href: "/admin/presenters", label: "Presenters", Icon: IconVideo },
];

const DEVELOPER: NavItem[] = [
  { href: "/admin/keys", label: "API Keys", Icon: IconKey },
  { href: "/admin/jobs", label: "Jobs", Icon: IconSparkle },
  { href: "/admin/api", label: "API & n8n", Icon: IconScript },
  { href: "/admin/settings", label: "Settings", Icon: IconSettings },
];

function SectionHeader({ label }: { label: string }) {
  return (
    <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-faint">
      {label}
    </p>
  );
}

function NavRow({ item, active }: { item: NavItem; active: boolean }) {
  const { Icon } = item;
  if (item.soon) {
    return (
      <span
        className="sidebar-link cursor-not-allowed opacity-45"
        title="Arrives in a later phase"
      >
        <Icon className="h-[18px] w-[18px] shrink-0" />
        <span className="flex-1 truncate">{item.label}</span>
        <span className="rounded-full bg-surface3 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-faint">
          soon
        </span>
      </span>
    );
  }
  return (
    <Link href={item.href} className={`sidebar-link ${active ? "active" : ""}`}>
      <Icon className="h-[18px] w-[18px] shrink-0" />
      <span className="flex-1 truncate">{item.label}</span>
    </Link>
  );
}

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    await fetch("/api/admin/session", { method: "DELETE" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen bg-bg">
      <aside className="fixed left-0 top-0 z-40 hidden h-screen w-[264px] flex-col border-r border-line bg-white lg:flex">
        <div className="flex h-16 shrink-0 items-center gap-2.5 border-b border-line px-5">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 shadow-lg shadow-brand-500/20">
            <IconWave className="h-4 w-4 text-white" />
          </span>
          <span className="gradient-text text-lg">VoiceForge</span>
        </div>

        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
          <SectionHeader label="Platform" />
          <div className="space-y-0.5">
            {PLATFORM.map((item) => (
              <NavRow key={item.href} item={item} active={pathname === item.href} />
            ))}
          </div>

          <div className="pt-4">
            <SectionHeader label="Developer" />
            <div className="space-y-0.5">
              {DEVELOPER.map((item) => (
                <NavRow key={item.href} item={item} active={pathname === item.href} />
              ))}
            </div>
          </div>
        </nav>

        <div className="shrink-0 space-y-1 border-t border-line p-3">
          <Link href="/" className="sidebar-link">
            <IconArrowRight className="h-[18px] w-[18px] shrink-0" />
            <span className="flex-1 truncate">Open studio</span>
          </Link>
          <button type="button" onClick={signOut} className="sidebar-link w-full text-left">
            <span className="flex-1 truncate">Sign out</span>
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col lg:pl-[264px]">
        {/* mobile bar */}
        <header className="flex h-16 items-center gap-3 border-b border-line bg-white px-4 lg:hidden">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-500">
            <IconWave className="h-4 w-4 text-white" />
          </span>
          <span className="gradient-text text-base">VoiceForge</span>
          <Link
            href="/"
            className="ml-auto rounded-lg px-3 py-1.5 text-[13px] font-medium text-muted hover:bg-surface3 hover:text-ink"
          >
            Studio
          </Link>
        </header>

        {/* mobile nav strip */}
        <nav className="flex gap-1 overflow-x-auto border-b border-line bg-white px-3 py-2 no-scrollbar lg:hidden">
          {[...PLATFORM, ...DEVELOPER]
            .filter((i) => !i.soon)
            .map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-[13px] font-medium ${
                  pathname === item.href
                    ? "bg-brand-50 text-brand-700"
                    : "text-muted hover:text-ink"
                }`}
              >
                {item.label}
              </Link>
            ))}
        </nav>

        <main className="min-h-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

export function AdminPage({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink">{title}</h1>
          {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </div>
  );
}
