import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

export interface SourceChunk { file: string; startLine: number; endLine: number; content: string }
export interface SourceIndex { version: 1; sha: string; files: number; chunks: SourceChunk[]; digest: string }
export const APPROVED_DOCS = [
  "docs/progress/plans/qa-assistant/PLAN.md",
  "docs/progress/decisions/OWNER_QUESTIONS_2026-10-14.md",
  "docs/features/oto-app.md",
];
export const fullSha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const MAX_INDEX_BYTES = 24 * 1024 * 1024;
const excluded = /(?:^|\/)(?:node_modules|dist|imports|services|seed|seeds|config|attachments|test-results)(?:\/|$)|(?:^|\/)\.env|(?:credential|secret|private[-_]?key)/i;

export function approvedSourcePath(file: string): boolean {
  if (file.includes("\\") || file.includes("..") || isAbsolute(file) || excluded.test(file)) return false;
  return file === "apps/oto-app/README.md" || APPROVED_DOCS.includes(file) || (/^apps\/oto-app\/(?:server|client\/src|shared)\/.+\.(?:ts|tsx|css)$/.test(file));
}

export function redactSourceLine(line: string): string {
  return /password|secret|(?:access|refresh|session|bearer|claim)[_ -]?token|authorization|BEGIN .*PRIVATE KEY/i.test(line)
    ? "// credential-related source line withheld"
    : line.replace(/https?:\/\/[^\s"'<>]+/g, (url) => url.split(/[?#]/)[0]!).slice(0, 400);
}

export async function buildSourceIndex(repoRoot: string, sha: string): Promise<SourceIndex> {
  const root = await realpath(repoRoot);
  let appRoot = join(root, "apps/oto-app");
  try { await readdir(join(appRoot, "server")); } catch { appRoot = root; }
  const paths: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name), file = "apps/oto-app/" + relative(appRoot, absolute).replaceAll("\\", "/");
      if (excluded.test(file)) continue;
      if (entry.isDirectory()) await walk(absolute);
      else if (approvedSourcePath(file)) paths.push(file);
    }
  }
  for (const directory of ["server", "client/src", "shared"]) await walk(join(appRoot, directory));
  try { await readFile(join(appRoot, "README.md")); paths.push("apps/oto-app/README.md"); } catch { /* Optional app documentation. */ }
  // Both deployment images have the app build context. Repository documents are
  // included only when explicitly supplied to both builds at the same revision.
  if (process.env.QA_SOURCE_DOCS_ROOT) for (const file of APPROVED_DOCS) { try { await readFile(join(process.env.QA_SOURCE_DOCS_ROOT, file)); paths.push(file); } catch { /* Never substitute a different document. */ } }
  const chunks: SourceChunk[] = [];
  let bytes = 0, files = 0;
  for (const file of [...new Set(paths)].sort()) {
    const base = file.startsWith("apps/oto-app/") ? appRoot : await realpath(process.env.QA_SOURCE_DOCS_ROOT!);
    const absolute = await realpath(join(base, file.startsWith("apps/oto-app/") ? file.slice("apps/oto-app/".length) : file)), within = relative(base, absolute);
    if (within.startsWith("..") || isAbsolute(within)) continue;
    const raw = await readFile(absolute);
    if (raw.length > 5 * 1024 * 1024 || bytes + raw.length > MAX_INDEX_BYTES || files >= 3000) continue;
    bytes += raw.length; files++;
    const lines = raw.toString("utf8").split(/\r?\n/).map(redactSourceLine);
    for (let start = 0; start < lines.length; start += 90) {
      const part = lines.slice(start, start + 100);
      chunks.push({ file, startLine: start + 1, endLine: start + part.length, content: part.join("\n") });
    }
  }
  return { version: 1, sha, files, chunks, digest: createHash("sha256").update(JSON.stringify(chunks)).digest("hex") };
}

export function validateSourceIndex(raw: unknown, sha: string): SourceIndex | null {
  const value = raw as SourceIndex;
  if (!fullSha(sha) || value?.version !== 1 || value.sha !== sha || !Array.isArray(value.chunks) || value.chunks.length > 30_000) return null;
  if (!value.chunks.every((c) => approvedSourcePath(c.file) && Number.isInteger(c.startLine) && c.startLine > 0 && Number.isInteger(c.endLine) && c.endLine >= c.startLine && c.endLine - c.startLine <= 100 && typeof c.content === "string" && c.content.length <= 41_000)) return null;
  if (createHash("sha256").update(JSON.stringify(value.chunks)).digest("hex") !== value.digest) return null;
  return value;
}

