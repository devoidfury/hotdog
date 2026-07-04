// http-app-demo.js — Example usage of createHttpApp() and serveStatic().
//
// Demonstrates all features of the Bun-native Express-like middleware framework:
// - Middleware chaining with app.use()
// - Route registration with app.get(), app.post(), etc.
// - Path prefix mounting
// - App nesting (mount one app inside another)
// - req.locals for passing data between middleware
// - Error handling
// - 404 fallback
// - Static file serving
//
// Run with: bun examples/http-app-demo.js
// Then visit http://localhost:8000

import { createHttpApp } from "../src/utils/http-app.js"
import { serveStatic } from "../src/utils/static-files.js"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const port = 8000

const app = createHttpApp()

// ── Logger middleware ──────────────────────────────────────────────────────
// Logs the response status for each request
app.use(function (req, res, next) {
  const start = Date.now()
  // We can't hook res.end like in Node, but we can use a wrapper approach
  // Instead, we log after next() returns (which means the response was sent)
  next()
  // Note: in the sync middleware model, next() doesn't return until the
  // full chain is processed, so we can log here
  console.log(`${req.method} ${req.path} - ${res.statusCode} (${Date.now() - start}ms)`)
})

// ── locals middleware ──────────────────────────────────────────────────────
// Demonstrates req.locals for passing data between middleware
app.use(function (req, res, next) {
  req.locals.startTime = Date.now()
  req.locals.requestId = Math.random().toString(36).substring(2, 8)
  next()
})

// ── Basic route ────────────────────────────────────────────────────────────
app.get("/", function (req, res) {
  res.send("hello, world")
})

// ── Route with locals ──────────────────────────────────────────────────────
app.get("/info", function (req, res) {
  res.json({
    requestId: req.locals.requestId,
    elapsed: Date.now() - req.locals.startTime,
    path: req.path,
    method: req.method,
  })
})

// ── Static file serving ────────────────────────────────────────────────────
// Serves files from the examples directory under /static/
app.use(serveStatic({
  root: path.join(__dirname, ".."),
  prefix: "/static/",
  maxAgeSecs: 0, // No caching for demo
}))

// ── App nesting (mount a sub-app) ──────────────────────────────────────────
const subApp = createHttpApp()

subApp.get("/test", function (req, res) {
  res.send("hello from sub-app")
})

subApp.get("/nested-info", function (req, res) {
  res.json({
    path: req.path,
    baseUrl: req.baseUrl,
    originalUrl: req.originalUrl,
  })
})

app.use("/sub-app", subApp.handler)

// ── Middleware that can short-circuit ──────────────────────────────────────
function randomlyEndRouteMiddleware(req, res, next) {
  if (Math.random() * 2 | 0) {
    next()
  } else {
    res.status(200).send("ended early by middleware")
  }
}

app.get("/two", randomlyEndRouteMiddleware, function (req, res) {
  res.send("called next")
})

// ── Error handling ─────────────────────────────────────────────────────────
app.get("/error", function (req, res, next) {
  next(new Error("some error"))
})

// ── POST route example ─────────────────────────────────────────────────────
app.post("/echo", async function (req, res) {
  try {
    const body = await req.json()
    res.json({ echoed: body })
  } catch {
    res.status(400).json({ error: "Invalid JSON" })
  }
})

// ── Custom 404 handler ─────────────────────────────────────────────────────
app.setNotFoundHandler(function (req, res) {
  res.statusCode = 404
  res.json({
    error: "Not Found",
    message: `Cannot ${req.method} ${req.path}`,
    availableRoutes: ["/", "/info", "/two", "/error", "/echo", "/sub-app/test"],
  })
})

// ── Custom error handler ───────────────────────────────────────────────────
app.setErrorHandler(function (err, req, res) {
  console.error(`[ERROR] ${req.method} ${req.path}: ${err.message}`)
  res.statusCode = 500
  res.json({
    error: "Internal Server Error",
    message: err.message,
  })
})

// ── Start the server ───────────────────────────────────────────────────────
app.listen({ port, hostname: "0.0.0.0" })
console.log(`listening on port ${port}`)
console.log(`  GET  /             — hello world`)
console.log(`  GET  /info         — request info with locals`)
console.log(`  GET  /two          — random middleware short-circuit`)
console.log(`  GET  /error        — triggers error handler`)
console.log(`  POST /echo         — echo JSON body`)
console.log(`  GET  /sub-app/test — nested app route`)
console.log(`  GET  /static/...   — static file serving`)
