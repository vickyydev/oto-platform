/**
 * SCRUM-978 — THE SIGN-IN DIAGNOSTICS STAY ON THE DEVELOPER'S MACHINE.
 *
 * The app wrote "[auth-diag]" lines to the browser's console on every page
 * load, in the live build too, one of them the signed-in person's own record
 * (`/api/user`: id, e-mail address, full name and more). Now they are written
 * only while the app runs under Vite's development server
 * (`import.meta.env.DEV`); a built app writes none. No line, even then,
 * holds more of a person than their id and role.
 */
export function authDiag(...args: unknown[]): void {
  if (import.meta.env?.DEV === true) console.log(...args);
}
