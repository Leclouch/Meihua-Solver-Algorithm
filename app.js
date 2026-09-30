(function () {
  'use strict';
  const S = window.ScrollRun;
  const F = S.FIELD;
  const NS = 'http://www.w3.org/2000/svg';
  const $ = (id) => document.getElementById(id);

  // Base colours of the real field material (RGB). 3D faces are shaded from these.
  const COLORS = { 200: [41, 82, 16], 400: [42, 113, 56], 600: [152, 166, 80] };

  // Oblique projection, north toward the top, viewer looking from the south-east.
  const PX = 118; // screen px per column
  const PY = 84; // screen px per row
  const SHEAR = 24; // rows farther north shift right by this much
  const ZS = 0.09; // screen px of pillar height per mm
  const GAP = 0.16; // gap between blocks, in block units
  const VIEWBOX = '-24 -84 498 440';

  const state = {
    placement: { fake: null, r2: [] },
    mode: 'fake',
    results: null,
    route: 'astar',
    collected: 0,
  };
  const anim = { res: null, segs: [], total: 0, t: 0, playing: false, raf: 0, last: 0, done: -1 };

  // ------------------------------------------------------------------ svg helpers
  function el(name, attrs, parent) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function proj(x, y, z) {
    return [x * PX + (F.rows - y) * SHEAR, y * PY - z * ZS];
  }
  function pts(list) {
    return list.map((p) => proj(p[0], p[1], p[2]).map((n) => n.toFixed(1)).join(',')).join(' ');
  }
  function shade(c, f) {
    return 'rgb(' + c.map((v) => Math.round(Math.min(255, v * f))).join(',') + ')';
  }
  function geom(b) {
    const p = S.position(F, b);
    const x0 = p.col + GAP / 2, x1 = p.col + 1 - GAP / 2, y0 = p.row + GAP / 2, y1 = p.row + 1 - GAP / 2;
    return { x0, x1, y0, y1, h: F.heights[b], xc: (x0 + x1) / 2, yc: (y0 + y1) / 2 };
  }
  function anchor(b) {
    const g = geom(b);
    return proj(g.xc, g.yc, g.h);
  }

  // ------------------------------------------------------------------ scene setup
  const svg = $('field');
  svg.setAttribute('viewBox', VIEWBOX);

  const defs = el('defs', {}, svg);
  for (const h of [200, 400, 600]) {
    const c = COLORS[h];
    const grad = (id, a, b, vertical) => {
      const g = el('linearGradient', { id: id + '-' + h, x1: 0, y1: 0, x2: vertical ? 0 : 1, y2: 1 }, defs);
      el('stop', { offset: '0', 'stop-color': shade(c, a) }, g);
      el('stop', { offset: '1', 'stop-color': shade(c, b) }, g);
    };
    grad('top', 1.1, 0.94, false);
    grad('front', 0.68, 0.56, true);
    grad('right', 0.52, 0.42, false);
  }
  const hatch = el('pattern', { id: 'hatch', width: 9, height: 9, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
  el('rect', { width: 9, height: 9, fill: 'rgba(120,20,10,0.35)' }, hatch);
  el('line', { x1: 0, y1: 0, x2: 0, y2: 9, stroke: 'rgba(255,110,90,0.75)', 'stroke-width': 3 }, hatch);
  const soil = el('radialGradient', { id: 'soil', cx: '50%', cy: '45%', r: '65%' }, defs);
  el('stop', { offset: '0', 'stop-color': '#182a20' }, soil);
  el('stop', { offset: '1', 'stop-color': '#0b130f' }, soil);

  // ground plate under the blocks
  el('polygon', {
    points: pts([[-0.18, -0.18, 0], [F.cols + 0.18, -0.18, 0], [F.cols + 0.18, F.rows + 0.12, 0], [-0.18, F.rows + 0.12, 0]]),
    fill: 'url(#soil)', stroke: 'rgba(190,210,170,0.14)', 'stroke-width': 1,
  }, svg);

  const blocksLayer = el('g', {}, svg);
  const routeLayer = el('g', {}, svg);
  const robotLayer = el('g', {}, svg);

  // robot: dark disc with a gold arrow that points along the current heading
  const robot = el('g', { visibility: 'hidden' }, robotLayer);
  el('ellipse', { cx: 0, cy: 12, rx: 15, ry: 5, fill: 'rgba(0,0,0,0.4)' }, robot);
  const robotBody = el('g', {}, robot);
  el('circle', { r: 14, fill: '#111c17', stroke: '#dcb75f', 'stroke-width': 2.5 }, robotBody);
  const robotArrow = el('g', {}, robotBody);
  el('polygon', { points: '-6,-7 10,0 -6,7 -3,0', fill: '#dcb75f' }, robotArrow);

  // screen angle of each heading, so the arrow follows the projected direction
  const HEAD_VEC = [[SHEAR, -PY], [PX, 0], [-SHEAR, PY], [-PX, 0]];
  const ANGLE = HEAD_VEC.map((v) => (Math.atan2(v[1], v[0]) * 180) / Math.PI);
  const mod = (a, n) => ((a % n) + n) % n;

  // ------------------------------------------------------------------ markers
  function drawFake(g, cx, cy) {
    el('ellipse', { cx, cy: cy + 12, rx: 14, ry: 4, fill: 'rgba(0,0,0,0.35)' }, g);
    const s = el('g', { transform: 'translate(' + cx + ',' + cy + ') rotate(-6)' }, g);
    el('rect', { x: -13, y: -13, width: 26, height: 26, rx: 3, fill: '#b8321f', stroke: '#f0b9a8', 'stroke-width': 1.5 }, s);
    el('path', { d: 'M-7 -7 L7 7 M7 -7 L-7 7', stroke: '#f7e6d0', 'stroke-width': 3.2, 'stroke-linecap': 'round' }, s);
  }
  function drawScroll(g, cx, cy) {
    el('ellipse', { cx, cy: cy + 11, rx: 17, ry: 4, fill: 'rgba(0,0,0,0.35)' }, g);
    const s = el('g', { transform: 'translate(' + cx + ',' + cy + ') rotate(-8)' }, g);
    el('rect', { x: -16, y: -8, width: 32, height: 16, rx: 2, fill: '#e6cd86', stroke: '#8f7431', 'stroke-width': 1 }, s);
    el('rect', { x: -20, y: -10, width: 7, height: 20, rx: 3, fill: '#7a4f26' }, s);
    el('rect', { x: 13, y: -10, width: 7, height: 20, rx: 3, fill: '#7a4f26' }, s);
    el('rect', { x: -3, y: -9, width: 6, height: 18, fill: '#2f9f7a' }, s);
    el('path', { d: 'M-11 -3 H-6 M-11 2 H-7 M6 -3 H11 M6 2 H10', stroke: '#8f7431', 'stroke-width': 1.2 }, s);
  }
  function drawFlag(g, fx, fy) {
    el('line', { x1: fx, y1: fy, x2: fx, y2: fy - 28, stroke: '#eadfbf', 'stroke-width': 2 }, g);
    el('polygon', { points: [fx, fy - 28, fx + 17, fy - 21, fx, fy - 14].join(' '), fill: '#dcb75f' }, g);
  }
  function drawGate(g, fx, fy) {
    const c = '#52c39a';
    el('path', { d: 'M' + (fx - 9) + ' ' + fy + ' V' + (fy - 22) + ' M' + (fx + 9) + ' ' + fy + ' V' + (fy - 22) +
      ' M' + (fx - 9) + ' ' + (fy - 16) + ' H' + (fx + 9), stroke: c, 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round' }, g);
    el('path', { d: 'M' + (fx - 15) + ' ' + (fy - 24) + ' Q' + fx + ' ' + (fy - 31) + ' ' + (fx + 15) + ' ' + (fy - 24),
      stroke: c, 'stroke-width': 3.5, fill: 'none', 'stroke-linecap': 'round' }, g);
  }

  // ------------------------------------------------------------------ block rendering
  function startMask() {
    const i = state.placement.r2.indexOf(F.start);
    return i >= 0 ? 1 << i : 0;
  }

  function blockLabel(b) {
    const p = state.placement;
    let what = 'empty';
    if (p.fake === b) what = 'Fake KFS';
    else if (p.r2.includes(b)) what = 'R2 KFS';
    const role = b === F.start ? ', start' : F.exits.includes(b) ? ', exit' : '';
    return 'Block ' + b + ', ' + F.heights[b] + ' millimetres' + role + ', ' + what;
  }

  function renderBlocks() {
    blocksLayer.replaceChildren();
    const p = state.placement;
    const fakeMode = state.mode === 'fake';
    for (let b = 1; b <= S.blockCount(F); b++) {
      const q = geom(b);
      const forbidden = F.fakeForbidden.includes(b);
      const g = el('g', {
        class: 'block' + (fakeMode && forbidden ? ' no-fake' : ''),
        'data-b': b, tabindex: 0, role: 'button', 'aria-label': blockLabel(b),
      }, blocksLayer);
      const front = pts([[q.x0, q.y1, 0], [q.x1, q.y1, 0], [q.x1, q.y1, q.h], [q.x0, q.y1, q.h]]);
      const right = pts([[q.x1, q.y1, 0], [q.x1, q.y0, 0], [q.x1, q.y0, q.h], [q.x1, q.y1, q.h]]);
      const top = pts([[q.x0, q.y0, q.h], [q.x1, q.y0, q.h], [q.x1, q.y1, q.h], [q.x0, q.y1, q.h]]);
      el('polygon', { class: 'front', points: front, fill: 'url(#front-' + q.h + ')' }, g);
      el('polygon', { class: 'right', points: right, fill: 'url(#right-' + q.h + ')' }, g);
      el('polygon', { class: 'top', points: top, fill: 'url(#top-' + q.h + ')' }, g);
      el('polygon', { class: 'edge', points: front }, g);
      el('polygon', { class: 'edge', points: right }, g);
      el('polygon', { class: 'edge', points: top }, g);
      el('polyline', { class: 'edge-hi', points: pts([[q.x0, q.y1, q.h], [q.x0, q.y0, q.h], [q.x1, q.y0, q.h]]) }, g);

      const hl = proj(q.xc, q.y1, q.h / 2);
      const ht = el('text', { class: 'hgt', x: hl[0], y: hl[1] + 3.5, 'text-anchor': 'middle' }, g);
      ht.textContent = q.h + ' mm';

      const nl = proj(q.x0 + 0.13, q.y0 + 0.2, q.h);
      el('text', { class: 'num', x: nl[0], y: nl[1] + 3 }, g).textContent = b;

      const c = proj(q.xc, q.yc, q.h);
      const cx = c[0] - 3, cy = c[1] - 3;
      const corner = proj(q.x1 - 0.2, q.y0 + 0.3, q.h);
      const tag = proj(q.xc, q.y1 - 0.1, q.h);
      if (b === F.start) {
        drawFlag(g, corner[0], corner[1]);
        el('text', { class: 'tag', x: tag[0], y: tag[1], 'text-anchor': 'middle' }, g).textContent = 'Start';
      } else if (F.exits.includes(b)) {
        drawGate(g, corner[0], corner[1]);
        el('text', { class: 'tag', x: tag[0], y: tag[1], 'text-anchor': 'middle' }, g).textContent = 'Exit';
      }

      if (p.fake === b) drawFake(g, cx, cy);
      const bit = p.r2.indexOf(b);
      if (bit >= 0 && !(state.collected & (1 << bit))) drawScroll(g, cx, cy);

      if (fakeMode && forbidden) el('polygon', { class: 'forbid', points: top, fill: 'url(#hatch)' }, g);
    }
  }

  // ------------------------------------------------------------------ status and controls
  const statusEl = $('status');
  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }
  function hint() {
    const p = state.placement;
    const needFake = p.fake === null;
    const needR2 = F.r2Count - p.r2.length;
    if (!needFake && needR2 === 0) return 'Everything is placed. Press Solve.';
    const bits = [];
    if (needFake) bits.push('the Fake KFS');
    if (needR2 > 0) bits.push(needR2 + ' more R2 KFS');
    return 'Still to place: ' + bits.join(' and ') + '.';
  }
  function updateControls() {
    const p = state.placement;
    $('count-fake').textContent = (p.fake === null ? 0 : 1) + '/1';
    $('count-r2').textContent = p.r2.length + '/' + F.r2Count;
    $('btn-solve').disabled = !S.isComplete(F, p);
  }

  // ------------------------------------------------------------------ placement
  function resetResults() {
    stopAnim();
    state.results = null;
    state.collected = 0;
    routeLayer.replaceChildren();
    robot.setAttribute('visibility', 'hidden');
    $('playback').hidden = true;
    const box = $('results');
    box.replaceChildren();
    box.insertAdjacentHTML('beforeend',
      '<div class="empty" id="empty"><p class="empty-title">Nothing planned yet.</p>' +
      '<p>Place the Fake KFS and four R2 KFS on the field, or press Randomize, then Solve. ' +
      'The Fake KFS cannot go on blocks 1, 2 or 3.</p></div>');
  }

  function changed(msg, kind) {
    const hadResults = state.results !== null;
    if (hadResults) resetResults();
    renderBlocks();
    updateControls();
    setStatus(msg ? msg + ' ' + hint() : hint(), kind);
  }

  function refuse(b, msg) {
    const g = blocksLayer.querySelector('.block[data-b="' + b + '"]');
    if (g) {
      g.classList.remove('refuse');
      void g.getBoundingClientRect();
      g.classList.add('refuse');
      setTimeout(() => g.classList.remove('refuse'), 700);
    }
    setStatus(msg, 'warn');
  }

  function onBlock(b) {
    const p = state.placement;
    if (p.fake === b) { p.fake = null; return changed('Removed the Fake KFS from block ' + b + '.'); }
    const i = p.r2.indexOf(b);
    if (i >= 0) { p.r2.splice(i, 1); return changed('Removed an R2 KFS from block ' + b + '.'); }
    if (state.mode === 'fake') {
      const chk = S.canPlaceFake(F, b);
      if (!chk.ok) return refuse(b, chk.reason);
      const moved = p.fake !== null;
      p.fake = b;
      return changed(moved ? 'Moved the Fake KFS to block ' + b + '.' : 'Fake KFS on block ' + b + '.');
    }
    if (p.r2.length >= F.r2Count) return refuse(b, 'All ' + F.r2Count + ' R2 KFS are already placed. Click one to remove it first.');
    p.r2.push(b);
    return changed('R2 KFS on block ' + b + '.');
  }

  svg.addEventListener('click', (e) => {
    const g = e.target.closest('.block');
    if (g) onBlock(Number(g.dataset.b));
  });
  svg.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const g = e.target.closest && e.target.closest('.block');
    if (!g) return;
    e.preventDefault();
    const b = Number(g.dataset.b);
    onBlock(b);
    const again = blocksLayer.querySelector('.block[data-b="' + b + '"]');
    if (again) again.focus();
  });

  document.querySelectorAll('.mode').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      document.querySelectorAll('.mode').forEach((o) => {
        const on = o === btn;
        o.classList.toggle('is-on', on);
        o.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      renderBlocks();
      setStatus(state.mode === 'fake'
        ? 'Placing the Fake KFS. Blocks 1, 2 and 3 are hatched because it may not go there.'
        : 'Placing R2 KFS. Click a marked block to clear it.');
    });
  });
  $('btn-random').addEventListener('click', () => {
    state.placement = S.randomPlacement(F);
    changed('Random placement made.', 'good');
  });
  $('btn-clear').addEventListener('click', () => {
    state.placement = { fake: null, r2: [] };
    changed('Field cleared.');
  });
  $('btn-solve').addEventListener('click', solve);

  // ------------------------------------------------------------------ solving
  function solve() {
    if (!S.isComplete(F, state.placement)) return;
    const p = { fake: state.placement.fake, r2: state.placement.r2.slice() };
    const bfs = S.bfs(F, p);
    const astar = S.astar(F, p);
    const ucs = S.ucs(F, p);
    state.results = { placement: p, bfs, ucs, astar, cmp: S.compare(bfs, astar) };
    renderResults();
    if (astar.found || bfs.found) {
      setStatus('Solved. BFS, UCS and A* ran on this placement.', 'good');
      setRoute(astar.found ? 'astar' : 'bfs');
    } else {
      setStatus('No route exists for this placement.', 'warn');
    }
  }

  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

  function chips(res) {
    return res.path.map((b, i) => {
      const cls = i === 0 ? ' first' : i === res.path.length - 1 ? ' exit' : '';
      return (i ? '<span class="arrow" aria-hidden="true">&rsaquo;</span>' : '') + '<span class="chip' + cls + '">' + b + '</span>';
    }).join('');
  }

  function routeCard(res, key, title, sub) {
    if (!res.found) {
      return '<article class="route ' + key + '"><h3>' + title + '</h3><p class="sub">' + sub + '</p>' +
        '<p class="noroute">No route found. ' + res.reason + '</p></article>';
    }
    return '<article class="route ' + key + '"><h3>' + title + '</h3><p class="sub">' + sub + '</p>' +
      '<div class="chips" aria-label="Blocks visited">' + chips(res) + '</div>' +
      '<ul class="facts"><li><b>' + res.moves + '</b>moves</li><li><b>' + res.cost + '</b>seconds</li>' +
      '<li>exit <b>' + res.exit + '</b></li><li>' + res.expanded + ' states expanded</li></ul></article>';
  }

  function ucsNote(r) {
    if (!r.ucs.found || !r.astar.found) return '';
    return '<p>UCS reaches the same cost as A* (<b>' + r.ucs.cost + ' s</b>) but expands ' + r.ucs.expanded +
      ' states against ' + r.astar.expanded + ' for A*, because it has no heuristic to steer it.</p>';
  }

  function verdictHtml(r) {
    const { bfs, astar, cmp } = r;
    if (!bfs.found && !astar.found) {
      return '<div class="verdict bad"><h3>No route exists for this placement</h3><p>' + astar.reason +
        '</p><p>All searches finished and found nothing, so there is no route to animate.</p></div>';
    }
    if (cmp.samePath) {
      return '<div class="verdict same"><h3>BFS and A* chose the same route</h3><p>' + plural(astar.moves, 'move') +
        ', <b>' + astar.cost + ' s</b>, leaving by block <b>' + astar.exit + '</b>. For this placement the route with the fewest moves is also the cheapest.</p>' + ucsNote(r) + '</div>';
    }
    let head;
    if (cmp.costDiff > 0) head = 'A* saves ' + cmp.costDiff + ' seconds';
    else head = 'Different routes, same cost';
    let body = '<p>BFS: ' + plural(bfs.moves, 'move') + ', <b>' + bfs.cost + ' s</b>, exit ' + bfs.exit +
      '. A*: ' + plural(astar.moves, 'move') + ', <b>' + astar.cost + ' s</b>, exit ' + astar.exit + '.</p>';
    body += cmp.sameExit
      ? '<p>Both leave by block ' + astar.exit + ', but along different paths.</p>'
      : '<p>They leave by <b>different exits</b>: BFS by block ' + bfs.exit + ', A* by block ' + astar.exit + '.</p>';
    if (cmp.moveDiff > 0) body += '<p>A* takes ' + plural(cmp.moveDiff, 'extra move') + ' to avoid slow climbs and turns. BFS never looks at seconds, only at move count.</p>';
    else if (cmp.moveDiff === 0 && cmp.costDiff > 0) body += '<p>Same number of moves, but A* picks the one with fewer turns and climbs.</p>';
    return '<div class="verdict"><h3>' + head + '</h3>' + body + ucsNote(r) + '</div>';
  }

  function renderResults() {
    const r = state.results;
    const box = $('results');
    box.replaceChildren();
    box.insertAdjacentHTML('beforeend',
      verdictHtml(r) +
      '<div class="routes">' +
      routeCard(r.bfs, 'bfs', 'Breadth-first search', 'Fewest moves, blind to seconds') +
      routeCard(r.astar, 'astar', 'A*', 'Fewest seconds, guided by the heuristic') +
      routeCard(r.ucs, 'ucs', 'Uniform-cost search', 'Fewest seconds, no heuristic') +
      '</div><div class="steps" id="steps"></div><div class="steps why" id="why"></div>');
  }

  function renderSteps(key) {
    const res = state.results[key];
    const name = { astar: 'A*', bfs: 'BFS', ucs: 'UCS' }[key];
    let rows = '<tr data-i="0"><td>0</td><td>Start on block ' + F.start + '</td><td>' + S.DIR_NAMES[F.startHeading] +
      '</td><td>&ndash;</td><td>&ndash;</td><td>0</td><td class="note">' +
      (startMask() ? 'R2 KFS on the start block' : '') + '</td></tr>';
    let climb = 0, turn = 0;
    res.steps.forEach((st, i) => {
      climb += st.climb;
      turn += st.turn;
      const notes = [];
      if (st.picked) notes.push('R2 KFS picked (' + S.popcount(st.maskAfter) + ' held)');
      if (i === res.steps.length - 1) notes.push('Exit reached');
      rows += '<tr data-i="' + (i + 1) + '"><td>' + (i + 1) + '</td><td>' + st.from + ' &rarr; ' + st.to + '</td><td>' + st.dirName +
        '</td><td>' + st.climb + '</td><td>' + st.turn + '</td><td>' + st.total + '</td><td class="note">' + notes.join(', ') + '</td></tr>';
    });
    $('steps').innerHTML = '<h3>Move by move: ' + name + ' route</h3><div class="table-wrap"><table>' +
      '<thead><tr><th>#</th><th>Move</th><th>Heading</th><th>Climb (s)</th><th>Turn (s)</th><th>Running total (s)</th><th>Note</th></tr></thead>' +
      '<tbody>' + rows + '</tbody><tfoot><tr><td colspan="3">Total</td><td>' + climb + '</td><td>' + turn +
      '</td><td>' + res.cost + '</td><td></td></tr></tfoot></table></div>';
    $('steps').dataset.route = key;
    renderWhy(key);
  }

  function renderWhy(key) {
    const name = { astar: 'A*', bfs: 'BFS', ucs: 'UCS' }[key];
    const trace = S.explainRoute(F, state.results.placement, state.results[key], key);
    const cap = {
      bfs: 'BFS ranks moves by how many moves the whole route needs. Seconds play no part.',
      ucs: 'UCS ranks moves by seconds spent so far (g). It has no idea where the exits are.',
      astar: 'A* ranks moves by f = g + h, the seconds so far plus an optimistic estimate of what is left. Best total is the real cheapest finish, which f never exceeds.',
    }[key];
    const cols = {
      bfs: ['Moves so far', 'Best total (moves)'],
      ucs: ['Cost of move (s)', 'g (s)', 'Best total (s)'],
      astar: ['Cost of move (s)', 'g (s)', 'h (s)', 'f (s)', 'Best total (s)'],
    }[key];
    let rows = '';
    trace.forEach((t) => {
      t.candidates.forEach((c) => {
        const cells = key === 'bfs'
          ? [c.moves, c.total]
          : key === 'ucs' ? [c.moveCost, c.g, c.total] : [c.moveCost, c.g, c.h, c.f, c.total];
        const extra = c.total - t.best;
        const verdict = c.chosen ? 'Picked' : extra > 0 ? 'Rejected, +' + extra + ' ' + t.unit : 'Tied, not picked';
        rows += '<tr class="' + (c.chosen ? 'pick ' + key : '') + '"><td>' + t.step + '</td><td>' + t.from + ' &rarr; ' + c.to +
          (c.picks ? ' (R2 KFS)' : '') + '</td><td>' + c.dirName + '</td>' +
          cells.map((v) => '<td>' + v + '</td>').join('') + '<td>' + verdict + '</td></tr>';
      });
      rows += '<tr class="reason"><td colspan="' + (4 + cols.length) + '">' + t.reason + '</td></tr>';
    });
    $('why').innerHTML = '<h3>Why each move: ' + name + '</h3><p class="sub">' + cap + '</p><div class="table-wrap"><table class="why-table">' +
      '<thead><tr><th>Step</th><th>Option</th><th>Heading</th>' + cols.map((c) => '<th>' + c + '</th>').join('') +
      '<th>Decision</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  // ------------------------------------------------------------------ route + animation
  function drawRoute(res, key) {
    routeLayer.replaceChildren();
    const points = res.path.map((b) => { const a = anchor(b); return a[0].toFixed(1) + ',' + (a[1] - 2).toFixed(1); });
    el('polyline', { class: 'route-line ' + key, points: points.join(' ') }, routeLayer);
  }

  function setRoute(key) {
    const res = state.results[key];
    if (!res || !res.found) return;
    state.route = key;
    document.querySelectorAll('.seg button').forEach((b) => {
      const on = b.dataset.route === key;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    $('playback').hidden = false;
    renderSteps(key);
    drawRoute(res, key);
    buildTimeline(res);
    anim.t = 0;
    anim.done = -1;
    applyPose();
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { pauseAnim(); } else { playAnim(); }
  }
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    if (state.results) setRoute(b.dataset.route);
  }));

  function buildTimeline(res) {
    const segs = [];
    let t = 0;
    let heading = S.startHeadingIndex;
    let ang = ANGLE[heading];
    let pos = anchor(F.start);
    res.steps.forEach((st, i) => {
      if (st.dir !== heading) {
        const delta = mod(st.dir - heading, 4);
        const target = ANGLE[st.dir];
        const a1 = delta === 3 ? ang - mod(ang - target, 360) : ang + mod(target - ang, 360);
        const dur = delta === 2 ? 640 : 380;
        segs.push({ type: 'turn', start: t, dur, pos, a0: ang, a1 });
        t += dur;
        ang = a1;
        heading = st.dir;
      }
      const to = anchor(st.to);
      segs.push({ type: 'move', start: t, dur: 720, from: pos, to, ang, step: i + 1 });
      t += 720;
      pos = to;
    });
    anim.res = res;
    anim.segs = segs;
    anim.total = t + 700;
  }

  const ease = (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);

  function applyPose() {
    if (!anim.res) return;
    let pos = anchor(F.start);
    let ang = ANGLE[S.startHeadingIndex];
    let hop = 0;
    let done = 0;
    for (const s of anim.segs) {
      const end = s.start + s.dur;
      if (anim.t >= end) {
        if (s.type === 'move') { pos = s.to; ang = s.ang; done = s.step; } else { ang = s.a1; }
        continue;
      }
      if (anim.t < s.start) break;
      const u = ease((anim.t - s.start) / s.dur);
      if (s.type === 'turn') { pos = s.pos; ang = s.a0 + (s.a1 - s.a0) * u; }
      else {
        pos = [s.from[0] + (s.to[0] - s.from[0]) * u, s.from[1] + (s.to[1] - s.from[1]) * u];
        ang = s.ang;
        hop = Math.sin(u * Math.PI) * 8;
      }
      break;
    }
    robot.setAttribute('transform', 'translate(' + pos[0].toFixed(1) + ',' + (pos[1] - 16 - hop).toFixed(1) + ')');
    robotArrow.setAttribute('transform', 'rotate(' + ang.toFixed(1) + ')');
    robot.setAttribute('visibility', 'visible');
    if (done !== anim.done) { anim.done = done; onProgress(done); }
  }

  function onProgress(done) {
    const res = anim.res;
    const mask = done === 0 ? startMask() : res.steps[done - 1].maskAfter;
    if (mask !== state.collected) { state.collected = mask; renderBlocks(); }
    const at = done === 0 ? F.start : res.steps[done - 1].to;
    $('held').textContent = 'On block ' + at + ', holding ' + S.popcount(mask) + ' of ' + S.R2_REQUIRED + ' scrolls needed';
    document.querySelectorAll('#steps tbody tr').forEach((tr) => {
      const i = Number(tr.dataset.i);
      tr.classList.toggle('current', i === done);
      tr.classList.toggle('bfs', state.route === 'bfs');
      tr.classList.toggle('ucs', state.route === 'ucs');
      tr.classList.toggle('done', i < done);
    });
  }

  function tick(now) {
    if (!anim.playing) return;
    anim.t = Math.min(anim.t + (now - anim.last), anim.total);
    anim.last = now;
    applyPose();
    if (anim.t >= anim.total) { pauseAnim(); return; }
    anim.raf = requestAnimationFrame(tick);
  }
  function playAnim() {
    if (!anim.res) return;
    if (anim.t >= anim.total) { anim.t = 0; anim.done = -1; }
    anim.playing = true;
    anim.last = performance.now();
    $('btn-play').textContent = 'Pause';
    cancelAnimationFrame(anim.raf);
    anim.raf = requestAnimationFrame(tick);
  }
  function pauseAnim() {
    anim.playing = false;
    cancelAnimationFrame(anim.raf);
    $('btn-play').textContent = 'Play';
  }
  function stopAnim() {
    pauseAnim();
    anim.res = null;
    anim.segs = [];
    anim.done = -1;
  }
  $('btn-play').addEventListener('click', () => (anim.playing ? pauseAnim() : playAnim()));
  $('btn-replay').addEventListener('click', () => {
    if (!anim.res) return;
    anim.t = 0;
    anim.done = -1;
    applyPose();
    playAnim();
  });

  // ------------------------------------------------------------------ bamboo backdrop
  function drawForest() {
    const host = $('forest');
    const root = el('svg', { viewBox: '0 0 1000 800', preserveAspectRatio: 'xMidYMid slice' });
    const d = el('defs', {}, root);
    const g = el('linearGradient', { id: 'stalk', x1: 0, x2: 1, y1: 0, y2: 0 }, d);
    el('stop', { offset: '0', 'stop-color': '#0b1a12' }, g);
    el('stop', { offset: '0.45', 'stop-color': '#2b4a33' }, g);
    el('stop', { offset: '1', 'stop-color': '#0b1a12' }, g);
    const mist = el('linearGradient', { id: 'mist', x1: 0, x2: 0, y1: 0, y2: 1 }, d);
    el('stop', { offset: '0', 'stop-color': '#0a120e', 'stop-opacity': 0.8 }, mist);
    el('stop', { offset: '0.55', 'stop-color': '#0a120e', 'stop-opacity': 0 }, mist);
    el('stop', { offset: '1', 'stop-color': '#0a120e', 'stop-opacity': 0.75 }, mist);
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 17; i++) {
      const x = rnd() * 1000, w = 8 + rnd() * 20, op = 0.07 + rnd() * 0.15;
      const sg = el('g', { opacity: op.toFixed(2) }, root);
      el('rect', { x, y: -10, width: w, height: 830, fill: 'url(#stalk)' }, sg);
      for (let y = 40 + rnd() * 60; y < 800; y += 90 + rnd() * 80) {
        el('rect', { x: x - 1.5, y, width: w + 3, height: 3.5, fill: '#4c7a55' }, sg);
      }
    }
    el('rect', { width: 1000, height: 800, fill: 'url(#mist)' }, root);
    host.appendChild(root);
  }

  // ------------------------------------------------------------------ boot
  drawForest();
  renderBlocks();
  updateControls();
  setStatus('Placing the Fake KFS. Blocks 1, 2 and 3 are hatched because it may not go there. ' + hint());
})();
