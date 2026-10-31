import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * UI v2 gave the studio real addresses under /studio. The old studio was
   * one page at "/" that switched views in memory (ids: home, speech, video,
   * clips); those keep working as redirects. Admin addresses are unchanged.
   */
  async redirects() {
    return [
      { source: "/", destination: "/studio", permanent: false },
      { source: "/studio/home", destination: "/studio", permanent: false },
      { source: "/studio/video", destination: "/studio/presenter", permanent: false },
      { source: "/studio/clips", destination: "/studio/ai-video", permanent: false },
      { source: "/speech", destination: "/studio/speech", permanent: false },
      { source: "/presenter", destination: "/studio/presenter", permanent: false },
      { source: "/ai-video", destination: "/studio/ai-video", permanent: false },
      { source: "/library", destination: "/studio/library", permanent: false },
    ];
  },
};

export default nextConfig;
