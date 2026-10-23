import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const files = [
  "platform-role-mapping.test.ts",
  "platform-role-mapping.check.ts",
  "platform-role-branch-scope.check.ts",
  "platform-role-storage-tenant.check.ts",
  "platform-role-training-scope.check.ts",
  "platform-role-managed-flag.check.ts",
  "platform-role-permissions.check.ts",
];

// Keep these isolated handler/guard checks in the existing handoff CI entry.
// The separately armed database proof requires its own disposable database.
for (const file of files) {
  execFileSync(process.execPath, [cli, "tests/" + file], {
    cwd: app,
    stdio: "inherit",
  });
}
console.log(JSON.stringify({ suite: "platform-role-mapping", programs: files.length, passed: true }));
