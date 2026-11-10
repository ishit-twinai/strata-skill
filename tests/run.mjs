#!/usr/bin/env node
// strata/tests/run.mjs — known-answer regression suite.
//
// Usage:  node tests/run.mjs [--keep]
//
// Builds both fixtures into a temp directory and asserts the exact values they
// were designed to produce. Exits non-zero on any failure.
//
// WHY THIS EXISTS. Four arithmetic bugs shipped in first drafts of these metrics
// and every one was caught by hand-checking a fixture against a value computed on
// paper - a tail percentile that returned the BEST case as the 95th, percentiles
// that invented a ranking among identical values, a tie-break that reported
// hash-map order as a finding, and a shell helper that ate its caller's loop
// counter. None would have been caught by "does it run". Nothing re-asserted
// those numbers afterwards, so a future edit could silently reintroduce any of
// them. This is that safety net.
//
// Every expected value below is derivable by hand from the fixture builders in
// evals/*/files/. If an assertion fails, check the arithmetic before changing the
// expectation - the fixtures are the specification.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = join(HERE, '..');
const KEEP = process.argv.includes('--keep');

let pass = 0, fail = 0;
const failures = [];

function check(name, got, want, cmp = (a, b) => a === b) {
  const ok = cmp(got, want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else {
    fail++;
    failures.push(`${name}\n          got:  ${JSON.stringify(got)}\n          want: ${JSON.stringify(want)}`);
    console.log(`  FAIL  ${name}`);
    console.log(`          got:  ${JSON.stringify(got)}`);
    console.log(`          want: ${JSON.stringify(want)}`);
  }
}
const near = (a, b, eps = 0.002) => Math.abs(a - b) <= eps;

function sh(cmd, args, opts = {}) {
  try {
    return { out: execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts }), code: 0 };
  } catch (e) {
    return { out: (e.stdout ?? '') + (e.stderr ?? ''), code: e.status ?? 1 };
  }
}
const node = (script, args, opts) => sh('node', [join(SKILL, 'scripts', script), ...args], opts);
const shell = (script, args, opts) => sh('sh', [join(SKILL, 'scripts', script), ...args], opts);
const json = (r) => { try { return JSON.parse(r.out); } catch { return null; } };

const WORK = mkdtempSync(join(tmpdir(), 'strata-tests-'));
console.log(`strata known-answer suite\nworkdir ${WORK}\n`);

// ───────────────────────────────── fixtures
console.log('── building fixtures');
const hist = sh('sh', [join(SKILL, 'evals/consolidates-split-identities/files/build-repo.sh')], { cwd: WORK });
const met = sh('sh', [join(SKILL, 'evals/quantifies-knowledge-loss-risk/files/build-metrics-repo.sh')], { cwd: WORK });
const HIST = join(WORK, 'fixture-repo');
const MET = join(WORK, 'metrics-repo');
check('history fixture builds', hist.code, 0);
check('metrics fixture builds', met.code, 0);

// The fixtures ARE the specification, so assert their own shape first. The shell
// scoping bug produced 14 commits instead of 42 and silently invalidated
// everything downstream; this catches that class of failure at the source.
check('history fixture: 14 commits across all refs',
  sh('git', ['-C', HIST, 'log', '--all', '--oneline']).out.trim().split('\n').length, 14);
check('metrics fixture: 42 commits',
  sh('git', ['-C', MET, 'log', '--oneline']).out.trim().split('\n').length, 42);
check('metrics fixture: core.py has 21 commits',
  sh('git', ['-C', MET, 'log', '--oneline', '--', 'core.py']).out.trim().split('\n').length, 21);

// ───────────────────────────────── pick-ref
console.log('\n── pick-ref');
check('exits 3 on a stale checkout', shell('pick-ref.sh', [HIST]).code, 3);
check('reports local main behind its remote',
  /main\s+behind 2/.test(shell('pick-ref.sh', [HIST]).out), true);

// ───────────────────────────────── repo-shape
console.log('\n── repo-shape');
const shape = shell('repo-shape.sh', ['HEAD', MET]);
check('flags the dominant file', /DOMINANT FILE/.test(shape.out), true);
check('names core.py as dominant', /core\.py \(\d+% of source\)/.test(shape.out), true);

