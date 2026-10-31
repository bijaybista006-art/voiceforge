"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell, SectionSwitch, type NavSection } from "@/components/layout/AppShell";
import {
  IconGrid,
  IconKey,
  IconLogout,
  IconMic,
  IconScript,
  IconServer,
  IconSettings,
  IconSparkle,
  IconVideo,
  IconWave,
} from "@/components/ui/Icons";
import { PageHeader } from "@/components/ui/Kit";

/**
 * The admin frame: platform management only, never creation tools. Violet
 * accent and an "Admin" badge (see AppShell) keep it visibly apart from the
 * studio; "Go to Studio" is the one way across.
 */
const SECTIONS: NavSection[] = [
  {
    label: "Overview",
    items: [{ href: "/admin", label: "Dashboard", Icon: IconGrid }],
  },
  {
    label: "GPU",
    items: [{ href: "/admin/backends", label: "Backends", Icon: IconServer }],
  },
  {
    label: "Library",
    items: [
      { href: "/admin/voices", label: "Voices", Icon: IconMic },
      { href: "/admin/presenters", label: "Presenters", Icon: IconVideo },
    ],
  },
  {
    // Kept apart from Voices: recordings collected to train a model.
    label: "Model training",
    items: [{ href: "/admin/training", label: "Training data", Icon: IconWave }],
  },
  {
    label: "Developer",
    items: [
      { href: "/admin/keys", label: "API Keys", Icon: IconKey },
      { href: "/admin/jobs", label: "Jobs", Icon: IconSparkle },
      { href: "/admin/api", label: "API & n8n", Icon: IconScript },
    ],
  },
  {
    label: "Platform",
    items: [{ href: "/admin/settings", label: "Settings", Icon: IconSettings }],
  },
];

export function AdminShell({ children, canSignOut }: { children: ReactNode; canSignOut: boolean }) {
  const router = useRouter();

  async function signOut() {
    await fetch("/api/admin/session", { method: "DELETE" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <AppShell
      section="admin"
      sections={SECTIONS}
      headerExtra={<SectionSwitch to="studio" />}
      sidebarFooter={
        canSignOut ? (
          <button type="button" onClick={() => void signOut()} className="sidebar-link w-full text-left">
            <IconLogout className="h-[18px] w-[18px] shrink-0" />
            <span className="flex-1 truncate">Sign out</span>
          </button>
        ) : (
          <p className="px-2 text-[11.5px] leading-relaxed text-faint">
            Login isn&apos;t set up, so there&apos;s nothing to sign out of. See the Dashboard.
          </p>
        )
      }
    >
      {children}
    </AppShell>
  );
}

/** The standard admin page frame: title, plain-English description, optional action. */
export function AdminPage({
  title,
  description,
  children,
  action,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`mx-auto w-full ${wide ? "max-w-6xl" : "max-w-5xl"} px-4 py-8 sm:px-6 lg:py-10`}>
      <PageHeader title={title} description={description} action={action} eyebrow="Admin" />
      {children}
    </div>
  );
}
