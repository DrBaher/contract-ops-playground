# contract-ops-playground

Sandboxed, in-browser playgrounds for the [contract-ops CLI suite](https://cli.drbaher.com).
Each playground takes **your** input, runs the real CLI on it in a hardened
executor, and shows the result. Embeddable per tool page via `<iframe>`.

> ⚠️ **This service executes the suite CLIs on untrusted user input.** Read
> [Security](#security) before exposing it to the internet. Do **not** deploy it
> publicly without the controls below in place.

## Status

| Playground | Input | Status |
|---|---|---|
| **draft** | template + params JSON → filled doc | ✅ Phase 1 |
| **compare** | two pasted versions → drift verdict + exit code | ✅ Phase 1 |
| **docx2pdf** | `.docx` upload → downloadable PDF | ✅ Phase 2 (LibreOffice in image; **isolate per the warning below**) |
| **template-vault** | seeded read-only vault explorer | ✅ Phase 3 |

(nda-review and sign already have their own hosted demos.)

## Run locally

```bash
# Point at local CLI clones (or omit to use the installed `draft` / `compare`):
COP_DRAFT_CMD="node /path/to/draft-cli/draft-cli.mjs" \
COP_COMPARE_CMD="node /path/to/compare-cli/compare-cli.mjs" \
  npm start
# → http://localhost:8080
npm test          # executor unit tests
```

Endpoints: `GET /` (UI), `GET /healthz`, `GET /api/meta`, `POST /api/run/<cli>`
(JSON body of the playground's fields).

## Security

The executor (`src/exec.mjs`) provides **process-level** defenses:

- **No shell** — `execFile`, so user input is never interpreted as a command.
- **Stripped env** — the child inherits *none* of the parent's secrets (LLM keys,
  tokens). LLM tiers are also explicitly disabled (`draft --no-llm`). Demos are offline.
- **Ephemeral cwd** — each run gets a fresh temp dir, deleted afterward. Input
  files have fixed, server-chosen names (no path traversal).
- **Timeout + output cap + input cap** — `COP_TIMEOUT_MS` (8s), `COP_MAX_OUTPUT`
  (256 KB), `COP_MAX_INPUT` (64 KB/field). Over-timeout runs are SIGKILLed.
- **Per-IP rate limit** — `COP_RATE_MAX` runs/min (in-memory; single-instance).
- **Strict CSP** on the UI; `x-content-type-options: nosniff`.

**The deploy layer MUST add what a process can't self-enforce:**

- **No outbound network egress** from the container (the CLIs need none here).
- **Resource caps** — memory, pids, CPU (`docker run --memory --pids-limit --cpus`).
- **Read-only rootfs** + a small `tmpfs` for `/tmp` (`--read-only --tmpfs /tmp`).
- A WAF / Cloudflare Turnstile in front if abuse appears.
- **Phase 2 (docx2pdf) raises the bar:** LibreOffice parsing untrusted `.docx`
  is a real RCE/macro surface — run each conversion in a **disposable** locked
  container (or gVisor/Firecracker), never in the long-lived server process, and
  disable macros. Treat it as a separate hardening task.

## Deploy (sketch — review first)

```bash
docker build -t contract-ops-playground .
docker run -p 8080:8080 \
  --read-only --tmpfs /tmp --memory 512m --pids-limit 256 --cpus 1 \
  contract-ops-playground
```
Then host it (Railway/Fly/Render — same pattern as the nda-review/sign demos)
and embed per tool page: `<iframe src="https://…/?cli=draft">`.

Pin the CLI versions in the Dockerfile to published releases before going live.

## Embedding into the site (last-mile, needs a deploy URL)

Once deployed, wire it into the showcase site (`DrBaher/Drbaher-cli`) without
breaking the static build by gating on an env var:

1. Add `PUBLIC_PLAYGROUND_URL=https://<your-playground-host>` to the site's
   Vercel env.
2. On each tool page, render an iframe only when the var is set, e.g.:
   ```astro
   {import.meta.env.PUBLIC_PLAYGROUND_URL && (
     <iframe src={`${import.meta.env.PUBLIC_PLAYGROUND_URL}/?cli=draft`}
             title="draft playground" loading="lazy"
             sandbox="allow-scripts allow-forms allow-same-origin"
             class="w-full h-[520px] rounded-lg border" />
   )}
   ```
   Map `cli=` to each tool: `draft`, `compare`, `docx2pdf`, `template-vault`.
3. Optionally add a combined `/play` page that tabs across all four.

The UI honors `?cli=<id>` and opens straight to that playground's tab, so the
per-tool iframe snippet above works as-is. Embedding the bare URL defaults to
the draft tab.

