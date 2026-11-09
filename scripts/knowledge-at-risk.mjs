#!/usr/bin/env node
// strata/knowledge-at-risk.mjs — Knowledge at Risk (KaR) and Expected Shortfall (ES).
//
// Usage:
//   node knowledge-at-risk.mjs --blame <blame.tsv> [--ref <ref>] [--repo <dir>]
//                              [--map <identities.tsv>] [--window 365] [--as-of YYYY-MM-DD]
//                              [--trials 1000] [--max-k N] [--alpha 0.95]
//                              [--abandon 0.90] [--successor 0.10]
//                              [--seed 42] [--format table|json]
//
// Rigby, Zhu, Donadelli, Mockus, "Quantifying and Mitigating Turnover-Induced
// Knowledge Loss", ICSE 2016.  https://dl.acm.org/doi/10.1145/2884781.2884851
//
// A Value-at-Risk analogue for knowledge: instead of asking "what is the bus
// factor" (a single number that says nothing about consequence), it asks "if k
// people leave, how much of the codebase is abandoned, and how bad is the bad
// case". The authors published PSEUDOCODE ONLY; a 2019 comparative survey
// (https://homepages.dcc.ufmg.br/~mtov/pub/2019-sqj.pdf) confirms no public
// implementation exists. Verified again 2026-11 against repowise and CodeLore:
// both compute bus factor and knowledge islands, neither computes KaR or ES.
//
//   for each k in 1..max-k:
//     repeat `trials` times:
//       S     = random sample of k ACTIVE developers
//       loss  = count of files where orphan(f | S departed) >= abandon
//     KaR_a(k) = the a-percentile of that loss distribution
//     ES_a(k)  = mean(loss | loss >= KaR_a(k))      <- the tail mean
//
// ES matters because KaR alone understates rare large losses: it is the boundary
// of the tail, not its weight. A repo can have a modest KaR and a severe ES.
//
// Nassif & Robillard (ICSME 2017) showed the original model overestimates loss by
// ignoring what happens to a file after abandonment. This implementation measures
// orphan state at the analysis ref, so what it reports is PERSISTENT abandonment.
//
// Mitigation, also from Rigby et al.: a SUCCESSOR is a second developer holding a
// non-trivial share of a file. Files with a successor survive one departure. The
// `no_successor` list is the cheapest actionable output here.
//
// Determinism: the sampler is a seeded PRNG (Node ships no seedable RNG), so the
// same repo and seed always produce the same numbers and the result is testable.

import { readFileSync } from 'node:fs';
import { gitIn } from './lib/strata.mjs';

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const BLAME = opt('blame');
const REF = opt('ref', 'HEAD');
const REPO = opt('repo', '.');
const MAP = opt('map');
const WINDOW = Number(opt('window', '365'));
const TRIALS = Number(opt('trials', '1000'));
const ALPHA = Number(opt('alpha', '0.95'));
const ABANDON = Number(opt('abandon', '0.90'));
const SUCCESSOR = Number(opt('successor', '0.10'));
const SEED = Number(opt('seed', '42'));
const FORMAT = opt('format', 'table');

if (!BLAME) {
  console.error('--blame <blame.tsv> is required. Produce it with:\n  sh blame-cache.sh <ref> <repo> > blame.tsv');
  process.exit(1);
}
if (!(ALPHA > 0 && ALPHA < 1)) { console.error('--alpha must be in (0,1)'); process.exit(1); }

// ---------- identity mapping ----------
const idmap = new Map();
if (MAP) {
  for (const line of readFileSync(MAP, 'utf8').split('\n')) {
    const t = line.indexOf('\t');
    if (t > 0) idmap.set(line.slice(0, t).trim(), line.slice(t + 1).trim());
  }
}
const BOT_RE = /\bbot\b|\[bot\]|dependabot|renovate|github-actions|semantic-release|greenkeeper/i;
const person = (id) => idmap.get(id) ?? id.replace(/\s*<.*>$/, '');

// ---------- who is still here ----------
const git = gitIn(REPO);
const AS_OF = opt('as-of') ??
  git('log', REF, '--date=short', '--pretty=%ad').split('\n').filter(Boolean).sort().pop();
const asOfMs = Date.parse(`${AS_OF}T00:00:00Z`);
const cutoff = asOfMs - WINDOW * 86400000;

