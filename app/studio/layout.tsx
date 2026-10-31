import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { StudioShell } from "@/components/studio/StudioShell";
import { SESSION_COOKIE, isAuthConfigured, verifySessionToken } from "@/lib/server/auth";

export const metadata: Metadata = { title: "Studio · VoiceForge" };

/**
 * Is the viewer the admin? There is one account (the admin password), so this
 * reuses the existing session check — no role system. With login not set up,
 * the site is open and /admin is already reachable by anyone, so the switch is
 * shown. Security stays in middleware.ts; this only decides whether to show
 * the "Go to Admin" button.
 */
async function viewerIsAdmin(): Promise<boolean> {
  if (!isAuthConfigured()) return true;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return verifySessionToken(token);
}

export default async function StudioLayout({ children }: { children: ReactNode }) {
  return <StudioShell isAdmin={await viewerIsAdmin()}>{children}</StudioShell>;
}
