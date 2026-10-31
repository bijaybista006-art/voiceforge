/**
 * Request schema for PATCH /api/admin/backends.
 *
 * It lives here rather than in the route so it can be unit-tested — a route
 * file may only export handlers, and this schema has a sharp edge worth
 * pinning down (see the ordering note below).
 */

import { z } from "zod";

export const providerSchema = z.enum(["modal", "colab", "kaggle", "custom"]);

/**
 * ORDER AND .strict() ARE LOad-BEARING.
 *
 * z.union returns the first member that validates, and a plain z.object
 * strips keys it doesn't know about. With the enable/priority variant listed
 * first, a {provider, url} body matched it, `url` was silently dropped, and
 * the handler tried to *update* a backend that didn't exist yet — so adding
 * Modal or a custom URL failed with "Unknown backend" and looked like a dead
 * button.
 *
 * The url variant therefore comes first, and every member is .strict() so an
 * unexpected key fails loudly instead of being discarded.
 */
export const backendPatchSchema = z.union([
  z
    .object({
      // Modal and Custom are registered by hand: Modal's URL is permanent and
      // printed by `modal deploy`, so it never self-registers.
      provider: z.enum(["modal", "custom"]),
      url: z.string().url().max(500),
    })
    .strict(),
  z.object({ active: z.union([z.literal("auto"), providerSchema]) }).strict(),
  z
    .object({
      provider: providerSchema,
      enabled: z.boolean().optional(),
      /** The Presenter switch (name kept from before AI video existed). */
      videoEnabled: z.boolean().optional(),
      /** The Voice switch. */
      voiceEnabled: z.boolean().optional(),
      /** The AI video switch. */
      clipsEnabled: z.boolean().optional(),
      priority: z.number().int().min(0).max(99).optional(),
    })
    .strict(),
]);

export type BackendPatch = z.infer<typeof backendPatchSchema>;
