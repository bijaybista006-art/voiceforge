"use client";

/**
 * The frame shared by both sections of the product.
 *
 *   Studio (/studio/...)  blue accent, friendly GPU status, for making things.
 *   Admin  (/admin/...)   violet accent and an "Admin" badge, for running it.
 *
 * Same structure, tokens and components, so they read as one product; each
 * section passes its own navigation, header controls and accent, so they never
 * mix. On phones the sidebar becomes a slide-over menu.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmHost } from "@/components/ui/ConfirmHost";
import { IconMenu, IconWave, IconX } from "@/components/ui/Icons";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Toaster } from "@/components/ui/Toast";

export interface NavItem {
  href: string;
  label: string;
  Icon: (p: { className?: string }) => ReactNode;
  /** Pages under this path also mark the item active (default: exact match). */
  matchPrefix?: boolean;
  /** Use the video (violet) active style in the studio. */
  video?: boolean;
  badge?: ReactNode;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

function isActive(pathname: string, item: NavItem): boolean {
  if (pathname === item.href) return true;
  return Boolean(item.matchPrefix) && pathname.startsWith(`${item.href}/`);
}

function Brand({ section, compact = false }: { section: "studio" | "admin"; compact?: boolean }) {
  return (
    <Link
      href={section === "admin" ? "/admin" : "/studio"}
      className="flex items-center gap-2.5 rounded-lg"
      aria-label={section === "admin" ? "VoiceForge admin home" : "VoiceForge studio home"}
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 text-white shadow-lg shadow-brand-500/20">
        <IconWave className="h-4 w-4" />
      </span>
      <span className={`gradient-text text-[17px] ${compact ? "hidden sm:inline" : ""}`}>VoiceForge</span>
      {section === "admin" ? (
        <span className="rounded-md border border-video/30 bg-videoSoft px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-video">
          Admin
        </span>
      ) : null}
    </Link>
  );
}

function NavList({
  sections,
  pathname,
  onNavigate,
}: {
  sections: NavSection[];
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      {sections.map((s) => (
        <div key={s.label}>
          <p className="mb-1.5 px-3 text-[10.5px] font-semibold uppercase tracking-[0.13em] text-faint">
            {s.label}
          </p>
          <ul className="flex flex-col gap-0.5">
            {s.items.map((item) => {
              const active = isActive(pathname, item);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={`sidebar-link ${active ? (item.video ? "active active-video" : "active") : ""}`}
                  >
                    <item.Icon className="h-[18px] w-[18px] shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.badge}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function AppShell({
  section,
  sections,
  headerExtra,
  sidebarFooter,
  children,
}: {
  section: "studio" | "admin";
  sections: NavSection[];
  /** Section-specific header controls, shown before the theme toggle. */
  headerExtra?: ReactNode;
  sidebarFooter?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const [menuOpen, setMenuOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Close the phone menu on navigation, and with Escape; focus moves into it.
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [menuOpen]);

  const navLabel = section === "admin" ? "Admin" : "Studio";

  return (
    <div className="min-h-screen bg-bg" data-section={section}>
      <a
        href="#main"
        className="visually-hidden focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:h-auto focus:w-auto focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:shadow-lift"
      >
        Skip to content
      </a>

      {/* ---------- sidebar (desktop) ---------- */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 hidden w-[248px] flex-col border-r border-line bg-surface lg:flex ${
          section === "admin" ? "sidebar-admin" : ""
        }`}
      >
        <div className="flex h-16 shrink-0 items-center border-b border-line px-5">
          <Brand section={section} />
        </div>
        <nav aria-label={navLabel} className="min-h-0 flex-1 overflow-y-auto px-3 py-5">
          <NavList sections={sections} pathname={pathname} />
        </nav>
        {sidebarFooter ? <div className="shrink-0 border-t border-line p-3">{sidebarFooter}</div> : null}
      </aside>

      {/* ---------- phone menu ---------- */}
      {menuOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={`${navLabel} menu`}>
          <button
            type="button"
            aria-label="Close menu"
            tabIndex={-1}
            onClick={() => setMenuOpen(false)}
            className="absolute inset-0 bg-[rgb(var(--overlay)/0.45)] backdrop-blur-sm"
          />
          <div
            className={`absolute inset-y-0 left-0 flex w-[min(300px,86vw)] animate-fade-up flex-col border-r border-line bg-surface shadow-lift ${
              section === "admin" ? "sidebar-admin" : ""
            }`}
          >
            <div className="flex h-16 shrink-0 items-center justify-between border-b border-line px-4">
              <Brand section={section} />
              <button
                ref={closeRef}
                type="button"
                onClick={() => setMenuOpen(false)}
                aria-label="Close menu"
                className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-surface3 hover:text-ink"
              >
                <IconX className="h-4 w-4" />
              </button>
            </div>
            <nav aria-label={navLabel} className="min-h-0 flex-1 overflow-y-auto px-3 py-5">
              <NavList sections={sections} pathname={pathname} onNavigate={() => setMenuOpen(false)} />
            </nav>
            {sidebarFooter ? <div className="shrink-0 border-t border-line p-3">{sidebarFooter}</div> : null}
          </div>
        </div>
      ) : null}

      {/* ---------- main column ---------- */}
      <div className="flex min-h-screen min-w-0 flex-col lg:pl-[248px]">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-line bg-bg/85 px-3 backdrop-blur-xl sm:gap-3 sm:px-6">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
            aria-expanded={menuOpen}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface3 hover:text-ink lg:hidden"
          >
            <IconMenu className="h-5 w-5" />
          </button>
          <div className="min-w-0 lg:hidden">
            <Brand section={section} compact />
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
            {headerExtra}
            <ThemeToggle />
          </div>
        </header>

        <main id="main" className="min-w-0 flex-1">
          {children}
        </main>
      </div>

      <Toaster />
      <ConfirmHost />
    </div>
  );
}

/** A header button that moves between the two sections ("Go to Admin" / "Go to Studio"). */
export function SectionSwitch({ to }: { to: "studio" | "admin" }) {
  return (
    <Link
      href={to === "admin" ? "/admin" : "/studio"}
      data-testid="section-switch"
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-[13px] font-semibold text-ink transition-colors hover:border-lineStrong"
    >
      <span className="hidden sm:inline">{to === "admin" ? "Go to Admin" : "Go to Studio"}</span>
      <span className="sm:hidden">{to === "admin" ? "Admin" : "Studio"}</span>
    </Link>
  );
}
