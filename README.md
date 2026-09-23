# CollabEdit ✍️

> A real-time collaborative text editor powered by a **from-scratch RGA CRDT** — the same class of algorithm behind Google Docs and VS Code Live Share. No "last write wins", no lock contention: concurrent edits from multiple users always converge to an identical document, even over an unreliable, out-of-order network.

![CI](https://github.com/YOUR_USERNAME/collab-editor/actions/workflows/ci.yml/badge.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)
![License](https://img.shields.io/badge/license-MIT-green)

## Why this is the hardest project in this portfolio

Naively syncing text between clients (e.g. diffing whole strings, or using numeric character indices) breaks the instant two people type at the same time — indices shift under you mid-edit, and there's no principled way to merge two people's changes without losing one of them. This project implements a proper **Conflict-free Replicated Data Type (CRDT)**: every character gets a globally unique, causally-ordered ID, and documents are modeled as a tree where each character's position is defined *relative to its neighbor*, not by a numeric index that goes stale.

**This implementation went through a real bug-and-fix cycle, not just a first-try success:** an initial flat-linked-list version of the algorithm passed 18 hand-written example tests but failed a 100-trial randomized convergence stress test, revealing a genuine correctness bug (a documented anomaly class from the CRDT literature — see `src/crdt.js` for the full writeup). It was fixed by switching to a proper tree structure, after which **all 100 trials (and an extra 500-trial, 5-site stress run) converge with zero failures.** That process — write the algorithm, write a test rigorous enough to catch subtle bugs, find a real bug, understand *why*, fix it properly — is exactly what makes this project worth including on a resume over a simpler one that "just works" on the happy path.

## Live proof, not just unit tests

Beyond the test suite, `tests/server.test.js` spins up the **real WebSocket server** and connects **real WebSocket clients** to verify two users' concurrent edits actually converge over the network — not mocked.

## Architecture

```
collab-editor/
├── src/
│   └── crdt.js          # the RGA CRDT — the core algorithm, framework-agnostic
├── server/
│   ├── wsServer.js        # WebSocket relay: broadcasts ops, replays history to new joiners
│   └── index.js              # HTTP server (serves the frontend + health check) + WS server
├── public/
│   ├── index.html
│   ├── style.css
│   ├── crdt.js                # same CRDT code, browser-loadable copy (UMD export)
│   └── app.js                   # textarea sync: diffs edits into CRDT ops, applies remote ops
└── tests/
    ├── crdt.test.js              # 19 tests, including a 100-trial randomized convergence stress test
    └── server.test.js              # 6 tests — real WebSocket clients against the real server
```

## Quick Start

```bash
npm install
npm start
```

Visit `http://localhost:4000` in two different browser tabs (or two different browsers) with the same document name — type in one, watch it appear in the other in real time. Try typing in *both* tabs at the same time to see concurrent edits converge correctly.

### Docker

```bash
docker build -t collab-editor .
docker run -p 4000:4000 collab-editor
```

## Running Tests

```bash
npm test
```

25 tests total. The CRDT tests include the randomized stress test described above; run it standalone for extra confidence:

```bash
node -e "require('./tests/crdt.test.js')"  # or just run the full suite, it's included
```

## How it works

1. **Every character gets a unique ID**: `{counter}@{siteId}`, where `siteId` is unique per browser tab/session and `counter` increments locally. IDs have a total order (compare counter, then siteId as a tiebreaker).
2. **The document is a tree**, not a flat string. Each character node has a parent (the character it was inserted immediately after — its "origin") and a sorted list of children.
3. **The visible text is a pre-order traversal** of this tree: visit a node, then immediately recurse into its children before moving to the next sibling. This is what guarantees a node's descendants always stay contiguous with it, however operations arrive.
4. **Deletes are tombstones** — marked deleted, not removed — so a concurrent operation can never reference a node that's vanished.
5. **Out-of-order delivery is buffered**: if an operation's causal dependency (its parent node, or its delete target) hasn't arrived yet, it waits in a per-dependency queue and is replayed once that dependency shows up.
6. **The server is deliberately dumb**: it never runs any CRDT logic. It just stores each document's operation history (so late joiners can replay it) and relays new ops to everyone else. All conflict resolution happens client-side — that's the point of a CRDT.

## Known limitations (roadmap)

- **O(n) per edit**: `toText()` and position lookups traverse the whole tree. Fine for a document-sized demo; a production version would use a balanced structure (e.g. a skip list or B-tree over CRDT nodes) for O(log n).
- **Cursor position on remote updates** is approximated by character offset, not anchored to a specific CRDT node. A polished editor would track cursors as CRDT references so they don't drift when someone edits earlier in the document.
- **No persistence** — the op history lives in server memory only; restarting the server loses all documents. Swapping in a database for the ops log is a natural next step.
- **No syntax highlighting / language support** — it's a plain `<textarea>`; wiring the same CRDT sync into CodeMirror or Monaco would make this a genuine code editor.

## License

MIT — see [LICENSE](LICENSE).
