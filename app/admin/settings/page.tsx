import { AdminPage } from "@/components/admin/AdminShell";
import { SettingsForm } from "@/components/admin/SettingsForm";
import { getSettings, isRedisConfigured } from "@/lib/server/redis";
import { IconAlert } from "@/components/ui/Icons";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const connected = isRedisConfigured();
  const settings = await getSettings();

  return (
    <AdminPage
      title="Settings"
      description="Platform defaults. These apply to the studio and, later, the public API."
    >
      {!connected ? (
        <div className="mb-5 flex gap-3 rounded-2xl border border-live/30 bg-liveSoft px-5 py-4">
          <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-live" />
          <p className="text-[13px] leading-relaxed text-ink">
            <strong>Storage isn&apos;t connected.</strong> You can see the defaults below, but
            changes can&apos;t be saved yet. Add the Supabase env vars in Vercel
            (free), then redeploy.
          </p>
        </div>
      ) : null}
      <SettingsForm initial={settings} canSave={connected} />
    </AdminPage>
  );
}
