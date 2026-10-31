import type { Metadata } from "next";
import { LibraryView } from "@/components/views/LibraryView";

export const metadata: Metadata = { title: "My Library · VoiceForge" };

export default function Page() {
  return <LibraryView />;
}
