import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { server } from "../src/server.mjs";

let base;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function post(path, body, contentType = "application/json") {
  return fetch(base + path, { method: "POST", headers: { "content-type": contentType }, body });
}

test("GET /healthz returns ok", async () => {
  const r = await fetch(base + "/healthz");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test("unknown playground → 404 (not a crash)", async () => {
  const r = await post("/api/run/nope", "{}");
  assert.equal(r.status, 404);
});

test("non-JSON body → clean 400", async () => {
  const r = await post("/api/run/draft", "}{ not json");
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /JSON/);
});

// Regression: valid-but-non-object JSON (null/array/number) used to throw a
// TypeError on destructure and surface as a misleading 500. It must be a 400.
test("JSON 'null' body → clean 400, never 500", async () => {
  for (const id of ["draft", "compare", "nda-review", "template-vault"]) {
    const r = await post(`/api/run/${id}`, "null");
    assert.equal(r.status, 400, `${id} with null body`);
    assert.match((await r.json()).error, /object/);
  }
});

test("JSON array body → clean 400, never 500", async () => {
  const r = await post("/api/run/draft", "[1,2,3]");
  assert.equal(r.status, 400);
});

test("JSON number body → clean 400, never 500", async () => {
  const r = await post("/api/run/compare", "42");
  assert.equal(r.status, 400);
});

test("empty upload → clean 400", async () => {
  const r = await post("/api/run/docx2pdf", "", "application/octet-stream");
  assert.equal(r.status, 400);
});
