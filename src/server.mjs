// Minimal, dependency-free HTTP server for the playgrounds. Plain node:http
// (fewer deps = smaller attack surface). Serves the UI and runs the CLIs via
// the hardened executor. See README "Security" for the deploy-layer controls
// this assumes (no egress, per-run resource caps, etc.).

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runCli, LIMITS } from "./exec.mjs";
import { PLAYGROUNDS, HttpError, seedVault } from "./clis.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 8080);

// In-memory per-IP token bucket. Fine for a single instance; a multi-instance
// deploy should put a rate limiter (or Cloudflare/Turnstile) in front.
const RATE = { windowMs: 60_000, max: Number(process.env.COP_RATE_MAX || 20) };
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const e = hits.get(ip);
  if (!e || now > e.resetAt) { hits.set(ip, { n: 1, resetAt: now + RATE.windowMs }); return false; }
  e.n += 1;
  return e.n > RATE.max;
}
// Opportunistic cleanup so the map doesn't grow unbounded.
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k); }, RATE.windowMs).unref?.();

function send(res, status, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": Buffer.isBuffer(body) ? "application/octet-stream" : (typeof body === "string" ? "text/html; charset=utf-8" : "application/json"), "x-content-type-options": "nosniff", ...headers });
  res.end(data);
}

function readRawBody(req, cap) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > cap) { reject(new HttpError(413, "input too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(join(ROOT, "public", "index.html"), "utf8");
      return send(res, 200, html, { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" });
    }
    if (req.method === "GET" && url.pathname === "/api/meta") {
      return send(res, 200, { clis: Object.keys(PLAYGROUNDS), limits: LIMITS });
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/run/")) {
      const id = url.pathname.slice("/api/run/".length);
      const pg = PLAYGROUNDS[id];
      if (!pg) return send(res, 404, { error: `unknown playground '${id}'` });
      const ip = (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "?").trim();
      if (rateLimited(ip)) return send(res, 429, { error: "rate limit — slow down" });

      let built;
      if (pg.type === "upload") {
        const buf = await readRawBody(req, pg.maxBytes);
        if (!buf.length) return send(res, 400, { error: "empty upload" });
        built = pg.build(buf);
      } else {
        const raw = (await readRawBody(req, LIMITS.maxInputBytes * (pg.fields.length + 1))).toString("utf8");
        let body; try { body = JSON.parse(raw || "{}"); } catch { return send(res, 400, { error: "body must be JSON" }); }
        for (const f of pg.fields) {
          if (typeof body[f] === "string" && body[f].length > LIMITS.maxInputBytes) {
            return send(res, 413, { error: `field '${f}' exceeds ${LIMITS.maxInputBytes} bytes` });
          }
        }
        built = pg.build(body);
      }
      const result = await runCli(built.argv, { files: built.files, readOutputFile: built.readOutputFile, timeoutMs: built.timeoutMs, cwd: built.cwd });
      return send(res, 200, pg.shape(result));
    }
    return send(res, 404, { error: "not found" });
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error("unhandled:", err);
    return send(res, 500, { error: "internal error" });
  }
});

// Seed the vault explorer (best-effort) before accepting traffic.
seedVault().finally(() => {
  server.listen(PORT, () => console.log(`contract-ops-playground on :${PORT} (limits: ${JSON.stringify(LIMITS)})`));
});
