import { AdminPage } from "@/components/admin/AdminShell";
import { JobsList } from "@/components/admin/JobsList";

export const dynamic = "force-dynamic";

export default function JobsPage() {
  return (
    <AdminPage
      title="Jobs"
      description="Every narration, presenter clip and AI video render. Play it, download it, or see why it failed."
    >
      <JobsList />
    </AdminPage>
  );
}
