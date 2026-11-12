import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};
const SECURITY = { 'strict-transport-security': 'max-age=315360000; includeSubdomains; preload',
  'x-content-type-options': 'nosniff' };

async function file(root: string, path: string): Promise<string | null> {
  try {
    const [base, candidate] = await Promise.all([realpath(root), realpath(resolve(root, `.${path}`))]);
    const inside = relative(base, candidate);
    if (inside.startsWith('..') || isAbsolute(inside) || !(await stat(candidate)).isFile()) return null;
    return candidate;
  } catch { return null; }
}

/** Static files only; proxy responses never pass through this compression path. */
export async function serveStatic(req: IncomingMessage, res: ServerResponse, root: string): Promise<void> {
  const fail = (status: number): void => { res.writeHead(status, { ...SECURITY, 'cache-control': 'no-store' }); res.end(); };
  if (req.method !== 'GET' && req.method !== 'HEAD') { fail(405); return; }
  let path: string;
  try { path = decodeURIComponent((req.url ?? '/').split('?')[0]!); }
  catch { fail(400); return; }
  // Check BEFORE normalization, including encoded separators and Windows paths.
  if (path.includes('\\') || path.includes('\0') || path.split('/').some(part => part.startsWith('.'))) {
    fail(400); return;
  }
  let selected = await file(root, path);
  if (!selected && !extname(path) && !path.startsWith('/assets/')) {
    path = '/index.html'; selected = await file(root, path);
  }
  if (!selected) { fail(404); return; }
  const type = TYPES[extname(selected)] ?? 'application/octet-stream';
  const immutable = path.startsWith('/assets/') && /-[\w-]{8,}\.[\w.]+$/.test(path);
  const cache = immutable ? 'public, max-age=31536000, immutable' : 'no-store';
  const encodings = (req.headers['accept-encoding'] ?? '').split(',').map(value => {
    const [name, parameter] = value.trim().split(';');
    const q = parameter?.trim().startsWith('q=') ? Number(parameter.trim().slice(2)) : 1;
    return { name, q };
  });
  const accepted = ['br', 'gzip'].map(name => ({ name,
    q: (encodings.find(e => e.name === name) ?? encodings.find(e => e.name === '*'))?.q ?? 0,
  })).filter(e => e.q > 0 && e.q <= 1).sort((a, b) => b.q - a.q);
  let encoding: string | undefined;
  for (const option of accepted) {
    const compressed = await file(root, `${path}.${option.name === 'br' ? 'br' : 'gz'}`);
    if (compressed) { selected = compressed; encoding = option.name; break; }
  }
  const size = (await stat(selected)).size;
  if (res.destroyed) return;
  res.writeHead(200, { ...SECURITY, 'content-type': type, 'content-length': size,
    'cache-control': cache, vary: 'Accept-Encoding', ...(encoding ? { 'content-encoding': encoding } : {}) });
  if (req.method === 'HEAD') { res.end(); return; }
  pipeline(createReadStream(selected), res, () => { /* pipeline closes both ends on disconnect */ });
}
