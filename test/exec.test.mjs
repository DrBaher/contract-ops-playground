import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli, LIMITS } from "../src/exec.mjs";

const node = process.execPath;

test("captures stdout and exit 0", async () => {
  const r = await runCli([node, "-e", "process.stdout.write('hi')"]);
  assert.equal(r.stdout, "hi");
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, false);
});

test("propagates a non-zero exit code", async () => {
  const r = await runCli([node, "-e", "process.exit(4)"]);
  assert.equal(r.exitCode, 4);
});

test("writes input files into the run dir (cwd)", async () => {
  const r = await runCli(
    [node, "-e", "process.stdout.write(require('fs').readFileSync('in.txt','utf8'))"],
    { files: { "in.txt": "hello-sandbox" } },
  );
  assert.equal(r.stdout, "hello-sandbox");
});

test("reads back a produced output file as a Buffer", async () => {
  const r = await runCli(
    [node, "-e", "require('fs').writeFileSync('out.bin', Buffer.from([1,2,3]))"],
    { readOutputFile: "out.bin" },
  );
  assert.ok(Buffer.isBuffer(r.outputFile));
  assert.deepEqual([...r.outputFile], [1, 2, 3]);
});

test("does NOT leak parent secrets into the child env", async () => {
  process.env.SECRET_SHOULD_NOT_LEAK = "topsecret";
  const r = await runCli([node, "-e", "process.stdout.write(String(process.env.SECRET_SHOULD_NOT_LEAK))"]);
  assert.equal(r.stdout, "undefined");
  delete process.env.SECRET_SHOULD_NOT_LEAK;
});

test("kills runs that exceed the timeout", async () => {
  const saved = LIMITS.timeoutMs;
  LIMITS.timeoutMs = 250;
  try {
    const r = await runCli([node, "-e", "setTimeout(()=>{}, 10000)"]);
    assert.equal(r.timedOut, true);
  } finally {
    LIMITS.timeoutMs = saved;
  }
});
