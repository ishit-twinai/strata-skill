#!/usr/bin/env node
// strata/propagation-cost.mjs — architectural erosion as a time series.
//
// Usage:
//   node propagation-cost.mjs [--ref <ref>] [--repo <dir>]
//                             [--at linear|monthly|tags|merges] [--points 8]
//                             [--no-tests] [--format table|json]
//
// PROPAGATION COST — MacCormack, Rusnak, Baldwin, Management Science 2006
//   V  = transitive closure of the dependency matrix M
//   PC = density(V) = (reachable pairs) / N^2
//      = the average fraction of the system reachable from a random file.
//   It answers "if I change something at random, how much of this codebase can
//   the change reach?" A rising PC means the architecture is losing its ability
//   to contain change.
//
// CORE / PERIPHERY — Baldwin, MacCormack, Rusnak, "Hidden Structure", 2014
//   Core      = the largest cyclic group (largest strongly connected component)
//   VFI(f)    = how many files can reach f      (visibility fan-in)
//   VFO(f)    = how many files f can reach      (visibility fan-out)
//   Quadrants: Core (high both) · Shared (high VFI) · Control (high VFO) ·
//              Periphery (low both)
//   Core size as a fraction of the system is the headline erosion indicator.
//
// Neither metric is implemented as a time series anywhere I could find
// (verified Nov 2026; see references/prior-art.md). Static-analysis tools compute
// dependency graphs without history; history tools compute churn without a graph.
// Both halves are needed, and strata already builds both.
//
// NOT IMPLEMENTED, deliberately: Decoupling Level (Mo, Cai, Kazman, ICSE 2016) is
// covered by patent WO2017106863A1. Propagation Cost and core-periphery are
// unencumbered academic publications from 2006 and 2014.
//
// COST: none. Pure git plus the Node standard library, run locally. The only
// expense is wall-clock - one import graph is built per snapshot.

import { gitIn, buildImportGraph, isNoise } from './lib/strata.mjs';

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const REF = opt('ref', 'HEAD');
const REPO = opt('repo', '.');
const AT = opt('at', 'auto');
const POINTS = Number(opt('points', '8'));
const NO_TESTS = argv.includes('--no-tests');
const FORMAT = opt('format', 'table');

const git = gitIn(REPO);

// ---------------------------------------------------------------- snapshots
//
// Most repositories do not tag releases usefully, so even sampling along the
// commit chain is the default rather than an afterthought: an erosion trend needs
// evenly spaced points more than it needs semantically meaningful ones.

function snapshots() {
  const tags = git('tag', '--sort=creatordate').split('\n').filter(Boolean);
  const mode = AT !== 'auto' ? AT : (tags.length >= 3 ? 'tags' : 'linear');

  if (mode === 'tags') {
    if (tags.length < 2) {
      console.error(`strata: --at tags needs at least 2 tags, found ${tags.length}.`);
      console.error('Use --at linear (the default when tags are sparse) or --at merges.');
      process.exit(2);
    }
    const step = Math.max(1, Math.ceil(tags.length / POINTS));
    const picked = tags.filter((_, i) => i % step === 0).slice(-POINTS);
    return { mode, points: picked.map((t) => ({ label: t, rev: t })) };
  }

  if (mode === 'merges') {
    const lines = git('log', REF, '--merges', '--date=short', '--pretty=%H|%ad')
      .split('\n').filter(Boolean).reverse();
    if (lines.length < 2) { console.error('strata: too few merge commits; use --at linear.'); process.exit(2); }
    const step = Math.max(1, Math.ceil(lines.length / POINTS));
    return {
      mode,
      points: lines.filter((_, i) => i % step === 0).slice(-POINTS).map((l) => {
        const [sha, date] = l.split('|');
        return { label: date, rev: sha };
      })
    };
  }

  if (mode === 'monthly') {
    // Bucket the first-parent chain by COMMITTER date - when work landed on this
    // branch - taking the last commit of each month. Committer date along
    // first-parent is monotonic in normal history, which author date is not.
    // Preferred when position-sampling clusters: a repo with a burst of early
    // commits and steady later work will put most evenly-spaced POSITIONS inside
    // the burst, which is monotonic but visually useless as a trend.
    const lines = git('log', REF, '--first-parent', '--reverse', '--date=short', '--pretty=%H|%cd')
      .split('\n').filter(Boolean);
    const byMonth = new Map();
    for (const l of lines) {
      const [sha, date] = l.split('|');
      byMonth.set(date.slice(0, 7), { label: date, rev: sha });   // later overwrites earlier
    }
    const months = [...byMonth.values()];
    if (months.length < 2) { console.error('strata: fewer than two months of history; use --at linear.'); process.exit(2); }
    const step = Math.max(1, Math.ceil(months.length / POINTS));
    return { mode, points: months.filter((_, i) => i % step === 0 || i === months.length - 1).slice(-POINTS) };
  }

  // Walk the first-parent chain oldest-to-newest and sample evenly by POSITION.
  //
  // Bucketing by calendar date looks more natural and is wrong: author dates do
  // not track commit order once a repo has seen a rebase, a cherry-pick or a
  // long-lived branch. Sampling by date then lands on an arbitrary point in the
  // chain, and the "trend" is not monotonic in content - on a fixture with
  // deliberately out-of-order dates it measured a two-file graph as the latest
  // state of a four-file repo. Position is always monotonic; the date is kept
  // only as the label.
  const chain = git('log', REF, '--first-parent', '--reverse', '--date=short', '--pretty=%H|%cd')
    .split('\n').filter(Boolean);
  if (chain.length < 2) { console.error('strata: too little history to trend.'); process.exit(2); }
  const want = Math.min(POINTS, chain.length);
  const picked = [];
  for (let i = 0; i < want; i++) {
    // always include the final commit, so the last row is the current state
    const idx = want === 1 ? chain.length - 1
      : Math.round((i * (chain.length - 1)) / (want - 1));
    const [sha, date] = chain[idx].split('|');
    if (!picked.some((p) => p.rev === sha)) picked.push({ label: date, rev: sha });
  }
  return { mode: 'linear', points: picked };
}

