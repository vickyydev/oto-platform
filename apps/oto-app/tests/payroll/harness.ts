// A node:test-shaped `test` that only registers, so the payroll prototype's
// own unit tests port with their bodies unchanged; tests/payroll-engine.check.ts
// runs what was registered and reports it the way the app's other checks do.
export type TestBody = () => void | Promise<void>;
export interface RegisteredTest { suite: string; name: string; fn: TestBody }
export const registered: RegisteredTest[] = [];
let suite = "";
/** Names the prototype test file the following registrations came from. */
export function describeSuite(name: string): void { suite = name; }
export function test(name: string, fn: TestBody): void { registered.push({ suite, name, fn }); }
export default test;
