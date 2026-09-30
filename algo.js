'use strict';
/*
 * Scroll Run - field model, cost function, BFS and A*.
 * Pure logic, no DOM. Loaded by index.html (window.ScrollRun) and by test.js (require).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ScrollRun = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // ---------------------------------------------------------------- field data
  const DIRS = ['N', 'E', 'S', 'W']; // clockwise, index = heading
  const DIR_NAMES = { N: 'North', E: 'East', S: 'South', W: 'West' };
  const STEP = [[-1, 0], [0, 1], [1, 0], [0, -1]]; // [row, col] delta per heading

  // Real field data. Do not change.
  const FIELD = {
    rows: 4,
    cols: 3,
    heights: { 1: 400, 2: 200, 3: 400, 4: 200, 5: 400, 6: 600, 7: 400, 8: 600, 9: 400, 10: 200, 11: 400, 12: 200 },
    edges: [
      [1, 2], [2, 3], [4, 5], [5, 6], [7, 8], [8, 9], [10, 11], [11, 12], // rows
      [1, 4], [4, 7], [7, 10], [2, 5], [5, 8], [8, 11], [3, 6], [6, 9], [9, 12], // columns
    ],
    start: 2,
    startHeading: 'S',
    exits: [10, 12],
    fakeForbidden: [1, 2, 3],
    r2Count: 4,
  };
  const R2_REQUIRED = 2;

  // ------------------------------------------------------------- cost function
  const CLIMB_UP = 10; // to a higher block
  const CLIMB_DOWN = 7; // to a lower block
  const CLIMB_FLAT = 7; // same height: not specified, treated like a descent (no flat moves on this field)
  const TURN_QUARTER = 5;
  const TURN_HALF = 10;
  // Cheapest a single move can ever cost (a turn can cost 0, a climb never less than this).
  const MIN_MOVE_COST = Math.min(CLIMB_UP, CLIMB_DOWN, CLIMB_FLAT);

  function climbCost(fromHeight, toHeight) {
    if (toHeight > fromHeight) return CLIMB_UP;
    if (toHeight < fromHeight) return CLIMB_DOWN;
    return CLIMB_FLAT;
  }

  function turnCost(heading, direction) {
    const diff = (direction - heading + 4) % 4;
    if (diff === 0) return 0;
    return diff === 2 ? TURN_HALF : TURN_QUARTER;
  }

  // ------------------------------------------------------------------ geometry
  function blockCount(field) { return field.rows * field.cols; }

  function position(field, block) {
    return { row: Math.floor((block - 1) / field.cols), col: (block - 1) % field.cols };
  }

  function neighbourBlock(field, block, dir) {
    const p = position(field, block);
    const r = p.row + STEP[dir][0];
    const c = p.col + STEP[dir][1];
    if (r < 0 || c < 0 || r >= field.rows || c >= field.cols) return null;
    return r * field.cols + c + 1;
  }

  // Height "level" = rank among the distinct heights on the field (200/400/600 -> 0/1/2).
  function levelMap(field) {
    const distinct = [...new Set(Object.values(field.heights))].sort((a, b) => a - b);
    const level = new Map();
    for (const b of Object.keys(field.heights)) level.set(Number(b), distinct.indexOf(field.heights[b]));
    return level;
  }

  /*
   * Movement graph. An edge a->b exists only if the two blocks are listed as adjacent, neither is
   * removed (Fake KFS), and their height levels differ by at most one. Checked generically for
   * every edge, so a field where some pair is more than one level apart loses that edge.
   * adj.get(block) is ordered N, E, S, W so every search expands neighbours deterministically.
   */
  function buildGraph(field, removed) {
    const gone = new Set(removed || []);
    const level = levelMap(field);
    const edgeSet = new Set(field.edges.map(([a, b]) => (a < b ? a + '-' + b : b + '-' + a)));
    const adj = new Map();
    for (let b = 1; b <= blockCount(field); b++) {
      if (gone.has(b)) continue;
      const list = [];
      for (let d = 0; d < 4; d++) {
        const nb = neighbourBlock(field, b, d);
        if (nb === null || gone.has(nb)) continue;
        if (!edgeSet.has(b < nb ? b + '-' + nb : nb + '-' + b)) continue;
        if (Math.abs(level.get(b) - level.get(nb)) > 1) continue;
        list.push({ to: nb, dir: d });
      }
      adj.set(b, list);
    }
    return { adj };
  }

  function directionBetween(field, a, b) {
    for (let d = 0; d < 4; d++) if (neighbourBlock(field, a, d) === b) return d;
    return -1;
  }

  // ---------------------------------------------------------------- placements
  // placement = { fake: block | null, r2: [block, ...] }. r2[i] owns bit i of the mask.
  function canPlaceFake(field, block) {
    if (field.fakeForbidden.includes(block)) {
      return { ok: false, reason: 'The Fake KFS cannot be placed on block 1, 2 or 3 (competition rule).' };
    }
    return { ok: true };
  }

  function isComplete(field, placement) {
    return placement.fake !== null && placement.r2.length === field.r2Count;
  }

  function validatePlacement(field, placement) {
    const used = new Set();
    if (placement.fake !== null) {
      const chk = canPlaceFake(field, placement.fake);
      if (!chk.ok) return chk.reason;
      used.add(placement.fake);
    }
    for (const b of placement.r2) {
      if (used.has(b)) return 'Block ' + b + ' holds more than one marker.';
      used.add(b);
    }
    if (placement.r2.length > field.r2Count) return 'Too many R2 KFS.';
    return null;
  }

  function randomPlacement(field, rng) {
    const rand = rng || Math.random;
    const all = [];
    for (let b = 1; b <= blockCount(field); b++) all.push(b);
    const fakeChoices = all.filter((b) => !field.fakeForbidden.includes(b));
    const fake = fakeChoices[Math.floor(rand() * fakeChoices.length)];
    const rest = all.filter((b) => b !== fake);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    return { fake, r2: rest.slice(0, field.r2Count) };
  }

  // ------------------------------------------------------------------- helpers
  function popcount(mask) {
    let n = 0;
    for (let m = mask; m; m >>= 1) n += m & 1;
    return n;
  }

  function prepare(field, placement) {
    const removed = placement.fake === null ? [] : [placement.fake];
    const graph = buildGraph(field, removed);
    const bitOf = new Map();
    placement.r2.forEach((b, i) => bitOf.set(b, i));
    const pick = (mask, block) => (bitOf.has(block) ? mask | (1 << bitOf.get(block)) : mask);
    return { graph, pick, startMask: pick(0, field.start) };
  }

  const isGoal = (field, block, mask) => field.exits.includes(block) && popcount(mask) >= R2_REQUIRED;

  // Blocks reachable from the start when every marker except the Fake is ignored.
  function reachableFrom(graph, start) {
    const seen = new Set();
    if (!graph.adj.has(start)) return seen;
    seen.add(start);
    const q = [start];
    for (let i = 0; i < q.length; i++) {
      for (const { to } of graph.adj.get(q[i])) {
        if (!seen.has(to)) { seen.add(to); q.push(to); }
      }
    }
    return seen;
  }

  function diagnose(field, placement, graph) {
    if (!graph.adj.has(field.start)) {
      return 'The start block ' + field.start + ' is not part of the field for this placement, so the robot cannot move.';
    }
    const reach = reachableFrom(graph, field.start);
    const reachList = [...reach].sort((a, b) => a - b);
    const exits = field.exits.filter((e) => reach.has(e));
    const fakeNote = placement.fake === null ? '' : ' with the Fake KFS on block ' + placement.fake;
    if (exits.length === 0) {
      return 'No exit can be reached' + fakeNote + ': from block ' + field.start + ' the robot can only reach blocks ' +
        reachList.join(', ') + ', and neither exit ' + field.exits.join(' nor ') +
        ' is among them (blocked by the Fake KFS and/or the one-level height rule).';
    }
    const r2Reach = placement.r2.filter((b) => reach.has(b));
    if (r2Reach.length < R2_REQUIRED) {
      return 'Only ' + r2Reach.length + ' of the ' + placement.r2.length + ' R2 KFS can be reached' + fakeNote +
        (r2Reach.length ? ' (block ' + r2Reach.join(', ') + ')' : '') + ', but ' + R2_REQUIRED + ' are needed before exiting.';
    }
    return 'No legal route exists for this placement.';
  }

  // Cost of a block sequence under the real cost function (used for BFS paths and for A* reporting).
  function evaluatePath(field, placement, blocks) {
    const ctx = prepare(field, placement);
    let heading = DIRS.indexOf(field.startHeading);
    let mask = ctx.startMask;
    let total = 0;
    const steps = [];
    for (let i = 1; i < blocks.length; i++) {
      const from = blocks[i - 1];
      const to = blocks[i];
      const dir = directionBetween(field, from, to);
      const climb = climbCost(field.heights[from], field.heights[to]);
      const turn = turnCost(heading, dir);
      total += climb + turn;
      const maskAfter = ctx.pick(mask, to);
      steps.push({
        index: i, from, to, dir, dirName: DIR_NAMES[DIRS[dir]], climb, turn, total,
        picked: maskAfter !== mask, maskAfter,
      });
      mask = maskAfter;
      heading = dir;
    }
    return { steps, cost: total, moves: blocks.length - 1, finalMask: mask };
  }

  function makeResult(name, field, placement, blocks, expanded) {
    const ev = evaluatePath(field, placement, blocks);
    return {
      algorithm: name, found: true, path: blocks, moves: ev.moves, cost: ev.cost, steps: ev.steps,
      exit: blocks[blocks.length - 1], expanded,
    };
  }

  function failResult(name, field, placement, graph, expanded) {
    return { algorithm: name, found: false, reason: diagnose(field, placement, graph), expanded };
  }

  // --------------------------------------------------------------------- BFS
  /*
   * Baseline: uniform cost 1 per move. The real cost function is never consulted while searching;
   * it is applied afterwards, only to report what the found path would really cost.
   * Search space is (block, mask). Heading does not change a move count, and the heading along the
   * found path is recomputed when the path is evaluated. Ties are broken by expansion order N, E, S, W.
   */
  function bfs(field, placement) {
    const ctx = prepare(field, placement);
    const { adj } = ctx.graph;
    if (!adj.has(field.start)) return failResult('BFS', field, placement, ctx.graph, 0);
    const key = (block, mask) => block * 1024 + mask;
    const first = { block: field.start, mask: ctx.startMask, parent: null };
    const seen = new Set([key(first.block, first.mask)]);
    const queue = [first];
    let expanded = 0;
    for (let head = 0; head < queue.length; head++) {
      const s = queue[head];
      expanded++;
      if (isGoal(field, s.block, s.mask)) {
        const blocks = [];
        for (let n = s; n; n = n.parent) blocks.push(n.block);
        return makeResult('BFS', field, placement, blocks.reverse(), expanded);
      }
      for (const { to } of adj.get(s.block)) {
        const mask = ctx.pick(s.mask, to);
        const k = key(to, mask);
        if (seen.has(k)) continue;
        seen.add(k);
        queue.push({ block: to, mask, parent: s });
      }
    }
    return failResult('BFS', field, placement, ctx.graph, expanded);
  }

  // ---------------------------------------------------------------------- A*
  // Unweighted move distance from every block to the nearest exit, computed once per run.
  // The graph is symmetric (edges are undirected and the height rule is symmetric), so a BFS
  // outward from the exits gives distances toward the exits.
  function exitDistances(field, graph) {
    const dist = new Map();
    const q = [];
    for (const e of field.exits) if (graph.adj.has(e)) { dist.set(e, 0); q.push(e); }
    for (let i = 0; i < q.length; i++) {
      for (const { to } of graph.adj.get(q[i])) {
        if (!dist.has(to)) { dist.set(to, dist.get(q[i]) + 1); q.push(to); }
      }
    }
    return dist;
  }

  /*
   * h(state) = max(kfs_still_needed, distance_to_nearest_exit) * MIN_MOVE_COST   (MIN_MOVE_COST = 7)
   *
   * Admissible: both terms are individually necessary lower bounds on the number of moves still to
   * make. Every missing R2 KFS must be picked up by landing on its own, different block, which is at
   * least one move each, so at least kfs_still_needed moves remain. Reaching an exit needs at least
   * distance_to_nearest_exit moves, because that is the shortest unweighted path and walls only add
   * moves. Both must be satisfied by the same sequence of moves, so the larger of the two is still a
   * lower bound on the remaining moves. Every move costs at least MIN_MOVE_COST seconds (a turn can
   * cost 0, a climb never costs less than 7), so moves * MIN_MOVE_COST is a lower bound on the
   * remaining cost. It is also consistent: one move lowers either term by at most 1, so h drops by
   * at most 7, which is no more than the cost of that move.
   * A block cut off from every exit gets Infinity (no route can ever finish from there).
   */
  function createHeuristic(field, placement) {
    const ctx = prepare(field, placement);
    const dist = exitDistances(field, ctx.graph);
    return function h(block, mask) {
      const d = dist.get(block);
      if (d === undefined) return Infinity;
      const kfsNeeded = Math.max(0, R2_REQUIRED - popcount(mask));
      return Math.max(kfsNeeded, d) * MIN_MOVE_COST;
    };
  }

  class MinHeap {
    constructor(less) { this.a = []; this.less = less; }
    get size() { return this.a.length; }
    push(x) {
      const a = this.a;
      a.push(x);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!this.less(a[i], a[p])) break;
        [a[i], a[p]] = [a[p], a[i]];
        i = p;
      }
    }
    pop() {
      const a = this.a;
      const top = a[0];
      const last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < a.length && this.less(a[l], a[m])) m = l;
          if (r < a.length && this.less(a[r], a[m])) m = r;
          if (m === i) break;
          [a[i], a[m]] = [a[m], a[i]];
          i = m;
        }
      }
      return top;
    }
  }

  // options.heuristic = false runs the same search with h = 0 (plain Dijkstra), used by the tests
  // to confirm that A* returns a cheapest route.
  function astar(field, placement, options) {
    const useHeuristic = !options || options.heuristic !== false;
    const name = (options && options.name) || 'A*';
    const ctx = prepare(field, placement);
    const { adj } = ctx.graph;
    if (!adj.has(field.start)) return failResult(name, field, placement, ctx.graph, 0);
    const heur = useHeuristic ? createHeuristic(field, placement) : () => 0;
    const key = (block, mask, heading) => (block * 1024 + mask) * 4 + heading;

    const startHeading = DIRS.indexOf(field.startHeading);
    const h0 = heur(field.start, ctx.startMask);
    if (h0 === Infinity) return failResult(name, field, placement, ctx.graph, 0);

    let seq = 0;
    // Order: lowest f, then lowest g, then insertion order (which follows the N, E, S, W expansion order).
    const open = new MinHeap((x, y) => ((x.f - y.f) || (x.g - y.g) || (x.seq - y.seq)) < 0);
    const best = new Map();
    const first = { block: field.start, mask: ctx.startMask, heading: startHeading, g: 0, f: h0, seq: seq++, parent: null };
    best.set(key(first.block, first.mask, first.heading), 0);
    open.push(first);
    let expanded = 0;

    while (open.size) {
      const s = open.pop();
      if (s.g > best.get(key(s.block, s.mask, s.heading))) continue; // stale entry
      expanded++;
      if (isGoal(field, s.block, s.mask)) {
        const blocks = [];
        for (let n = s; n; n = n.parent) blocks.push(n.block);
        return makeResult(name, field, placement, blocks.reverse(), expanded);
      }
      for (const { to, dir } of adj.get(s.block)) {
        const g = s.g + climbCost(field.heights[s.block], field.heights[to]) + turnCost(s.heading, dir);
        const mask = ctx.pick(s.mask, to);
        const k = key(to, mask, dir);
        if (best.has(k) && best.get(k) <= g) continue;
        const h = heur(to, mask);
        if (h === Infinity) continue;
        best.set(k, g);
        open.push({ block: to, mask, heading: dir, g, f: g + h, seq: seq++, parent: s });
      }
    }
    return failResult(name, field, placement, ctx.graph, expanded);
  }

  /*
   * Uniform-cost search: the same search on the full (block, mask, heading) state with real costs,
   * but no heuristic (h = 0). Optimal like A*, only it expands states in plain cost order.
   */
  function ucs(field, placement) {
    return astar(field, placement, { heuristic: false, name: 'UCS' });
  }


  // ------------------------------------------------------------- decision trace
  // Cheapest way to finish from an arbitrary state. metric 'moves' counts 1 per move (what BFS
  // optimises), 'cost' uses the real seconds (what UCS and A* optimise). Only used for explanation.
  function minToGoal(field, placement, start, metric) {
    const ctx = prepare(field, placement);
    const { adj } = ctx.graph;
    if (!adj.has(start.block)) return Infinity;
    const key = (b, m, h) => (b * 1024 + m) * 4 + h;
    const open = new MinHeap((x, y) => x.g < y.g);
    const best = new Map([[key(start.block, start.mask, start.heading), 0]]);
    open.push({ block: start.block, mask: start.mask, heading: start.heading, g: 0 });
    while (open.size) {
      const s = open.pop();
      if (s.g > best.get(key(s.block, s.mask, s.heading))) continue;
      if (isGoal(field, s.block, s.mask)) return s.g;
      for (const { to, dir } of adj.get(s.block)) {
        const step = metric === 'moves' ? 1 : climbCost(field.heights[s.block], field.heights[to]) + turnCost(s.heading, dir);
        const mask = ctx.pick(s.mask, to);
        const g = s.g + step;
        const k = key(to, mask, dir);
        if (best.has(k) && best.get(k) <= g) continue;
        best.set(k, g);
        open.push({ block: to, mask, heading: dir, g });
      }
    }
    return Infinity;
  }

  /*
   * For every step of a found route, list every legal next move from where the robot stands, with the
   * numbers the algorithm weighs, and say why the chosen one won. key is 'bfs', 'ucs' or 'astar'.
   * "total" is the true cheapest full route through that move (moves for BFS, seconds otherwise),
   * found by searching on from the candidate state. It is the honest reason a move is chosen.
   */
  function explainRoute(field, placement, res, key) {
    if (!res.found) return [];
    const ctx = prepare(field, placement);
    const heur = key === 'astar' ? createHeuristic(field, placement) : null;
    const metric = key === 'bfs' ? 'moves' : 'cost';
    const unit = key === 'bfs' ? 'moves' : 's';
    let heading = DIRS.indexOf(field.startHeading);
    let mask = ctx.startMask;
    let g = 0;
    const out = [];
    for (let i = 0; i + 1 < res.path.length; i++) {
      const cur = res.path[i];
      const next = res.path[i + 1];
      const cands = [];
      for (const { to, dir } of ctx.graph.adj.get(cur)) {
        const climb = climbCost(field.heights[cur], field.heights[to]);
        const turn = turnCost(heading, dir);
        const maskAfter = ctx.pick(mask, to);
        const gAfter = g + climb + turn;
        const togo = minToGoal(field, placement, { block: to, mask: maskAfter, heading: dir }, metric);
        const h = heur ? heur(to, maskAfter) : null;
        cands.push({
          to, dir, dirName: DIR_NAMES[DIRS[dir]], climb, turn, moveCost: climb + turn,
          g: gAfter, moves: i + 1, picks: maskAfter !== mask,
          h, f: h === null ? null : gAfter + h,
          total: (key === 'bfs' ? i + 1 : gAfter) + togo,
          chosen: to === next,
        });
      }
      const best = Math.min(...cands.map((c) => c.total));
      const chosen = cands.find((c) => c.chosen);
      const tied = cands.filter((c) => c.total === best && !c.chosen);
      let reason;
      if (chosen.total > best) {
        reason = 'Not the cheapest local choice, but the search commits to this move as part of its final route.';
      } else if (!tied.length) {
        reason = (key === 'bfs' ? 'Fewest moves to finish' : 'Cheapest way to finish') + ': ' + chosen.total + ' ' + unit +
          ' through this move. Every other move ends up worse.';
      } else {
        reason = 'Tied at ' + chosen.total + ' ' + unit + ' with block ' + tied.map((c) => c.to).join(', ') +
          '. The tie is broken by the search order (neighbours are tried N, E, S, W and earlier ones are queued first).';
      }
      out.push({ step: i + 1, from: cur, heading: DIR_NAMES[DIRS[heading]], best, unit, candidates: cands, reason });
      g = chosen.g;
      mask = ctx.pick(mask, next);
      heading = chosen.dir;
    }
    return out;
  }

  // ------------------------------------------------------------------ compare
  function compare(bfsRes, astarRes) {
    if (!bfsRes.found || !astarRes.found) return null;
    return {
      samePath: bfsRes.path.length === astarRes.path.length && bfsRes.path.every((b, i) => b === astarRes.path[i]),
      sameExit: bfsRes.exit === astarRes.exit,
      costDiff: bfsRes.cost - astarRes.cost,
      moveDiff: astarRes.moves - bfsRes.moves,
    };
  }

  return {
    FIELD, DIRS, DIR_NAMES, STEP, R2_REQUIRED, MIN_MOVE_COST,
    climbCost, turnCost, position, neighbourBlock, directionBetween, levelMap, buildGraph, blockCount,
    canPlaceFake, isComplete, validatePlacement, randomPlacement,
    popcount, evaluatePath, createHeuristic, bfs, ucs, astar, compare, explainRoute, startHeadingIndex: DIRS.indexOf(FIELD.startHeading),
  };
});