function sourceKey(prefix: string, sha: string): string {
  if (!fullSha(sha) || !/^[a-zA-Z0-9/_-]+$/.test(prefix) || prefix.includes("..")) throw new Error("QA source configuration is unavailable");
  return `${prefix}/qa-source/${sha}.json`;
}

async function bundledIndex(): Promise<SourceIndex | null> {
  const sha = process.env.RENDER_GIT_COMMIT;
  if (!fullSha(sha)) return null;
  // dist is the deployment location; source-run checks may use the explicit file.
  const filename = process.env.QA_SOURCE_INDEX_FILE || resolve(process.cwd(), "dist/qa-source-index.json");
  try { const bytes = await readFile(filename); return bytes.length <= MAX_INDEX_BYTES ? validateSourceIndex(JSON.parse(bytes.toString("utf8")), sha) : null; } catch { return null; }
}

export async function publishBundledSourceIndex(): Promise<boolean> {
  try {
    const index = await bundledIndex(); if (!index) return false;
    const { qaStorage } = await import("./media");
    const { client, bucket, prefix } = qaStorage();
    const body = Buffer.from(JSON.stringify(index)); if (body.length > MAX_INDEX_BYTES) return false;
    try { await client.send(new PutObjectCommand({ Bucket: bucket, Key: sourceKey(prefix, index.sha), Body: body, ContentType: "application/json", CacheControl: "private, max-age=31536000", IfNoneMatch: "*" }), { abortSignal: AbortSignal.timeout(15_000) }); }
    catch (error) { if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412) return false; return (await readStoredIndex(index.sha))?.digest === index.digest; }
    return true;
  } catch { return false; }
}

export async function getSourceIndexForSha(sha: unknown): Promise<SourceIndex | null> {
  if (!fullSha(sha)) return null;
  const bundled = await bundledIndex(); if (bundled?.sha === sha) return bundled;
  return readStoredIndex(sha);
}

async function readStoredIndex(sha: string): Promise<SourceIndex | null> {
  try {
    const { qaStorage } = await import("./media"); const { client, bucket, prefix } = qaStorage();
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: sourceKey(prefix, sha) }), { abortSignal: AbortSignal.timeout(15_000) });
    if (!response.Body || (response.ContentLength ?? 0) > MAX_INDEX_BYTES) return null;
    const parts: Buffer[] = []; let size = 0;
    const timer = setTimeout(() => (response.Body as { destroy?: () => void }).destroy?.(), 15_000);
    try {
      for await (const part of response.Body as AsyncIterable<Uint8Array>) { const bytes = Buffer.from(part); size += bytes.length; if (size > MAX_INDEX_BYTES) { (response.Body as { destroy?: () => void }).destroy?.(); return null; } parts.push(bytes); }
      return validateSourceIndex(JSON.parse(Buffer.concat(parts).toString("utf8")), sha);
    } finally { clearTimeout(timer); }
  } catch { return null; }
}

export function selectSourceChunks(index: SourceIndex, question: string): SourceChunk[] {
  const terms = [...new Set(question.toLowerCase().match(/[a-z][a-z0-9_-]{3,35}/g) ?? [])].slice(0, 80);
  const ranked = index.chunks.map((chunk) => ({ chunk, score: terms.reduce((score, term) => score + (chunk.file.toLowerCase().includes(term) ? 5 : 0) + Math.min(3, chunk.content.toLowerCase().split(term).length - 1), 0) })).filter((v) => v.score > 0).sort((a, b) => b.score - a.score);
  const selected: SourceChunk[] = []; let size = 0, docs = 0;
  for (const { chunk } of ranked) {
    if (selected.length >= 12 || size + chunk.content.length > 18_000 || (chunk.file.startsWith("docs/") && docs >= 2)) continue;
    selected.push(chunk); size += chunk.content.length; if (chunk.file.startsWith("docs/")) docs++;
  }
  return selected;
}
