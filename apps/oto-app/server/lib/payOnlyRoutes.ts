/**
 * What a login in pay only may ask the server for (SCRUM-769), with no imports
 * so the fence (`./payOnlyAccess.ts`) and the checks read the same list.
 *
 * Who is signed in, signing out, the launcher hand-off and the theme it
 * carries, the person's own payslips (the list and each file:
 * `server/payroll/routes.ts`, which answers only the caller's own), and the
 * token pages for signing a contract or a letter, which read no session at
 * all (a leaver may still have a letter to sign). Matched on the whole path,
 * lower-cased and without a trailing slash, as Express routes it; a HEAD is
 * its GET.
 */
const PAY_ONLY_ROUTES: ReadonlyArray<{ methods: readonly string[]; path: RegExp }> = [
  { methods: ["GET"], path: /^\/api\/user$/ },
  { methods: ["POST"], path: /^\/api\/logout$/ },
  { methods: ["GET"], path: /^\/api\/auth\/sign-in-options$/ },
  { methods: ["POST"], path: /^\/api\/auth\/handoff$/ },
  { methods: ["PUT"], path: /^\/api\/platform\/preferences$/ },
  { methods: ["GET"], path: /^\/api\/payroll\/me\/payslips(\/[^/]+)?$/ },
  { methods: ["GET", "POST"], path: /^\/api\/signing\/[^/]+(\/(policy|sign))?$/ },
  { methods: ["GET", "POST"], path: /^\/api\/letter-sign\/[^/]+$/ },
];

/**
 * Whether a login in pay only is refused this request. Only the server's data
 * is fenced (`/api` and the stored files under `/uploads`); the client bundle
 * is not, so the app can load and show the person My pay.
 */
export function payOnlyRefuses(method: string, path: string): boolean {
  const lower = path.toLowerCase().replace(/\/+$/, "") || "/";
  if (!/^\/(api|uploads)(\/|$)/.test(lower)) return false;
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  return !PAY_ONLY_ROUTES.some((route) => route.methods.includes(verb) && route.path.test(lower));
}
