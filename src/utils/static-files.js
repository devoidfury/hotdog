// static-files.js — Static file serving middleware for createHttpApp().
//
// Provides serveStatic() middleware with directory traversal protection,
// MIME type detection, fallback to index.html for SPA routing, and caching headers.
//
// Usage:
//   const { createHttpApp } = await import('./http-app.js')
//   const { serveStatic } = await import('./static-files.js')
//   const app = createHttpApp()
//   app.use(serveStatic('/path/to/public'))

import fs from "node:fs"

/**
 * MIME types for common file extensions.
 */
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".otf": "font/otf",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/csv",
  ".webmanifest": "application/manifest+json",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
}

/**
 * Get the MIME type for a file path based on its extension.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function getMimeType(filePath) {
  const ext = filePath.match(/\.([a-z0-9]+)$/i)
  return ext ? MIME_TYPES[ext[0].toLowerCase()] || "application/octet-stream" : "application/octet-stream"
}

/**
 * Create a static file serving middleware.
 *
 * @param {Object} options
 * @param {string} options.root — Absolute path to the static files directory
 * @param {string} [options.prefix=''] — URL path prefix to mount under (e.g. '/static/')
 * @param {boolean} [options.indexHtmlFallback=false] — If true, serve index.html for unmatched paths (SPA mode)
 * @param {number} [options.maxAgeSecs=3600] — Cache-Control max-age in seconds
 * @param {boolean} [options.dotfiles=false] — Whether to serve dotfiles
 * @returns {Function} Middleware function for createHttpApp().use()
 */
export function serveStatic({
  root,
  prefix = "",
  indexHtmlFallback = false,
  maxAgeSecs = 3600,
  dotfiles = false,
} = {}) {
  if (!root) {
    throw new Error("serveStatic() requires a 'root' path")
  }

  // Resolve root to absolute path once
  const resolvedRoot = new URL(root, "file://").pathname

  return function serveStaticMiddleware(req, res, next) {
    // Check prefix match
    if (prefix && !req.path.startsWith(prefix)) {
      return next()
    }

    // Strip prefix from path
    let filePath = prefix ? req.path.substring(prefix.length) : req.path

    // Default to index.html for directory requests
    if (filePath === "/" || filePath.endsWith("/")) {
      filePath = filePath + "index.html"
    }

    // Strip query string and fragment
    filePath = filePath.split("?").shift().split("#").shift()

    // Decode URI components
    try {
      filePath = decodeURIComponent(filePath)
    } catch {
      res.statusCode = 400
      res.end("Bad Request")
      return
    }

    // Security: check for directory traversal BEFORE normalizing
    // (URL normalization can silently resolve ../ sequences)
    const segments = filePath.split("/")
    if (segments.some((seg) => seg === "..")) {
      res.statusCode = 403
      res.end("Forbidden")
      return
    }

    // Normalize path — remove leading slashes, collapse ./
    const normalized = filePath.replace(/^\/+/, "").replace(/\/\.\//g, "/")

    // Security: ensure the resolved path is within the root directory
    const resolvedPath = new URL(normalized, `file://${resolvedRoot}/`).pathname
    if (!resolvedPath.startsWith(resolvedRoot)) {
      res.statusCode = 403
      res.end("Forbidden")
      return
    }

    // Security: block dotfiles if not explicitly enabled
    if (!dotfiles && normalized.split("/").some((segment) => segment.startsWith("."))) {
      res.statusCode = 403
      res.end("Forbidden")
      return
    }

    try {
      const exists = fs.existsSync(resolvedPath)

      // For SPA fallback, try index.html if the file doesn't exist
      if (!exists && indexHtmlFallback) {
        const indexPath = new URL("index.html", `file://${resolvedRoot}/`).pathname
        if (fs.existsSync(indexPath)) {
          const indexFile = Bun.file(indexPath)
          const mimeType = getMimeType("index.html")
          res.setHeader("Content-Type", mimeType)
          res.setHeader("Cache-Control", `public, max-age=${maxAgeSecs}`)
          res.file(indexFile)
          return
        }
      }

      if (!exists) {
        return next()
      }

      const file = Bun.file(resolvedPath)
      const mimeType = getMimeType(resolvedPath)
      res.setHeader("Content-Type", mimeType)
      res.setHeader("Cache-Control", `public, max-age=${maxAgeSecs}`)
      res.file(file)
    } catch {
      res.statusCode = 500
      res.end("Internal Server Error")
    }
  }
}
