import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

export class StoreBusyError extends Error {
  constructor() {
    super(
      'The box store is in use. Stop the oto-box service before restoring or starting another agent.',
    );
  }
}

/** Kernel-owned: a killed process cannot leave a stale PID file blocking recovery. */
export async function holdStoreLock(
  directory: string,
  purpose = 'store',
): Promise<() => Promise<void>> {
  let canonical = await realpath(directory).catch(() => resolve(directory));
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  const key = createHash('sha256').update(`${purpose}:${canonical}`).digest('hex').slice(0, 32);
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\oto-box-${key}` : `\0oto-box-${key}`;
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.removeListener('error', reject);
      done();
    });
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') throw new StoreBusyError();
    throw error;
  });
  server.unref();
  return () =>
    new Promise<void>((done, reject) => {
      server.close((error) => (error ? reject(error) : done()));
    });
}
