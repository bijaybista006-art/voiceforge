import type { Metadata } from "next";
import { ClipView } from "@/components/views/ClipView";

export const metadata: Metadata = { title: "AI Video · VoiceForge" };

export default function Page() {
  return <ClipView />;
}
