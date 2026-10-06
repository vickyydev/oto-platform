/**
 * `oto-box` — the booth box's command line (SCRUM-223).
 *
 *   oto-box claim --api <url> [--home <dir>] [--hostname <name>] [--force]
 *   oto-box run [--api <url>] [--home <dir>] [--port <n>] [--page <dir>]
 *   oto-box status [--home <dir>]
 *   oto-box version
 *
 * `claim` asks for the claim code at a prompt (SCRUM-418): a code given as an
 * argument stays in the shell's history and in `ps` for as long as the claim
 * takes. It is still taken from the command line when a script puts it there.
 *
 * Every option can come from the environment instead — `OTO_BOX_API`,
 * `OTO_BOX_HOME`, `OTO_BOX_PORT`, `OTO_BOX_PAGE`, `OTO_BOX_HOSTNAME` — which is
 * how the systemd unit passes `/etc/oto-box/config`. A flag wins over the
 * environment.
 *
 * What it prints, it prints for a person reading a terminal or `journalctl`:
 * one JSON line per event from the agent, and plain sentences from here. It
 * never prints the box's secret, its signing key, a claim code, a PIN or a
 * password — the credential file is data, and `status` says whether it exists
 * and which box it names, nothing more.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { fileCredentialStore } from '../credentials';
import { BOX_AGENT_VERSION } from '../protocol';
import type { AgentLog } from '../transport';
import { readJsonFile, readOverrides, readRunnerState, runnerPaths } from './home';
import { KIOSK_DEFAULT_PORT } from './kiosk-server';
import {
  RunnerError,
  claimBox,
  inspectStoreFile,
  latestSalvage,
  openNodeSqlite,
  startRunner,
} from './runtime';

/** Exit codes: 0 done; 1 failed; 2 used wrongly; 75 restart me (systemd does). */
const EXIT_RESTART = 75;

interface Parsed {
  command: string | null;
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): Parsed {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
      if (inline !== undefined) flags.set(name, inline);
      else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) flags.set(name, argv[(i += 1)]!);
      else flags.set(name, true);
    } else positional.push(arg);
  }
  return { command: positional.shift() ?? null, positional, flags };
}

function option(parsed: Parsed, flag: string, env: string): string | undefined {
  const value = parsed.flags.get(flag);
  if (typeof value === 'string' && value !== '') return value;
  const fromEnv = process.env[env];
  return fromEnv && fromEnv !== '' ? fromEnv : undefined;
}

function defaultHome(): string {
  return process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? process.cwd(), 'oto-box')
    : '/var/lib/oto-box';
}

/** `<folder of this file>/booth`, which is where the release tarball puts the page. */
function defaultPageDir(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidate = join(here, 'booth');
    return existsSync(join(candidate, 'index.html')) ? candidate : null;
  } catch {
    return null;
  }
}

/** One JSON line per event, to stdout, which is what journald keeps. */
export function jsonLog(write: (line: string) => void = (l) => process.stdout.write(l)): AgentLog {
  const line = (level: string) => (obj: Record<string, unknown>, msg: string) => {
    write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...obj })}\n`);
  };
  return { info: line('info'), warn: line('warn'), error: line('error') };
}

/** Where the command reads and writes; a test hands in streams of its own. */
export interface CliStreams {
  stdin?: NodeJS.ReadableStream;
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
}

/**
 * One line from `input`, trimmed, or null when it closes without one.
 *
 * The prompt goes to `output` (stderr, in `main`) so stdout stays what it is
 * everywhere else here: lines a script can read. `terminal: false` whatever
 * the input is — the terminal's own line editing is enough for a claim code,
 * and readline's raw mode would echo the keystrokes itself.
 */
export function readClaimCode(
  input: NodeJS.ReadableStream,
  output: { write(chunk: string): unknown },
  prompt: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    // readline only ever calls `write` on it, which is all a stream of ours has.
    const rl = createInterface({ input, output: output as unknown as NodeJS.WritableStream, terminal: false });
    let answered = false;
    rl.once('close', () => {
      if (!answered) resolve(null);
    });
    rl.question(prompt, (answer) => {
      answered = true;
      rl.close();
      resolve(answer.trim() || null);
    });
  });
}

const USAGE = `oto-box ${BOX_AGENT_VERSION} — the OTO booth box

  oto-box claim --api <url> [--home <dir>] [--hostname <name>] [--force]
      Register this box: asks for the claim code from Console → Devices → Add a box.
  oto-box run [--api <url>] [--home <dir>] [--port <n>] [--page <dir>]
      Run the box and serve the booth page at http://127.0.0.1:${KIOSK_DEFAULT_PORT}/.
  oto-box status [--home <dir>]
      Say whether this box is registered, which booth it runs and what it holds.
  oto-box version

