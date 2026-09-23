/**
 * A text CRDT based on RGA (Replicated Growable Array), implemented as a
 * proper ordered TREE rather than a flat linked list with ad-hoc scanning.
 *
 * Why a tree and not a simpler flat-list scan: an earlier version of this
 * file used a flat linked list where inserting a new node scanned forward
 * "while the next node shares our origin and has a higher ID". That looks
 * reasonable and passes small hand-written tests, but it has a real bug —
 * a documented class of anomaly (see the "Fugue" CRDT paper) where
 * concurrent inserts under a shared ancestor can end up in a different
 * final order depending on the order operations are received, because a
 * flat scan doesn't correctly keep a node's descendants contiguous with it
 * when an unrelated sibling is inserted nearby. A 100-trial randomized
 * convergence test caught this — it's the kind of bug that's easy to miss
 * with only example-based tests.
 *
 * The fix: model the document as a tree. Every node has an explicit
 * parent (its "origin" — the node it was inserted immediately after) and
 * a list of children, kept sorted by ID (descending — higher ID = higher
 * priority = appears first). The visible text is a pre-order traversal:
 * visit a node, then IMMEDIATELY recurse into all of its children before
 * moving to its next sibling. This guarantees a node's descendants always
 * stay contiguous with it, regardless of what order operations arrive in
 * — which is exactly the property a flat scan couldn't guarantee.
 *
 * Concurrent inserts under the same parent are ordered deterministically
 * by ID comparison (see `compareIds`), so every replica that applies the
 * same set of operations — in ANY order, respecting only causal
 * dependencies — converges to the identical final sequence. This is
 * verified with a randomized stress test in the test suite, not just
 * asserted.
 *
 * Out-of-order network delivery is handled by buffering an operation
 * whose causal dependency (its parent node, for inserts; its target
 * node, for deletes) hasn't arrived yet, flushing once it does.
 */

function compareIds(a, b) {
  const [aCounterStr, aSite] = a.split("@");
  const [bCounterStr, bSite] = b.split("@");
  const aCounter = parseInt(aCounterStr, 10);
  const bCounter = parseInt(bCounterStr, 10);
  if (aCounter !== bCounter) return aCounter - bCounter;
  if (aSite < bSite) return -1;
  if (aSite > bSite) return 1;
  return 0;
}

class RGA {
  constructor(siteId) {
    if (!siteId) throw new Error("RGA requires a unique siteId");
    this.siteId = siteId;
    this.counter = 0;
    this.nodes = new Map(); // id -> { id, char, deleted, children: [id, ...] sorted desc }
    this.root = { children: [] }; // virtual root — represents "start of document"
    this.pending = new Map(); // dependencyId -> [ops waiting on it]
  }

  _nextId() {
    this.counter += 1;
    return `${this.counter}@${this.siteId}`;
  }

  _getNode(id) {
    return id === null ? this.root : this.nodes.get(id);
  }

  /** Inserts `childId` into `parent.children`, maintaining the descending
   * sort-by-id invariant that determines sibling order. */
  _insertChildSorted(parent, childId) {
    const children = parent.children;
    let i = 0;
    while (i < children.length && compareIds(children[i], childId) > 0) i++;
    children.splice(i, 0, childId);
  }

  /** Pre-order traversal: every node id in document order (including
   * tombstoned/deleted nodes — callers filter those out as needed). */
  _traverseIds() {
    const result = [];
    const visit = (node) => {
      for (const childId of node.children) {
        result.push(childId);
        visit(this.nodes.get(childId));
      }
    };
    visit(this.root);
    return result;
  }

  /** Visible (non-tombstoned) text, in document order. */
  toText() {
    let text = "";
    for (const id of this._traverseIds()) {
      const node = this.nodes.get(id);
      if (!node.deleted) text += node.char;
    }
    return text;
  }

  /** Total node count including tombstones — useful for tests/metrics. */
  size() {
    return this.nodes.size;
  }

  /** Returns the id of the visible node at `index`, or null if index < 0
   * or out of range. */
  _idAtVisiblePosition(index) {
    if (index < 0) return null;
    let i = -1;
    for (const id of this._traverseIds()) {
      const node = this.nodes.get(id);
      if (!node.deleted) {
        i += 1;
        if (i === index) return id;
      }
    }
    return null;
  }

  /** Insert `char` at visible position `index` (0-based). Returns the
   * operation to broadcast to other replicas. */
  localInsert(index, char) {
    const originId = this._idAtVisiblePosition(index - 1);
    const id = this._nextId();
    const op = { type: "insert", id, char, originId };
    this._applyInsert(op);
    return op;
  }

  /** Delete the visible character at `index`. Returns the operation to
   * broadcast, or null if index is out of range (nothing to delete). */
  localDelete(index) {
    const id = this._idAtVisiblePosition(index);
    if (id === null) return null;
    const op = { type: "delete", id };
    this._applyDelete(op);
    return op;
  }

  /** Apply an operation received from another replica. Idempotent — safe
   * to apply the same op twice. Handles out-of-order delivery via
   * buffering on missing causal dependencies. */
  applyRemote(op) {
    if (op.type === "insert") {
      if (this.nodes.has(op.id)) return; // already applied
      if (op.originId !== null && !this.nodes.has(op.originId)) {
        this._buffer(op.originId, op);
        return;
      }
      this._applyInsert(op);
      this._flush(op.id);
    } else {
      if (!this.nodes.has(op.id)) {
        this._buffer(op.id, op);
        return;
      }
      this._applyDelete(op);
    }
  }

  _buffer(waitingOnId, op) {
    if (!this.pending.has(waitingOnId)) this.pending.set(waitingOnId, []);
    this.pending.get(waitingOnId).push(op);
  }

  _flush(readyId) {
    const waiting = this.pending.get(readyId);
    if (!waiting) return;
    this.pending.delete(readyId);
    for (const op of waiting) this.applyRemote(op);
  }

  _applyInsert({ id, char, originId }) {
    if (this.nodes.has(id)) return; // idempotent
    const node = { id, char, deleted: false, children: [] };
    this.nodes.set(id, node);
    const parent = this._getNode(originId);
    this._insertChildSorted(parent, id);
  }

  _applyDelete({ id }) {
    const node = this.nodes.get(id);
    if (node) node.deleted = true; // idempotent — already-deleted is a no-op
  }
}

// UMD export: works as a CommonJS module (Node/Jest) and as a plain
// browser <script> global (window.RGA / window.RGAUtils).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { RGA, compareIds };
} else if (typeof window !== "undefined") {
  window.RGA = RGA;
  window.compareIds = compareIds;
}
