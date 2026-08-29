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

export function getMimeType(filePath: string): string {
  const ext = filePath.match(/\.([a-z0-9]+)$/i);
  return ext ? MIME_TYPES[ext[0].toLowerCase()] || "application/octet-stream" : "application/octet-stream";
}

/** Serve a static file under rootDir; returns null for 404. Unmatched paths fall back to index.html (SPA). */
export function serveStaticFile(
  rootDir: string,
  maxAgeSecs: number,
  pathname: string,
): Response | null {
  let filePath = pathname.split("?")[0]!.split("#")[0]!;

  if (filePath === "/" || filePath.endsWith("/")) {
    filePath = filePath + "index.html";
  }

  try {
    filePath = decodeURIComponent(filePath);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // Reject traversal before normalizing, since normalization would collapse it away.
  if (filePath.split("/").some((seg) => seg === "..")) {
    return new Response("Forbidden", { status: 403 });
  }

  const normalized = filePath.replace(/^\/+/, "").replace(/\/\.\//g, "/");

  // Containment is a boundary check, not a bare startsWith(): a sibling dir
  // sharing a prefix ("/srv/app" vs "/srv/app2") would otherwise pass.
  const root = rootDir.endsWith("/") ? rootDir.slice(0, -1) : rootDir;
  const resolvedPath = new URL(normalized, `file://${root}/`).pathname;
  if (resolvedPath !== root && !resolvedPath.startsWith(root + "/")) {
    return new Response("Forbidden", { status: 403 });
  }

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

  const indexPath = new URL("index.html", `file://${root}/`).pathname;
  if (fs.existsSync(indexPath)) {
    const indexFile = Bun.file(indexPath);
    return new Response(indexFile, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": `public, max-age=${maxAgeSecs}`,
      },
    });
  }

  return null;
}