Environment: OTO_BOX_API, OTO_BOX_HOME, OTO_BOX_PORT, OTO_BOX_PAGE, OTO_BOX_HOSTNAME,
OTO_BOX_BRIDGE_ORIGINS and OTO_BOX_BRIDGE_PORT (the station bridge, on a counter box).
`;

export async function main(argv: readonly string[], io: CliStreams = {}): Promise<number> {
  const parsed = parseArgs(argv);
  const home = resolve(option(parsed, 'home', 'OTO_BOX_HOME') ?? defaultHome());
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const out = (text: string) => stdout.write(`${text}\n`);
  const err = (text: string) => stderr.write(`${text}\n`);

  switch (parsed.command) {
    case 'version':
    case '--version':
      out(BOX_AGENT_VERSION);
      return 0;

    case 'claim': {
      const api = option(parsed, 'api', 'OTO_BOX_API');
      if (!api) {
        err('Usage: oto-box claim --api <url> [--home <dir>]  (the claim code is asked for)');
        return 2;
      }
      const code =
        parsed.positional[0] ??
        (await readClaimCode(stdin, stderr, 'Claim code (Console → Devices → Add a box): '));
      if (!code) {
        err('No claim code was entered.');
        return 2;
      }
      try {
        const { boxId } = await claimBox({
          home,
          apiBaseUrl: api,
          code,
          hostname: option(parsed, 'hostname', 'OTO_BOX_HOSTNAME'),
          force: parsed.flags.get('force') === true,
          log: jsonLog(),
        });
        out(`Registered: this is box ${boxId}. The credential is in ${runnerPaths(home).credential} (owner-only).`);
        // A box that needs service (SCRUM-403) picks the credential up when it
        // next tries its store, which it does once a minute.
        out(
          'Next: a running oto-box service picks this up by itself — within a few seconds, or within about a minute on a box whose television says it needs service; otherwise start it (sudo systemctl start oto-box) or run "oto-box run".',
        );
        return 0;
      } catch (error) {
        err(error instanceof RunnerError ? error.message : `Claim failed: ${String(error)}`);
        return 1;
      }
    }

    case 'run': {
      const port = Number(option(parsed, 'port', 'OTO_BOX_PORT') ?? KIOSK_DEFAULT_PORT);
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        err('The port must be a whole number from 1 to 65535.');
        return 2;
      }
      const log = jsonLog();
      let box: Awaited<ReturnType<typeof startRunner>>;
      try {
        box = await startRunner({
          home,
          apiBaseUrl: option(parsed, 'api', 'OTO_BOX_API') ?? null,
          port,
          pageDir: option(parsed, 'page', 'OTO_BOX_PAGE') ?? defaultPageDir(),
          hostname: option(parsed, 'hostname', 'OTO_BOX_HOSTNAME'),
          log,
          /**
           * The station bridge (offline plan Round 3), for a counter box:
           * `OTO_BOX_BRIDGE_ORIGINS` names the POS origins its tills are served
           * from, comma-separated, and turns it on; `OTO_BOX_BRIDGE_PORT` moves
           * it off 8471. Caddy publishes it on the LAN (`pi/Caddyfile`).
           */
          bridge: process.env.OTO_BOX_BRIDGE_ORIGINS
            ? {
                origins: process.env.OTO_BOX_BRIDGE_ORIGINS.split(','),
                ...(process.env.OTO_BOX_BRIDGE_PORT
                  ? { port: Number(process.env.OTO_BOX_BRIDGE_PORT) }
                  : {}),
              }
            : null,
          onRestartNeeded: () => {
            setTimeout(() => process.exit(EXIT_RESTART), 250).unref();
          },
        });
      } catch (error) {
        err(error instanceof RunnerError ? error.message : `The box could not start: ${String(error)}`);
        return 1;
      }
      return await new Promise<number>((resolveExit) => {
        const shutdown = (signal: string) => {
          log.info({ module: 'runner', signal }, 'stopping');
          void box.stop().finally(() => resolveExit(0));
        };
        process.once('SIGTERM', () => shutdown('SIGTERM'));
        process.once('SIGINT', () => shutdown('SIGINT'));
      });
    }

    case 'status': {
      const paths = runnerPaths(home);
      const credential = await fileCredentialStore(paths.credential).read();
      const state = await readRunnerState(paths);
      const bundle = (await readJsonFile(paths.configBundle)) as {
        configVersion?: string;
        box?: { name?: string };
        stations?: Array<{ id: string; name: string; kind: string; codePrefix: string | null }>;
      } | null;
      const { overrides, problem } = await readOverrides(paths);
      out(`home        ${home}`);
      out(`registered  ${credential ? `yes — box ${credential.boxId}` : 'no (enter the claim code on the television, or run "oto-box claim")'}`);
      // Before a claim, runner.json names no api; the configuration does, and
      // it is the one a claim or a run would use (closing audit L25).
      const configured = option(parsed, 'api', 'OTO_BOX_API');
      const api =
        state.apiBaseUrl ??
        (configured
          ? `${configured} (from the configuration; not claimed against it yet)`
          : '(not set)');
      out(`api         ${api}`);
      const booths = (bundle?.stations ?? []).filter((s) => s.kind === 'booth');
      out(`config      ${bundle?.configVersion ? `held (${bundle.configVersion}), box "${bundle.box?.name ?? '?'}"` : 'none held yet'}`);
      out(`booths      ${booths.length === 0 ? 'none on this box' : booths.map((b) => `${b.name} (${b.codePrefix ?? '—'})${b.id === state.stationId || booths.length === 1 ? ' ← running' : ''}`).join(', ')}`);
      out(`printer     ${overrides.printer ? `override ${overrides.printer.host}:${overrides.printer.port}, ${overrides.printer.widthDots} dots` : 'from the Console'}${problem ? ` (config.json ignored: ${problem})` : ''}`);
      if (existsSync(paths.database)) {
        // The same look the running box takes before it opens its store
        // (SCRUM-403): read-only, and with the integrity check, because a
        // damaged store can still answer a count.
        const verdict = await inspectStoreFile(paths.database);
        out(
          `store       ${
            verdict.ok
              ? 'ok'
              : `${verdict.problem === 'damaged' ? 'damaged' : 'could not be read'} — the booth needs service (PI_BOOTH.md section 7, "A damaged store")`
          }`,
        );
        let db: Awaited<ReturnType<typeof openNodeSqlite>> | null = null;
        try {
          db = await openNodeSqlite(paths.database, { readOnly: true });
          // Counted in the table, not in the send index, as the salvage reads
          // it (`UNSENT_OUTBOX_SQL` in store-sqlite.ts): a damaged index page
          // would say the store could not be read, and a stale one, none.
          const rows = db
            .prepare("select count(*) as n from box_outbox not indexed where state in ('queued','sending')")
            .all() as Array<{ n: number }>;
          out(`outbox      ${rows[0]?.n ?? 0} fact(s) waiting to reach the cloud`);
        } catch {
          out('outbox      (the store could not be read)');
        } finally {
          try {
            db?.close();
          } catch {
            /* nothing opened */
          }
        }
      }
      // What the box copied out of a store it could not use: the vouchers the
      // cloud has not had, which the set-aside files still hold.
      const salvage = await latestSalvage(paths);
      if (salvage) {
        out(
          `salvage     ${salvage.document.rows} unsent record(s) copied out of the store to ${salvage.file}${
            salvage.document.complete ? '' : ' (the read stopped at damage; the store may hold more)'
          }`,
        );
      }
      return 0;
    }

    case null:
    case 'help':
    case '--help':
      out(USAGE);
      return parsed.command === null ? 2 : 0;

    default:
      err(`Unknown command "${parsed.command}".\n\n${USAGE}`);
      return 2;
  }
}

/**
 * Run when this file is the program — directly, or as the bundled
 * `oto-box.mjs` — and not when a test imports it.
 */
const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
const self = fileURLToPath(import.meta.url);
if (invoked === self || /oto-box(\.mjs)?$/.test(invoked)) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`oto-box failed: ${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
