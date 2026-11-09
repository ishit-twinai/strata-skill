#!/usr/bin/env node
// strata/brief.mjs — a task-scoped change brief.
//
// Usage:
//   node brief.mjs "<task description>" [--ref <ref>] [--repo <dir>] [--map <ids.tsv>]
//                  [--anchor <path>]...        # override the provisional anchors
//                  [--top 3] [--depth 3] [--min-support 3] [--max-p 0.05]
//                  [--include-tests]           # tests are excluded from anchors by default
//                  [--format json|text]
//
// WHAT THIS IS FOR
// Every comparable tool is anchor-scoped: you hand it a file path, a symbol, or a
// diff that already exists. Verified 2026-11 (see references/prior-art.md):
// repowise `context` takes paths or symbols, its `risk` takes a revspec, its `ask`
// takes a question but answers in prose; CodeLore takes --target and --analysis;
// SourceAtlas `impact` takes a path; act101 ships a reading path and a blast
// radius as two skills that never talk. aider's personalised PageRank is the only
// precedent for task-biased ranking and it was never exposed as an answer.
//
// So: those tools answer "I am making this change, what now?". This answers
// "I need to make this change, where do I start?" - which needs the task-to-anchor
// bridge none of them build.
//
// FOUR OUTPUTS, deliberately distinct
//   anchors      candidates with printed evidence. Scripts score; the MODEL picks.
//   read_set     what to READ to make the change safely (upstream, examples, tests)
//   impact_set   what BREAKS if you change it (downstream, by depth)
//   surprise_set co-change partners the dependency graph does NOT explain
//
// read_set and impact_set are different sets and every other tool conflates them.
// surprise_set is the Clio "modularity violation" (Wong & Cai, ICSE 2011, never
// released) computed relative to a task instead of repo-wide; CodeLore ships the
// repo-wide form, so the task scoping is the new part, not the idea.

import { readFileSync } from 'node:fs';
import {
  gitIn, buildImportGraph, reach, connected, coChange, fisherExact,
  ownership, taskTerms, isNoise, latestAuthorDate
} from './lib/strata.mjs';

