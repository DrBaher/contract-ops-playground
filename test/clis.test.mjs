import { test } from "node:test";
import assert from "node:assert/strict";
import { PLAYGROUNDS, HttpError } from "../src/clis.mjs";

test("seven playgrounds are registered", () => {
  assert.deepEqual(
    Object.keys(PLAYGROUNDS).sort(),
    ["compare", "docx2pdf", "draft", "extract", "nda-review", "sign", "template-vault"],
  );
});

test("extract build: pasted text → contract.md + --json", () => {
  const b = PLAYGROUNDS.extract.build({ text: "# NDA\n\nBetween A and B." });
  assert.ok(b.argv.includes("contract.md") && b.argv.includes("--json"));
  assert.equal(b.files["contract.md"], "# NDA\n\nBetween A and B.");
  // deterministic tier only — never opts into the networked LLM tier
  assert.ok(!b.argv.includes("--llm"));
});

test("extract build: empty text is tolerated (no crash)", () => {
  const b = PLAYGROUNDS.extract.build({});
  assert.equal(b.files["contract.md"], "");
});

test("extract upload build: .docx buffer → contract.docx + --json", () => {
  const b = PLAYGROUNDS.extract.upload.build(Buffer.from("PK\x03\x04"));
  assert.ok(b.argv.includes("contract.docx") && b.argv.includes("--json"));
  assert.ok(Buffer.isBuffer(b.files["contract.docx"]));
  assert.equal(typeof b.timeoutMs, "number");
});

test("extract shape: exit 0 → ok + parsed result", () => {
  const s = PLAYGROUNDS.extract.shape({ exitCode: 0, stdout: '{"parties":[]}', stderr: "", timedOut: false });
  assert.equal(s.ok, true);
  assert.equal(s.lowSignal, false);
  assert.deepEqual(s.result, { parties: [] });
});

test("extract shape: exit 1 is a low-signal finding, not a failure (JSON still surfaced)", () => {
  const s = PLAYGROUNDS.extract.shape({ exitCode: 1, stdout: '{"parties":[]}', stderr: "warn", timedOut: false });
  assert.equal(s.ok, false);
  assert.equal(s.lowSignal, true);
  assert.deepEqual(s.result, { parties: [] });
});

test("draft build: template + params → argv/files, --no-llm always on", () => {
  const b = PLAYGROUNDS.draft.build({ template: "[X]", params: '{"x":1}' });
  assert.ok(b.argv.includes("--no-llm"));
  assert.ok(b.argv.includes("--params"));
  assert.equal(b.files["template.md"], "[X]");
  assert.equal(b.files["params.json"], '{"x":1}');
});

test("draft build: omits --params when none given", () => {
  const b = PLAYGROUNDS.draft.build({ template: "x" });
  assert.ok(!b.argv.includes("--params"));
});

test("draft build: rejects invalid params JSON with 400", () => {
  assert.throws(
    () => PLAYGROUNDS.draft.build({ template: "x", params: "not json" }),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

test("compare build: writes both versions + --json", () => {
  const b = PLAYGROUNDS.compare.build({ base: "a", candidate: "b" });
  assert.deepEqual(Object.keys(b.files).sort(), ["base.md", "candidate.md"]);
  assert.ok(b.argv.includes("--json"));
});

test("compare shape: exit code → drift meaning", () => {
  const s = PLAYGROUNDS.compare.shape({ exitCode: 2, stdout: "{}", stderr: "", timedOut: false });
  assert.equal(s.exitCode, 2);
  assert.match(s.meaning, /substantive/);
  assert.equal(s.ok, false);
});

test("docx2pdf build: upload buffer → in.docx, reads back out.pdf", () => {
  const b = PLAYGROUNDS.docx2pdf.build(Buffer.from("x"));
  assert.ok(b.argv.includes("in.docx") && b.argv.includes("out.pdf"));
  assert.equal(b.readOutputFile, "out.pdf");
  assert.ok(Buffer.isBuffer(b.files["in.docx"]));
});

test("template-vault build: rejects non-whitelisted (mutating) action with 400", () => {
  assert.throws(
    () => PLAYGROUNDS["template-vault"].build({ action: "upload", arg: "x" }),
    (e) => e instanceof HttpError && e.status === 400,
  );
});

test("template-vault build: a valid action with no seeded vault is 503 (not a crash)", () => {
  // getSeedVault() is null in unit tests (seedVault never ran).
  assert.throws(
    () => PLAYGROUNDS["template-vault"].build({ action: "list" }),
    (e) => e instanceof HttpError && e.status === 503,
  );
});

test("nda-review build: review --file --playbook --why on the pasted text", () => {
  const b = PLAYGROUNDS["nda-review"].build({ text: "Mutual NDA." });
  assert.ok(b.argv.includes("review") && b.argv.includes("--why") && b.argv.includes("--playbook"));
  assert.equal(b.files["nda.txt"], "Mutual NDA.");
});

test("sign build: offline demo → reads back the signed PDF", () => {
  const b = PLAYGROUNDS.sign.build();
  assert.ok(b.argv.includes("demo"));
  assert.equal(b.readOutputFile, "demo-bundle/signed.pdf");
});

test("sign build: explorer actions need the seed; unknown action rejected", () => {
  assert.throws(() => PLAYGROUNDS.sign.build({ action: "audit" }), /not seeded|not available/);
  assert.throws(() => PLAYGROUNDS.sign.build({ action: "bogus" }), /action must be one of/);
});

test("sign shape: surfaces audit result + base64 PDF", () => {
  const s = PLAYGROUNDS.sign.shape({
    exitCode: 0, stdout: '{"auditChainValid":true}', stderr: "", timedOut: false,
    outputFile: Buffer.from("%PDF-1.7"),
  });
  assert.equal(s.ok, true);
  assert.equal(s.result.auditChainValid, true);
  assert.ok(s.pdfBase64.length > 0);
});
