// seed: none — no database; a stand-in for the platform bucket served from
// this process is the only thing it reads or writes, and only in memory.
// Usage, from apps/oto-app: npx tsx tests/contract-pdf-paths.check.ts
//
// SCRUM-1047: signed contracts and letters restored from the old system.
//
// The restored database remembers a signed contract by the old system's own
// storage path, "/<its bucket>/<its folder>/contracts/signed_contract_<id>.pdf",
// or, from before it used cloud storage, by a path on its own disk,
// "/uploads/signed-contracts/signed_contract_<id>.pdf". The files are copied
// into this app's own contracts folder; the stored rows are not rewritten.
// This check drives server/pdf-storage.ts against the stand-in bucket:
//
//   1. the app's own path opens exactly as before;
//   2. a path of the old system's storage opens the file of that name in this
//      app's own bucket, environment folder and contracts or letters folder;
//   3. a path of the old system's disk opens the same way once the file is
//      there, and is "not found", never an error, until then;
//   4. anything else a stored path says is refused before the bucket is asked:
//      another folder or environment, "..", separators in the name, encoded or
//      not, a name the app never writes, an empty or a very long name;
//   5. the stream reader reads only from this app's own bucket, the same way.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

const run = randomBytes(4).toString("hex");
const OWN = `zz-own-${run}`;
const OLD = `zz-old-${run}`;
const PREFIX = "zz-test";

// ─── A stand-in for the platform bucket ─────────────────────────────────────
//
// Private, as the real one is: it answers only a request the SDK signed — an
// Authorization header, or a presigned URL's query. It serves any bucket's
// path it holds, so a read of another bucket would show in the log and work.

const objects = new Map<string, Buffer>();
const log: string[] = [];
const bucketServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://bucket");
  const path = decodeURIComponent(url.pathname);
  const signed = url.searchParams.has("X-Amz-Signature") || /^AWS4-HMAC-SHA256 /.test(String(req.headers.authorization ?? ""));
  log.push(`${req.method} ${path}`);
  if (!signed) {
    res.writeHead(403, { "content-type": "application/xml" });
    res.end("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>");
    return;
  }
  const body = objects.get(path);
  if (!body) {
    res.writeHead(404, { "content-type": "application/xml" });
    res.end(req.method === "HEAD" ? undefined : "<Error><Code>NoSuchKey</Code></Error>");
    return;
  }
  res.writeHead(200, { "content-type": "application/pdf", "content-length": String(body.length) });
  res.end(req.method === "HEAD" ? undefined : body);
});
await new Promise<void>((resolve) => bucketServer.listen(0, "127.0.0.1", resolve));
const PORT = (bucketServer.address() as AddressInfo).port;

// The app's configuration, set before its modules are imported (config/env.ts
// reads it once, at import). Nothing here connects to a database.
Object.assign(process.env, {
  APP_ENV: "dev",
  DEPLOY_ENV: "local",
  STORAGE_ENV_PREFIX: PREFIX,
  OBJECT_STORAGE: "s3",
  S3_BUCKET: OWN,
  S3_ENDPOINT: "127.0.0.1",
  S3_PORT: String(PORT),
  S3_USE_SSL: "false",
  AWS_REGION: "auto",
  AWS_ACCESS_KEY_ID: "zz-test-key",
  AWS_SECRET_ACCESS_KEY: "zz-test-secret",
  DATABASE_URL: "postgres://zz-test@127.0.0.1:9/zz_test",
});
const storage = await import("../server/pdf-storage");

// ─── helpers ─────────────────────────────────────────────────────────────────

const pdf = (what: string) => Buffer.from(`%PDF-1.4\nZZ TEST ${what}\n`, "latin1");
/** Put a file at a key of the app's own bucket (or any bucket's path). */
const put = (path: string, what = path) => {
  objects.set(path, pdf(what));
  return path;
};
const own = (folder: string, name: string) => `/${OWN}/${PREFIX}/${folder}/${name}`;
const contractName = () => `signed_contract_${randomUUID()}.pdf`;
const finalizedName = (version = 3) => `finalized_contract_${randomUUID()}_v${version}.pdf`;
const letterName = () => `signed_letter_${randomUUID()}.pdf`;

/** What the app asked the bucket while `fn` ran. */
async function asked<T>(fn: () => Promise<T>): Promise<{ value: T; requests: string[] }> {
  const mark = log.length;
  const value = await fn();
  return { value, requests: log.slice(mark) };
}

