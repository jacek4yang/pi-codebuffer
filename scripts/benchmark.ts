import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { harness, jsonOf, textOf } from "../test/harness.js";
import { bytes } from "../src/text.js";
const reports = [];
for (const protocol of ["legacy", "fused"] as const) {
  const h = await harness();
  const report = {
    protocol,
    calls: 0,
    requestBytes: 0,
    responseBytes: 0,
    providerRequestBytes: 0,
    providerResponseBytes: 0,
    providerRequests: 0,
    sourceSubmittedBytes: 0,
    repairBodyBytes: 0,
    schemaBytes: 0,
    exampleBytes: 0,
    elapsedMs: 0,
    status: {} as unknown,
    correct: true,
  };
  const started = performance.now();
  try {
    const s = await h.make();
    const call = async (args: Record<string, unknown>) => {
      report.calls++;
      report.requestBytes += bytes(
        JSON.stringify({ name: "codebuffer", arguments: args }),
      );
      if (typeof args.source === "string")
        report.sourceSubmittedBytes += bytes(args.source);
      const before = h.payloads.length;
      const beforeResponse = h.wire.responseBytes;
      const out = await h.call(s, args);
      report.responseBytes += bytes(JSON.stringify(out));
      report.providerRequests += h.payloads.length - before;
      report.providerResponseBytes += h.wire.responseBytes - beforeResponse;
      for (const p of h.payloads.slice(before)) {
        report.providerRequestBytes += bytes(JSON.stringify(p));
        report.schemaBytes += bytes(JSON.stringify(p.tools ?? []));
      }
      return out;
    };
    const clean = async (name: string, source: string) => {
      if (protocol === "legacy") {
        await call({ action: "create", name, source });
        return call({ action: "run", name, revision: 1 });
      }
      return call({ action: "exec", source });
    };
    assert.equal((await clean("clean", "text(42);")).isError, false);
    for (const [name, source, old, replacement] of [
      ["syntax", "//" + "x".repeat(12288) + "\ntext(42;", "42;", "42);"],
      [
        "runtime",
        "//" + "x".repeat(12288) + "\ntext(missing);",
        "missing",
        "42",
      ],
    ]) {
      const bad = await clean(name!, source!);
      assert.equal(bad.isError, true, textOf(bad));
      let fixed;
      if (protocol === "legacy") {
        report.repairBodyBytes += bytes(old!) + bytes(replacement!);
        await call({
          action: "patch",
          name,
          baseRevision: 1,
          old,
          replacement,
        });
        fixed = await call({ action: "run", name, revision: 2 });
      } else {
        const ref = jsonOf(bad);
        report.repairBodyBytes += bytes(old!) + bytes(replacement!);
        fixed = await call({
          action: "repair",
          ref: ref.ref,
          base: ref.base,
          rerun: "from-start",
          edit: { format: "replace", edits: [{ old, replacement }] },
        });
      }
      assert.equal(fixed.isError, false, textOf(fixed));
    }
    for (let i = 0; i < 20; i++)
      assert.equal(
        (await clean("independent" + i, "text(" + i + ");")).isError,
        false,
      );
    const body = JSON.stringify("z".repeat(8192));
    const source = "const block = " + body + "; text(block.length);";
    const first = await clean("block", source);
    assert.equal(first.isError, false);
    let last;
    if (protocol === "legacy") {
      report.repairBodyBytes += bytes(body) + 2;
      await call({
        action: "patch",
        name: "block",
        baseRevision: 1,
        old: body,
        replacement: JSON.stringify(""),
      });
      last = await call({ action: "run", name: "block", revision: 2 });
    } else {
      const ref = jsonOf(first);
      report.repairBodyBytes += 2;
      last = await call({
        action: "repair",
        ref: ref.ref,
        base: ref.base,
        rerun: "from-start",
        edit: {
          format: "range",
          edits: [
            { start: 14, end: 14 + body.length, text: JSON.stringify("") },
          ],
        },
      });
    }
    assert.equal(last.isError, false, textOf(last));
    // Observation excluded from workload call/byte totals for both protocols.
    report.status = jsonOf(await h.call(s, { action: "status" }));
    report.elapsedMs = performance.now() - started;
  } finally {
    await h.close();
  }
  reports.push(report);
}
const result = {
  method:
    "Same candidate, real Pi1.0.0 SDK + QuickJS, local deterministic SSE provider. Complete tool request/result envelopes; schema bytes counted from all provider requests. No tokens/billing claim. No examples sent separately. Elapsed time includes provider fixture and session history. 24 programs + 3 repairs. Status observation excluded.",
  node: process.version,
  reports,
};
const json = JSON.stringify(result, null, 2) + "\n";
if (process.argv[2]) writeFileSync(process.argv[2], json);
console.log(json);
