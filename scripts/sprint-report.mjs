// A short, readable Sprint 2 report, composed from Jira and delivered to
// WhatsApp through Twilio.
//
// WHY A SCRIPT AND NOT A PLATFORM JOB, YET. The platform's job runner and its
// alert channels (S2-03) are the right home for this, and it moves there once
// S2-17a is out of apps/api. Until then this runs from a machine that already
// has the credentials, which is enough to get the report in front of somebody
// this week rather than next.
//
// It prints the report whether or not it can send it, so it is useful with no
// credentials at all and its output can be pasted anywhere.
//
// Reads, from the environment or the gitignored .env:
//   JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN     required
//   TWILIO_ACCOUNT_SID                            required to send
//   TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET    preferred credential
//   TWILIO_AUTH_TOKEN                             fallback credential
//   TWILIO_WHATSAPP_FROM   e.g. whatsapp:+14155238886 (the Twilio sandbox)
//   REPORT_WHATSAPP_TO     one or more E.164 numbers, comma separated
//
// Usage:
//   node scripts/sprint-report.mjs            print it
//   node scripts/sprint-report.mjs --send     print it and send it
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const BASE = process.env.JIRA_BASE_URL?.replace(/\/+$/, '');
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
if (!BASE || !EMAIL || !TOKEN) {
  console.error('Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN (environment or .env).');
  process.exit(1);
}
const auth = 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');
const send = process.argv.includes('--send');

/** The sprint, its epics included, newest movement first. */
const JQL =
  'project = SCRUM AND (sprint = 3 OR key in (SCRUM-181, SCRUM-182, SCRUM-183, SCRUM-184)) ORDER BY updated DESC';

async function jira(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: auth } });
  if (!res.ok) throw new Error(`Jira ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const { issues } = await jira(
  `/rest/api/3/search/jql?jql=${encodeURIComponent(JQL)}&maxResults=100&fields=summary,status,issuetype,updated`,
);

/** Ticket keys carry no meaning outside Jira, so the report leads with the plan's own names. */
const shortName = (summary) => {
  const m = summary.match(/^\s*(S2-\d+[a-c]?)\s*[—-]\s*(.*)$/);
  if (!m) return summary.replace(/^S2 P\d+ - /, '');
  const [, id, rest] = m;
  return `${id}: ${rest.split(/[:,]/)[0].trim()}`;
};

const stories = issues.filter((i) => i.fields.issuetype.name !== 'Epic');
const by = (name) => stories.filter((i) => i.fields.status.name === name);
const testing = by('Testing');
const inProgress = by('In Progress');
const todo = by('To Do');
const done = by('Done');
const built = testing.length + done.length;

const day = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

const lines = [
  `*OTO Platform — Sprint 2* · ${day}`,
  '',
  `${built} of ${stories.length} built, ${inProgress.length} in flight, ${todo.length} to come.`,
  '',
];

if (testing.length > 0) {
  lines.push('*Built and on staging — ready to look at*');
  for (const i of testing) lines.push(`• ${shortName(i.fields.summary)}`);
  lines.push('');
}
if (inProgress.length > 0) {
  lines.push('*Being built now*');
  for (const i of inProgress) lines.push(`• ${shortName(i.fields.summary)}`);
  lines.push('');
}
if (done.length > 0) {
  lines.push(`*Signed off*: ${done.length}`);
  lines.push('');
}

lines.push(
  'Try it: the front door is https://oto-launcher-staging.onrender.com — sign in once and the tiles open already signed in.',
  '',
  `Every ticket, with what changed and how it was checked: ${BASE}/issues/?filter=10033`,
);

const body = lines.join('\n');
console.log('\n' + body + '\n');

if (!send) {
  console.log('(Not sent. Add --send to deliver it.)');
  process.exit(0);
}

// --- Delivery ---------------------------------------------------------------

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const from = process.env.TWILIO_WHATSAPP_FROM;
const to = (process.env.REPORT_WHATSAPP_TO ?? '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

// Name what is missing rather than half-sending: a report nobody received and
// nobody was told about is worse than no report.
const missing = [];
if (!accountSid) missing.push('TWILIO_ACCOUNT_SID');
if (!from) missing.push('TWILIO_WHATSAPP_FROM');
if (to.length === 0) missing.push('REPORT_WHATSAPP_TO');
const keySid = process.env.TWILIO_API_KEY_SID;
const keySecret = process.env.TWILIO_API_KEY_SECRET;
const authToken = process.env.TWILIO_AUTH_TOKEN;
if (!(keySid && keySecret) && !authToken) missing.push('TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET (or TWILIO_AUTH_TOKEN)');
if (missing.length > 0) {
  console.error('Not sent. These are unset: ' + missing.join(', '));
  process.exit(1);
}

// An API key is preferred over the account token: it is revoked and rotated on
// its own, without changing every other thing the account authenticates.
const credential = keySid && keySecret ? `${keySid}:${keySecret}` : `${accountSid}:${authToken}`;
const twilioAuth = 'Basic ' + Buffer.from(credential).toString('base64');
const whatsapp = (n) => (n.startsWith('whatsapp:') ? n : `whatsapp:${n}`);

let sent = 0;
for (const number of to) {
  const params = new URLSearchParams({ From: whatsapp(from), To: whatsapp(number), Body: body });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: { authorization: twilioAuth, 'content-type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const json = await res.json().catch(() => null);
  if (res.ok) {
    sent++;
    console.log(`sent to ${number} (${json?.sid})`);
  } else {
    // Twilio's own message says what is wrong far better than a wrapper would;
    // code 63015/63016 means the recipient has not joined the sandbox yet.
    console.error(`failed for ${number}: ${json?.code ?? res.status} ${json?.message ?? ''}`);
  }
}
console.log(`${sent}/${to.length} delivered.`);
process.exit(sent === to.length ? 0 : 1);
