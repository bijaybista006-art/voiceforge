import { AdminPage } from "@/components/admin/AdminShell";
import { PresentersManager } from "@/components/admin/PresentersManager";

export const dynamic = "force-dynamic";

export default function PresentersPage() {
  return (
    <AdminPage
      title="Presenters"
      description="The faces for lip-synced intro and outro clips. Upload a short recording or a still image once — every backend reads from here."
    >
      <PresentersManager />
    </AdminPage>
  );
}
