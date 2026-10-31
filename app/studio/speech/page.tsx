import type { Metadata } from "next";
import { SpeechView } from "@/components/views/SpeechView";

export const metadata: Metadata = { title: "Text to Speech · VoiceForge" };

export default function Page() {
  return <SpeechView />;
}
