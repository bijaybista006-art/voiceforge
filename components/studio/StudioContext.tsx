"use client";

import { createContext, useContext } from "react";

/**
 * Whether the person using the studio is the admin.
 *
 * VoiceForge has exactly one account (the admin password). When login is set
 * up, the server computes this from the existing session cookie in
 * app/studio/layout.tsx; when it isn't set up, the whole site is open and
 * everyone already reaches /admin, so this is true. Studio pages use it only to
 * decide whether to show links into the admin section — never for security,
 * which stays in middleware.ts.
 */
const StudioContext = createContext<{ isAdmin: boolean }>({ isAdmin: false });

export const StudioProvider = StudioContext.Provider;

export function useIsAdmin(): boolean {
  return useContext(StudioContext).isAdmin;
}
