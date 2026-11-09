#!/usr/bin/env node
// strata/validate-graph.mjs — check hand-built graph data before publishing it.
//
// Usage: node validate-graph.mjs <file.html | file.json>
//
//   .html  — extracts `var N = [...]` and `var E = [...]` (the force-graph template)
//   .json  — expects { nodes: [...], edges: [[i,j], ...] } or { N: [...], E: [...] }
//
// Catches off-by-one indices, self-edges, duplicate edges and orphan nodes — none of
// which a force layout makes visually obvious — then prints the in-degree ranking.
// Quote THESE in-degree numbers in your prose rather than your recollection of the
// edge list; disagreement between the two is the usual source of a wrong hub claim.
//
// Exit codes: 0 clean (warnings allowed), 1 bad input, 2 structural errors found.

import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: node validate-graph.mjs <file.html|file.json>');
  process.exit(1);
}

let src;
try {
  src = readFileSync(path, 'utf8');
} catch (e) {
  console.error(`cannot read ${path}: ${e.message}`);
  process.exit(1);
}

let nodes, edges;

function arrayLiteral(text, name) {
  // find `var <name> = [` then walk brackets so nested arrays don't end it early
  const re = new RegExp(`(?:var|let|const)\\s+${name}\\s*=\\s*\\[`);
  const m = re.exec(text);
  if (!m) return null;
  let i = m.index + m[0].length - 1, depth = 0, inStr = null, prev = '';
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === inStr && prev !== '\\') inStr = null;
    } else if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return text.slice(m.index + m[0].length - 1, i + 1); }
    prev = c;
  }
  return null;
}

if (path.endsWith('.json')) {
  const j = JSON.parse(src);
  nodes = j.nodes ?? j.N;
  edges = j.edges ?? j.E;
  if (!nodes || !edges) {
    console.error('json must contain {nodes, edges} or {N, E}');
    process.exit(1);
  }
  nodes = nodes.map((n) => (Array.isArray(n) ? n[0] : (n.label ?? n.id ?? String(n))));
  edges = edges.map((e) => (Array.isArray(e) ? [e[0], e[1]] : [e.source, e.target]));
} else {
  const nLit = arrayLiteral(src, 'N');
  const eLit = arrayLiteral(src, 'E');
  if (!nLit || !eLit) {
    console.error('could not find `var N = [...]` and `var E = [...]` in the file.');
    console.error('If you renamed them, pass JSON instead.');
    process.exit(1);
  }
  // labels: first string of each node tuple
  nodes = [...nLit.matchAll(/\[\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  edges = [...eLit.matchAll(/\[\s*(\d+)\s*,\s*(\d+)\s*\]/g)].map((m) => [+m[1], +m[2]]);
}

console.log(`nodes: ${nodes.length}   edges: ${edges.length}`);
if (!nodes.length || !edges.length) {
  console.error('\nFAIL — empty node or edge set.');
  process.exit(2);
}

let errors = 0;

const oor = edges.filter(([a, b]) => !Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= nodes.length || b >= nodes.length);
const self = edges.filter(([a, b]) => a === b);
const seen = new Set();
const dups = [];
for (const [a, b] of edges) {
  const k = `${a}->${b}`;
  if (seen.has(k)) dups.push(`${nodes[a] ?? a} -> ${nodes[b] ?? b}`);
  seen.add(k);
}

const deg = new Map(), indeg = new Map(), outdeg = new Map();
for (const [a, b] of edges) {
  if (a >= nodes.length || b >= nodes.length) continue;
  deg.set(a, (deg.get(a) ?? 0) + 1);
  deg.set(b, (deg.get(b) ?? 0) + 1);
  outdeg.set(a, (outdeg.get(a) ?? 0) + 1);
  indeg.set(b, (indeg.get(b) ?? 0) + 1);
}
const orphans = nodes.map((l, i) => [l, i]).filter(([, i]) => !deg.has(i));

function report(label, list, fatal, fmt = (x) => JSON.stringify(x)) {
  if (!list.length) { console.log(`  [PASS] ${label}`); return; }
  console.log(`  [${fatal ? 'FAIL' : 'WARN'}] ${label}: ${list.length}`);
  for (const x of list.slice(0, 8)) console.log(`         ${fmt(x)}`);
  if (list.length > 8) console.log(`         … ${list.length - 8} more`);
  if (fatal) errors += list.length;
}

console.log('\nchecks:');
report('out-of-range edge indices', oor, true);
report('self-edges', self, true, ([a]) => `${nodes[a] ?? a} -> itself`);
report('duplicate edges', dups, true, (s) => s);
report('orphan nodes (no edges)', orphans, false, ([l]) => l);

// undirected reachability — a disconnected island is usually a missed edge
const adj = new Map();
for (const [a, b] of edges) {
  if (a >= nodes.length || b >= nodes.length) continue;
  if (!adj.has(a)) adj.set(a, []);
  if (!adj.has(b)) adj.set(b, []);
  adj.get(a).push(b);
  adj.get(b).push(a);
}
const comp = new Array(nodes.length).fill(-1);
let nc = 0;
for (let i = 0; i < nodes.length; i++) {
  if (comp[i] !== -1 || !adj.has(i)) continue;
  const stack = [i];
  comp[i] = nc;
  while (stack.length) {
    const v = stack.pop();
    for (const w of adj.get(v) ?? []) if (comp[w] === -1) { comp[w] = nc; stack.push(w); }
  }
  nc++;
}
if (nc > 1) {
  const sizes = {};
  comp.forEach((c) => { if (c >= 0) sizes[c] = (sizes[c] ?? 0) + 1; });
  console.log(`  [WARN] ${nc} disconnected components (sizes: ${Object.values(sizes).sort((a, b) => b - a).join(', ')})`);
  console.log('         An island is usually a missed edge, not a real separation.');
} else {
  console.log('  [PASS] graph is connected');
}

const rank = [...indeg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log('\ntop in-degree (quote these as your hubs):');
for (const [i, n] of rank) console.log(`  ${String(n).padStart(4)}  ${nodes[i]}`);

const orank = [...outdeg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log('\ntop out-degree (the modules that pull in the most):');
for (const [i, n] of orank) console.log(`  ${String(n).padStart(4)}  ${nodes[i]}`);

console.log(
  errors
    ? `\nFAILED — ${errors} structural error(s). Fix before publishing.`
    : '\nOK — structurally sound. Warnings above are judgement calls, not blockers.'
);
process.exit(errors ? 2 : 0);
