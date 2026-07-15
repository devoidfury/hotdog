// Tests for static-files.ts — MIME type detection and static file serving.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { getMimeType, serveStaticFile } from "../../src/utils/static-files.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("getMimeType", () => {
  it("returns correct MIME types for common extensions", () => {
    expect(getMimeType("page.html")).toBe("text/html; charset=utf-8");
    expect(getMimeType("page.htm")).toBe("text/html; charset=utf-8");
    expect(getMimeType("style.css")).toBe("text/css; charset=utf-8");
    expect(getMimeType("app.js")).toBe("application/javascript; charset=utf-8");
    expect(getMimeType("app.mjs")).toBe("application/javascript; charset=utf-8");
    expect(getMimeType("data.json")).toBe("application/json; charset=utf-8");
    expect(getMimeType("image.png")).toBe("image/png");
    expect(getMimeType("image.jpg")).toBe("image/jpeg");
    expect(getMimeType("image.jpeg")).toBe("image/jpeg");
    expect(getMimeType("image.gif")).toBe("image/gif");
    expect(getMimeType("icon.svg")).toBe("image/svg+xml");
    expect(getMimeType("icon.ico")).toBe("image/x-icon");
    expect(getMimeType("image.webp")).toBe("image/webp");
    expect(getMimeType("image.avif")).toBe("image/avif");
    expect(getMimeType("font.woff")).toBe("font/woff");
    expect(getMimeType("font.woff2")).toBe("font/woff2");
    expect(getMimeType("font.ttf")).toBe("font/ttf");
    expect(getMimeType("data.xml")).toBe("application/xml");
    expect(getMimeType("doc.pdf")).toBe("application/pdf");
    expect(getMimeType("archive.zip")).toBe("application/zip");
    expect(getMimeType("archive.gz")).toBe("application/gzip");
    expect(getMimeType("readme.txt")).toBe("text/plain; charset=utf-8");
    expect(getMimeType("readme.md")).toBe("text/plain; charset=utf-8");
    expect(getMimeType("data.csv")).toBe("text/csv");
    expect(getMimeType("site.webmanifest")).toBe("application/manifest+json");
    expect(getMimeType("audio.mp3")).toBe("audio/mpeg");
    expect(getMimeType("video.mp4")).toBe("video/mp4");
    expect(getMimeType("video.webm")).toBe("video/webm");
    expect(getMimeType("audio.ogg")).toBe("audio/ogg");
    expect(getMimeType("audio.wav")).toBe("audio/wav");
  });

  it("returns application/octet-stream for unknown extensions", () => {
    expect(getMimeType("file.xyz")).toBe("application/octet-stream");
    expect(getMimeType("file.unknown123")).toBe("application/octet-stream");
  });

  it("returns application/octet-stream for files without extension", () => {
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
    // Create test files
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

  it("serves a specific file with correct MIME type", () => {
    const response = serveStaticFile(tmpDir, 3600, "/app.js");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(response!.headers.get("Content-Type")).toBe("application/javascript; charset=utf-8");
  });

  it("serves CSS with correct MIME type", () => {
    const response = serveStaticFile(tmpDir, 3600, "/style.css");
    expect(response).not.toBeNull();
    expect(response!.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
  });

  it("serves files in subdirectories", () => {
    const response = serveStaticFile(tmpDir, 3600, "/subdir/nested.txt");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(response!.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  });

  it("falls back to index.html for non-existent files (SPA fallback)", () => {
    const response = serveStaticFile(tmpDir, 3600, "/nonexistent.html");
    // SPA fallback: non-existent files serve index.html
    expect(response).not.toBeNull();
    expect(response!.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("returns 403 for directory traversal attempts", () => {
    const response = serveStaticFile(tmpDir, 3600, "/../etc/passwd");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
  });

  it("returns 403 for path with .. segment", () => {
    const response = serveStaticFile(tmpDir, 3600, "/subdir/../../etc/passwd");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
  });

  it("includes Cache-Control header", () => {
    const response = serveStaticFile(tmpDir, 3600, "/index.html");
    expect(response!.headers.get("Cache-Control")).toContain("max-age=3600");
  });

  it("handles directory requests by serving index.html", () => {
    const response = serveStaticFile(tmpDir, 3600, "/subdir/");
    // subdir doesn't have index.html, so it falls through to root index.html
    expect(response).not.toBeNull();
  });

  it("handles URL-encoded paths", () => {
    const response = serveStaticFile(tmpDir, 3600, "/%61pp.js"); // %61 = 'a'
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
  });

  it("strips query strings from paths", () => {
    const response = serveStaticFile(tmpDir, 3600, "/app.js?v=1.0");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
  });

  it("falls back to index.html for SPA routes", () => {
    const response = serveStaticFile(tmpDir, 3600, "/some-spa-route");
    expect(response).not.toBeNull();
    expect(response!.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("returns null when no index.html exists for SPA fallback", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "static-empty-"));
    try {
      const response = serveStaticFile(emptyDir, 3600, "/anything");
      expect(response).toBeNull();
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