/** A presigned URL for exactly this own-bucket path, five minutes, that serves the file. */
async function assertOpens(url: string | null, path: string, what: string) {
  assert.ok(url, `${what}: a URL`);
  const u = new URL(url);
  assert.equal(u.host, `127.0.0.1:${PORT}`, what);
  assert.equal(decodeURIComponent(u.pathname), path, what);
  assert.equal(u.searchParams.get("X-Amz-Expires"), "300", what);
  const served = await fetch(u);
  assert.equal(served.status, 200, what);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), objects.get(path), what);
}

async function readAll(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(parts);
}

const failures: string[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message.split("\n").join("\n       ") : String(error)}`);
  }
}

try {
  // ── 1. The app's own path ──────────────────────────────────────────────────
  console.log("1. the app's own path opens exactly as before:");

  await check("a signed contract, a finalized contract and a signed letter at the app's own path", async () => {
    for (const [folder, name] of [["contracts", contractName()], ["contracts", finalizedName()], ["letters", letterName()]] as const) {
      const path = put(own(folder, name));
      assert.equal(storage.isObjectStoragePath(path), true, path);
      const { value, requests } = await asked(() => storage.presignedPdfUrl(path, "ZZ TEST document.pdf"));
      assert.deepEqual(requests, [`HEAD ${path}`], path);
      await assertOpens(value, path, path);
    }
  });

  await check("the app's own rule is kept byte for byte: its folder, under its own environment, any file name", async () => {
    // Today's rule for the app's own path checks the folder, not the name;
    // SCRUM-1047 leaves it as it is. Its file there opens, a missing one is
    // "not found" after one question to the bucket.
    const path = put(own("contracts", "zz-test-any-name.pdf"));
    await assertOpens(await storage.presignedPdfUrl(path, "ZZ TEST.pdf"), path, path);
    const missing = own("letters", contractName());
    const { value, requests } = await asked(() => storage.presignedPdfUrl(missing, "ZZ TEST.pdf"));
    assert.equal(value, null);
    assert.deepEqual(requests, [`HEAD ${missing}`]);
  });

  // ── 2. The old system's storage ────────────────────────────────────────────
  console.log("2. a path of the old system's storage opens the file of that name in the app's own folder:");

  await check("a signed contract restored with the old bucket's name in front opens from the app's own contracts folder", async () => {
    const name = contractName();
    const target = put(own("contracts", name));
    const restored = `/${OLD}/staging/contracts/${name}`;
    assert.equal(storage.isObjectStoragePath(restored), true, "routed to object storage, not the local disk");
    const { value, requests } = await asked(() => storage.presignedPdfUrl(restored, "ZZ TEST contract.pdf"));
    assert.deepEqual(requests, [`HEAD ${target}`]);
    await assertOpens(value, target, restored);
  });

  await check("a finalized contract and a signed letter restored the same way open from their own folders", async () => {
    for (const [folder, name] of [["contracts", finalizedName(12)], ["letters", letterName()]] as const) {
      const target = put(own(folder, name));
      for (const restored of [`/${OLD}/staging/${folder}/${name}`, `/${OLD}/${PREFIX}/${folder}/${name}`]) {
        assert.equal(storage.isObjectStoragePath(restored), true, restored);
        const { value, requests } = await asked(() => storage.presignedPdfUrl(restored, "ZZ TEST.pdf"));
        assert.deepEqual(requests, [`HEAD ${target}`], restored);
        await assertOpens(value, target, restored);
      }
    }
  });

  await check("the bucket and folder the old path names are never asked", async () => {
    const name = contractName();
    put(`/${OLD}/staging/contracts/${name}`, "the old bucket's copy");
    const restored = `/${OLD}/staging/contracts/${name}`;
    const { value, requests } = await asked(() => storage.presignedPdfUrl(restored, "ZZ TEST.pdf"));
    assert.equal(value, null, "not in the app's own folder: not found");
    assert.deepEqual(requests, [`HEAD ${own("contracts", name)}`]);
  });

  await check("ownPdfKey: the old storage's path names the app's own key", () => {
    const name = contractName();
    assert.equal(storage.ownPdfKey(`/${OLD}/staging/contracts/${name}`, OWN), `${PREFIX}/contracts/${name}`);
    const letter = letterName();
    assert.equal(storage.ownPdfKey(`/${OLD}/staging/letters/${letter}`, OWN), `${PREFIX}/letters/${letter}`);
    assert.equal(storage.ownPdfKey(own("contracts", name), OWN), `${PREFIX}/contracts/${name}`);
  });

  // ── 3. The old system's disk ───────────────────────────────────────────────
  console.log("3. a path of the old system's disk opens the same way once the file is there:");

  await check("before the file is copied: \"not found\", after one question to the app's own folder, never an error", async () => {
    const name = contractName();
    const disk = `/uploads/signed-contracts/${name}`;
    assert.equal(storage.ownPdfKey(disk, OWN), `${PREFIX}/contracts/${name}`);
    assert.equal(storage.isObjectStoragePath(disk), true, "routed to object storage, not the local disk");
    const { value, requests } = await asked(() => storage.presignedPdfUrl(disk, "ZZ TEST.pdf"));
    assert.equal(value, null);
    assert.deepEqual(requests, [`HEAD ${own("contracts", name)}`]);
    const streamed = await asked(() => storage.streamSignedPdf(disk));
    assert.equal(streamed.value.exists, false);
    assert.equal(streamed.value.stream, null);
    assert.deepEqual(streamed.requests, [`HEAD ${own("contracts", name)}`]);
  });

  await check("once the file is in the app's own contracts folder, the same stored path opens it", async () => {
    const name = contractName();
    const disk = `/uploads/signed-contracts/${name}`;
    assert.equal(await storage.presignedPdfUrl(disk, "ZZ TEST.pdf"), null);
    const target = put(own("contracts", name));
    const { value, requests } = await asked(() => storage.presignedPdfUrl(disk, "ZZ TEST.pdf"));
    assert.deepEqual(requests, [`HEAD ${target}`]);
    await assertOpens(value, target, disk);
  });

  // ── 4. Everything else is refused ──────────────────────────────────────────
  console.log("4. anything else a stored path says is refused before the bucket is asked:");

  const id = randomUUID();
  const name = `signed_contract_${id}.pdf`;
  const letter = `signed_letter_${id}.pdf`;
  // Every key a refused path could be read as is there, so a refusal is the
  // path's shape, never a missing file.
  for (const folder of ["contracts", "letters", "photos"]) {
    put(own(folder, name));
    put(own(folder, letter));
    put(`/${OWN}/production/${folder}/${name}`);
  }
  const hostile: Array<[string, string]> = [
    ["the app's own bucket, another environment's folder", `/${OWN}/production/contracts/${name}`],
    ["the app's own bucket, a prefix that only starts like its own", `/${OWN}/${PREFIX}x/contracts/${name}`],
    ["the app's own bucket and environment, another folder", `/${OWN}/${PREFIX}/photos/${name}`],
    ["the app's own bucket and environment, a folder that only starts like its own", `/${OWN}/${PREFIX}/contractsx/${name}`],
    ["the old bucket, another folder", `/${OLD}/staging/photos/${name}`],
    ["the old bucket, the old disk's folder name", `/${OLD}/staging/signed-contracts/${name}`],
    ["the old bucket with no environment folder", `/${OLD}/contracts/${name}`],
    ["the old bucket, a deeper prefix", `/${OLD}/staging/extra/contracts/${name}`],
    ["a folder inside the contracts folder", `/${OLD}/staging/contracts/sub/${name}`],
    ["\"..\" after the contracts folder", `/${OLD}/staging/contracts/../contracts/${name}`],
    ["\"..\" as the environment", `/${OLD}/../contracts/${name}`],
    ["\"..\" as the bucket", `/../${PREFIX}/contracts/${name}`],
    ["\"..\" before the folder", `/${OLD}/staging/../contracts/${name}`],
    ["\"..\" as the name", `/${OLD}/staging/contracts/..`],
    ["\".\" as the environment", `/${OLD}/./contracts/${name}`],
    ["an encoded slash in the name", `/${OLD}/staging/contracts/sub%2F${name}`],
    ["an encoded lower-case slash and dots in the name", `/${OLD}/staging/contracts/%2e%2e%2f${name}`],
    ["an encoded slash between environment and folder", `/${OLD}/staging%2Fcontracts/${name}`],
    ["a backslash in the name", `/${OLD}/staging/contracts/..\\${name}`],
    ["a NUL in the name", `/${OLD}/staging/contracts/${name}\0`],
    ["an encoded NUL in the name", `/${OLD}/staging/contracts/${name}%00`],
    ["a newline after the name", `/${OLD}/staging/contracts/${name}\n`],
    ["a space before the name", `/${OLD}/staging/contracts/ ${name}`],
    ["a letter's name in the contracts folder", `/${OLD}/staging/contracts/${letter}`],
    ["a contract's name in the letters folder", `/${OLD}/staging/letters/${name}`],
    ["a finalized contract without its version", `/${OLD}/staging/contracts/finalized_contract_${id}.pdf`],
    ["a finalized contract with an empty version", `/${OLD}/staging/contracts/finalized_contract_${id}_v.pdf`],
    ["a finalized contract with a padded version", `/${OLD}/staging/contracts/finalized_contract_${id}_v01.pdf`],
    ["a name in capitals", `/${OLD}/staging/contracts/signed_contract_${id.toUpperCase()}.pdf`],
    ["an extension in capitals", `/${OLD}/staging/contracts/signed_contract_${id}.PDF`],
    ["a second extension", `/${OLD}/staging/contracts/${name}.html`],
    ["no extension", `/${OLD}/staging/contracts/signed_contract_${id}`],
    ["an id that is no id", `/${OLD}/staging/contracts/signed_contract_zz-test.pdf`],
    ["another kind of file", `/${OLD}/staging/contracts/profile_${id}.jpg`],
    ["an empty name", `/${OLD}/staging/contracts/`],
    ["an extension alone", `/${OLD}/staging/contracts/.pdf`],
    ["a very long name", `/${OLD}/staging/contracts/signed_contract_${"a".repeat(5000)}.pdf`],
    ["a very long bucket", `/${"z".repeat(5000)}/staging/contracts/${name}`],
    ["an empty path", ""],
    ["a lone slash", "/"],
    ["no leading slash", `${OLD}/staging/contracts/${name}`],
    ["an empty bucket", `//staging/contracts/${name}`],
    ["a URL", `https://${OLD}.example.invalid/staging/contracts/${name}`],
    ["the old disk's folder, a letter's name", `/uploads/signed-contracts/${letter}`],
    ["the old disk's folder, a folder inside it", `/uploads/signed-contracts/sub/${name}`],
    ["the old disk's folder, \"..\"", `/uploads/signed-contracts/../contracts/${name}`],
    ["the old disk's folder, an encoded slash", `/uploads/signed-contracts/sub%2F${name}`],
    ["the old disk's folder, an empty name", "/uploads/signed-contracts/"],
    ["the old disk's folder, no leading slash", `uploads/signed-contracts/${name}`],
    ["the old disk's folder under another root", `/home/zz/uploads/signed-contracts/${name}`],
    ["a letters folder on the old disk, which no restored row is known to hold", `/uploads/signed-letters/${letter}`],
    ["the app's own local path stays a local path", `/uploads/contracts/${name}`],
  ];
  for (const [what, path] of hostile) {
    await check(`refused: ${what}`, async () => {
      assert.equal(storage.ownPdfKey(path, OWN), null);
      // Routing is today's: a path naming the app's own bucket goes to object
      // storage, as it always has; nothing else refused here does.
      assert.equal(storage.isObjectStoragePath(path), path.includes(OWN));
      const signed = await asked(() => storage.presignedPdfUrl(path, "ZZ TEST.pdf"));
      assert.equal(signed.value, null);
      assert.deepEqual(signed.requests, [], "the bucket is not asked");
      const streamed = await asked(() => storage.streamSignedPdf(path));
      assert.equal(streamed.value.exists, false);
      assert.deepEqual(streamed.requests, [], "the bucket is not asked");
    });
  }

  // ── 5. The stream reader ───────────────────────────────────────────────────
  console.log("5. the stream reader reads only from the app's own bucket, the same way:");

  await check("the app's own path streams as before", async () => {
    const path = put(own("contracts", contractName()));
    const { value, requests } = await asked(() => storage.streamSignedPdf(path));
    assert.equal(value.exists, true);
    assert.equal(value.size, objects.get(path)!.length);
    assert.equal(value.contentType, "application/pdf");
    assert.deepEqual(await readAll(value.stream!), objects.get(path));
    assert.deepEqual(requests, [`HEAD ${path}`, `GET ${path}`]);
  });

  await check("a restored path streams the file of that name from the app's own folder", async () => {
    for (const [folder, n] of [["contracts", contractName()], ["letters", letterName()]] as const) {
      const target = put(own(folder, n));
      const { value, requests } = await asked(() => storage.streamSignedPdf(`/${OLD}/staging/${folder}/${n}`));
      assert.equal(value.exists, true);
      assert.deepEqual(await readAll(value.stream!), objects.get(target));
      assert.deepEqual(requests, [`HEAD ${target}`, `GET ${target}`]);
    }
    const n = contractName();
    const target = put(own("contracts", n));
    const downloaded = await storage.downloadSignedPdf(`/uploads/signed-contracts/${n}`);
    assert.equal(downloaded.exists, true);
    assert.deepEqual(downloaded.buffer, objects.get(target));
  });

  await check("another bucket's file is never read, even where the bucket would serve it", async () => {
    const path = put(`/${OLD}/staging/photos/zz-test.pdf`, "another bucket's file");
    const { value, requests } = await asked(() => storage.streamSignedPdf(path));
    assert.equal(value.exists, false);
    assert.equal(value.stream, null);
    assert.deepEqual(requests, []);
  });
} finally {
  bucketServer.close();
}

if (failures.length) {
  console.error(`\ncontract-pdf-paths.check: ${failures.length} failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("\ncontract-pdf-paths.check: all passed");
