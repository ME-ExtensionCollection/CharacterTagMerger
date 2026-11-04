// Dev harness server: builds the extension, then serves the repo on
// http://localhost:5178/dev/harness.html with a mock Marinara API.
// Nothing here talks to a real Marinara install.
//
// Usage: node scripts/serve.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2]) || 5178;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json" };

const build = () => execFileSync(process.execPath, [join(ROOT, "scripts/build.mjs")], { stdio: "inherit" });
build();

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/") {
    res.writeHead(302, { Location: "/dev/harness.html" });
    return res.end();
  }
  // Rebuild on every harness load so edits show up after a refresh.
  if (url.pathname === "/dev/build/page-runtime.js") {
    try {
      build();
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end(String(error));
    }
  }
  const file = normalize(join(ROOT, decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Harness: http://localhost:${PORT}/dev/harness.html`));
