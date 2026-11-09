#!/usr/bin/env node
// strata/ownership-metrics.mjs — published ownership & knowledge metrics from git alone.
//
// Usage:
//   node ownership-metrics.mjs [--metric bird|decay|orphan|all]
//                              [--ref <ref>] [--repo <dir>] [--map <identities.tsv>]
//                              [--blame <blame.tsv>]       # required for orphan
//                              [--granularity file|dir] [--threshold 0.05]
//                              [--half-life 5] [--window 365] [--as-of YYYY-MM-DD]
//                              [--fanin <edges.json>] [--format table|json]
//
// Three metrics, each with a published definition and (verified 2026-11) no
// open-source implementation. See references/metrics.md and references/prior-art.md.
//
// BIRD OWNERSHIP SUITE — Bird, Nagappan, Murphy, Gall, Devanbu, ESEC/FSE 2011
//   ownership(d,c) = commits by d to c / total commits to c      (commits, NOT lines)
//   Minor(c) = |{d : ownership < t}|   Major(c) = |{d : ownership >= t}|   t = 0.05
//   Ownership(c) = max_d ownership(d,c)
//   On Windows Vista/7, Minor predicted defects better than size, churn or complexity.
//
// DECAY-WEIGHTED KNOWLEDGE — Jabrayilzade et al., ICSE-SEIP 2022
//   knowledge(d,f) = SUM over d's commits to f of  2^( -months_ago / 5 )
//   A 5-month half-life, validated on 13 JetBrains projects. Every tool in the
//   category uses a binary ex-developer flag or a hard window instead; nothing
//   ships continuous decay. Only the commit term is used here - the paper's
//   review/comment/meeting weights need data git does not have.
//
// ORPHANED CODE — Izquierdo-Cortazar et al., HICSS 2009; threshold from Rigby et al.,
// ICSE 2016; corrected per Nassif & Robillard, ICSME 2017
//   active(d)  = d has >= 1 commit within --window days of --as-of
//   orphan(f)  = lines blamed to inactive devs / total lines in f
//   abandoned  = orphan(f) >= 0.90
//   risk(f)    = orphan(f) * churn_rate(f) * fan_in(f)
//   Nassif & Robillard showed the original model overestimates loss by ignoring
//   what happens after abandonment, so this reports PERSISTENT abandonment -
//   measured at the analysis ref, not at the moment of departure.

import { readFileSync } from 'node:fs';
import { gitIn } from './lib/strata.mjs';

// ---------- args ----------
const argv = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const METRIC = opt('metric', 'all');
const REF = opt('ref', 'HEAD');
const REPO = opt('repo', '.');
const MAP = opt('map');
const BLAME = opt('blame');
const GRAN = opt('granularity', 'file');
const THRESHOLD = Number(opt('threshold', '0.05'));
const HALF_LIFE = Number(opt('half-life', '5'));      // months
const WINDOW = Number(opt('window', '365'));          // days
const FANIN = opt('fanin');
const FORMAT = opt('format', 'table');

const WANT = (m) => METRIC === 'all' || METRIC === m;
for (const bad of [['granularity', ['file', 'dir'].includes(GRAN)],
                   ['metric', ['bird', 'decay', 'orphan', 'all'].includes(METRIC)],
                   ['threshold', THRESHOLD > 0 && THRESHOLD < 1],
                   ['half-life', HALF_LIFE > 0],
                   ['window', WINDOW > 0]]) {
  if (!bad[1]) { console.error(`invalid --${bad[0]}`); process.exit(1); }
}
if (WANT('orphan') && !BLAME && METRIC === 'orphan') {
  console.error('--metric orphan needs --blame <blame.tsv>; produce it with:\n  sh blame-cache.sh <ref> <repo> > blame.tsv');
  process.exit(1);
}

