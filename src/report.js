// Task reports: up to 3 short lines from the agent (--report), the rest built by the bus from its own records.
// Built server-side when a done-check passes; stored on the task, appended to .bus/reports.md, never sent to inboxes.
import { BusError, LEAD } from './bus.js';

const roleLabel = (a) => a.role ?? (a.name === LEAD ? 'head' : 'worker');

export const REPORT_MAX_LINES = 3;
export const REPORT_MAX_CHARS = 160;

/** Agent notes -> array of up to 3 trimmed lines. Real newlines or a literal "\n" separate lines; blanks dropped. */
export function parseReport(text) {
  const lines = String(text ?? '').split(/\r?\n|\\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > REPORT_MAX_LINES) throw new BusError(`--report takes at most ${REPORT_MAX_LINES} lines (got ${lines.length})`);
  const long = lines.findIndex((l) => l.length > REPORT_MAX_CHARS);
  if (long !== -1) throw new BusError(`--report line ${long + 1} is too long (max ${REPORT_MAX_CHARS} chars)`);
  return lines;
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
const stamp = (ts) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ') + 'Z';

/**
 * Messages the agent sent and received in [since, until], grouped by counterpart:
 * "↔ backend-1: 4 sent, 3 received; → lead: 2; ← you: 1". Sent: DM -> recipient, channel post -> #channel.
 * Received: anything addressed to the agent (DM, @name, @team), by sender. System "bus" notices are left out.
 */
export function messageSummary(messages, agent, since, until, isFor) {
  const by = new Map();
  const bump = (k, f) => { const e = by.get(k) ?? { sent: 0, received: 0 }; e[f]++; by.set(k, e); };
  for (const m of messages) {
    if (m.ts < since || m.ts > until || m.from === 'bus') continue;
    if (m.from === agent.name) bump(m.to || m.channel, 'sent');
    else if (isFor(m, agent)) bump(m.from, 'received');
  }
  if (!by.size) return 'none';
  return [...by.entries()]
    .sort(([a, x], [b, y]) => (y.sent + y.received) - (x.sent + x.received) || a.localeCompare(b))
    .map(([k, { sent, received }]) => (sent && received ? `↔ ${k}: ${sent} sent, ${received} received`
      : sent ? `→ ${k}: ${sent}` : `← ${k}: ${received}`))
    .join('; ');
}

/** The full report as fields; `render` turns it into text or markdown. */
export function buildReport({ task: t, agent, claims, messages, isFor, notes = [], now = Date.now() }) {
  const since = t.takenAt ?? t.createdAt;
  const r = t.result || {};
  const runs = t.checkRuns ?? 1;
  const fails = t.checkFails ?? 0;
  return {
    title: `#${t.id} ${t.title} — ${agent.name} (${roleLabel(agent)}, team ${agent.team ?? '-'})`,
    fields: [
      ['time', `${fmtDuration(now - since)} (${stamp(since)} → ${stamp(now)})`],
      ['files claimed', claims.length ? claims.join(', ') : 'none'],
      ['commit', t.commit ? `${t.commit.slice(0, 7)} on ${t.branch ?? '?'}` : 'none recorded'],
      ['checks', `${runs} run${runs === 1 ? '' : 's'}${fails ? ` (${fails} failed)` : ''}, final: ${r.ok ? 'passed' : `failed (exit ${r.code})`}${r.ms != null ? ` in ${(r.ms / 1000).toFixed(1)}s` : ''}`],
      ['messages', messageSummary(messages, agent, since, now, isFor)],
    ],
    notes,
    ts: now,
  };
}

export function render(rep, { md = false } = {}) {
  const notes = rep.notes.length ? rep.notes : ['(none given)'];
  if (!md) return [rep.title, ...rep.fields.map(([k, v]) => `${k}: ${v}`), 'notes:', ...notes.map((l) => `  ${l}`)].join('\n');
  return [`## ${rep.title}`, '', ...rep.fields.map(([k, v]) => `- **${k}:** ${v}`), '- **notes:**', ...notes.map((l) => `  - ${l}`), ''].join('\n');
}
