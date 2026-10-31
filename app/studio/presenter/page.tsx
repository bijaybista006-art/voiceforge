import type { Metadata } from "next";
import { VideoView } from "@/components/views/VideoView";

export const metadata: Metadata = { title: "Presenter Video · VoiceForge" };

export default function Page() {
  return <VideoView />;
}
