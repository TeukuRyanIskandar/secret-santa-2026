// Local preview with an in-memory database: `npm run dev`, then open http://localhost:3000/?setup
// Setup key is "dev". Data resets every time the server restarts.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { makeCore, AppError } from "./lib/core.js";
import { memoryStore } from "./lib/store-memory.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const core = makeCore(memoryStore(), { setupKey: process.env.SETUP_KEY || "dev" });
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const port = Number(process.env.PORT) || 3000;

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/rpc") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let status = 200, out;
    try {
      out = await core.handle(JSON.parse(raw || "{}"));
    } catch (e) {
      status = e instanceof AppError ? e.status : 500;
      out = { error: e instanceof AppError ? e.message : String(e) };
      if (status === 500) console.error(e);
    }
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(out));
  }
  const path = normalize(join(root, url.pathname === "/" ? "index.html" : url.pathname));
  if (!path.startsWith(root)) return res.writeHead(403).end();
  try {
    const file = await readFile(path);
    res.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream" });
    res.end(file);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, () => console.log(`Secret Santa dev server: http://localhost:${port}/?setup  (setup key: dev)`));
