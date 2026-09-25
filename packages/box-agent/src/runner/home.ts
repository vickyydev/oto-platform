/**
 * The box's home directory, as a Raspberry Pi keeps it (SCRUM-223).
 *
 * One directory holds everything a booth box has to remember across a power
 * cut, and nothing else:
 *
 *   credential.json   — the box id, its secret and its signing key. Mode 0600,
 *                       owned by the service user. Losing it means a new claim
 *                       code from the Console; copying it means a second box
 *                       that is this one. It is data, never printed.
 *   box.sqlite        — the store: outbox, print queue, counters, sessions.
 *   config-bundle.json — the last config bundle the cloud sent, exactly as sent,
 *                       so a box that boots before the mall's internet still
 *                       knows its booth, its printer and its trading day.
 *   runner.json       — what this runner chose: the api it was claimed against
 *                       and which booth station the kiosk's picker chose.
 *   config.json       — OPTIONAL, written by a person: the bench override for
 *                       the receipt printer (host, port, dots per line).
 *
 * Every write here is write-to-a-temporary-then-rename, so a power cut during
 * a write leaves either the old file or the new one and never half of one.
 */

import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export interface RunnerPaths {
  home: string;
  credential: string;
  database: string;
  configBundle: string;
  state: string;
  overrides: string;
}

export function runnerPaths(home: string): RunnerPaths {
  return {
    home,
    credential: join(home, 'credential.json'),
    database: join(home, 'box.sqlite'),
    configBundle: join(home, 'config-bundle.json'),
    state: join(home, 'runner.json'),
    overrides: join(home, 'config.json'),
  };
}

/**
 * Write JSON so that a reader sees the old file or the new one, never half.
 *
 * The temporary file is created with the final mode already applied, flushed
 * to the card, and renamed over the target — rename within one directory is
 * atomic on every filesystem a Pi boots from.
 */
export async function writeJsonAtomic(path: string, value: unknown, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, 'w', mode);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (err) {
    await rm(temporary, { force: true });
    throw err;
  }
  // An existing file keeps the mode it had; the rename replaced it with ours,
  // but a filesystem that ignores the open mode is put right here.
  await chmod(path, mode).catch(() => {});
  // The rename is a change to the DIRECTORY, and ext4 commits those on its
  // own timer — up to a few seconds later — unless the directory is flushed
  // as well. A credential written seconds before a power cut would otherwise
  // be gone with the claim code already spent (SCRUM-418). Best effort: the
  // file's own bytes are already on the card, and Windows cannot open a
  // directory this way.
  await open(dirname(path), 'r')
    .then(async (dir) => {
      await dir.sync().catch(() => {});
      await dir.close();
    })
    .catch(() => {});
}

export async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

// --- What the runner chose ------------------------------------------------

const RunnerStateSchema = z.object({
  /** The api this box was claimed against. A box talks to one cloud. */
  apiBaseUrl: z.string().url().nullable().default(null),
  /** The booth station the kiosk's picker chose, when the box has several. */
  stationId: z.string().uuid().nullable().default(null),
});
export type RunnerState = z.infer<typeof RunnerStateSchema>;

export async function readRunnerState(paths: RunnerPaths): Promise<RunnerState> {
  const parsed = RunnerStateSchema.safeParse((await readJsonFile(paths.state)) ?? {});
  return parsed.success ? parsed.data : { apiBaseUrl: null, stationId: null };
}

export async function writeRunnerState(paths: RunnerPaths, state: RunnerState): Promise<void> {
  await writeJsonAtomic(paths.state, state, 0o600);
}

// --- The bench override ---------------------------------------------------

/**
 * The receipt printer, as a person at the bench says it is.
 *
 * `widthDots` is the one number that must never be guessed: an 80 mm ESC/POS
 * head is 576 dots per line, or 512 on some XP-80 units, and a raster wider
 * than the head is discarded without a word (`templates/booth.ts` in
 * `@oto/print`). It comes off the printer's self-test page. Multiples of 8
 * only, because the raster is sent a byte — eight dots — at a time.
 */
export const PrinterOverrideSchema = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65_535).default(9100),
  widthDots: z
    .number()
    .int()
    .min(384)
    .max(832)
    .refine((dots) => dots % 8 === 0, { message: 'dots per line is a multiple of 8' })
    .default(576),
});
export type PrinterOverride = z.infer<typeof PrinterOverrideSchema>;

const OverridesSchema = z.object({
  printer: PrinterOverrideSchema.nullable().optional(),
  /** What this machine calls itself to the cloud. The OS hostname otherwise. */
  hostname: z.string().trim().min(1).max(128).optional(),
});
export type RunnerOverrides = z.infer<typeof OverridesSchema>;

/**
 * Read `config.json`, or nothing.
 *
 * A file somebody typed at a bench is allowed to be wrong, and a wrong one
 * must not stop the booth: it is reported, by field, and ignored whole — a
 * printer override that parsed half would send the voucher to a half-right
 * address.
 */
export async function readOverrides(
  paths: RunnerPaths,
): Promise<{ overrides: RunnerOverrides; problem: string | null }> {
  const raw = await readJsonFile(paths.overrides);
  if (raw === null) return { overrides: {}, problem: null };
  const parsed = OverridesSchema.safeParse(raw);
  if (parsed.success) return { overrides: parsed.data, problem: null };
  const issue = parsed.error.issues[0];
  return {
    overrides: {},
    problem: `${paths.overrides} was not used: ${issue?.path.join('.') || 'file'} — ${issue?.message ?? 'unreadable'}`,
  };
}
