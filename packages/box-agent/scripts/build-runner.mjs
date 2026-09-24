#!/usr/bin/env node
/**
 * Build the booth box's release: one JavaScript file, its fonts, the booth
 * page, and the Raspberry Pi install kit, packed as one tarball (SCRUM-223).
 *
 *   node scripts/build-runner.mjs            → dist/oto-box/ (runnable here)
 *   node scripts/build-runner.mjs --pack     → also dist/oto-box-<version>-<commit>.tgz
 *   node scripts/build-runner.mjs --no-page  → skip building apps/booth
 *
 * What ends up in dist/oto-box/:
 *
 *   oto-box.mjs     the agent, the runner and the kiosk server, bundled by
 *                   esbuild for Node 22. Pure JavaScript, so the same file runs
 *                   on this Windows machine and on a Pi's arm64 Linux.
 *   fonts/          the receipt faces `@oto/print` reads at runtime (OFL; the
 *                   licence files travel with them).
 *   booth/          the built booth page the kiosk serves.
 *   package.json    one dependency: @node-rs/argon2, pinned. It is the only
 *                   native module, and npm fetches the prebuilt binary for the
 *                   machine it runs on (linux-arm64-gnu on a Pi 5).
 *   pi/             install.sh and the systemd units.
 *   PI_BOOTH.md     the set-up guide.
 *   VERSION         the commit this was built from.
 *
 * SQLite needs no module at all: the store uses `node:sqlite`, which is part
 * of Node 22 itself.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import console from 'node:console';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const ROOT = resolve(PKG, '..', '..');
const OUT = join(PKG, 'dist', 'oto-box');
const args = new Set(process.argv.slice(2));

const version = /BOX_AGENT_VERSION = '([^']+)'/.exec(
  readFileSync(join(PKG, 'src', 'protocol.ts'), 'utf8'),
)?.[1];
if (!version) throw new Error('BOX_AGENT_VERSION not found in src/protocol.ts');

/** The argon2 version the platform already locks, so the box verifies PINs with what the api hashes them with. */
const argon2Version = JSON.parse(
  readFileSync(createRequire(join(PKG, 'package.json')).resolve('@node-rs/argon2/package.json'), 'utf8'),
).version;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/**
 * `@oto/print` finds its fonts at `../../fonts/` from its own source file.
 * Bundled, "its own file" is `oto-box.mjs`, so the path is rewritten to
 * `./fonts/` beside the bundle. Refused loudly if the line has moved: a build
 * that silently lost the fonts would print every voucher as boxes.
 */
const fontDirPlugin = {
  name: 'oto-print-font-dir',
  setup(b) {
    b.onLoad({ filter: /[\\/]packages[\\/]print[\\/]src[\\/]fonts[\\/]stack\.ts$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8');
      const from = "new URL('../../fonts/', import.meta.url)";
      if (!source.includes(from)) {
        throw new Error(`${args.path}: the font directory line has changed; update build-runner.mjs`);
      }
      return { contents: source.replace(from, "new URL('./fonts/', import.meta.url)"), loader: 'ts' };
    });
  },
};

const started = Date.now();
await build({
  entryPoints: [join(PKG, 'src', 'runner', 'cli.ts')],
  outfile: join(OUT, 'oto-box.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@node-rs/argon2'],
  plugins: [fontDirPlugin],
  // A CommonJS dependency calling `require` inside an ES module needs one.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __otoRequire } from 'node:module';\nconst require = __otoRequire(import.meta.url);",
  },
  legalComments: 'eof',
  logLevel: 'warning',
});
console.log(`bundled oto-box.mjs in ${Date.now() - started} ms`);

cpSync(join(ROOT, 'packages', 'print', 'fonts'), join(OUT, 'fonts'), { recursive: true });

if (!args.has('--no-page')) {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(pnpm, ['--filter', '@oto/booth', 'run', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) throw new Error('the booth page did not build');
}
const page = join(ROOT, 'apps', 'booth', 'dist', 'public');
if (existsSync(join(page, 'index.html'))) {
  cpSync(page, join(OUT, 'booth'), { recursive: true });
} else {
  console.warn('the booth page is not built (apps/booth/dist/public); the box will say so on screen');
}

const piKit = join(ROOT, 'scripts', 'pi');
if (existsSync(piKit)) {
  cpSync(piKit, join(OUT, 'pi'), { recursive: true });
  /**
   * Unix line endings, whatever the checkout did: a Windows clone with
   * `core.autocrlf` hands these files over with CRLF, and bash on the Pi reads
   * `$'\r'` as part of every command.
   */
  for (const name of readdirSync(join(OUT, 'pi'))) {
    const file = join(OUT, 'pi', name);
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  }
}
const guide = join(ROOT, 'docs', 'ops', 'PI_BOOTH.md');
if (existsSync(guide)) cpSync(guide, join(OUT, 'PI_BOOTH.md'));

writeFileSync(
  join(OUT, 'package.json'),
  `${JSON.stringify(
    {
      name: 'oto-box',
      version,
      private: true,
      type: 'module',
      description: 'The OTO booth box: agent, runner and kiosk server for a Raspberry Pi',
      bin: { 'oto-box': 'oto-box.mjs' },
      engines: { node: '>=22.13' },
      dependencies: { '@node-rs/argon2': argon2Version },
    },
    null,
    2,
  )}\n`,
);

let commit = 'unknown';
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'packages', 'apps/booth', 'scripts/pi'], {
    cwd: ROOT,
  })
    .toString()
    .trim();
  if (dirty) commit += '+local';
} catch {
  /* not a checkout: the version alone will do */
}
writeFileSync(join(OUT, 'VERSION'), `oto-box ${version} ${commit} built ${new Date().toISOString()}\n`);

if (args.has('--pack')) {
  /**
   * A lockfile for the one dependency, so a Pi installs exactly what was
   * tested, checked against the registry's integrity hashes. Needs the npm
   * registry; without it the tarball ships without one and the Pi resolves
   * the same pinned version on its own.
   */
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const lock = spawnSync(npm, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: OUT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (lock.status !== 0) console.warn('no package-lock.json: npm could not reach the registry');
  const tarball = join(PKG, 'dist', `oto-box-${version}-${commit.replace(/[^A-Za-z0-9.+-]/g, '')}.tgz`);
  rmSync(tarball, { force: true });
  // Relative names from inside dist/: GNU tar (Git Bash on Windows) reads the
  // drive letter in an absolute C:… path as a remote host, bsdtar does not.
  execFileSync('tar', ['-czf', basename(tarball), 'oto-box'], { cwd: join(PKG, 'dist'), stdio: 'inherit' });
  console.log(`packed ${tarball}`);
}
console.log(`built ${OUT}`);
