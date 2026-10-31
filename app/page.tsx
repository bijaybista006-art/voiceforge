import { redirect } from "next/navigation";

/**
 * The studio used to live here as one page that swapped views in memory. It
 * now has real addresses under /studio. next.config.ts redirects "/" before
 * this runs; this is the fallback if that config is ever bypassed.
 */
export default function Root() {
  redirect("/studio");
}
