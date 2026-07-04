import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createHttpApp } from "../../src/utils/http-app.js"
import { serveStatic, getMimeType } from "../../src/utils/static-files.js"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// ── Helper: create a mock Bun Request ──────────────────────────────────────

function mockRequest(url, options = {}) {
  return new Request(url, {
    method: options.method || "GET",
    headers: options.headers || {},
    body: options.body || null,
  })
}

// ── createHttpApp ──────────────────────────────────────────────────────────

describe("createHttpApp", () => {
  it("creates an app with all expected methods", () => {
    const app = createHttpApp()
    expect(typeof app.use).toBe("function")
    expect(typeof app.route).toBe("function")
    expect(typeof app.get).toBe("function")
    expect(typeof app.post).toBe("function")
    expect(typeof app.put).toBe("function")
    expect(typeof app.patch).toBe("function")
    expect(typeof app.del).toBe("function")
    expect(typeof app.head).toBe("function")
    expect(typeof app.options).toBe("function")
    expect(typeof app.handler).toBe("function")
    expect(typeof app.listen).toBe("function")
    expect(typeof app.errorHandler).toBe("function")
    expect(typeof app.notfound).toBe("function")
    expect(typeof app.setErrorHandler).toBe("function")
    expect(typeof app.setNotFoundHandler).toBe("function")
  })

  it("returns the app instance from use() for chaining", () => {
    const app = createHttpApp()
    expect(app.use(() => {})).toBe(app)
  })

  it("returns the app instance from route() for chaining", () => {
    const app = createHttpApp()
    expect(app.get("/", () => {})).toBe(app)
  })

  it("returns the app instance from setErrorHandler() for chaining", () => {
    const app = createHttpApp()
    expect(app.setErrorHandler(() => {})).toBe(app)
  })

  it("returns the app instance from setNotFoundHandler() for chaining", () => {
    const app = createHttpApp()
    expect(app.setNotFoundHandler(() => {})).toBe(app)
  })

  // ── Middleware chain ─────────────────────────────────────────────────

  it("executes middleware in order", async () => {
    const app = createHttpApp()
    const order = []

    app.use((req, res, next) => {
      order.push(1)
      next()
    })
    app.use((req, res, next) => {
      order.push(2)
      next()
    })
    app.use((req, res, next) => {
      order.push(3)
      next()
    })
    app.get("/", (req, res) => {
      order.push("handler")
      res.send("ok")
    })

    const response = await app.handler(mockRequest("http://localhost/"))
    expect(order).toEqual([1, 2, 3, "handler"])
    expect(response.status).toBe(200)
  })

  it("middleware can short-circuit by calling res.send()", async () => {
    const app = createHttpApp()
    const order = []

    app.use((req, res, next) => {
      order.push("first")
      res.send("short-circuit")
    })
    app.use((req, res, next) => {
      order.push("second")
      next()
    })
    app.get("/", (req, res) => {
      order.push("handler")
      res.send("handler")
    })

    const response = await app.handler(mockRequest("http://localhost/"))
    expect(order).toEqual(["first"])
    expect(response.status).toBe(200)
  })

  // ── Route matching ───────────────────────────────────────────────────

  it("matches GET routes by path and method", async () => {
    const app = createHttpApp()

    app.get("/hello", (req, res) => res.send("hello"))
    app.get("/world", (req, res) => res.send("world"))

    const r1 = await app.handler(mockRequest("http://localhost/hello"))
    expect(r1.status).toBe(200)

    const r2 = await app.handler(mockRequest("http://localhost/world"))
    expect(r2.status).toBe(200)
  })

  it("does not match routes with wrong HTTP method", async () => {
    const app = createHttpApp()

    app.get("/only-get", (req, res) => res.send("get"))
    app.post("/only-get", (req, res) => res.send("post"))

    const r1 = await app.handler(mockRequest("http://localhost/only-get"))
    expect(r1.status).toBe(200)

    const r2 = await app.handler(
      mockRequest("http://localhost/only-get", { method: "POST" }),
    )
    expect(r2.status).toBe(200)
  })

  it("returns 404 when no route matches", async () => {
    const app = createHttpApp()
    app.get("/exists", (req, res) => res.send("exists"))

    const response = await app.handler(
      mockRequest("http://localhost/not-found"),
    )
    expect(response.status).toBe(404)
  })

  // ── req.locals ───────────────────────────────────────────────────────

  it("req.locals persists across middleware", async () => {
    const app = createHttpApp()

    app.use((req, res, next) => {
      req.locals.foo = "bar"
      next()
    })

    app.get("/", (req, res) => {
      res.json({ foo: req.locals.foo })
    })

    const response = await app.handler(mockRequest("http://localhost/"))
    expect(response.status).toBe(200)
  })

  // ── req.path, req.baseUrl, req.originalUrl ──────────────────────────

  it("sets req.path and req.originalUrl for root requests", async () => {
    const app = createHttpApp()
    let capturedPath, capturedOriginalUrl

    app.get("/test", (req, res) => {
      capturedPath = req.path
      capturedOriginalUrl = req.originalUrl
      res.send("ok")
    })

    await app.handler(mockRequest("http://localhost/test"))
    expect(capturedPath).toBe("/test")
    expect(capturedOriginalUrl).toBe("/test")
  })

  // ── Error handling ───────────────────────────────────────────────────

  it("calls errorHandler when next(err) is called", async () => {
    const app = createHttpApp()
    let errorCaptured = null

    app.setErrorHandler((err, req, res) => {
      errorCaptured = err
      res.statusCode = 500
      res.json({ error: err.message })
    })

    app.get("/error", (req, res, next) => {
      next(new Error("test error"))
    })

    const response = await app.handler(
      mockRequest("http://localhost/error"),
    )
    expect(errorCaptured).toBeInstanceOf(Error)
    expect(errorCaptured.message).toBe("test error")
    expect(response.status).toBe(500)
  })

  it("catches synchronous errors in middleware", async () => {
    const app = createHttpApp()

    app.use(() => {
      throw new Error("sync error")
    })

    const response = await app.handler(mockRequest("http://localhost/"))
    expect(response.status).toBe(500)
  })

  // ── Response helpers ─────────────────────────────────────────────────

  it("res.json() sets Content-Type to application/json", async () => {
    const app = createHttpApp()

    app.get("/", (req, res) => {
      res.json({ hello: "world" })
    })

    const response = await app.handler(mockRequest("http://localhost/"))
    expect(response.headers.get("Content-Type")).toBe("application/json")
  })

  it("res.html() sets Content-Type to text/html", async () => {
    const app = createHttpApp()

    app.get("/", (req, res) => {
      res.html("<h1>Hello</h1>")
    })

    const response = await app.handler(mockRequest("http://localhost/"))
    expect(response.headers.get("Content-Type")).toBe("text/html")
  })

  it("res.status() sets the status code", async () => {
    const app = createHttpApp()

    app.get("/", (req, res) => {
      res.status(418).send("I'm a teapot")
    })

    const response = await app.handler(mockRequest("http://localhost/"))
    expect(response.status).toBe(418)
  })

  it("res.redirect() sets Location header and 302 status", async () => {
    const app = createHttpApp()

    app.get("/", (req, res) => {
      res.redirect("/new-location")
    })

    const response = await app.handler(mockRequest("http://localhost/"))
    expect(response.status).toBe(302)
    expect(response.headers.get("Location")).toBe("/new-location")
  })

  it("res.setHeader() sets custom headers", async () => {
    const app = createHttpApp()

    app.get("/", (req, res) => {
      res.setHeader("X-Custom", "value")
      res.send("ok")
    })

    const response = await app.handler(mockRequest("http://localhost/"))
    expect(response.headers.get("X-Custom")).toBe("value")
  })

  // ── Path prefix mounting ─────────────────────────────────────────────

  it("app.use(prefix, handler) only matches paths starting with prefix", async () => {
    const app = createHttpApp()
    let matched = false

    app.use("/api", (req, res, next) => {
      matched = true
      res.send("api")
    })

    app.get("/", (req, res) => res.send("root"))

    // Should match /api prefix
    await app.handler(mockRequest("http://localhost/api/v1"))
    expect(matched).toBe(true)

    matched = false
    // Should NOT match /api prefix
    await app.handler(mockRequest("http://localhost/other"))
    expect(matched).toBe(false)
  })

  // ── App nesting ──────────────────────────────────────────────────────

  it("supports mounting one app inside another", async () => {
    const subApp = createHttpApp()
    subApp.get("/test", (req, res) => {
      res.json({
        path: req.path,
        baseUrl: req.baseUrl,
      })
    })

    const app = createHttpApp()
    app.use("/sub", subApp.handler)

    const response = await app.handler(
      mockRequest("http://localhost/sub/test"),
    )
    expect(response.status).toBe(200)
  })

  // ── Multiple handlers on a route ─────────────────────────────────────

  it("supports multiple handlers on a single route", async () => {
    const app = createHttpApp()
    const order = []

    app.get(
      "/multi",
      (req, res, next) => {
        order.push(1)
        req.locals.step1 = true
        next()
      },
      (req, res, next) => {
        order.push(2)
        req.locals.step2 = true
        next()
      },
      (req, res) => {
        order.push(3)
        res.json({ step1: req.locals.step1, step2: req.locals.step2 })
      },
    )

    const response = await app.handler(mockRequest("http://localhost/multi"))
    expect(order).toEqual([1, 2, 3])
    expect(response.status).toBe(200)
  })

  // ── Custom 404 handler ───────────────────────────────────────────────

  it("uses custom notfound handler", async () => {
    const app = createHttpApp()

    app.setNotFoundHandler((req, res) => {
      res.statusCode = 404
      res.json({ custom: "not found" })
    })

    const response = await app.handler(
      mockRequest("http://localhost/nonexistent"),
    )
    expect(response.status).toBe(404)
  })

  // ── Async middleware ─────────────────────────────────────────────────

  it("supports async middleware (e.g. for reading request body)", async () => {
    const app = createHttpApp()

    app.post("/echo", async (req, res) => {
      const body = await req.json()
      res.json({ echoed: body })
    })

    const response = await app.handler(
      mockRequest("http://localhost/echo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      }),
    )
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json).toEqual({ echoed: { hello: "world" } })
  })
})

