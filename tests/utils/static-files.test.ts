// Tests for static-files.ts — MIME type detection and static file serving.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { getMimeType, serveStaticFile } from "../../src/utils/static-files.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("getMimeType", () => {
  it("returns correct MIME types for common extensions", () => {
    const expected: Record<string, string> = {
      "page.html": "text/html; charset=utf-8",
      "page.htm": "text/html; charset=utf-8",
      "style.css": "text/css; charset=utf-8",
      "app.js": "application/javascript; charset=utf-8",
      "app.mjs": "application/javascript; charset=utf-8",
      "data.json": "application/json; charset=utf-8",
      "image.png": "image/png",
      "image.jpg": "image/jpeg",
      "image.jpeg": "image/jpeg",
      "image.gif": "image/gif",
      "icon.svg": "image/svg+xml",
      "icon.ico": "image/x-icon",
      "image.webp": "image/webp",
      "image.avif": "image/avif",
      "font.woff": "font/woff",
      "font.woff2": "font/woff2",
      "font.ttf": "font/ttf",
      "data.xml": "application/xml",
      "doc.pdf": "application/pdf",
      "archive.zip": "application/zip",
      "archive.gz": "application/gzip",
      "readme.txt": "text/plain; charset=utf-8",
      "readme.md": "text/plain; charset=utf-8",
      "data.csv": "text/csv",
      "site.webmanifest": "application/manifest+json",
      "audio.mp3": "audio/mpeg",
      "video.mp4": "video/mp4",
      "video.webm": "video/webm",
      "audio.ogg": "audio/ogg",
      "audio.wav": "audio/wav",
    };
    for (const [filename, mime] of Object.entries(expected)) {
      expect(getMimeType(filename)).toBe(mime);
    }
  });

  it("returns application/octet-stream for unknown or missing extensions", () => {
    expect(getMimeType("file.xyz")).toBe("application/octet-stream");
    expect(getMimeType("Makefile")).toBe("application/octet-stream");
    expect(getMimeType("file")).toBe("application/octet-stream");
  });

  it("handles uppercase extensions", () => {
    expect(getMimeType("file.HTML")).toBe("text/html; charset=utf-8");
    expect(getMimeType("file.PNG")).toBe("image/png");
    expect(getMimeType("file.JSON")).toBe("application/json; charset=utf-8");
  });
});

describe("serveStaticFile", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "static-test-"));
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<html><body>Hello</body></html>");
    fs.writeFileSync(path.join(tmpDir, "app.js"), "console.log('hello');");
    fs.writeFileSync(path.join(tmpDir, "style.css"), "body { color: red; }");
    fs.mkdirSync(path.join(tmpDir, "subdir"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "subdir", "nested.txt"), "nested content");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("serves root path as index.html", () => {
    const response = serveStaticFile(tmpDir, 3600, "/");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(response!.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("serves files with correct MIME types", () => {
    const js = serveStaticFile(tmpDir, 3600, "/app.js");
    expect(js!.status).toBe(200);
    expect(js!.headers.get("Content-Type")).toBe("application/javascript; charset=utf-8");

    const css = serveStaticFile(tmpDir, 3600, "/style.css");
    expect(css!.status).toBe(200);
    expect(css!.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
  });

  it("serves files in subdirectories", () => {
    const response = serveStaticFile(tmpDir, 3600, "/subdir/nested.txt");
    expect(response!.status).toBe(200);
    expect(response!.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  });

  it("falls back to index.html for non-existent files (SPA fallback)", () => {
    expect(serveStaticFile(tmpDir, 3600, "/nonexistent.html")!.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(serveStaticFile(tmpDir, 3600, "/some-spa-route")!.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("returns 403 for directory traversal attempts", () => {
    expect(serveStaticFile(tmpDir, 3600, "/../etc/passwd")!.status).toBe(403);
    expect(serveStaticFile(tmpDir, 3600, "/subdir/../../etc/passwd")!.status).toBe(403);
  });

  it("includes Cache-Control header", () => {
    expect(serveStaticFile(tmpDir, 3600, "/index.html")!.headers.get("Cache-Control")).toContain("max-age=3600");
  });

  it("handles URL-encoded paths and query strings", () => {
    expect(serveStaticFile(tmpDir, 3600, "/%61pp.js")!.status).toBe(200);
    expect(serveStaticFile(tmpDir, 3600, "/app.js?v=1.0")!.status).toBe(200);
  });

  it("returns null when no index.html exists for SPA fallback", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "static-empty-"));
    try {
      expect(serveStaticFile(emptyDir, 3600, "/anything")).toBeNull();
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
