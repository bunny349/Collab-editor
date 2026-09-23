/**
 * Relays CRDT operations between connected clients. Deliberately dumb by
 * design: the server does NOT run any CRDT logic itself — it just stores
 * each document's operation history (so late joiners can replay it) and
 * broadcasts new ops to everyone else in the same document room. All
 * conflict resolution happens client-side via the RGA implementation,
 * which is the whole point of a CRDT — the server never needs to
 * understand the data model.
 */

const { WebSocketServer } = require("ws");
const { randomUUID } = require("crypto");

function createServer({ server } = {}) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  /** @type {Map<string, { ops: object[], clients: Set<import('ws').WebSocket> }>} */
  const documents = new Map();

  function getDocument(docId) {
    if (!documents.has(docId)) {
      documents.set(docId, { ops: [], clients: new Set() });
    }
    return documents.get(docId);
  }

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const docId = url.searchParams.get("doc") || "default";
    const siteId = url.searchParams.get("siteId") || randomUUID();

    const doc = getDocument(docId);
    doc.clients.add(ws);

    // Send full operation history so this client can rebuild the document
    // by replaying every op through its own local RGA instance.
    ws.send(JSON.stringify({ type: "history", ops: doc.ops, siteId }));
    broadcastPresence(doc);

    ws.on("message", (raw) => {
      let op;
      try {
        op = JSON.parse(raw.toString());
      } catch {
        return; // ignore malformed messages
      }
      doc.ops.push(op);
      for (const client of doc.clients) {
        if (client !== ws && client.readyState === client.OPEN) {
          client.send(JSON.stringify({ type: "op", op }));
        }
      }
    });

    ws.on("close", () => {
      doc.clients.delete(ws);
      broadcastPresence(doc);
      if (doc.clients.size === 0) {
        // Keep the ops history around briefly in memory for the demo;
        // a production version would persist to a database instead.
      }
    });
  });

  function broadcastPresence(doc) {
    const message = JSON.stringify({ type: "presence", count: doc.clients.size });
    for (const client of doc.clients) {
      if (client.readyState === client.OPEN) client.send(message);
    }
  }

  return { wss, documents };
}

module.exports = { createServer };