const argv = process.argv.slice(2);
const TASK = argv.find((a) => !a.startsWith('--')) ?? '';
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const all = (n) => argv.reduce((acc, a, i) => (a === `--${n}` && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

const REF = opt('ref', 'HEAD');
const REPO = opt('repo', '.');
const MAP = opt('map');
const TOP = Number(opt('top', '3'));
const DEPTH = Number(opt('depth', '3'));
const MIN_SUPPORT = Number(opt('min-support', '3'));
const MAX_P = Number(opt('max-p', '0.05'));
const FORMAT = opt('format', 'text');
const EXPLICIT = all('anchor');
const INCLUDE_TESTS = argv.includes('--include-tests');

// A test file named after the thing it tests scores highly on every term the task
// mentions, and is almost never where the change belongs. Worse, anchoring on one
// drags its imports into the read set: on a real repo, anchoring on a shared-chart
// test pulled auth models, token services and the Flask entry point into "what to
// read before changing chart colours". Excluded by default; --include-tests when
// the task really is about the tests.
const isTestPath = (f) =>
  /(^|\/)(tests?|spec|__tests__)\//.test(f) || /[._](test|spec)\./.test(f) || /_harness\./.test(f);

if (!TASK && !EXPLICIT.length) {
  console.error('usage: node brief.mjs "<task description>" [--anchor <path>]...');
  process.exit(1);
}

const git = gitIn(REPO);
const idmap = new Map();
if (MAP) {
  for (const line of readFileSync(MAP, 'utf8').split('\n')) {
    const t = line.indexOf('\t');
    if (t > 0) idmap.set(line.slice(0, t).trim(), line.slice(t + 1).trim());
  }
}

const terms = taskTerms(TASK);
const graph = buildImportGraph(git, REF);
const own = ownership(git, REF, { idmap });
const cc = coChange(git, REF);

// ---------------------------------------------------------------- anchors
//
// Deterministic evidence, printed. The model does the choosing - that step needs
// judgement about what the task means, which is exactly what a static indexer
// cannot supply and a skill can.

function anchorCandidates() {
  const score = new Map();
  const ev = new Map();
  const bump = (f, n, why) => {
    if (isNoise(f)) return;
    if (!INCLUDE_TESTS && isTestPath(f)) return;
    score.set(f, (score.get(f) ?? 0) + n);
    if (!ev.has(f)) ev.set(f, []);
    ev.get(f).push(why);
  };

  // 1. path / filename contains a task term
  for (const f of graph.files) {
    const lower = f.toLowerCase();
    for (const t of terms) {
      if (lower.includes(t)) bump(f, lower.split('/').pop().includes(t) ? 6 : 3, `path contains "${t}"`);
    }
  }

  // 2. TERM COVERAGE, not raw mention count.
  //
  // Counting total mentions and capping the score makes a file with 793 hits
  // score the same as one with 167 - the cap destroys discrimination precisely
  // among the top candidates. Worse, raw volume rewards whichever file happens to
  // say "chart" most often, not the file this task is about.
  //
  // What actually separates them is how many DISTINCT task terms a file matches.
  // For "make chart colours consistent when the theme changes", the renderer
  // mentions chart AND colour AND theme; the chart-planning service mentions
  // chart constantly and the other two never. Coverage finds that; volume does not.
  const coverage = new Map();
  const mentions = new Map();
  for (const term of terms) {
    let out = '';
    try { out = git('grep', '-c', '-I', '-i', '-e', term, REF); } catch { continue; }
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const firstColon = line.indexOf(':');
      const lastColon = line.lastIndexOf(':');
      if (firstColon < 0 || lastColon <= firstColon) continue;
      const path = line.slice(firstColon + 1, lastColon);
      const count = Number(line.slice(lastColon + 1));
      if (!Number.isFinite(count) || !count) continue;
      coverage.set(path, (coverage.get(path) ?? 0) + 1);
      mentions.set(path, (mentions.get(path) ?? 0) + count);
    }
  }
  for (const [path, covered] of coverage) {
    // superlinear in coverage so matching 3 of 5 terms clearly beats matching 1,
    // with volume kept only as a small tiebreak among equal coverage
    const frac = covered / Math.max(1, terms.length);
    bump(path, 10 * Math.pow(frac, 1.5) + Math.min(2.5, Math.log2(1 + (mentions.get(path) ?? 0)) / 4),
      `matches ${covered}/${terms.length} task terms (${mentions.get(path)} mentions)`);
  }

  // 3. a DEFINITION named after a task term outranks a passing mention
  if (terms.length) {
    const pat = `^[[:space:]]*(def|class|function|const|let|var|async def)[^=(]*(${terms.join('|')})`;
    try {
      const out = git('grep', '-c', '-I', '-i', '-E', pat, REF);
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const f = line.slice(line.indexOf(':') + 1, line.lastIndexOf(':'));
        bump(f, 7, 'defines a symbol named after the task');
      }
    } catch { /* none */ }
  }

  // 4. structural centrality — a hub is a likelier anchor than a leaf, and a file
  // nothing references at all is usually a prototype or a scratch page rather than
  // the thing you are being asked to change.
  for (const f of graph.files) {
    if (!score.has(f)) continue;
    const deg = (graph.out.get(f)?.size ?? 0) + (graph.inn.get(f)?.size ?? 0);
    if (deg >= 3) bump(f, Math.min(4, deg / 2), `${deg} graph edges`);
    else if (deg === 0) bump(f, -4, 'nothing references this (prototype or scratch?)');
  }

  // 5. recently touched code is likelier to be what the task means
  for (const f of score.keys()) {
    const o = own.forFile(f);
    if (o && o.live_knowledge_share > 0.5 && o.commits >= 3) {
      bump(f, 2, 'actively maintained');
    }
  }

  return [...score.entries()]
    .map(([path, s]) => ({ path, score: +s.toFixed(2), evidence: ev.get(path) ?? [] }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

const candidates = anchorCandidates();
const anchors = EXPLICIT.length ? EXPLICIT : candidates.slice(0, TOP).map((c) => c.path);
const provisional = !EXPLICIT.length;

// ---------------------------------------------------------------- the four sets

// READ: what the anchors depend on (you cannot change safely what you do not
// understand), plus tests that exercise them, plus docs that describe them.
const upstream = reach(graph, anchors, 'up', 2);
const readSet = [];
for (const a of anchors) {
  const o = own.forFile(a);
  readSet.push({ path: a, reason: 'the change target itself', depth: 0, commits: o?.commits ?? 0 });
}
for (const [p, d] of upstream) {
  if (!INCLUDE_TESTS && isTestPath(p)) continue;
  readSet.push({ path: p, reason: `the target depends on this (depth ${d})`, depth: d });
}
// tests referencing an anchor by basename
for (const f of graph.files) {
  if (!/(^|\/)(tests?|spec|__tests__)\//.test(f) && !/[._](test|spec)\./.test(f)) continue;
  for (const a of anchors) {
    const base = a.split('/').pop().replace(/\.[^.]+$/, '');
    if (!base || base.length < 3) continue;
    let text = '';
    try { text = git('show', `${REF}:${f}`); } catch { continue; }
    if (text.includes(base)) {
      readSet.push({ path: f, reason: `test covering ${a} — extend this`, depth: 1 });
      break;
    }
  }
}

// IMPACT: what depends on the anchors. Depth framing follows GitNexus, which
// states it more usefully than most: d=1 will break, d=2 likely, d=3 worth testing.
const downstream = reach(graph, anchors, 'down', DEPTH);
const VERDICT = { 1: 'WILL BREAK', 2: 'LIKELY AFFECTED', 3: 'MAY NEED TESTING' };
const impactAll = [...downstream.entries()]
  .map(([path, depth]) => ({ path, depth, verdict: VERDICT[depth] ?? 'DISTANT', test: isTestPath(path) }))
  .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
// A test depending on the thing you change is expected, not fallout. Mixing them
// in buries the production breakage under a list of tests that will obviously fail.
const impactSet = impactAll.filter((i) => !i.test);
const impactTests = impactAll.filter((i) => i.test);

// SURPRISE: co-change partners the graph does not explain, Fisher-gated.
const surpriseSet = [];
for (const a of anchors) {
  const aN = cc.fileCommits.get(a) ?? 0;
  if (!aN) continue;
  for (const [key, both] of cc.pair) {
    const [x, y] = key.split(' ');
    if (x !== a && y !== a) continue;
    const other = x === a ? y : x;
    if (anchors.includes(other) || isNoise(other)) continue;
    if (both < MIN_SUPPORT) continue;
    const bN = cc.fileCommits.get(other) ?? 0;
    const p = fisherExact(both, aN - both, bN - both, cc.commits - aN - bN + both);
    if (p > MAX_P) continue;
    if (connected(graph, a, other, 3)) continue;   // the graph explains it; not a surprise
    surpriseSet.push({
      path: other, with: a, joint_commits: both,
      confidence: +(both / aN).toFixed(3), fisher_p: +p.toExponential(2),
      why: 'changes with the target, and no dependency path explains why'
    });
  }
}
surpriseSet.sort((a, b) => b.joint_commits - a.joint_commits || a.fisher_p - b.fisher_p);

// OWNERSHIP for everything in scope
const scope = [...new Set([...anchors, ...impactSet.map((i) => i.path), ...surpriseSet.map((s) => s.path)])];
const ownershipRows = scope.map((p) => own.forFile(p)).filter(Boolean);
const nobodyLeft = ownershipRows.filter((o) => o.nobody_left);
const departedOwners = ownershipRows.filter((o) => !o.top_owner_active && !o.nobody_left);

// ---------------------------------------------------------------- emit

const out = {
  task: TASK,
  ref: REF,
  as_of: own.asOf,
  anchors: {
    selected: anchors,
    provisional,
    note: provisional
      ? 'PROVISIONAL - scored by evidence, not chosen by judgement. Review the candidates, decide which anchors the task actually means, then re-run with --anchor <path> for each.'
      : 'explicit, supplied by the caller',
    task_terms: terms,
    candidates: candidates.slice(0, 12)
  },
  read_set: dedupe(readSet),
  impact_set: impactSet,
  tests_affected: impactTests,
  surprise_set: surpriseSet,
  ownership: ownershipRows,
  flags: {
    files_with_nobody_left: nobodyLeft.map((o) => o.path),
    files_whose_owner_departed: departedOwners.map((o) => ({ path: o.path, owner: o.top_owner })),
    unexplained_couplings: surpriseSet.length
  },
  stats: {
    graph_files: graph.files.length,
    commits: cc.commits,
    supernode_commits_suppressed: cc.suppressed
  },
  caveats: [
    'Anchors are scored from name and term evidence; a task phrased in domain language absent from the code will score poorly. Read the candidate evidence rather than trusting the ranking.',
    'The dependency graph comes from regex import extraction, not type resolution: dynamic imports, DI containers and reflection are invisible to it, so impact_set is a floor, not a ceiling.',
    '"Owner" means wrote the most commits, not is responsible for.',
    'surprise_set is correlation. A pair can co-change because of a shared release cadence rather than a hidden dependency - the Fisher test filters coincidence, not confounding.',
    MAP ? null : 'No identity mapping supplied; ownership may be split across aliases of the same person.'
  ].filter(Boolean)
};

function dedupe(rows) {
  const seen = new Map();
  for (const r of rows) {
    const prev = seen.get(r.path);
    if (!prev || r.depth < prev.depth) seen.set(r.path, r);
  }
  return [...seen.values()].sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
}

if (FORMAT === 'json') {
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else {
  const line = (s = '') => console.log(s);
  line(`CHANGE BRIEF — ${TASK || '(anchors supplied directly)'}`);
  line(`ref ${REF} · as-of ${out.as_of} · ${out.stats.graph_files} files · ${out.stats.commits} commits`);
  if (out.stats.supernode_commits_suppressed)
    line(`${out.stats.supernode_commits_suppressed} oversized commit(s) suppressed from co-change`);

  line(`\n── ANCHORS ${provisional ? '(PROVISIONAL — you decide)' : '(explicit)'}`);
  if (terms.length) line(`task terms: ${terms.join(', ')}`);
  for (const c of out.anchors.candidates.slice(0, 8)) {
    const mark = anchors.includes(c.path) ? '*' : ' ';
    line(`${mark} ${c.score.toFixed(1).padStart(5)}  ${c.path}`);
    line(`         ${c.evidence.slice(0, 3).join(' · ')}`);
  }
  if (provisional) line(`\n${out.anchors.note}`);

  line(`\n── READ SET (${out.read_set.length}) — understand these before changing anything`);
  for (const r of out.read_set.slice(0, 15)) line(`  ${r.path}\n      ${r.reason}`);
  if (out.read_set.length > 25) {
    line(`\n  ${out.read_set.length} files is too many to read, which means the anchors are too`);
    line('  broad. Narrow them: re-run with --anchor on the one or two files the task');
    line('  really means. A read set you will not read is worse than none.');
  }

  line(`\n── IMPACT SET (${out.impact_set.length}) — what breaks`);
  if (!out.impact_set.length) line('  nothing in production depends on the anchors in the static graph');
  for (const i of out.impact_set.slice(0, 15)) line(`  d=${i.depth}  ${i.verdict.padEnd(16)}  ${i.path}`);
  if (out.tests_affected.length) {
    line(`\n  + ${out.tests_affected.length} test file(s) cover this — expected to fail, not fallout:`);
    for (const i of out.tests_affected.slice(0, 6)) line(`      ${i.path}`);
    if (out.tests_affected.length > 6) line(`      … and ${out.tests_affected.length - 6} more`);
  }

  line(`\n── SURPRISE SET (${out.surprise_set.length}) — co-changes the graph does not explain`);
  if (!out.surprise_set.length) line('  none above the significance threshold');
  for (const s of out.surprise_set.slice(0, 10))
    line(`  ${s.path}\n      ${s.joint_commits} joint commits with ${s.with} · confidence ${s.confidence} · p=${s.fisher_p}`);

  line(`\n── OWNERSHIP IN SCOPE`);
  line('  LIVE%  OWNER                 MINOR  COMMITS  FILE');
  for (const o of out.ownership.slice(0, 15)) {
    line('  ' + (o.live_knowledge_share * 100).toFixed(0).padStart(5) + '  ' +
      `${o.top_owner_tied ? `${o.top_owner_tied.length}-way tie` : o.top_owner}${o.top_owner_active ? '' : ' (departed)'}`
        .slice(0, 21).padEnd(21) + '  ' +
      String(o.minor).padStart(5) + '  ' + String(o.commits).padStart(7) + '  ' + o.path);
  }
  if (nobodyLeft.length) {
    line(`\n  ⚠ NOBODY LEFT who has touched these: ${nobodyLeft.map((o) => o.path).join(', ')}`);
  }
  if (departedOwners.length) {
    line(`  ⚠ primary owner departed: ${departedOwners.map((o) => `${o.path} (${o.top_owner})`).join(', ')}`);
  }
  line('');
  for (const c of out.caveats) line(`note: ${c}`);
}
