// Per-CLI command resolution + how each playground turns user input into a run.
//
// The base command defaults to the installed bin (as in the Docker image) but
// can be overridden for local dev, e.g.:
//   COP_DRAFT_CMD="node /Users/bbot/draft-cli/draft-cli.mjs"
//   COP_COMPARE_CMD="node /tmp/compare-fresh/compare-cli.mjs"

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function cmd(id, fallback) {
  const v = process.env[`COP_${id}_CMD`];
  return v ? v.split(" ").filter(Boolean) : fallback;
}

export const BIN = {
  extract: cmd("EXTRACT", ["extract"]),
  draft: cmd("DRAFT", ["draft"]),
  compare: cmd("COMPARE", ["compare"]),
  docx2pdf: cmd("DOCX2PDF", ["docx2pdf"]),
  templatevault: cmd("TEMPLATEVAULT", ["template-vault"]),
  ndareview: cmd("NDAREVIEW", ["nda-review-cli"]),
  sign: cmd("SIGN", ["sign"]),
  contractvault: cmd("CONTRACTVAULT", ["contract-vault"]),
};

// nda-review's `review` needs a policy file; bundle the suite default in the image.
export const NDA_POLICY = process.env.COP_NDA_POLICY || "/app/assets/nda-policy.json";

// Bundled templates uploaded into the demo vault at seed time so the explorer
// spans multiple categories (msa, employment), not just the demo's NDAs.
const ASSETS = process.env.COP_ASSETS_DIR || join(dirname(dirname(fileURLToPath(import.meta.url))), "assets");
const EXTRA_VAULT_TEMPLATES = [
  { category: "msa", name: "standard", summary: "Master Services Agreement — bracketed template", tags: "services,vendor", file: join(ASSETS, "vault", "msa.md") },
  { category: "employment", name: "ip-assignment", summary: "Proprietary Information & Inventions Agreement", tags: "employment,ip", file: join(ASSETS, "vault", "ip-assignment.md") },
];

// The vault explorer runs read-only commands against a demo vault seeded once
// at startup (via `template-vault demo`). Read-only commands don't mutate it,
// so the seeded dir is shared safely across requests.
let SEED_VAULT = null;
export function getSeedVault() { return SEED_VAULT; }
export async function seedVault() {
  try {
    const dir = await mkdtemp(join(tmpdir(), "cop-vault-seed-"));
    const [c, ...base] = BIN.templatevault;
    await new Promise((resolve, reject) => {
      execFile(c, [...base, "demo", "--clean", "--path", dir], { timeout: 30000, env: { ...process.env, NO_COLOR: "1" } }, (err) => err ? reject(err) : resolve());
    });
    // Best-effort: add bundled cross-category templates so the explorer isn't NDA-only.
    for (const t of EXTRA_VAULT_TEMPLATES) {
      await new Promise((resolve) => {
        execFile(c, [...base, "upload", "--category", t.category, "--name", t.name, "--version", "1.0", "--summary", t.summary, "--tags", t.tags, "--license", "example", "--non-interactive", t.file], { cwd: dir, timeout: 20000, env: { ...process.env, NO_COLOR: "1" } }, () => resolve());
      });
    }
    SEED_VAULT = dir;
    console.log("vault explorer seeded at", dir);
    return dir;
  } catch (e) {
    console.error("vault seed failed (explorer disabled):", e.message);
    SEED_VAULT = null;
    return null;
  }
}

// The contract-vault explorer runs read-only commands against a seeded register
// of SIGNED contracts: init a vault, then ingest two bundled extract-cli payloads
// (no extract needed — `.json` payloads ingest directly). Read-only commands
// don't mutate it, so the seeded dir is shared safely across requests.
const CONTRACT_VAULT_PAYLOADS = ["acme-msa.json", "initech-nda.json"].map(
  (f) => join(ASSETS, "contract-vault", f));
let SEED_CONTRACT_VAULT = null;
export function getSeedContractVault() { return SEED_CONTRACT_VAULT; }
export async function seedContractVault() {
  try {
    const dir = await mkdtemp(join(tmpdir(), "cop-cvault-seed-"));
    const [c, ...base] = BIN.contractvault;
    const env = { ...process.env, NO_COLOR: "1" };
    await new Promise((resolve, reject) => {
      execFile(c, [...base, "init", dir], { timeout: 30000, env }, (err) => err ? reject(err) : resolve());
    });
    for (const payload of CONTRACT_VAULT_PAYLOADS) {
      await new Promise((resolve) => {
        execFile(c, [...base, "ingest", payload, "--vault", dir], { timeout: 20000, env }, () => resolve());
      });
    }
    SEED_CONTRACT_VAULT = dir;
    console.log("contract-vault explorer seeded at", dir);
    return dir;
  } catch (e) {
    console.error("contract-vault seed failed (explorer disabled):", e.message);
    SEED_CONTRACT_VAULT = null;
    return null;
  }
}

