// Fake webapp for eval task 007-web-comment: POST /login exchanges known
// credentials for a token; POST /comments requires it as a Bearer header and
// appends the comment to ./comments.jsonl (checked from the workspace).
// Fixed port: serve tasks assume concurrency 1 (README).

import { appendFileSync } from "node:fs";

const PORT = 8732;
const USER = "grillmaster";
const PASS = "kielbasa-secret";

const tokens = new Set<string>();
let nextId = 1;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const path = new URL(req.url).pathname;

    if (path === "/healthz") return Response.json({ ok: true });

    if (path === "/") {
      return Response.json({
        name: "hotdog-journal",
        endpoints: {
          "POST /login": "json {username, password} -> {token}",
          "POST /comments": "json {text}, header Authorization: Bearer <token> -> {id}",
        },
      });
    }

    if (path === "/login" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { username?: unknown; password?: unknown } | null;
      if (!body || body.username !== USER || body.password !== PASS) {
        return Response.json({ error: "invalid credentials" }, { status: 401 });
      }
      const token = `tok-${nextId}-${Math.random().toString(36).slice(2, 10)}`;
      tokens.add(token);
      return Response.json({ token });
    }

    if (path === "/comments" && req.method === "POST") {
      const auth = req.headers.get("authorization") ?? "";
      if (!tokens.has(auth.replace(/^Bearer\s+/i, ""))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
      if (!body || typeof body.text !== "string" || !body.text.trim()) {
        return Response.json({ error: "body needs a non-empty {text}" }, { status: 400 });
      }
      const id = nextId++;
      appendFileSync("comments.jsonl", JSON.stringify({ id, user: USER, text: body.text }) + "\n");
      return Response.json({ id }, { status: 201 });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
});

console.log(`journal listening on http://127.0.0.1:${PORT}`);
void server;