// ───────────────────────────────── identities + contributors
console.log('\n── identities / contributors');
const ids = shell('identities.sh', [HIST], { cwd: WORK });
check('groups the two Ada identities to one person',
  (ids.out.match(/-> Ada$/gm) ?? []).length, 2);
check('flags identities it could not group',
  /could NOT group/.test(ids.out), true);

// a correct mapping folds ghopper into Grace
const mapPath = join(WORK, 'map-good.tsv');
writeFileSync(mapPath, [
  'ada <ada@personal.test>\tAda',
  'Ada Lovelace <ada@work.test>\tAda',
  'Alan Turing <alan@work.test>\tAlan',
  'ghopper <grace.hopper@other.test>\tGrace',
  'Grace Hopper <grace@work.test>\tGrace'
].join('\n') + '\n');
const good = shell('contributors.sh', ['--all', mapPath], { cwd: HIST });
check('complete mapping exits 0', good.code, 0);
check('complete mapping reports 3 people', /per person \(3\)/.test(good.out), true);
check('Ada 5, Grace 5, Alan 4',
  ['Ada', 'Grace', 'Alan'].map((p) => {
    const m = new RegExp(`^${p}\\s+(\\d+)`, 'm').exec(good.out);
    return m ? Number(m[1]) : null;
  }), [5, 5, 4], (a, b) => JSON.stringify(a) === JSON.stringify(b));

// an incomplete mapping must REFUSE, not quietly split a person in two
const badPath = join(WORK, 'map-bad.tsv');
writeFileSync(badPath, [
  'ada <ada@personal.test>\tAda',
  'Ada Lovelace <ada@work.test>\tAda',
  'Alan Turing <alan@work.test>\tAlan',
  'Grace Hopper <grace@work.test>\tGrace'
].join('\n') + '\n');
const bad = shell('contributors.sh', ['--all', badPath], { cwd: HIST });
check('incomplete mapping exits 4', bad.code, 4);
check('incomplete mapping names the unmapped identity', /ghopper/.test(bad.out), true);

// ───────────────────────────────── dep-graph
console.log('\n── dep-graph');
const dg = json(node('dep-graph.mjs', ['--repo', MET, '--format', 'json']));
check('emits a parseable graph', !!dg, true);
const labels = (dg?.nodes ?? []).map((n) => n[0]);
const edgePairs = (dg?.edges ?? []).map(([a, b]) => `${labels[a]}->${labels[b]}`);
check('gamma.py -> delta.py edge found', edgePairs.includes('gamma.py->delta.py'), true);
check('epsilon.py -> zeta.py edge found', edgePairs.includes('epsilon.py->zeta.py'), true);
check('no alpha/beta edge (they only co-change)',
  edgePairs.some((e) => e.startsWith('alpha.py->beta') || e.startsWith('beta.py->alpha')), false);

const graphPath = join(WORK, 'graph.json');
writeFileSync(graphPath, JSON.stringify(dg));
check('validate-graph accepts dep-graph output', node('validate-graph.mjs', [graphPath]).code, 0);

// ───────────────────────────────── Bird suite
console.log('\n── Bird ownership suite (FSE 2011)');
const blame = shell('blame-cache.sh', ['HEAD', MET]);
const blamePath = join(WORK, 'blame.tsv');
writeFileSync(blamePath, blame.out);
check('blame cache produced rows', blame.out.trim().split('\n').length > 5, true);

const om = json(node('ownership-metrics.mjs', ['--repo', MET, '--blame', blamePath, '--format', 'json']));
const comp = (p) => om?.bird?.components?.find((c) => c.path === p);
check('core.py Minor = 1 (Eli at 1/21 = 0.0476, under 0.05)', comp('core.py')?.minor, 1);
check('core.py Major = 1', comp('core.py')?.major, 1);
check('core.py Ownership = 20/21', comp('core.py')?.ownership, 0.9524, near);
check('core.py total commits = 21', comp('core.py')?.total_commits, 21);
check('shared.py Minor = 0, Major = 2', [comp('shared.py')?.minor, comp('shared.py')?.major], [0, 2],
  (a, b) => JSON.stringify(a) === JSON.stringify(b));
