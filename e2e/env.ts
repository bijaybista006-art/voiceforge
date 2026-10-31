/** Shared by playwright.config.ts and the specs. Test-only values. */
export const PORT = Number(process.env.E2E_PORT ?? 3123);
export const AUTH_PORT = PORT + 1;
export const AUTH_BASE = `http://localhost:${AUTH_PORT}`;
export const E2E_AUTH = { password: "e2e-password-123", secret: "e2e-session-secret-0123456789abcdef" };
