import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { runnerPaths } from './home';
import { holdStoreLock } from './store-lock';

/** Also refuse an older installed service which does not hold our kernel lock. */
async function serviceStopped(): Promise<void> {
  if (process.platform !== 'linux') return;
  try {
    const { stdout } = await promisify(execFile)('systemctl', [
      'show',
      'oto-box.service',
      '--property=ActiveState',
      '--value',
    ]);
    if (!['inactive', 'failed', ''].includes(stdout.trim()))
      throw new Error('Stop the oto-box service before restoring.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    // A development machine may have systemctl installed without systemd.
    if (
      String((error as { stderr?: string }).stderr).includes(
        'System has not been booted with systemd',
      )
    )
      return;
    throw error;
  }
}

export async function restoreStore(
  home: string,
  source: string,
  stopped = serviceStopped,
): Promise<{ unsent: number; replaced: string[] }> {
  const paths = runnerPaths(resolve(home));
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await stopped();
  const release = await holdStoreLock(paths.home);
  const suffix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const temp = `${paths.database}.restore-${suffix}`;
  const moved: Array<{ from: string; to: string }> = [];
  try {
    await stopped();
    if (resolve(source) === resolve(paths.database))
      throw new Error('Choose a mirror file, not the current store.');
    const claiming = await stat(`${paths.home}/claiming.json`).catch(() => null);
    if (claiming && Date.now() - claiming.mtimeMs < 300_000)
      throw new Error('A box registration is in progress; finish it before restoring.');
    await copyFile(source, temp, constants.COPYFILE_EXCL);
    const { DatabaseSync } = await import('node:sqlite');
    const checked = new DatabaseSync(temp, { readOnly: true });
    let unsent: number;
    try {
      const rows = checked.prepare('pragma quick_check').all();
      if (rows.length !== 1 || Object.values(rows[0]!)[0] !== 'ok')
        throw new Error('The mirror is damaged; the current store has not been moved.');
      // Read the table, not an index; rejected rows already reached the cloud.
      const count = checked
        .prepare(
          "select count(*) as n from box_outbox not indexed where state in ('queued','sending')",
        )
        .get();
      unsent = Number(count?.n ?? 0);
    } finally {
      checked.close();
    }
    const handle = await open(temp, 'r+');
    try {
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (const tail of ['', '-wal', '-shm']) {
      const from = `${paths.database}${tail}`;
      const to = `${paths.database}.replaced-${suffix}${tail}`;
      try {
        await rename(from, to);
        moved.push({ from, to });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await rename(temp, paths.database);
    if (process.platform !== 'win32') {
      const directory = await open(paths.home, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    return { unsent, replaced: moved.map(({ to }) => to) };
  } catch (error) {
    // Put the original family back if installation failed. A failed rollback
    // leaves the named aside intact for recovery, never deletes it.
    for (const { from, to } of moved.reverse()) await rename(to, from).catch(() => undefined);
    throw error;
  } finally {
    await rm(temp, { force: true });
    await release();
  }
}