check('shared.py Ownership = 0.5', comp('shared.py')?.ownership, 0.5, near);
check('core.py is the ONLY component with Minor > 0',
  om?.bird?.components?.filter((c) => c.minor > 0).map((c) => c.path), ['core.py'],
  (a, b) => JSON.stringify(a) === JSON.stringify(b));

// the tie-break bug: 3/3 ownership must be reported as a tie, not resolved silently
check('shared.py reports a 2-way ownership tie', comp('shared.py')?.top_owner_tied?.length, 2);
check('shared.py tie is deterministic (alphabetical)', comp('shared.py')?.top_owner, 'Dana Okafor');

// the percentile bug: identical values must share a percentile
const zeroMinor = om?.bird?.components?.filter((c) => c.minor === 0) ?? [];
check('all Minor=0 components share one percentile',
  new Set(zeroMinor.map((c) => c.minor_pctile)).size, 1);
check('that shared percentile is 0', zeroMinor[0]?.minor_pctile, 0);

// ───────────────────────────────── decay + orphan
console.log('\n── decay-weighted knowledge / orphaned code');
const dec = (p) => om?.decay?.components?.find((c) => c.path === p);
check('legacy.py live knowledge share = 0 (sole author departed)', dec('legacy.py')?.live_share, 0);
check('core.py live knowledge share = 1', dec('core.py')?.live_share, 1, near);
check('decay half-life recorded as 5 months', om?.decay?.half_life_months, 5);

const orp = (p) => om?.orphan?.components?.find((c) => c.path === p);
check('legacy.py orphan = 1.0', orp('legacy.py')?.orphan, 1, near);
check('legacy.py is abandoned', orp('legacy.py')?.abandoned, true);
check('legacy.py is the only abandoned file',
  om?.orphan?.components?.filter((c) => c.abandoned).map((c) => c.path), ['legacy.py'],
  (a, b) => JSON.stringify(a) === JSON.stringify(b));
check('shared.py has a successor (3/3 split)', orp('shared.py')?.has_successor, true);
check('alpha.py has no successor (sole author)', orp('alpha.py')?.has_successor, false);
check('churn is a RATE, not a commit count', typeof orp('core.py')?.churn_rate, 'number');
check('exactly one contributor is departed', om?.summary?.departed, 1);
check('the departed contributor is the legacy author',
  om?.summary?.departed_names, ['Morgan Reyes'], (a, b) => JSON.stringify(a) === JSON.stringify(b));

// ───────────────────────────────── Knowledge at Risk
console.log('\n── Knowledge at Risk / Expected Shortfall (ICSE 2016)');
const kar = json(node('knowledge-at-risk.mjs', ['--blame', blamePath, '--repo', MET, '--format', 'json']));
const k = (n) => kar?.curve?.find((c) => c.k === n);
// By hand: Dana departing abandons legacy,alpha,beta,core,epsilon,zeta = 6.
//          Eli  departing abandons legacy,delta,gamma = 3. Both = all 9.
check('k=1 KaR = 6 (the WORSE of the two single departures)', k(1)?.kar, 6);
check('k=1 ES = 6', k(1)?.es, 6, near);
check('k=1 mean loss = 4.5', k(1)?.mean_loss, 4.5, near);
check('k=2 KaR = 9 (everything abandons)', k(2)?.kar, 9);
check('small sample space is enumerated exactly, not sampled', k(1)?.method, 'exhaustive');
check('7 files have no successor', kar?.files_without_successor?.length, 7);

// the tail-percentile bug, directly: floor(a*(N-1)) returns the BEST case
const nearestRank = (n, a) => Math.max(0, Math.min(n - 1, Math.ceil(a * n) - 1));
for (const [arr, a, want] of [
  [[3, 6], 0.95, 6], [[9], 0.95, 9], [[0, 0, 0, 0, 5], 0.95, 5],
  [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95, 10], [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5, 5]
]) {
  check(`nearest-rank percentile a=${a} [${arr}] = ${want}`, arr[nearestRank(arr.length, a)], want);
}

