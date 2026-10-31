import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/studio",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

import { GpuOfflineNotice } from "@/components/studio/GpuOfflineNotice";
import { gpuState } from "@/components/studio/GpuStatus";
import { StudioProvider } from "@/components/studio/StudioContext";
import { StudioShell } from "@/components/studio/StudioShell";
import { clipMinutesLeft } from "@/components/views/ClipView";

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
}

describe("studio for a viewer who is not the admin", () => {
  const html = renderToString(
    <StudioShell isAdmin={false}>
      <p>page</p>
    </StudioShell>
  );

  it("has no links into /admin and no section switch", () => {
    expect(hrefs(html).filter((h) => h.startsWith("/admin"))).toEqual([]);
    expect(html).not.toContain("Go to Admin");
    expect(html).not.toContain('data-testid="section-switch"');
  });

  it("still has every studio tool in the navigation", () => {
    for (const h of ["/studio", "/studio/speech", "/studio/presenter", "/studio/ai-video", "/studio/library"]) {
      expect(hrefs(html)).toContain(h);
    }
  });

  it("offline notice offers no admin link", () => {
    const notice = renderToString(
      <StudioProvider value={{ isAdmin: false }}>
        <GpuOfflineNotice />
      </StudioProvider>
    );
    expect(notice).toContain("Check again");
    expect(notice).not.toContain("/admin");
  });
});

describe("studio for the admin", () => {
  it("shows the one switch into Admin", () => {
    const html = renderToString(
      <StudioShell isAdmin>
        <p>page</p>
      </StudioShell>
    );
    expect(html).toContain('data-testid="section-switch"');
    expect(hrefs(html)).toContain("/admin");
  });

  it("offline notice links to Backends", () => {
    const notice = renderToString(
      <StudioProvider value={{ isAdmin: true }}>
        <GpuOfflineNotice />
      </StudioProvider>
    );
    expect(notice).toContain('href="/admin/backends"');
  });
});

describe("GPU status words", () => {
  it("is Offline, Busy or Ready", () => {
    expect(gpuState({ connected: false }, false)).toBe("offline");
    expect(gpuState({ connected: false, health: "busy" }, true)).toBe("offline");
    expect(gpuState({ connected: true }, true)).toBe("busy");
    expect(gpuState({ connected: true, health: "busy" }, false)).toBe("busy");
    expect(gpuState({ connected: true, health: "online" }, false)).toBe("ready");
  });
});

describe("AI video time left", () => {
  it("waits for enough progress before estimating", () => {
    expect(clipMinutesLeft(5, 60)).toBeNull();
    expect(clipMinutesLeft(50, null)).toBeNull();
    expect(clipMinutesLeft(100, 600)).toBeNull();
  });
  it("extrapolates and never says zero", () => {
    expect(clipMinutesLeft(50, 300)).toBe(5);
    expect(clipMinutesLeft(25, 120)).toBe(6);
    expect(clipMinutesLeft(99, 600)).toBe(1);
  });
});
