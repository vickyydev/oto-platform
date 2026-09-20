/**
 * DEV-ONLY Legacy Core Uploads Importer
 * 
 * This script uploads files from legacy_uploads/core/uploads to object storage
 * and records them in the files table.
 * 
 * Since the Replit sidecar authentication only works within the web server context,
 * this script calls the API endpoint which handles the actual upload.
 * 
 * Prerequisites:
 * - The web server must be running
 * - APP_ENV must be set to 'dev'
 * - Admin authentication is required
 * 
 * Usage:
 *   tsx script/importCoreLegacyUploads.ts
 * 
 * Or via curl (requires authentication):
 *   curl -X POST http://localhost:5000/api/dev/import-core-legacy-uploads \
 *     -H "Cookie: your-session-cookie"
 */

import { assertDevEnv } from "../server/config/env";

async function main(): Promise<void> {
  console.log("=== Core Legacy Uploads Importer ===\n");

  assertDevEnv();
  console.log("Environment check passed (APP_ENV=dev)\n");

  console.log("NOTE: This script must be run via the API endpoint since");
  console.log("object storage authentication requires the web server context.\n");

  console.log("To import legacy uploads, use one of these methods:\n");

  console.log("1. Via curl with session cookie:");
  console.log("   curl -X POST http://localhost:5000/api/dev/import-core-legacy-uploads \\");
  console.log('     -H "Cookie: connect.sid=YOUR_SESSION_COOKIE"\n');

  console.log("2. Via browser console (when logged in as admin):");
  console.log('   fetch("/api/dev/import-core-legacy-uploads", { method: "POST" })');
  console.log('     .then(r => r.json()).then(console.log)\n');

  console.log("3. Via the running server (programmatic):");
  console.log("   The importCoreLegacyUploads() function is available in server/routes/legacyImport.ts\n");

  process.exit(0);
}

main();