// The sign explorer runs read-only commands against a demo sign DB seeded once
// at startup: two SENT-but-pending requests (a tokenized signer inbox) plus one
// fully-signed request (a completed audit chain). Seeded to the default
// data/sign.db so read commands work with cwd alone (no env needed).
let SIGN_SEED = null;
let SIGN_SEED_REQ = null; // a request id for the "anatomy" view
export function getSignSeed() { return SIGN_SEED; }
export function getSignSeedReq() { return SIGN_SEED_REQ; }
export async function seedSignDb() {
  try {
    const dir = await mkdtemp(join(tmpdir(), "cop-sign-seed-"));
    await mkdir(join(dir, "data"), { recursive: true });
    await copyFile(join(ASSETS, "sample.pdf"), join(dir, "contract.pdf"));
    const [c, ...base] = BIN.sign;
    const env = { ...process.env, NO_COLOR: "1", SIGN_DB: join(dir, "data", "sign.db") };
    const run = (args) => new Promise((resolve) => execFile(c, [...base, ...args], { cwd: dir, timeout: 30000, env }, (e, so) => resolve(String(so || ""))));
    const pendings = [
      { title: "Vendor MSA — Acme ↔ Globex", a: "name:Alice Founder,email:alice@acme.com,order:1", b: "name:Bob Counsel,email:bob@globex.com,order:2" },
      { title: "Mutual NDA — Acme ↔ Initech", a: "name:Carol Lee,email:carol@acme.com,order:1", b: "name:Dan Ops,email:dan@initech.com,order:2" },
    ];
    for (const p of pendings) {
      const out = await run(["request", "create", "--title", p.title, "--document", "contract.pdf", "--signer", p.a, "--signer", p.b, "--provider", "local"]);
      let id = null; try { id = JSON.parse(out).requestId; } catch { /* ignore */ }
      if (id) { await run(["request", "send", "--request-id", id, "--provider", "local"]); if (!SIGN_SEED_REQ) SIGN_SEED_REQ = id; }
    }
    await run(["demo", "--out", "demo-bundle"]); // one fully-signed request → completed audit chain
    SIGN_SEED = dir;
    console.log("sign explorer seeded at", dir);
    return dir;
  } catch (e) {
    console.error("sign seed failed (explorer disabled):", e.message);
    SIGN_SEED = null;
    return null;
  }
}

export const UPLOAD_MAX = Number(process.env.COP_MAX_UPLOAD || 3 * 1024 * 1024); // 3 MB

function tryJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Each playground: validate user fields, map to { argv, files, readOutputFile },
// and shape the executor result into a JSON response for the UI.
export const PLAYGROUNDS = {
  extract: {
    // Paste any contract (markdown / text) → structured JSON. Deterministic tier
    // only (no --llm → no network). Text paste only — no untrusted binary parsing.
    fields: ["text"],
    build({ text }) {
      // Written as .md so the native markdown reader runs (HTML inside a .txt is
      // auto-detected too); the deterministic cascade handles the rest.
      return {
        argv: [...BIN.extract, "contract.md", "--json"],
        files: { "contract.md": text ?? "" },
      };
    },
    // Optional .docx upload path (same `extract … --json`, shared shape). The
    // server routes an octet-stream POST here. NOTE: we deliberately do NOT
    // install the `[docx]` extra in the image — extract's stdlib .docx reader
    // honors Word heading styles (Heading1-9/Title → clause map), whereas the
    // python-docx path flattens them and loses the clause structure.
    upload: {
      accept: ".docx",
      maxBytes: UPLOAD_MAX,
      timeoutMs: Number(process.env.COP_EXTRACT_DOCX_TIMEOUT_MS || 20000),
      build(buf) {
        return { argv: [...BIN.extract, "contract.docx", "--json"], files: { "contract.docx": buf }, timeoutMs: this.timeoutMs };
      },
    },
    shape(r) {
      // exit 1 = low-signal document — a *finding*, not a crash: valid JSON is
      // still emitted, so surface it with a flag rather than treating it as failure.
      return {
        ok: r.exitCode === 0,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        lowSignal: r.exitCode === 1,
        result: tryJson(r.stdout),
        raw: r.stdout,
        stderr: r.stderr,
      };
    },
  },

  draft: {
    // Fill placeholders in a user-supplied template with user-supplied params.
    fields: ["template", "params"],
    build({ template, params }) {
      const files = { "template.md": template ?? "" };
      const argv = [...BIN.draft, "template.md", "--no-llm"]; // --no-llm: never call out
      if (params && params.trim()) {
        if (!tryJson(params)) throw new HttpError(400, "params must be valid JSON");
        files["params.json"] = params;
        argv.push("--params", "params.json");
      }
      return { argv, files };
    },
    shape(r) {
      return { ok: r.exitCode === 0, exitCode: r.exitCode, timedOut: r.timedOut, output: r.stdout, stderr: r.stderr };
    },
  },

  compare: {
    // Clause-aware drift between two user-supplied versions (pasted text only —
    // no binary uploads, so no untrusted .docx/.pdf parsing here).
    fields: ["base", "candidate"],
    build({ base, candidate }) {
      return {
        argv: [...BIN.compare, "base.md", "candidate.md", "--json"],
        files: { "base.md": base ?? "", "candidate.md": candidate ?? "" },
      };
    },
    shape(r) {
      const COMPARE_EXIT = { 0: "clean — safe to sign", 1: "I/O error", 2: "substantive drift", 3: "cosmetic / typographic", 4: "clauses moved" };
      return {
        ok: r.exitCode === 0,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        meaning: COMPARE_EXIT[r.exitCode] ?? `exit ${r.exitCode}`,
        verdict: tryJson(r.stdout),
        raw: r.stdout,
        stderr: r.stderr,
      };
    },
  },
};

