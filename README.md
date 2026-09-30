# Scroll Run

A route planner for a robot on a 12-block field. The robot starts on block 2 facing south, must pick up exactly two of four R2 KFS scrolls, must never touch the Fake KFS, and has to finish on block 10 or 12. The page runs three searches on the same placement and compares them:

- **BFS** finds the route with the fewest moves. It never looks at seconds.
- **UCS** (uniform-cost search) finds the route with the fewest seconds using the same real costs, but with no heuristic.
- **A\*** finds the route with the fewest seconds, using the real cost of climbing and turning, guided by a heuristic.

The point of the demo is the gap between the two.

**Live demo:** _add the GitHub Pages link here after deploying (see below)_

## The field

Blocks are numbered 1 to 12 in three columns and four rows, north at the top. Heights (mm) are real field data:

```
 1:400   2:200   3:400
 4:200   5:400   6:600
 7:400   8:600   9:400
10:200  11:400  12:200
```

Moves are orthogonal only. A move between two adjacent blocks is legal only when their height levels differ by at most one. The check runs on every edge in `buildGraph`, so it works on a field where it is not true. On this field every adjacent pair passes.

Start is block 2, exits are blocks 10 and 12. Block 11 is a normal block but never a valid finish.

## Markers

- **Fake KFS (one).** Landing on it is a failure, so its block is removed from the graph for that run. It cannot be placed on blocks 1, 2 or 3 (competition rule). The UI hatches those blocks in Fake mode and shakes the block with a message if you try.
- **R2 KFS (four).** Landing on one picks it up. The robot needs exactly two before it may exit.
- One marker per block. Clicking a block that already has a marker clears it. Solve stays disabled until the Fake KFS and all four R2 KFS are placed.

## Search

State is `(block, mask, heading)`. `mask` has one bit per R2 KFS, so which scrolls are held matters, and heading is part of the state because turning in place costs time.

Cost of a move = climb cost + turn cost.

| | seconds |
|---|---|
| Move to a higher block | 10 |
| Move to a lower block | 7 |
| Move to a block of equal height | 7 (not in the spec, never happens on this field) |
| Same direction | 0 |
| 90 degree turn | 5 |
| 180 degree reversal | 10 |

**BFS** searches on `(block, mask)` with a cost of 1 per move and ties broken by expanding neighbours in the order N, E, S, W. After it finishes, its path is scored with the real cost function for comparison only.

**UCS** searches on the full `(block, mask, heading)` state with real costs and h = 0. It is optimal, so it returns the same cost as A\*, but it expands more states.

**A\*** searches on the full state with real costs. The heuristic is

```
h = max(scrolls still needed, moves to nearest exit) * 7
```

where the move distance is an unweighted BFS from the exits, computed once per run. It is admissible because both terms are lower bounds on the remaining number of moves, so their max is too, and every move costs at least 7 seconds. It is also consistent. The reasoning is written next to the code in `algo.js`.

If no route exists, both searches finish and report why (for example, the exits are cut off, or fewer than two R2 KFS are reachable). On the real field with one Fake KFS every placement is solvable, because removing one block never disconnects the grid. The "no route" path is exercised by the tests on hypothetical fields.

## Run it locally

No build step and no dependencies.

```
# open index.html directly, or serve the folder:
python -m http.server 8000
# then visit http://localhost:8000
```

Run the tests with Node 16 or newer:

```
node test.js
```

The tests check the cost function, the graph rules and the placement rules. They also compare A\* against an independent reference search and against Dijkstra (h = 0) on 400 random placements, confirm the heuristic never overestimates, and cover unsolvable fields.

## Files

| File | What it is |
|---|---|
| `index.html` | page structure |
| `style.css` | theme |
| `algo.js` | field, cost function, BFS, A\* (no DOM, also loaded by the tests) |
| `app.js` | rendering, placement, solving UI, animation |
| `test.js` | `node test.js` |

## Deploy (GitHub Pages)

The site is static, so any static host works. To publish on GitHub Pages:

1. Create a repository and push these files to the `main` branch, with `index.html` at the root.
2. In the repository go to **Settings, Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, branch `main`, folder `/ (root)`, and save.
4. After a minute the site is live at `https://<user>.github.io/<repo>/`. Put that link in the **Live demo** line above and in the course project README.

The page loads two fonts from Google Fonts. If they fail to load it falls back to system fonts.
