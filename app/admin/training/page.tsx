import { AdminPage } from "@/components/admin/AdminShell";
import { TrainingManager } from "@/components/admin/TrainingManager";

export const dynamic = "force-dynamic";

export default function TrainingPage() {
  return (
    <AdminPage
      title="Training data"
      description="Recordings for training the model, kept separate from your voice library. Each clip is the audio, its exact transcript and optional notes. About 30 minutes per speaker and language is enough for a first training run."
    >
      <TrainingManager />
    </AdminPage>
  );
}