// ---------------------------------------------------------------- metrics

/** Reachability by BFS from every node. N is small enough that this beats bitsets. */
function closure(nodes, adj) {
  const reach = new Map();
  for (const start of nodes) {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const v = queue.shift();
      for (const w of adj.get(v) ?? []) if (!seen.has(w)) { seen.add(w); queue.push(w); }
    }
    seen.delete(start);          // self-reachability is not propagation
    reach.set(start, seen);
  }
  return reach;
}

/** Tarjan, iterative - a deep dependency chain should not blow the stack. */
function largestSCC(nodes, adj) {
  const index = new Map(), low = new Map(), onStack = new Set();
  const stack = [];
  let idx = 0, best = [];

  for (const root of nodes) {
    if (index.has(root)) continue;
    const work = [[root, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, pi] = frame;
      if (pi === 0) { index.set(v, idx); low.set(v, idx); idx++; stack.push(v); onStack.add(v); }
      const succ = [...(adj.get(v) ?? [])];
      if (pi < succ.length) {
        frame[1]++;
        const w = succ[pi];
        if (!index.has(w)) work.push([w, 0]);
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
      } else {
        if (low.get(v) === index.get(v)) {
          const comp = [];
          let w;
          do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
          if (comp.length > best.length) best = comp;
        }
        work.pop();
        if (work.length) {
          const p = work[work.length - 1][0];
          low.set(p, Math.min(low.get(p), low.get(v)));
        }
      }
    }
  }
  return best;
}

function measure(rev) {
  const g = buildImportGraph(git, rev, { includeTests: !NO_TESTS });
  const degree = (f) => (g.out.get(f)?.size ?? 0) + (g.inn.get(f)?.size ?? 0);
  const nodes = g.files.filter((f) => !isNoise(f) && degree(f) > 0);
  const n = nodes.length;
  if (!n) return null;

  const reach = closure(nodes, g.out);
  let pairs = 0;
  for (const s of reach.values()) pairs += s.size;

  const core = largestSCC(nodes, g.out);
  const coreSet = new Set(core.length > 1 ? core : []);

  // VFI / VFO, for the quadrant split
  const vfo = new Map(), vfi = new Map();
  for (const f of nodes) { vfo.set(f, reach.get(f).size); vfi.set(f, 0); }
  for (const f of nodes) for (const t of reach.get(f)) vfi.set(t, (vfi.get(t) ?? 0) + 1);

  const med = (arr) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)] ?? 0; };
  const mi = med(vfi.values()), mo = med(vfo.values());
  const quad = { core: 0, shared: 0, control: 0, periphery: 0 };
  const classify = new Map();
  for (const f of nodes) {
    let q;
    if (coreSet.has(f)) q = 'core';
    else if (vfi.get(f) > mi && vfo.get(f) > mo) q = 'core';
    else if (vfi.get(f) > mi) q = 'shared';
    else if (vfo.get(f) > mo) q = 'control';
    else q = 'periphery';
    quad[q]++; classify.set(f, q);
  }

  return {
    files: n,
    edges: [...g.out.values()].reduce((s, v) => s + v.size, 0),
    propagation_cost: +(pairs / (n * n)).toFixed(4),
    core_size: coreSet.size,
    core_pct: +((coreSet.size / n) * 100).toFixed(1),
    quadrants: quad,
    largest_cycle: core.length > 1 ? core.slice(0, 6) : []
  };
}