// ---------- identity mapping ----------
// Every metric below is meaningless without this: one person under two identities
// splits their ownership and invents a phantom minor contributor, which is exactly
// the variable Bird et al. found most predictive.
const idmap = new Map();
if (MAP) {
  for (const line of readFileSync(MAP, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const t = line.indexOf('\t');
    if (t > 0) idmap.set(line.slice(0, t).trim(), line.slice(t + 1).trim());
  }
}
const BOT_RE = /\bbot\b|\[bot\]|dependabot|renovate|github-actions|semantic-release|greenkeeper/i;
const person = (id) => idmap.get(id) ?? id.replace(/\s*<.*>$/, '');

// ---------- git extraction (one pass, shared by every metric) ----------
// one git runner for the whole toolkit: it validates the repo up front and fails
// with a sentence instead of a stack trace
const git = gitIn(REPO);

// Default as-of is the LATEST AUTHOR DATE in the analysed history, not HEAD's own
// date. Commit order and author order diverge routinely (rebases, cherry-picks,
// long-lived branches), and using HEAD's date leaves commits authored "in the
// future" relative to as-of, whose decay weight then has to be clamped.
const AS_OF = opt('as-of') ??
  git('log', REF, '--date=short', '--pretty=%ad').split('\n')
    .filter(Boolean).sort().pop();
const asOfMs = Date.parse(`${AS_OF}T00:00:00Z`);
if (Number.isNaN(asOfMs)) { console.error(`bad --as-of ${AS_OF}`); process.exit(1); }

const componentOf = (p) => {
  if (GRAN === 'file') return p;
  const i = p.lastIndexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
};

const raw = git('log', REF, '--use-mailmap', '-M', '--name-only',
                '--pretty=format:@@%an <%ae>|%ad', '--date=short');

const counts = new Map();   // component -> Map(person -> commits)
const totals = new Map();   // component -> total commits
const decayed = new Map();  // component -> Map(person -> decayed knowledge)
const lastSeen = new Map(); // person -> latest commit date (ms)
const span = new Map();     // component -> {first, last} commit date (ms)
const people = new Set();
const bots = new Set();
let commitsScanned = 0;

let who = null, when = 0, touched = null;
const flush = () => {
  if (!who || !touched) return;
  const monthsAgo = Math.max(0, (asOfMs - when) / (1000 * 60 * 60 * 24 * 30.4375));
  const w = Math.pow(2, -monthsAgo / HALF_LIFE);
  for (const comp of touched) {
    if (!counts.has(comp)) { counts.set(comp, new Map()); decayed.set(comp, new Map()); }
    const c = counts.get(comp), d = decayed.get(comp);
    c.set(who, (c.get(who) ?? 0) + 1);
    d.set(who, (d.get(who) ?? 0) + w);
    totals.set(comp, (totals.get(comp) ?? 0) + 1);
    // component lifespan, for a real churn RATE rather than a bare commit count
    const sp = span.get(comp);
    if (!sp) span.set(comp, { first: when, last: when });
    else { if (when < sp.first) sp.first = when; if (when > sp.last) sp.last = when; }
  }
};

for (const line of raw.split('\n')) {
  if (line.startsWith('@@')) {
    flush();
    commitsScanned++;
    const rec = line.slice(2), bar = rec.lastIndexOf('|');
    const id = rec.slice(0, bar);
    if (BOT_RE.test(id)) { bots.add(id); who = null; touched = null; continue; }
    who = person(id);
    when = Date.parse(`${rec.slice(bar + 1)}T00:00:00Z`);
    people.add(who);
    if (!lastSeen.has(who) || when > lastSeen.get(who)) lastSeen.set(who, when);
    touched = new Set();
    continue;
  }
  if (who && line.trim()) touched.add(componentOf(line.trim()));
}
flush();

// active / departed, from the last commit date per person
const activeCutoff = asOfMs - WINDOW * 24 * 60 * 60 * 1000;
const isActive = (p) => (lastSeen.get(p) ?? 0) >= activeCutoff;
const activePeople = [...people].filter(isActive);
const departedPeople = [...people].filter((p) => !isActive(p));

// ---------- B1: Bird suite ----------
function birdRows() {
  const rows = [];
  for (const [comp, m] of counts) {
    const total = totals.get(comp) ?? 0;
    let minor = 0, major = 0, best = 0;
    for (const [, n] of m) {
      const share = n / total;
      if (share < THRESHOLD) minor++; else major++;
      if (share > best) best = share;
    }
    // Deterministic tie-break, and report the tie. Silently picking one of two
    // equal owners turns Map iteration order into a finding.
    const leaders = [...m.entries()].filter(([, n]) => n / total === best)
      .map(([p]) => p).sort();
    rows.push({
      path: comp, total_commits: total, contributors: m.size,
      minor, major, ownership: +best.toFixed(4),
      top_owner: leaders[0] ?? null,
      top_owner_tied: leaders.length > 1 ? leaders : null
    });
  }
  // Tie-aware percentile rank: fraction of components strictly lower. Indexing a
  // sorted array would invent a ranking among equal values.
  const vals = rows.map((r) => r.minor).sort((a, b) => a - b);
  const lessThan = (x) => {
    let lo = 0, hi = vals.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (vals[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  };
  for (const r of rows) r.minor_pctile = vals.length ? +(lessThan(r.minor) / vals.length).toFixed(4) : 0;
  rows.sort((a, b) => b.minor - a.minor || a.ownership - b.ownership || a.path.localeCompare(b.path));
  return rows;
}

// ---------- B2: decay-weighted knowledge ----------
function decayRows() {
  const rows = [];
  for (const [comp, m] of decayed) {
    const tot = [...m.values()].reduce((s, v) => s + v, 0);
    const ranked = [...m.entries()]
      .map(([p, k]) => ({
        person: p, knowledge: +k.toFixed(4),
        share: tot > 0 ? +(k / tot).toFixed(4) : 0, active: isActive(p)
      }))
      .sort((a, b) => b.knowledge - a.knowledge || a.person.localeCompare(b.person));
    const live = ranked.filter((r) => r.active).reduce((s, r) => s + r.knowledge, 0);
    rows.push({
      path: comp,
      total_knowledge: +tot.toFixed(4),
      live_knowledge: +live.toFixed(4),
      // the actionable number: how much of what is known about this file is still
      // held by someone who is around
      live_share: tot > 0 ? +(live / tot).toFixed(4) : 0,
      holders: ranked.slice(0, 5)
    });
  }
  rows.sort((a, b) => a.live_share - b.live_share || b.total_knowledge - a.total_knowledge);
  return rows;
}

// ---------- B3: orphaned code ----------
function orphanRows() {
  if (!BLAME) return null;
  const lines = new Map();  // path -> Map(person -> lines)
  for (const row of readFileSync(BLAME, 'utf8').split('\n')) {
    if (!row.trim()) continue;
    const [path, author, n] = row.split('\t');
    if (!path || !author || !n) continue;
    if (BOT_RE.test(author)) continue;
    const p = person(author);
    const comp = componentOf(path);
    if (!lines.has(comp)) lines.set(comp, new Map());
    const m = lines.get(comp);
    m.set(p, (m.get(p) ?? 0) + Number(n));
  }

  // optional static fan-in, for the risk weighting
  const fanin = new Map();
  if (FANIN) {
    try {
      const j = JSON.parse(readFileSync(FANIN, 'utf8'));
      const nodes = j.nodes ?? j.N ?? [];
      const edges = j.edges ?? j.E ?? [];
      const label = (n) => (Array.isArray(n) ? n[0] : (n.label ?? n.id ?? String(n)));
      for (const e of edges) {
        const t = Array.isArray(e) ? e[1] : e.target;
        const k = typeof t === 'number' ? label(nodes[t]) : String(t);
        fanin.set(k, (fanin.get(k) ?? 0) + 1);
      }
    } catch (e) {
      console.error(`warning: could not read --fanin ${FANIN}: ${e.message}`);
    }
  }

  const rows = [];
  for (const [comp, m] of lines) {
    const total = [...m.values()].reduce((s, v) => s + v, 0);
    if (!total) continue;
    let orphanLines = 0;
    for (const [p, n] of m) if (!isActive(p)) orphanLines += n;
    const orphan = orphanLines / total;
    const commits = totals.get(comp) ?? 0;
    // A real churn RATE: commits per month over the component's observed lifespan.
    // A bare commit count would rank a long-settled file with many old commits
    // above a file being actively churned right now, which inverts the signal.
    const sp = span.get(comp);
    const months = sp ? Math.max(1, (sp.last - sp.first) / (1000 * 60 * 60 * 24 * 30.4375)) : 1;
    const churnRate = commits / months;
    const fi = fanin.get(comp) ?? 0;
    rows.push({
      path: comp,
      lines: total,
      orphan_lines: orphanLines,
      orphan: +orphan.toFixed(4),
      abandoned: orphan >= 0.90,
      commits,
      churn_rate: +churnRate.toFixed(3),
      fan_in: fi,
      // orphaned AND still changing AND depended upon - the combination that
      // actually bites. Reported raw so the weighting stays inspectable.
      risk: +(orphan * churnRate * (fi + 1)).toFixed(3),
      departed_holders: [...m.entries()].filter(([p]) => !isActive(p))
        .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, n]) => ({ person: p, lines: n })),
      // Rigby's mitigation: a second contributor with a non-trivial share means the
      // file does not abandon when the primary leaves.
      has_successor: [...m.values()].filter((n) => n / total >= 0.10).length >= 2
    });
  }
  rows.sort((a, b) => b.risk - a.risk || b.orphan - a.orphan);
  return rows;
}

