import type { Metadata } from "next";
import { HomeView } from "@/components/views/HomeView";

export const metadata: Metadata = { title: "Studio · VoiceForge" };

export default function StudioHome() {
  return <HomeView />;
}
