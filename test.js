'use strict';
// Run with: node test.js
const assert = require('assert');
const S = require('./algo.js');
const F = S.FIELD;

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log('cost function');
test('climb: up 10, down 7', () => {
  assert.strictEqual(S.climbCost(200, 400), 10);
  assert.strictEqual(S.climbCost(400, 600), 10);
  assert.strictEqual(S.climbCost(600, 400), 7);
  assert.strictEqual(S.climbCost(400, 200), 7);
});
test('turn: 0 / 5 / 10', () => {
  const N = 0, E = 1, So = 2, W = 3;
  assert.strictEqual(S.turnCost(So, So), 0);
  assert.strictEqual(S.turnCost(So, E), 5);
  assert.strictEqual(S.turnCost(So, W), 5);
  assert.strictEqual(S.turnCost(So, N), 10);
  assert.strictEqual(S.turnCost(N, E), 5);
});
test('cheapest possible move is 7', () => assert.strictEqual(S.MIN_MOVE_COST, 7));

console.log('field and graph');
test('adjacency list matches the grid geometry (17 edges, all orthogonal)', () => {
  assert.strictEqual(F.edges.length, 17);
  for (const [a, b] of F.edges) assert.ok(S.directionBetween(F, a, b) >= 0, a + '-' + b + ' not orthogonal');
});
test('every adjacent pair on the real field is height-legal (no edge removed)', () => {
  const g = S.buildGraph(F, []);
  let directed = 0;
  for (const list of g.adj.values()) directed += list.length;
  assert.strictEqual(directed, 34);
});
test('removing the Fake block removes it from the graph entirely', () => {
  const g = S.buildGraph(F, [5]);
  assert.ok(!g.adj.has(5));
  for (const list of g.adj.values()) assert.ok(list.every((e) => e.to !== 5));
});
test('height rule is generic: a 200 next to a 600 loses its edge', () => {
  const field = Object.assign({}, F, { heights: Object.assign({}, F.heights, { 5: 600, 2: 200 }) });
  const g = S.buildGraph(field, []);
  assert.ok(!g.adj.get(2).some((e) => e.to === 5));
  assert.ok(!g.adj.get(5).some((e) => e.to === 2));
});
test('Fake KFS refused on blocks 1, 2, 3 and allowed elsewhere', () => {
  for (const b of [1, 2, 3]) assert.strictEqual(S.canPlaceFake(F, b).ok, false);
  for (let b = 4; b <= 12; b++) assert.strictEqual(S.canPlaceFake(F, b).ok, true);
});
test('random placements always follow the rules', () => {
  const rng = mulberry32(7);
  for (let i = 0; i < 500; i++) {
    const p = S.randomPlacement(F, rng);
    assert.strictEqual(S.validatePlacement(F, p), null);
    assert.ok(S.isComplete(F, p));
  }
});


// Independent reference: repeated relaxation over every (block, mask, heading), no priority queue.
function referenceCost(field, p) {
  const g = S.buildGraph(field, p.fake === null ? [] : [p.fake]);
  const bit = new Map(p.r2.map((b, i) => [b, i]));
  const pick = (m, b) => (bit.has(b) ? m | (1 << bit.get(b)) : m);
  const key = (b, m, h) => b + ',' + m + ',' + h;
  const dist = new Map([[key(field.start, pick(0, field.start), S.startHeadingIndex), 0]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [k, d] of [...dist]) {
      const [b, m, h] = k.split(',').map(Number);
      for (const { to, dir } of g.adj.get(b)) {
        const nd = d + S.climbCost(field.heights[b], field.heights[to]) + S.turnCost(h, dir);
        const nk = key(to, pick(m, to), dir);
        if (!dist.has(nk) || dist.get(nk) > nd) { dist.set(nk, nd); changed = true; }
      }
    }
  }
  let best = Infinity;
  for (const [k, d] of dist) {
    const [b, m] = k.split(',').map(Number);
    if (field.exits.includes(b) && S.popcount(m) >= 2 && d < best) best = d;
  }
  return best;
}

console.log('search');
const rng = mulberry32(2026);
const samples = [];
for (let i = 0; i < 400; i++) samples.push(S.randomPlacement(F, rng));