// ───────────────────────────────── propagation cost
console.log('\n── Propagation Cost / core-periphery (MacCormack 2006)');
const pc = json(node('propagation-cost.mjs', ['--repo', MET, '--points', '4', '--format', 'json']));
const pcLast = pc?.series?.[pc.series.length - 1];
// By hand on the fixture: connected files are gamma, delta, epsilon, zeta.
// gamma->delta and epsilon->zeta, acyclic. Reachable pairs = 2, so PC = 2/4^2.
check('fixture Propagation Cost = 2/16', pcLast?.propagation_cost, 0.125, near);
check('fixture has 4 connected files', pcLast?.files, 4);
check('fixture has 2 edges', pcLast?.edges, 2);
check('fixture is acyclic (no SCC > 1)', pcLast?.core_size, 0);
check('sampling is position-based, not date-based', pc?.sampled_by, 'linear');
check('scale-sensitivity caveat is carried',
  (pc?.caveats ?? []).some((c) => /scale-sensitive/i.test(c)), true);

// ───────────────────────────────── the change brief
console.log('\n── change brief: the three planted controls');
const brief = (args) => json(node('brief.mjs', [...args, '--repo', MET, '--format', 'json']));

// CONTROL 1 — co-change with NO import edge must surface as a surprise
const b1 = brief(['--anchor', 'alpha.py']);
check('alpha.py: beta.py appears in the surprise set',
  b1?.surprise_set?.map((s) => s.path), ['beta.py'], (a, b) => JSON.stringify(a) === JSON.stringify(b));
check('alpha.py: 6 joint commits with beta.py', b1?.surprise_set?.[0]?.joint_commits, 6);
check('alpha.py: coupling is Fisher-significant', b1?.surprise_set?.[0]?.fisher_p < 0.05, true);

// CONTROL 2 — co-change that IS explained by an import must NOT be a surprise.
// This is the discriminating test: it proves the set means "unexplained".
const b2 = brief(['--anchor', 'gamma.py']);
check('gamma.py: delta.py is in the read set (it is an upstream dep)',
  b2?.read_set?.map((r) => r.path).includes('delta.py'), true);
check('gamma.py: delta.py is NOT a surprise — the import explains the co-change',
  b2?.surprise_set?.map((s) => s.path).includes('delta.py'), false);

// CONTROL 3 — a dependent must land in the impact set, not the read set
const b3 = brief(['--anchor', 'zeta.py']);
check('zeta.py: epsilon.py is in the impact set at depth 1',
  b3?.impact_set?.find((i) => i.path === 'epsilon.py')?.depth, 1);
check('zeta.py: epsilon.py verdict is WILL BREAK',
  b3?.impact_set?.find((i) => i.path === 'epsilon.py')?.verdict, 'WILL BREAK');
check('zeta.py: nothing in the surprise set', b3?.surprise_set?.length, 0);

// read_set and impact_set must be genuinely different sets
const overlap = (b3?.read_set ?? []).map((r) => r.path)
  .filter((p) => (b3?.impact_set ?? []).some((i) => i.path === p));
check('read set and impact set do not overlap', overlap, [], (a, b) => JSON.stringify(a) === JSON.stringify(b));

// anchor resolution from a task description, not a path
const b4 = brief(['fix how core totals are rounded']);
check('resolves a task description to core.py', b4?.anchors?.selected?.includes('core.py'), true);
check('marks an unconfirmed anchor set provisional', b4?.anchors?.provisional, true);
check('prints evidence for its anchor choice',
  (b4?.anchors?.candidates?.[0]?.evidence?.length ?? 0) > 0, true);
check('an explicit --anchor is not provisional', b1?.anchors?.provisional, false);

// ───────────────────────────────── done
if (!KEEP) rmSync(WORK, { recursive: true, force: true });
console.log(`\n${'─'.repeat(60)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  console.log('\nThe fixtures are the specification. Check the arithmetic before');
  console.log('changing an expectation.');
}
if (KEEP) console.log(`\nfixtures kept at ${WORK}`);
process.exit(fail ? 1 : 0);