// ---------------------------------------------------------------- run

const snap = snapshots();
const series = [];
process.stderr.write(`sampling ${snap.points.length} point(s) by ${snap.mode}…\n`);
for (const p of snap.points) {
  process.stderr.write(`  ${p.label} … `);
  let m = null;
  try { m = measure(p.rev); } catch (e) { process.stderr.write(`skipped (${e.message.slice(0, 40)})\n`); continue; }
  if (!m) { process.stderr.write('skipped (no graph)\n'); continue; }
  process.stderr.write(`PC ${m.propagation_cost}\n`);
  series.push({ label: p.label, rev: p.rev.slice(0, 7), ...m });
}

if (!series.length) { console.error('strata: no measurable snapshots.'); process.exit(2); }
if (series.length === 1) {
  process.stderr.write('\nstrata: only one snapshot had a measurable dependency graph, so there\n');
  process.stderr.write('is no trend to report - the earlier points predate any imports. The single\n');
  process.stderr.write('measurement below still stands on its own.\n');
}

const first = series[0], last = series[series.length - 1];
const out = {
  metric: 'propagation_cost_and_core_periphery',
  citation: 'MacCormack, Rusnak & Baldwin, Management Science 2006; Baldwin, MacCormack & Rusnak, Hidden Structure, 2014',
  ref: REF,
  sampled_by: snap.mode,
  series,
  trend: {
    pc_first: first.propagation_cost,
    pc_last: last.propagation_cost,
    pc_change: +(last.propagation_cost - first.propagation_cost).toFixed(4),
    core_pct_first: first.core_pct,
    core_pct_last: last.core_pct,
    files_first: first.files,
    files_last: last.files
  },
  caveats: [
    'Propagation Cost is scale-sensitive: a repository that doubles in size can show a falling PC while absolute coupling rises. Read it next to the file count, never alone.',
    'Edges come from regex import extraction, not type resolution, so dynamic imports and DI are invisible. PC is therefore a floor.',
    'A rising PC is a prompt to look, not a defect. Some architectures legitimately centralise.',
    'Decoupling Level (Mo et al. 2016) is deliberately not implemented here: it is patent-encumbered (WO2017106863A1).'
  ]
};

if (FORMAT === 'json') {
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else {
  console.log(`\nPropagation Cost & core-periphery  (MacCormack 2006; Baldwin 2014)`);
  console.log(`ref ${REF} · sampled by ${snap.mode} · ${series.length} snapshots\n`);
  console.log('DATE        FILES  EDGES     PC  CYCLE  HUB  SHARED  CONTROL  PERIPH');
  console.log('----------  -----  -----  -----  -----  ---  ------  -------  ------');
  for (const s of series) {
    console.log(
      s.label.padEnd(10) + '  ' + String(s.files).padStart(5) + '  ' + String(s.edges).padStart(5) + '  ' +
      s.propagation_cost.toFixed(3).padStart(5) + '  ' + String(s.core_size).padStart(5) + '  ' +
      String(s.quadrants.core).padStart(3) + '  ' + String(s.quadrants.shared).padStart(6) + '  ' +
      String(s.quadrants.control).padStart(7) + '  ' + String(s.quadrants.periphery).padStart(6));
  }
  const d = out.trend.pc_change;
  console.log('');
  console.log(`PC ${out.trend.pc_first} → ${out.trend.pc_last}  (${d >= 0 ? '+' : ''}${d})` +
              `   files ${out.trend.files_first} → ${out.trend.files_last}`);
  if (d > 0.02) {
    console.log('Rising: change reaches further through the system than it used to.');
  } else if (d < -0.02) {
    console.log('Falling: change is better contained than it used to be — but check the');
    console.log('file count, since growth alone can dilute PC without decoupling anything.');
  } else {
    console.log('Broadly flat.');
  }
  console.log('');
  if (last.largest_cycle.length) {
    console.log(`CYCLE = files in the largest dependency cycle. Currently ${last.core_size}: ` +
                last.largest_cycle.join(', ') + (last.core_size > 6 ? ' …' : ''));
  } else {
    console.log('CYCLE = files in the largest dependency cycle. There are none: no file in');
    console.log('this codebase can reach itself through imports. That is a genuinely good');
    console.log('property and worth not losing.');
  }
  console.log('HUB / SHARED / CONTROL / PERIPH are the Baldwin quadrants by visibility');
  console.log('fan-in and fan-out — HUB is high on both, PERIPH low on both.');
  console.log('');
  for (const c of out.caveats) console.log(`note: ${c}`);
}