test('A* cost equals the independent reference on 400 random placements', () => {
  for (const p of samples) assert.strictEqual(S.astar(F, p).cost, referenceCost(F, p), JSON.stringify(p));
});
test('A* cost equals plain Dijkstra (h = 0) on 400 random placements', () => {
  for (const p of samples) {
    const a = S.astar(F, p);
    const d = S.astar(F, p, { heuristic: false });
    assert.ok(a.found && d.found, JSON.stringify(p));
    assert.strictEqual(a.cost, d.cost, 'cost mismatch for ' + JSON.stringify(p));
  }
});
test('UCS is named UCS, matches the reference cost, and never expands fewer states than A*', () => {
  let fewer = 0;
  for (const p of samples) {
    const u = S.ucs(F, p);
    const a = S.astar(F, p);
    assert.strictEqual(u.algorithm, 'UCS');
    assert.strictEqual(u.cost, referenceCost(F, p), JSON.stringify(p));
    assert.ok(a.expanded <= u.expanded, 'A* expanded more than UCS for ' + JSON.stringify(p));
    if (a.expanded < u.expanded) fewer++;
  }
  console.log('       (A* expanded fewer states than UCS on ' + fewer + ' of ' + samples.length + ' placements)');
});
test('BFS never uses more moves than A*, A* never costs more than BFS', () => {
  let differ = 0;
  for (const p of samples) {
    const b = S.bfs(F, p);
    const a = S.astar(F, p);
    assert.ok(b.moves <= a.moves, 'BFS moves ' + b.moves + ' > A* moves ' + a.moves);
    assert.ok(a.cost <= b.cost, 'A* cost ' + a.cost + ' > BFS cost ' + b.cost);
    if (!S.compare(b, a).samePath) differ++;
  }
  console.log('       (' + differ + ' of ' + samples.length + ' placements gave different BFS and A* routes)');
});
test('found routes are legal: start at 2, adjacent hops, end on 10 or 12 holding 2+ scrolls', () => {
  for (const p of samples) {
    for (const r of [S.bfs(F, p), S.astar(F, p)]) {
      assert.strictEqual(r.path[0], F.start);
      assert.ok(F.exits.includes(r.exit));
      assert.ok(!r.path.includes(p.fake), 'route crosses the Fake KFS');
      for (let i = 1; i < r.path.length; i++) assert.ok(S.directionBetween(F, r.path[i - 1], r.path[i]) >= 0);
      assert.ok(S.popcount(r.steps.length ? r.steps[r.steps.length - 1].maskAfter : 0) >= 2);
    }
  }
});
test('heuristic never exceeds the true remaining cost along the optimal route', () => {
  for (const p of samples.slice(0, 150)) {
    const a = S.astar(F, p);
    const h = S.createHeuristic(F, p);
    // Rebuild mask/remaining cost along the path.
    const bit = new Map(p.r2.map((b, i) => [b, i]));
    let mask = bit.has(F.start) ? 1 << bit.get(F.start) : 0;
    assert.ok(h(F.start, mask) <= a.cost);
    for (const st of a.steps) {
      mask = st.maskAfter;
      const remaining = a.cost - st.total;
      assert.ok(h(st.to, mask) <= remaining, 'h overestimates at block ' + st.to);
    }
  }
});
test('no path: unreachable exits are reported cleanly by both algorithms (hypothetical field)', () => {
  // Bottom row at 600 mm sits two levels above the 200 mm row 3, so the height rule walls it off.
  const heights = { 1: 400, 2: 200, 3: 400, 4: 400, 5: 400, 6: 400, 7: 200, 8: 200, 9: 200, 10: 600, 11: 600, 12: 600 };
  const field = Object.assign({}, F, { heights });
  const p = { fake: 5, r2: [1, 3, 4, 6] };
  const b = S.bfs(field, p);
  const a = S.astar(field, p);
  for (const r of [a, b]) {
    assert.strictEqual(r.found, false);
    assert.ok(/No exit can be reached/.test(r.reason), r.reason);
  }
  assert.strictEqual(S.compare(b, a), null);
});
test('no path: fewer than 2 R2 KFS available is reported specifically', () => {
  const p = { fake: 5, r2: [6] };
  for (const r of [S.astar(F, p), S.bfs(F, p)]) {
    assert.strictEqual(r.found, false);
    assert.ok(/Only 1 of the 1 R2 KFS/.test(r.reason), r.reason);
  }
});

console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', with failures above' : ''));
