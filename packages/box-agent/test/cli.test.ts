import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { BOX_AGENT_VERSION } from '../src/protocol';
import { main, parseArgs, readClaimCode, type CliStreams } from '../src/runner/cli';
import { runnerPaths } from '../src/runner/home';

/**
 * SCRUM-418 (closing audit L24, L25) — `oto-box` at the terminal.
 *
 * The claim code is asked for rather than taken from the command line, so it
 * is in nobody's shell history; and `status` names the api the box would be
 * claimed against before there is a claim, instead of "(not set)".
 */

/** Streams a test can read back, and an input it feeds. */
function streams(input: string | null): CliStreams & { out(): string; err(): string } {
  let out = '';
  let err = '';
  const stdin = new PassThrough();
  if (input === null) stdin.end();
  else stdin.end(input);
  return {
    stdin,
    stdout: { write: (chunk: string) => ((out += chunk), true) },
    stderr: { write: (chunk: string) => ((err += chunk), true) },
    out: () => out,
    err: () => err,
  };
}

test('flags, inline values and positionals are read apart', () => {
  const parsed = parseArgs(['claim', '--api', 'http://cloud.test', '--home=/tmp/box', '--force']);
  assert.equal(parsed.command, 'claim');
  assert.deepEqual(parsed.positional, []);
  assert.deepEqual(
    [...parsed.flags],
    [
      ['api', 'http://cloud.test'],
      ['home', '/tmp/box'],
      ['force', true],
    ],
  );
});

test('the claim code is read from a line on stdin, trimmed, after a prompt on stderr', async () => {
  const io = streams('  ABCD-1234  \n');
  assert.equal(await readClaimCode(io.stdin!, io.stderr!, 'Claim code: '), 'ABCD-1234');
  assert.equal(io.err(), 'Claim code: ');

  const nothing = streams(null);
  assert.equal(
    await readClaimCode(nothing.stdin!, nothing.stderr!, 'Claim code: '),
    null,
    'stdin closed first',
  );
  const blank = streams('\n');
  assert.equal(
    await readClaimCode(blank.stdin!, blank.stderr!, 'Claim code: '),
    null,
    'an empty line is no code',
  );
});

test('claim without an api, or with no code entered, is a usage error and calls nobody', async () => {
  const home = mkdtempSync(join(tmpdir(), 'oto-box-cli-'));
  const noApi = streams('ABCD-1234\n');
  const saved = process.env.OTO_BOX_API;
  delete process.env.OTO_BOX_API;
  try {
    assert.equal(await main(['claim', '--home', home], noApi), 2);
    assert.match(noApi.err(), /Usage: oto-box claim --api/);
    assert.match(noApi.err(), /the claim code is asked for/);

    const noCode = streams(null);
    assert.equal(await main(['claim', '--api', 'http://cloud.test', '--home', home], noCode), 2);
    assert.match(noCode.err(), /No claim code was entered/);
    assert.match(noCode.err(), /^Claim code \(Console/, 'it asked first');
  } finally {
    if (saved !== undefined) process.env.OTO_BOX_API = saved;
  }
});

test('status names the configured api before a claim, and the claimed one after', async () => {
  const home = mkdtempSync(join(tmpdir(), 'oto-box-cli-'));
  const saved = process.env.OTO_BOX_API;
  delete process.env.OTO_BOX_API;
  try {
    const unset = streams(null);
    assert.equal(await main(['status', '--home', home], unset), 0);
    assert.match(unset.out(), /^registered {2}no/m);
    assert.match(unset.out(), /^api {9}\(not set\)/m);

    const flagged = streams(null);
    assert.equal(await main(['status', '--home', home, '--api', 'http://cloud.test'], flagged), 0);
    assert.match(
      flagged.out(),
      /^api {9}http:\/\/cloud\.test \(from the configuration; not claimed against it yet\)/m,
    );

    // As the systemd unit and the wrapper script hand it over.
    process.env.OTO_BOX_API = 'http://env.test';
    const fromEnv = streams(null);
    assert.equal(await main(['status', '--home', home], fromEnv), 0);
    assert.match(fromEnv.out(), /^api {9}http:\/\/env\.test \(from the configuration/m);

    // Claimed: the api the box was claimed against wins, with no aside.
    writeFileSync(
      runnerPaths(home).state,
      JSON.stringify({ apiBaseUrl: 'http://claimed.test', stationId: null }),
    );
    const claimed = streams(null);
    assert.equal(await main(['status', '--home', home], claimed), 0);
    assert.match(claimed.out(), /^api {9}http:\/\/claimed\.test$/m);
  } finally {
    if (saved === undefined) delete process.env.OTO_BOX_API;
    else process.env.OTO_BOX_API = saved;
  }
});

test('version, help and an unknown command', async () => {
  const version = streams(null);
  assert.equal(await main(['version'], version), 0);
  assert.equal(version.out(), `${BOX_AGENT_VERSION}\n`);

  const help = streams(null);
  assert.equal(await main(['help'], help), 0);
  assert.match(help.out(), /oto-box claim --api <url>/);
  assert.match(help.out(), /asks for the claim code/);

  const unknown = streams(null);
  assert.equal(await main(['frobnicate'], unknown), 2);
  assert.match(unknown.err(), /Unknown command "frobnicate"/);
});
