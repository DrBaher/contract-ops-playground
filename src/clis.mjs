// Per-CLI command resolution + how each playground turns user input into a run.
//
// The base command defaults to the installed bin (as in the Docker image) but
// can be overridden for local dev, e.g.:
//   COP_DRAFT_CMD="node /Users/bbot/draft-cli/draft-cli.mjs"
//   COP_COMPARE_CMD="node /tmp/compare-fresh/compare-cli.mjs"

import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function cmd(id, fallback) {
  const v = process.env[`COP_${id}_CMD`];
  return v ? v.split(" ").filter(Boolean) : fallback;
}

export const BIN = {
  draft: cmd("DRAFT", ["draft"]),
  compare: cmd("COMPARE", ["compare"]),
  docx2pdf: cmd("DOCX2PDF", ["docx2pdf"]),
  templatevault: cmd("TEMPLATEVAULT", ["template-vault"]),
  ndareview: cmd("NDAREVIEW", ["nda-review-cli"]),
  sign: cmd("SIGN", ["sign"]),
};

// nda-review's `review` needs a policy file; bundle the suite default in the image.
export const NDA_POLICY = process.env.COP_NDA_POLICY || "/app/assets/nda-policy.json";

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
    SEED_VAULT = dir;
    console.log("vault explorer seeded at", dir);
    return dir;
  } catch (e) {
    console.error("vault seed failed (explorer disabled):", e.message);
    SEED_VAULT = null;
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
PLAYGROUNDS["sign"] = {
  fields: [],
  timeoutMs: 20000,
  build() {
    return {
      argv: [...BIN.sign, "demo", "--out", "demo-bundle"],
      readOutputFile: "demo-bundle/signed.pdf",
      timeoutMs: 20000,
    };
  },
  shape(r) {
    const pdf = r.outputFile;
    return {
      ok: r.exitCode === 0 && Boolean(pdf) && pdf.length > 0,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      result: tryJson(r.stdout),
      pdfBytes: pdf ? pdf.length : 0,
      pdfBase64: pdf && pdf.length ? pdf.toString("base64") : null,
      stderr: r.stderr,
    };
  },
};

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
