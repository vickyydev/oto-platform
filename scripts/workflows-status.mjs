#!/usr/bin/env node
/**
 * What the background workflows are doing right now — for an editor where
 * `/workflows` is not available.
 *
 * Reads every workflow run's journal under this session's transcript folder
 * and each agent's transcript: which phase it is in, its last tool call, and
 * whether it is still writing. A run whose agents have not written for a
 * while and whose transcript ends with "interrupted" was stopped by a Stop
 * key or a declined permission prompt — that cuts every running subagent at
 * once, so the number here can drop suddenly.
 *
 *   node scripts/workflows-status.mjs            # runs touched in the last 3 hours
 *   node scripts/workflows-status.mjs --all      # every run in the session
 *   node scripts/workflows-status.mjs --watch    # refresh every 30 s
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROJECT = 'c--Users-waqar-OneDrive-Desktop-Projects-oto-pos';
const base = join(homedir(), '.claude', 'projects', PROJECT);
const args = process.argv.slice(2);
const all = args.includes('--all');
const watch = args.includes('--watch');

function sessions() {
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .map((s) => join(base, s, 'subagents', 'workflows'))
    .filter((p) => existsSync(p));
}

function lastLine(file) {
  const text = readFileSync(file, 'utf8').trim();
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 5; i -= 1) {
    try {
      const x = JSON.parse(lines[i]);
      const c = x.message?.content ?? x.content;
      if (typeof c === 'string' && c.trim()) return c.slice(0, 90);
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'tool_use') return `${b.name} ${JSON.stringify(b.input).slice(0, 70)}`;
          if (b.type === 'text' && b.text?.includes('interrupted')) return 'INTERRUPTED';
          if (b.type === 'text' && b.text?.trim()) return b.text.slice(0, 90);
        }
      }
    } catch {
      /* partial line */
    }
  }
  return '';
}

function report() {
  const now = Date.now();
  const rows = [];
  for (const dir of sessions()) {
    for (const run of readdirSync(dir)) {
      const journal = join(dir, run, 'journal.jsonl');
      if (!existsSync(journal)) continue;
      const touched = statSync(journal).mtimeMs;
      const agents = readdirSync(join(dir, run)).filter((f) => /^agent-.*\.jsonl$/.test(f));
      const latest = agents.reduce((m, f) => Math.max(m, statSync(join(dir, run, f)).mtimeMs), touched);
      if (!all && now - latest > 3 * 3600_000) continue;
      const events = readFileSync(journal, 'utf8')
        .trim()
        .split('\n')
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const started = events.filter((e) => e.type === 'started').map((e) => e.label);
      const done = events.filter((e) => e.type === 'result').length;
      const finished = events.some((e) => e.type === 'completed' || e.type === 'finished' || e.type === 'return');
      const agentLines = agents.map((f) => {
        const p = join(dir, run, f);
        const age = Math.round((now - statSync(p).mtimeMs) / 60_000);
        const last = lastLine(p);
        const state = last === 'INTERRUPTED' ? 'stopped' : age > 20 ? 'quiet' : 'working';
        return `      ${f.slice(6, 20)}  ${state.padEnd(8)} ${String(age).padStart(3)} min ago  ${last.replace(/\s+/g, ' ')}`;
      });
      rows.push({
        latest,
        text: `${run}  agents ${done}/${started.length} done${finished ? '  FINISHED' : ''}  last write ${Math.round((now - latest) / 60_000)} min ago\n   phases: ${started.join(' · ')}\n${agentLines.join('\n')}`,
      });
    }
  }
  rows.sort((a, b) => b.latest - a.latest);
  console.clear?.();
  console.log(new Date().toLocaleTimeString(), `— ${rows.length} workflow run(s)${all ? '' : ' touched in the last 3 h'}\n`);
  for (const r of rows) console.log(r.text + '\n');
}

report();
if (watch) setInterval(report, 30_000);