const lastSeen = new Map();
for (const line of git('log', REF, '--use-mailmap', '--date=short', '--pretty=%an <%ae>|%ad').split('\n')) {
  if (!line.trim()) continue;
  const bar = line.lastIndexOf('|');
  const id = line.slice(0, bar);
  if (BOT_RE.test(id)) continue;
  const p = person(id);
  const t = Date.parse(`${line.slice(bar + 1)}T00:00:00Z`);
  if (!lastSeen.has(p) || t > lastSeen.get(p)) lastSeen.set(p, t);
}
const isActive = (p) => (lastSeen.get(p) ?? 0) >= cutoff;

// ---------- blame: lines per person per file ----------
const files = new Map();   // path -> Map(person -> lines)
for (const row of readFileSync(BLAME, 'utf8').split('\n')) {
  if (!row.trim()) continue;
  const [path, author, n] = row.split('\t');
  if (!path || !author || !n) continue;
  if (BOT_RE.test(author)) continue;
  const p = person(author);
  if (!files.has(path)) files.set(path, new Map());
  const m = files.get(path);
  m.set(p, (m.get(p) ?? 0) + Number(n));
}

const active = [...new Set([...files.values()].flatMap((m) => [...m.keys()]))]
  .filter(isActive).sort();

// Precompute, per file: total lines, lines already orphaned (held by people who
// have ALREADY left), and the active holders' line counts. Then a trial is just
// a sum over the sampled departures - no blame work inside the Monte Carlo loop.
const fileRows = [];
for (const [path, m] of files) {
  let total = 0, already = 0;
  const held = new Map();
  for (const [p, n] of m) {
    total += n;
    if (isActive(p)) held.set(p, n); else already += n;
  }
  if (!total) continue;
  const activeShares = [...held.values()].map((n) => n / total);
  fileRows.push({
    path, total, already, held,
    orphan_now: already / total,
    abandoned_now: already / total >= ABANDON,
    // Rigby's successor: >= 2 holders each with a non-trivial share
    has_successor: activeShares.filter((s) => s >= SUCCESSOR).length >= 2
  });
}

const MAX_K = Math.min(Number(opt('max-k', String(active.length))), active.length);

// ---------- seeded PRNG (mulberry32) ----------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample(pool, k, rnd) {
  // partial Fisher-Yates on a copy: unbiased, and O(k) rather than O(n log n)
  const a = pool.slice();
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rnd() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

function lossFor(departedSet) {
  let fileLoss = 0, lineLoss = 0;
  for (const f of fileRows) {
    let gone = f.already;
    for (const [p, n] of f.held) if (departedSet.has(p)) gone += n;
    if (gone / f.total >= ABANDON) { fileLoss++; lineLoss += f.total; }
  }
  return { fileLoss, lineLoss };
}

// ---------- Monte Carlo ----------
const rnd = rng(SEED);
const curve = [];
const exhaustiveUpTo = (k) => {
  // With a small active population the sample space is tiny, so enumerate it
  // exactly instead of sampling - exact beats approximate when it is affordable,
  // and it makes the result independent of the seed.
  let combos = 1;
  for (let i = 0; i < k; i++) combos = combos * (active.length - i) / (i + 1);
  return combos <= 2000;
};

for (let k = 1; k <= MAX_K; k++) {
  const losses = [];
  if (exhaustiveUpTo(k)) {
    const idx = [];
    (function rec(start) {
      if (idx.length === k) {
        losses.push(lossFor(new Set(idx.map((i) => active[i]))).fileLoss);
        return;
      }
      for (let i = start; i < active.length; i++) { idx.push(i); rec(i + 1); idx.pop(); }
    })(0);
  } else {
    for (let t = 0; t < TRIALS; t++) {
      losses.push(lossFor(new Set(sample(active, k, rnd))).fileLoss);
    }
  }
  losses.sort((a, b) => a - b);
  // NEAREST-RANK percentile: ceil(alpha * N) - 1.
  // The tempting floor(alpha * (N-1)) collapses to index 0 for small N and returns
  // the BEST case as the 95th percentile - for N=2 it reported 3 where the answer
  // is 6. Understating the tail is the exact failure this metric exists to catch.
  const at = Math.max(0, Math.min(losses.length - 1, Math.ceil(ALPHA * losses.length) - 1));
  const kar = losses[at];
  const tail = losses.filter((l) => l >= kar);
  curve.push({
    k,
    method: exhaustiveUpTo(k) ? 'exhaustive' : `monte-carlo(${TRIALS})`,
    scenarios: losses.length,
    mean_loss: +(losses.reduce((s, l) => s + l, 0) / losses.length).toFixed(2),
    kar: kar,
    es: +(tail.reduce((s, l) => s + l, 0) / tail.length).toFixed(2),
    worst: losses[losses.length - 1],
    pct_of_files: +((kar / fileRows.length) * 100).toFixed(1)
  });
}