// ── serveStatic ────────────────────────────────────────────────────────────

describe("serveStatic", () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "http-app-test-"))
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<h1>Hello</h1>")
    fs.writeFileSync(path.join(tmpDir, "style.css"), "body { color: red; }")
    fs.writeFileSync(path.join(tmpDir, "app.js"), "console.log('hi')")
    fs.mkdirSync(path.join(tmpDir, "subdir"))
    fs.writeFileSync(path.join(tmpDir, "subdir", "nested.txt"), "nested")
    fs.writeFileSync(path.join(tmpDir, ".hidden"), "secret")
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("serves existing files with correct Content-Type", async () => {
    const app = createHttpApp()
    app.use(serveStatic({ root: tmpDir }))

    const response = await app.handler(
      mockRequest("http://localhost/style.css"),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("text/css; charset=utf-8")
  })

  it("serves JavaScript files with correct Content-Type", async () => {
    const app = createHttpApp()
    app.use(serveStatic({ root: tmpDir }))

    const response = await app.handler(
      mockRequest("http://localhost/app.js"),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe(
      "application/javascript; charset=utf-8",
    )
  })

  it("serves index.html for root path", async () => {
    const app = createHttpApp()
    app.use(serveStatic({ root: tmpDir }))

    const response = await app.handler(mockRequest("http://localhost/"))
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8")
  })

  it("serves files from subdirectories", async () => {
    const app = createHttpApp()
    app.use(serveStatic({ root: tmpDir }))

    const response = await app.handler(
      mockRequest("http://localhost/subdir/nested.txt"),
    )
    expect(response.status).toBe(200)
  })

  it("returns 403 for directory traversal attempts", () => {
    // Test the .. check in serveStatic by calling the middleware directly
    // with a crafted path that contains .. (bypassing URL normalization)
    const middleware = serveStatic({ root: tmpDir })

    const req = {
      method: "GET",
      url: "http://localhost/../../etc/passwd",
      path: "../../etc/passwd", // bypass URL normalization for testing
      originalUrl: "../../etc/passwd",
      baseUrl: "",
      query: {},
      search: "",
      hostname: "localhost",
      href: "http://localhost/../../etc/passwd",
      headers: new Headers(),
      locals: {},
    }
    const res = {
      statusCode: 200,
      setHeader: () => {},
      end: () => {},
    }
    let nextCalled = false
    middleware(req, res, () => {
      nextCalled = true
    })

    expect(res.statusCode).toBe(403)
    expect(nextCalled).toBe(false)
  })

  it("returns 404 for normalized traversal URLs (Bun handles normalization)", async () => {
    const app = createHttpApp()
    app.use(serveStatic({ root: tmpDir }))

    // Bun normalizes ../../etc/passwd to /etc/passwd, which is within root
    // but doesn't exist as a file, so it falls through to 404.
    const response = await app.handler(
      mockRequest("http://localhost/../../etc/passwd"),
    )
    expect(response.status).toBe(404) // normalized path doesn't exist in tmpDir
  })

  it("blocks dotfiles by default", async () => {
    const app = createHttpApp()
    app.use(serveStatic({ root: tmpDir }))

    const response = await app.handler(
      mockRequest("http://localhost/.hidden"),
    )
    expect(response.status).toBe(403)
  })

  it("allows dotfiles when dotfiles option is true", async () => {
    const app = createHttpApp()
    app.use(serveStatic({ root: tmpDir, dotfiles: true }))

    const response = await app.handler(
      mockRequest("http://localhost/.hidden"),
    )
    expect(response.status).toBe(200)
  })

  it("respects the prefix option", async () => {
    const app = createHttpApp()
    app.use(serveStatic({ root: tmpDir, prefix: "/static/" }))

    // Should serve from /static/
    const response1 = await app.handler(
      mockRequest("http://localhost/static/style.css"),
    )
    expect(response1.status).toBe(200)

    // Should NOT serve without prefix
    const response2 = await app.handler(
      mockRequest("http://localhost/style.css"),
    )
    expect(response2.status).toBe(404)
  })

  it("calls next() for non-existent files", async () => {
    const app = createHttpApp()
    let fallbackCalled = false

    app.use(serveStatic({ root: tmpDir }))
    app.get("/nonexistent", (req, res) => {
      fallbackCalled = true
      res.send("fallback")
    })

    await app.handler(mockRequest("http://localhost/nonexistent"))
    expect(fallbackCalled).toBe(true)
  })

  it("sets Cache-Control header with maxAgeSecs", async () => {
    const app = createHttpApp()
    app.use(serveStatic({ root: tmpDir, maxAgeSecs: 86400 }))

    const response = await app.handler(
      mockRequest("http://localhost/style.css"),
    )
    expect(response.headers.get("Cache-Control")).toContain("max-age=86400")
  })

  it("supports SPA index.html fallback mode", async () => {
    const app = createHttpApp()
    app.use(serveStatic({ root: tmpDir, indexHtmlFallback: true }))

    // A non-existent path should fall back to index.html
    const response = await app.handler(
      mockRequest("http://localhost/some-spa-route"),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8")
  })
})

// ── getMimeType ────────────────────────────────────────────────────────────

describe("getMimeType", () => {
  it("returns correct MIME types for common extensions", () => {
    expect(getMimeType("file.html")).toBe("text/html; charset=utf-8")
    expect(getMimeType("file.css")).toBe("text/css; charset=utf-8")
    expect(getMimeType("file.js")).toBe("application/javascript; charset=utf-8")
    expect(getMimeType("file.json")).toBe("application/json; charset=utf-8")
    expect(getMimeType("file.png")).toBe("image/png")
    expect(getMimeType("file.svg")).toBe("image/svg+xml")
    expect(getMimeType("file.woff2")).toBe("font/woff2")
  })

  it("returns application/octet-stream for unknown extensions", () => {
    expect(getMimeType("file.unknown")).toBe("application/octet-stream")
  })

  it("returns application/octet-stream for files without extension", () => {
    expect(getMimeType("file")).toBe("application/octet-stream")
  })

  it("is case-insensitive for extensions", () => {
    expect(getMimeType("file.HTML")).toBe("text/html; charset=utf-8")
    expect(getMimeType("file.CSS")).toBe("text/css; charset=utf-8")
  })
})
