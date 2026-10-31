import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { isAuthConfigured } from "@/lib/server/auth";

export const metadata: Metadata = { title: "Admin · VoiceForge" };

export default function AdminLayout({ children }: { children: ReactNode }) {
  // Sign out only means something once the login gate is switched on.
  return <AdminShell canSignOut={isAuthConfigured()}>{children}</AdminShell>;
}