const noSuccessor = fileRows
  .filter((f) => !f.has_successor && !f.abandoned_now)
  .map((f) => ({
    path: f.path,
    sole_holder: [...f.held.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    lines: f.total
  }))
  .sort((a, b) => b.lines - a.lines);

const out = {
  metric: 'knowledge_at_risk',
  citation: 'Rigby, Zhu, Donadelli, Mockus. Quantifying and Mitigating Turnover-Induced Knowledge Loss. ICSE 2016. Correction: Nassif & Robillard, ICSME 2017.',
  ref: REF,
  as_of: AS_OF,
  params: { alpha: ALPHA, abandon: ABANDON, successor: SUCCESSOR, window_days: WINDOW, trials: TRIALS, seed: SEED },
  population: {
    files: fileRows.length,
    active_developers: active.length,
    active_names: active,
    already_abandoned: fileRows.filter((f) => f.abandoned_now).length
  },
  curve,
  files_without_successor: noSuccessor,
  caveats: [
    'Loss counts PERSISTENT abandonment at the analysis ref (Nassif & Robillard 2017), not abandonment at the moment of departure.',
    'Abandonment is a line-ownership proxy for knowledge; it says nothing about documentation, tests or whoever reviewed the code.',
    'Departures are sampled uniformly. Real turnover is not uniform - weight it yourself if you know who is likely to leave.',
    MAP ? null : 'NO IDENTITY MAPPING - unmerged identities both understate each person\'s reach and inflate the apparent developer count.'
  ].filter(Boolean)
};

if (FORMAT === 'json') {
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else {
  console.log('Knowledge at Risk / Expected Shortfall   (Rigby et al., ICSE 2016)');
  console.log(`ref ${REF} · as-of ${AS_OF} · alpha ${ALPHA} · abandoned at orphan >= ${ABANDON}`);
  console.log(`${out.population.files} files · ${out.population.active_developers} active developers` +
              (out.population.already_abandoned ? ` · ${out.population.already_abandoned} already abandoned` : ''));
  console.log(`active: ${active.join(', ')}`);
  console.log('');
  console.log('  K  SCENARIOS  METHOD              MEAN    KaR     ES   WORST   %FILES');
  console.log('---  ---------  ------------------  ----  -----  -----  ------  -------');
  for (const r of curve) {
    console.log(
      String(r.k).padStart(3) + '  ' + String(r.scenarios).padStart(9) + '  ' +
      r.method.padEnd(18) + '  ' + r.mean_loss.toFixed(1).padStart(4) + '  ' +
      String(r.kar).padStart(5) + '  ' + r.es.toFixed(1).padStart(5) + '  ' +
      String(r.worst).padStart(6) + '  ' + (r.pct_of_files.toFixed(1) + '%').padStart(7));
  }
  console.log('');
  console.log('KaR = the a-percentile loss (how bad it gets at that confidence).');
  console.log('ES  = the mean of the tail beyond KaR. ES >> KaR means rare departures are');
  console.log('      far worse than the headline figure suggests.');
  if (noSuccessor.length) {
    console.log(`\nFiles with no successor (${noSuccessor.length}) — one departure abandons each:`);
    for (const f of noSuccessor.slice(0, 15)) {
      console.log(`  ${String(f.lines).padStart(6)} lines  ${String(f.sole_holder ?? '-').padEnd(20)}  ${f.path}`);
    }
    if (noSuccessor.length > 15) console.log(`  … and ${noSuccessor.length - 15} more`);
    console.log('\nAdding a second substantive contributor to these is the cheapest mitigation');
    console.log('available, and the one Rigby et al. measured as effective.');
  }
  console.log('');
  for (const c of out.caveats) console.log(`note: ${c}`);
}