// docx2pdf: a .docx UPLOAD → PDF. LibreOffice parsing untrusted .docx is the
// riskiest surface in the suite — the deploy layer MUST run this in a disposable,
// no-egress, locked container (see README "Security", Phase 2).
PLAYGROUNDS.docx2pdf = {
  type: "upload",
  accept: ".docx",
  maxBytes: UPLOAD_MAX,
  // LibreOffice cold-start is slow; give it more headroom than the text tools.
  timeoutMs: Number(process.env.COP_DOCX_TIMEOUT_MS || 30000),
  build(buf) {
    return {
      argv: [...BIN.docx2pdf, "in.docx", "out.pdf", "--json"],
      files: { "in.docx": buf },
      readOutputFile: "out.pdf",
      timeoutMs: this.timeoutMs,
    };
  },
  shape(r) {
    const pdf = r.outputFile;
    const tooBig = pdf && pdf.length > UPLOAD_MAX;
    return {
      ok: r.exitCode === 0 && Boolean(pdf) && pdf.length > 0,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      stderr: r.stderr,
      info: tryJson(r.stdout),
      pdfBytes: pdf ? pdf.length : 0,
      pdfBase64: pdf && pdf.length && !tooBig ? pdf.toString("base64") : null,
    };
  },
};

// template-vault: a READ-ONLY explorer over the seeded demo vault. Only
// non-mutating, no-network subcommands are allowed (no init/upload/compose/
// swap/import/ask), so a shared seed dir stays safe.
const VAULT_ACTIONS = { find: true, list: false, info: true, clauses: true, history: true, stats: false };
const REF_RE = /^[a-z][a-z0-9-]*\/[a-z0-9-]+(@[A-Za-z0-9._-]+)?$/;

PLAYGROUNDS["template-vault"] = {
  fields: ["action", "arg"],
  build({ action, arg }) {
    if (!(action in VAULT_ACTIONS)) {
      throw new HttpError(400, `action must be one of: ${Object.keys(VAULT_ACTIONS).join(", ")}`);
    }
    const seed = getSeedVault();
    if (!seed) throw new HttpError(503, "vault demo not available (template-vault not seeded)");
    const args = [action];
    if (VAULT_ACTIONS[action]) {
      const a = String(arg ?? "").trim();
      if (!a) throw new HttpError(400, `'${action}' needs an argument`);
      if (action === "find") {
        if (a.length > 200) throw new HttpError(400, "query too long");
        args.push(a);
      } else {
        if (!REF_RE.test(a)) throw new HttpError(400, "ref must look like category/name[@version]");
        args.push(a);
      }
    }
    args.push("--json");
    return { argv: [...BIN.templatevault, ...args], cwd: seed };
  },
  shape(r) {
    return { ok: r.exitCode === 0, exitCode: r.exitCode, result: tryJson(r.stdout), raw: r.stdout, stderr: r.stderr };
  },
};

