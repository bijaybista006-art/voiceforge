import { headers } from "next/headers";
import { AdminPage } from "@/components/admin/AdminShell";
import { BackendsManager } from "@/components/admin/BackendsManager";

export const dynamic = "force-dynamic";

/**
 * The connect snippet needs this deployment's own public URL to paste into a
 * notebook. Prefer Vercel's env var; fall back to the request host so it's
 * correct on localhost and on preview deployments too.
 */
async function appUrl(): Promise<string> {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = host.startsWith("localhost") ? "http" : "https";
  return `${proto}://${host}`;
}

export default async function BackendsPage() {
  return (
    <AdminPage
      title="Backends"
      description="The GPUs that do the work. See what's serving right now, switch features on or off per GPU, and connect new ones."
      wide
    >
      <BackendsManager appUrl={await appUrl()} />
    </AdminPage>
  );
}
