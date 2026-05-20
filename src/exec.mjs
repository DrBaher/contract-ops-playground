// Hardened CLI executor for the playgrounds.
//
// Threat model: this runs suite CLIs on UNTRUSTED user input. Defenses here are
// process-level (timeout, output cap, stripped env, ephemeral cwd, no shell).
// Container/network isolation (no egress, seccomp, read-only rootfs, per-run
// memory/pids caps) is the deploy layer's job — see README "Security".

import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const LIMITS = {
  timeoutMs: Number(process.env.COP_TIMEOUT_MS || 8000),
  maxOutputBytes: Number(process.env.COP_MAX_OUTPUT || 256 * 1024),
  maxInputBytes: Number(process.env.COP_MAX_INPUT || 64 * 1024),
};

// Minimal environment: NONE of the parent's secrets (LLM keys, tokens) are
// inherited, so a crafted input can't exfiltrate them and the LLM tiers stay
// off. The demos are fully offline.
function safeEnv(homeDir) {
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: homeDir,
    TMPDIR: homeDir,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
  };
}

/**
 * Run a CLI in a fresh ephemeral working dir with strict limits.
 *
 * @param {string[]} argv - full command, e.g. ["draft", "t.md", "--no-llm"].
 *   The command + flags are server-controlled; only file *contents* are
 *   user-supplied. Uses execFile (no shell) so input is never interpreted.
 * @param {{ files?: Record<string,string|Buffer>, readOutputFile?: string }} opts
 *   files: fixed-name files written into the run dir before execution.
 *   readOutputFile: a fixed filename to read back (e.g. produced PDF) as a Buffer.
 * @returns {Promise<{stdout:string,stderr:string,exitCode:number,timedOut:boolean,outputFile?:Buffer|null}>}
 */
export async function runCli(argv, { files = {}, readOutputFile = null, timeoutMs = LIMITS.timeoutMs, cwd = null } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error("argv required");
  // `cwd` runs read-only commands against a pre-seeded dir (e.g. the vault
  // explorer's demo vault); it is reused, not created/deleted, and we never
  // write input files into it. Otherwise each run gets a fresh ephemeral dir.
  const ephemeral = !cwd;
  const dir = cwd || await mkdtemp(join(tmpdir(), "cop-play-"));
  try {
    if (ephemeral) {
      for (const [name, content] of Object.entries(files)) {
        // Names are fixed by the route (never user-controlled) — no traversal.
        await writeFile(join(dir, name), content);
      }
    }
    const [cmd, ...args] = argv;
    const result = await new Promise((resolve) => {
      execFile(cmd, args, {
        cwd: dir,
        timeout: timeoutMs,
        maxBuffer: LIMITS.maxOutputBytes,
        env: safeEnv(dir),
        killSignal: "SIGKILL",
        windowsHide: true,
      }, (err, stdout, stderr) => {
        resolve({
          stdout: String(stdout).slice(0, LIMITS.maxOutputBytes),
          stderr: String(stderr).slice(0, LIMITS.maxOutputBytes),
          exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          timedOut: Boolean(err && err.killed),
        });
      });
    });
    if (readOutputFile) {
      result.outputFile = await readFile(join(dir, readOutputFile)).catch(() => null);
    }
    return result;
  } finally {
    if (ephemeral) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
