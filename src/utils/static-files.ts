// static-files.ts — Static file serving for Bun.serve() fetch handlers.
//
// Provides serveStaticFile() with MIME type detection, caching headers,
// SPA fallback to index.html, and directory traversal protection.

import fs from "node:fs";

const MIME_TYPES: Record<string, string> = {
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
};

/**
 * Get the MIME type for a file path based on its extension.
 */
export function getMimeType(filePath: string): string {
  const ext = filePath.match(/\.([a-z0-9]+)$/i);
  return ext ? MIME_TYPES[ext[0].toLowerCase()] || "application/octet-stream" : "application/octet-stream";
}

/**
 * Serve a static file from a directory.
 * Handles MIME types, caching headers, SPA fallback to index.html,
 * and directory traversal protection.
 *
 * @param rootDir - Absolute path to the static files root directory.
 * @param maxAgeSecs - Cache-Control max-age in seconds.
 * @param pathname - The URL pathname to serve (from `new URL(req.url).pathname`).
 * @returns A Response if the file was found, or null for 404.
 */
export function serveStaticFile(
  rootDir: string,
  maxAgeSecs: number,
  pathname: string,
): Response | null {
  // Strip query string and fragment
  let filePath = pathname.split("?")[0]!.split("#")[0]!;

  // Default to index.html for directory requests
  if (filePath === "/" || filePath.endsWith("/")) {
    filePath = filePath + "index.html";
  }

  // Decode URI components
  try {
    filePath = decodeURIComponent(filePath);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // Security: check for directory traversal BEFORE normalizing
  const segments = filePath.split("/");
  if (segments.some((seg) => seg === "..")) {
    return new Response("Forbidden", { status: 403 });
  }

  // Normalize path
  const normalized = filePath.replace(/^\/+/, "").replace(/\/\.\//g, "/");

  // Security: ensure the resolved path is within the root directory
  const resolvedPath = new URL(normalized, `file://${rootDir}/`).pathname;
  if (!resolvedPath.startsWith(rootDir)) {
    return new Response("Forbidden", { status: 403 });
  }

  // Try to serve the file
  if (fs.existsSync(resolvedPath)) {
    const file = Bun.file(resolvedPath);
    const mimeType = getMimeType(resolvedPath);
    return new Response(file, {
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": `public, max-age=${maxAgeSecs}`,
      },
    });
  }

  // SPA fallback: serve index.html for unmatched paths
  const indexPath = new URL("index.html", `file://${rootDir}/`).pathname;
  if (fs.existsSync(indexPath)) {
    const indexFile = Bun.file(indexPath);
    return new Response(indexFile, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": `public, max-age=${maxAgeSecs}`,
      },
    });
  }

  return null; // 404
}