// nda-review: paste an NDA → score it against the bundled house policy.
// `review` has no --json flag, so we surface its human-readable report.
PLAYGROUNDS["nda-review"] = {
  fields: ["text"],
  build({ text }) {
    return {
      argv: [...BIN.ndareview, "review", "--file", "nda.txt", "--playbook", NDA_POLICY, "--why"],
      files: { "nda.txt": text ?? "" },
    };
  },
  shape(r) {
    return { ok: r.exitCode === 0, exitCode: r.exitCode, timedOut: r.timedOut, report: r.stdout, stderr: r.stderr };
  },
};

// sign: run the offline local-provider demo (create → sign → verify → bundle).
// No user input — signing arbitrary uploads is out of scope. Returns the audit
// result plus the produced signed PDF for download.
const SIGN_ACTIONS = new Set(["demo", "inbox", "requests", "anatomy", "audit"]);
PLAYGROUNDS["sign"] = {
  fields: ["action"],
  timeoutMs: 20000,
  build({ action } = {}) {
    const a = action || "demo";
    if (!SIGN_ACTIONS.has(a)) throw new HttpError(400, `action must be one of: ${[...SIGN_ACTIONS].join(", ")}`);
    if (a === "demo") {
      // The offline lifecycle (create → sign → verify → bundle) in an ephemeral dir; returns the signed PDF.
      return { argv: [...BIN.sign, "demo", "--out", "demo-bundle"], readOutputFile: "demo-bundle/signed.pdf", timeoutMs: 20000 };
    }
    const seed = getSignSeed();
    if (!seed) throw new HttpError(503, "sign explorer not available (demo data not seeded)");
    const base = [...BIN.sign];
    if (a === "inbox") return { argv: [...base, "signer", "list", "--json"], cwd: seed };
    if (a === "requests") return { argv: [...base, "request", "list", "--json"], cwd: seed };
    if (a === "audit") return { argv: [...base, "audit", "scan", "--json"], cwd: seed };
    // anatomy: the full state of one seeded request (document + signers + audit metadata)
    const id = getSignSeedReq();
    if (!id) throw new HttpError(503, "no seeded request to inspect");
    return { argv: [...base, "request", "show", "--request-id", id, "--json"], cwd: seed };
  },
  shape(r) {
    const pdf = r.outputFile;
    return {
      ok: r.exitCode === 0,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      result: tryJson(r.stdout),
      raw: r.stdout,
      stderr: r.stderr,
      pdfBytes: pdf ? pdf.length : 0,
      pdfBase64: pdf && pdf.length ? pdf.toString("base64") : null,
    };
  },
};

// contract-vault: a READ-ONLY explorer over a seeded register of signed
// contracts. Only non-mutating, no-network subcommands are allowed (no
// init/ingest/accept), so a shared seed dir stays safe. due/risk pin --as-of to
// the demo's reference date so the 2025–2027 sample dates surface as upcoming.
const CVAULT_ACTIONS = new Set(["list", "find", "due", "risk", "stats", "get"]);
const CVAULT_ID_RE = /^[a-z0-9][a-z0-9 ._/-]{0,118}$/i;
PLAYGROUNDS["contract-vault"] = {
  fields: ["action", "arg"],
  build({ action, arg } = {}) {
    const a = String(action || "list");
    if (!CVAULT_ACTIONS.has(a)) throw new HttpError(400, `action must be one of: ${[...CVAULT_ACTIONS].join(", ")}`);
    // Validate user input before touching server state (seed), so a bad request
    // is a 400 even when the register hasn't seeded.
    const args = [a];
    if (a === "get") {
      const id = String(arg ?? "").trim();
      if (!id) throw new HttpError(400, "'get' needs a deal id (e.g. acme-corporation/master-services-agreement)");
      if (!CVAULT_ID_RE.test(id)) throw new HttpError(400, "invalid deal id");
      args.push(id);
    } else if (a === "find") {
      const q = String(arg ?? "").trim();
      if (q) {
        if (q.length > 120) throw new HttpError(400, "query too long");
        args.push(q);
      }
    }
    const seed = getSeedContractVault();
    if (!seed) throw new HttpError(503, "contract-vault explorer not available (register not seeded)");
    if (a === "due" || a === "risk") args.push("--within", "365d", "--as-of", "2026-01-01");
    args.push("--json", "--vault", seed);
    return { argv: [...BIN.contractvault, ...args] };
  },
  shape(r) {
    return { ok: r.exitCode === 0, exitCode: r.exitCode, timedOut: r.timedOut, result: tryJson(r.stdout), raw: r.stdout, stderr: r.stderr };
  },
};

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