// ---------- assemble ----------
const out = {
  ref: REF,
  as_of: AS_OF,
  granularity: GRAN,
  summary: {
    commits_scanned: commitsScanned,
    people: people.size,
    active: activePeople.length,
    departed: departedPeople.length,
    departed_names: departedPeople.sort(),
    activity_window_days: WINDOW,
    bots_excluded: bots.size,
    identity_mapping: MAP ?? null
  },
  caveats: [
    'Ownership is counted in COMMITS (Bird et al. 2011), not lines.',
    '"Owner" means wrote the most commits, NOT is responsible for.',
    'Decay uses the commit term only; the published model also weights code review, comments and meetings, which git cannot see.',
    'Abandonment is reported as PERSISTENT at the analysis ref (Nassif & Robillard 2017), not at the moment of departure.',
    'Foucault et al. found the Bird metrics weaker in open source, where a long tail of drive-by contributors saturates Minor; rank with minor_pctile inside one repo.',
    MAP ? null : 'NO IDENTITY MAPPING - run identities.sh and pass --map, or these numbers split one person into several.'
  ].filter(Boolean)
};
if (WANT('bird')) out.bird = { citation: 'Bird et al., ESEC/FSE 2011', threshold: THRESHOLD, components: birdRows() };
if (WANT('decay')) out.decay = { citation: 'Jabrayilzade et al., ICSE-SEIP 2022', half_life_months: HALF_LIFE, components: decayRows() };
if (WANT('orphan')) {
  const r = orphanRows();
  out.orphan = r
    ? { citation: 'Izquierdo-Cortazar et al. HICSS 2009; Rigby et al. ICSE 2016; Nassif & Robillard ICSME 2017', abandoned_threshold: 0.90, components: r }
    : { skipped: 'needs --blame <blame.tsv> (produce with blame-cache.sh)' };
}

