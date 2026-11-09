#!/usr/bin/env node
// strata/dep-graph.mjs — THE authoritative dependency graph, machine-readable.
//
// Usage:
//   node dep-graph.mjs [--ref <ref>] [--repo <dir>] [--format json|table|dot]
//                      [--no-tests] [--min-degree 0]
//
// Why this exists rather than a flag on dep-edges.sh: the graph was being built
// twice - once by shell regex in dep-edges.sh and once in lib/strata.mjs for the
// brief - which is two definitions of the same thing, free to drift apart. This
// is the single source of truth; `dep-edges.sh` keeps the jobs only a shell pass
// does well (counting lazy imports per file, route declarations, endpoint call
// sites) and defers the edge list to here.
//
// Output shape is deliberately the one the rest of the toolkit already consumes:
//   { nodes: [[label, group, owner, desc], ...], edges: [[fromIdx, toIdx], ...] }
// so it feeds validate-graph.mjs directly, ownership-metrics.mjs --fanin, and
// assets/force-graph.html with no translation step.
//
//   node dep-graph.mjs --format json > graph.json
//   node validate-graph.mjs graph.json
//   node ownership-metrics.mjs --metric orphan --blame blame.tsv --fanin graph.json

import { gitIn, buildImportGraph } from './lib/strata.mjs';

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const REF = opt('ref', 'HEAD');
const REPO = opt('repo', '.');
const FORMAT = opt('format', 'table');
const NO_TESTS = argv.includes('--no-tests');
const MIN_DEGREE = Number(opt('min-degree', '0'));

const git = gitIn(REPO);
const g = buildImportGraph(git, REF, { includeTests: !NO_TESTS });

// Keep only files that actually participate in the graph, unless asked for all.
const degree = (f) => (g.out.get(f)?.size ?? 0) + (g.inn.get(f)?.size ?? 0);
const kept = g.files.filter((f) => degree(f) >= Math.max(1, MIN_DEGREE));
const index = new Map(kept.map((f, i) => [f, i]));

// group: a coarse layer guess from the path, so a consumer has something to
// colour by without a hand-written mapping. Deliberately simple - a real layering
// is a judgement call the caller should make.
const groupOf = (f) => {
  if (/(^|\/)(tests?|spec|__tests__)\//.test(f) || /[._](test|spec)\./.test(f)) return 'test';
  if (/\.(html?|css)$/.test(f)) return 'view';
  if (/(^|\/)(static|public|assets|client|web|frontend|src\/components?)\//.test(f)) return 'client';
  if (/(^|\/)(migrations?|models?|schema|db)(\/|\.)/.test(f)) return 'data';
  if (/(^|\/)(routes?|api|controllers?|handlers?|views?)(\/|\.)/.test(f)) return 'api';
  if (/(^|\/)(services?|lib|core|domain|internal)\//.test(f)) return 'service';
  return 'other';
};

const edges = [];
for (const [from, tos] of g.out) {
  if (!index.has(from)) continue;
  for (const to of tos) {
    if (!index.has(to)) continue;
    edges.push([index.get(from), index.get(to)]);
  }
}

const nodes = kept.map((f) => [f, groupOf(f), 'unknown', '']);

if (FORMAT === 'json') {
  process.stdout.write(JSON.stringify({
    ref: REF,
    generated_by: 'strata/dep-graph.mjs',
    note: 'Edges are import statements, <script src> tags and resolved relative module specifiers, extracted by regex at any indentation (so lazy imports inside functions are included). Not type-resolved: dynamic imports, DI containers and reflection are invisible, so this is a floor on the real dependency set.',
    nodes, edges
  }, null, 2) + '\n');
} else if (FORMAT === 'dot') {
  console.log('digraph deps {');
  console.log('  rankdir=LR; node [shape=box, fontname="monospace", fontsize=9];');
  for (const [a, b] of edges) console.log(`  "${kept[a]}" -> "${kept[b]}";`);
  console.log('}');
} else {
  console.log(`dependency graph — ref ${REF}`);
  console.log(`${kept.length} connected files · ${edges.length} edges` +
              (g.files.length - kept.length ? ` · ${g.files.length - kept.length} isolated file(s) omitted` : ''));
  console.log('');
  const byFrom = new Map();
  for (const [a, b] of edges) {
    if (!byFrom.has(a)) byFrom.set(a, []);
    byFrom.get(a).push(kept[b]);
  }
  for (const [a, tos] of [...byFrom.entries()].sort((x, y) => kept[x[0]].localeCompare(kept[y[0]]))) {
    console.log(`${kept[a]}`);
    for (const t of tos.sort()) console.log(`    -> ${t}`);
  }
  console.log('');
  console.log('top in-degree (the hubs — a change here reaches furthest):');
  const indeg = kept.map((f, i) => [f, g.inn.get(f)?.size ?? 0])
    .sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [f, n] of indeg) if (n) console.log(`  ${String(n).padStart(4)}  ${f}`);
  console.log('');
  console.log('Edges mix import statements, script tags and relative specifiers, and are not');
  console.log('type-resolved — dynamic imports and DI are invisible, so treat this as a floor.');
}
