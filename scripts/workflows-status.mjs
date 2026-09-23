#!/usr/bin/env node
/**
 * What the background workflow runs are doing right now — for an editor where
 * `/workflows` is not available.
 *
 * Every run writes a journal next to its agents' transcripts. The journal is
 * the authority here: `started` names each phase and the agent that took it,
 * `result` is that agent returning. So an agent is finished when its id has a
 * `result`, not when its prose happens to read like a report — several slices
 * this morning resumed interrupted attempts and wrote the word "interrupted"
 * all over their final reports.
 *
 * An agent that was cut off leaves no `result` and its transcript ends on
 * the cut itself: "[Request interrupted by user" (the Stop key, or a declined
 * permission prompt, which cuts every running subagent at once) or the
 * session-limit message, which ends every running agent the same way. Those
 * are the only stopped signals.
 *
 * "done" means every phase that started has returned. The journal records no
 * event for the script itself exiting, so a run can sit in `done` for a few
 * seconds between phases before the next `started` appears.
 *
 *   node scripts/workflows-status.mjs            # runs touched in the last 3 hours
 *   node scripts/workflows-status.mjs --all      # every run in the session
 *   node scripts/workflows-status.mjs --watch    # refresh every 30 s
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setInterval } from 'node:timers';

const PROJECT = 'c--Users-waqar-OneDrive-Desktop-Projects-oto-pos';
const base = join(homedir(), '.claude', 'projects', PROJECT);
const args = process.argv.slice(2);
const all = args.includes('--all');
const watch = args.includes('--watch');

const WORKING_MIN = 3; // a live agent writes a tool call every few seconds
const STALLED_MIN = 20;

function sessions() {
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .map((s) => join(base, s, 'subagents', 'workflows'))
    .filter((p) => existsSync(p));
}

function readJsonl(file) {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null; // the line being written right now
      }
    })
    .filter(Boolean);
}

/** The last thing the agent did, and whether it was cut off mid-tool. */
function tail(file) {
  const entries = readJsonl(file).slice(-6);
  let last = '';
  let interrupted = false;
  for (const x of entries) {
    const content = x.message?.content ?? x.content;
    if (typeof content === 'string' && content.trim()) last = content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === 'tool_use') last = `${b.name} ${JSON.stringify(b.input).slice(0, 70)}`;
      else if (b.type === 'text' && b.text?.trim()) last = b.text;
      const text = b.type === 'text' ? b.text : typeof b.content === 'string' ? b.content : '';
      if (text?.includes('[Request interrupted by user')) interrupted = true;
      else if (text?.includes("doesn't want to proceed with this tool use")) interrupted = true;
      // The session limit ends every running agent at once; the transcript's
      // last line is the limit message, not a tool call.
      else if (text?.includes("You've hit your session limit")) interrupted = true;
      else if (b.type === 'tool_use' || (b.type === 'text' && b.text?.trim())) interrupted = false;
    }
  }
  return { last: last.replace(/\s+/g, ' ').slice(0, 96), interrupted };
}

function collect() {
  const now = Date.now();
  const runs = [];
  for (const dir of sessions()) {
    for (const run of readdirSync(dir)) {
      const journalFile = join(dir, run, 'journal.jsonl');
      if (!existsSync(journalFile)) continue;
      const files = readdirSync(join(dir, run));
      const touched = files
        .filter((f) => /\.jsonl$/.test(f))
        .reduce((m, f) => Math.max(m, statSync(join(dir, run, f)).mtimeMs), 0);
      if (!all && now - touched > 3 * 3600_000) continue;

      const events = readJsonl(journalFile);
      const returned = new Set(events.filter((e) => e.type === 'result').map((e) => e.agentId));
      const agents = events
        .filter((e) => e.type === 'started')
        .map((e) => {
          const file = join(dir, run, `agent-${e.agentId}.jsonl`);
          if (!existsSync(file)) return { label: e.label, state: 'spawning', age: 0, last: '' };
          const age = Math.round((now - statSync(file).mtimeMs) / 60_000);
          const { last, interrupted } = tail(file);
          const state = returned.has(e.agentId)
            ? 'returned'
            : interrupted
              ? 'stopped'
              : age <= WORKING_MIN
                ? 'working'
                : age <= STALLED_MIN
                  ? 'quiet'
                  : 'stalled';
          return { label: e.label ?? e.phase, state, age, last };
        });

      const live = agents.some((a) => ['working', 'quiet', 'spawning'].includes(a.state));
      const state = live
        ? 'running'
        : agents.some((a) => a.state === 'stopped')
          ? 'stopped'
          : agents.every((a) => a.state === 'returned')
            ? 'done'
            : 'stalled';
      runs.push({ run, touched, agents, state });
    }
  }
  return runs.sort((a, b) => b.touched - a.touched);
}

function report() {
  const now = Date.now();
  const runs = collect();
  const tally = (s) => runs.filter((r) => r.state === s).length;
  console.clear?.();
  console.log(
    `${new Date().toLocaleTimeString()} — ${tally('running')} running · ${tally('done')} done · ` +
      `${tally('stopped')} stopped · ${tally('stalled')} stalled` +
      `${all ? '' : '   (touched in the last 3 h)'}\n`,
  );
  for (const group of ['running', 'stalled', 'stopped', 'done']) {
    const rows = runs.filter((r) => r.state === group);
    if (!rows.length) continue;
    console.log(group.toUpperCase());
    for (const r of rows) {
      const mins = Math.round((now - r.touched) / 60_000);
      console.log(`  ${r.run}  last write ${mins} min ago`);
      for (const a of r.agents) {
        console.log(
          `     ${String(a.label).padEnd(22)} ${a.state.padEnd(8)} ${String(a.age).padStart(3)} min  ${a.last}`,
        );
      }
    }
    console.log('');
  }
}

report();
if (watch) setInterval(report, 30_000);