// ---------- output ----------
if (FORMAT === 'json') {
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else {
  const s = out.summary;
  console.log(`strata ownership & knowledge metrics`);
  console.log(`ref ${REF} · as-of ${AS_OF} · granularity ${GRAN}`);
  console.log(`${s.commits_scanned} commits · ${s.people} people (${s.active} active, ${s.departed} departed @ ${WINDOW}d)` +
              (s.bots_excluded ? ` · ${s.bots_excluded} bot identities excluded` : ''));
  if (s.departed) console.log(`departed: ${s.departed_names.join(', ')}`);

  if (out.bird) {
    console.log(`\n── Bird ownership suite ─ ${out.bird.citation} ─ threshold ${THRESHOLD}`);
    console.log('MINOR  MAJOR  OWNERSHIP  PCTILE  COMMITS  TOP OWNER            COMPONENT');
    for (const r of out.bird.components) {
      console.log(
        String(r.minor).padStart(5) + '  ' + String(r.major).padStart(5) + '  ' +
        r.ownership.toFixed(3).padStart(9) + '  ' + r.minor_pctile.toFixed(2).padStart(6) + '  ' +
        String(r.total_commits).padStart(7) + '  ' +
        (r.top_owner_tied ? `${r.top_owner_tied.length}-way tie` : String(r.top_owner ?? '-')).slice(0, 19).padEnd(19) +
        '  ' + r.path);
    }
  }
  if (out.decay) {
    console.log(`\n── Decay-weighted knowledge ─ ${out.decay.citation} ─ ${HALF_LIFE}-month half-life`);
    console.log('LIVE%  KNOWLEDGE  TOP HOLDER                 COMPONENT');
    for (const r of out.decay.components) {
      const h = r.holders[0];
      console.log(
        (r.live_share * 100).toFixed(0).padStart(5) + '  ' +
        r.total_knowledge.toFixed(3).padStart(9) + '  ' +
        `${h ? h.person : '-'}${h && !h.active ? ' (departed)' : ''}`.slice(0, 25).padEnd(25) + '  ' + r.path);
    }
  }
  if (out.orphan?.components) {
    console.log(`\n── Orphaned code ─ abandoned at orphan >= 0.90`);
    console.log('ORPHAN  ABND  SUCC  LINES  CHURN/MO  FANIN     RISK  COMPONENT');
    for (const r of out.orphan.components) {
      console.log(
        r.orphan.toFixed(3).padStart(6) + '  ' + (r.abandoned ? ' YES' : '   -') + '  ' +
        (r.has_successor ? ' yes' : '  no') + '  ' + String(r.lines).padStart(5) + '  ' +
        r.churn_rate.toFixed(2).padStart(8) + '  ' + String(r.fan_in).padStart(5) + '  ' +
        r.risk.toFixed(2).padStart(7) + '  ' + r.path);
    }
  } else if (out.orphan?.skipped) {
    console.log(`\n── Orphaned code: skipped — ${out.orphan.skipped}`);
  }
  console.log('');
  for (const c of out.caveats) console.log(`note: ${c}`);
}
