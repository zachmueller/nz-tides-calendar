import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run, aggregateExit, EXIT } from "../src/run.js";

const nullLog = { info() {}, warn() {}, error() {}, notify() {} };

// A minimal 2-target normalized config (skips loadConfig/disk).
function twoTargetConfig(workDir, { dryRun = false } = {}) {
  return {
    home: workDir,
    secretsDir: path.join(workDir, "secrets"),
    workDir,
    subject: "shared@example.com",
    serviceAccountKeyPath: path.join(workDir, "sa.json"),
    eventDurationMinutes: 60,
    days: 14,
    tz: "Pacific/Auckland",
    datum: "MSL",
    dryRun,
    targets: [
      { name: "Long Bay", slug: "long-bay", location: { lat: -36.68, long: 174.74, name: "Long Bay" }, calendarId: "lb@g", subject: "shared@example.com" },
      { name: "Island Bay", slug: "island-bay", location: { lat: -41.34, long: 174.77, name: "Island Bay" }, calendarId: "ib@g", subject: "shared@example.com" },
    ],
  };
}

test("aggregateExit: worst-of by severity, not numeric max", () => {
  assert.equal(aggregateExit([EXIT.FETCH, EXIT.PARTIAL]), EXIT.FETCH); // 20 beats 22
  assert.equal(aggregateExit([EXIT.CONFIG, EXIT.AUTH]), EXIT.CONFIG);
  assert.equal(aggregateExit([EXIT.OK, EXIT.PARTIAL]), EXIT.PARTIAL);
  assert.equal(aggregateExit([EXIT.OK, EXIT.OK]), EXIT.OK);
  assert.equal(aggregateExit([EXIT.AUTH, EXIT.FETCH, EXIT.PARTIAL]), EXIT.AUTH);
  assert.equal(aggregateExit([]), EXIT.OK);
});

test("run: fans out over all targets with correct per-target config", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tc-run-"));
  const config = twoTargetConfig(tmp);
  const seen = [];
  let mintCalls = 0;

  const stages = {
    mintToken: async ({ subject }) => {
      mintCalls++;
      return `token-for-${subject}`;
    },
    fetchTides: async ({ config: c }) => {
      seen.push({ stage: "fetch", workDir: c.workDir, calendarId: c.calendarId, lat: c.location.lat });
      return { ok: true, points: 10 };
    },
    transformEvents: async ({ config: c }) => {
      seen.push({ stage: "transform", workDir: c.workDir });
      return { ok: true, counts: { total: 5 } };
    },
    syncCalendar: async ({ config: c, accessToken }) => {
      seen.push({ stage: "sync", workDir: c.workDir, calendarId: c.calendarId, accessToken });
      return { ok: true, inserted: 5, updated: 0, failed: 0, total: 5 };
    },
  };

  const { exit, summary } = await run({ config, http: {}, log: nullLog, stages });

  assert.equal(exit, EXIT.OK);
  assert.equal(mintCalls, 1, "shared subject → token minted exactly once");
  assert.equal(summary.targets.length, 2);

  // Each target's stages saw its own work subdir + calendarId.
  const lbSync = seen.find((s) => s.stage === "sync" && s.calendarId === "lb@g");
  const ibSync = seen.find((s) => s.stage === "sync" && s.calendarId === "ib@g");
  assert.equal(lbSync.workDir, path.join(tmp, "long-bay"));
  assert.equal(ibSync.workDir, path.join(tmp, "island-bay"));
  assert.equal(lbSync.accessToken, "token-for-shared@example.com");

  // Work subdirs were created on disk.
  assert.ok(fs.existsSync(path.join(tmp, "long-bay")));
  assert.ok(fs.existsSync(path.join(tmp, "island-bay")));
});

test("run: one target failing does not stop the other; exit is aggregated", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tc-run-"));
  const config = twoTargetConfig(tmp);
  const synced = [];

  const stages = {
    mintToken: async () => "tok",
    // Long Bay fetch fails; Island Bay succeeds.
    fetchTides: async ({ config: c }) =>
      c.calendarId === "lb@g" ? { ok: false, reason: "http-error-503" } : { ok: true, points: 3 },
    transformEvents: async () => ({ ok: true, counts: { total: 3 } }),
    syncCalendar: async ({ config: c }) => {
      synced.push(c.calendarId);
      return { ok: true, inserted: 3, updated: 0, failed: 0, total: 3 };
    },
  };

  const { exit, summary } = await run({ config, http: {}, log: nullLog, stages });

  // Island Bay still synced despite Long Bay's fetch failure.
  assert.deepEqual(synced, ["ib@g"]);
  assert.equal(exit, EXIT.FETCH); // worst of [FETCH, OK]
  const lb = summary.targets.find((t) => t.slug === "long-bay");
  assert.equal(lb.reason, "http-error-503");
});

test("run: partial sync on one target surfaces PARTIAL", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tc-run-"));
  const config = twoTargetConfig(tmp);
  const stages = {
    mintToken: async () => "tok",
    fetchTides: async () => ({ ok: true, points: 3 }),
    transformEvents: async () => ({ ok: true, counts: { total: 3 } }),
    syncCalendar: async ({ config: c }) =>
      c.calendarId === "lb@g"
        ? { ok: true, inserted: 2, updated: 0, failed: 1, total: 3 }
        : { ok: true, inserted: 3, updated: 0, failed: 0, total: 3 },
  };
  const { exit } = await run({ config, http: {}, log: nullLog, stages });
  assert.equal(exit, EXIT.PARTIAL);
});

test("run: token mint failure yields AUTH for every target without fetching", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tc-run-"));
  const config = twoTargetConfig(tmp);
  let fetched = 0;
  const stages = {
    mintToken: async () => {
      throw new Error("invalid_grant");
    },
    fetchTides: async () => {
      fetched++;
      return { ok: true, points: 1 };
    },
    transformEvents: async () => ({ ok: true, counts: { total: 1 } }),
    syncCalendar: async () => ({ ok: true, inserted: 1, updated: 0, failed: 0, total: 1 }),
  };
  const { exit } = await run({ config, http: {}, log: nullLog, stages });
  assert.equal(exit, EXIT.AUTH);
  assert.equal(fetched, 0, "no fetch attempted when the shared token can't be minted");
});

test("run: dry-run skips minting entirely", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tc-run-"));
  const config = twoTargetConfig(tmp, { dryRun: true });
  let mintCalls = 0;
  const stages = {
    mintToken: async () => {
      mintCalls++;
      return "tok";
    },
    fetchTides: async () => ({ ok: true, points: 1 }),
    transformEvents: async () => ({ ok: true, counts: { total: 1 } }),
    syncCalendar: async () => ({ ok: true, inserted: 0, updated: 0, failed: 0, total: 1, dryRun: true }),
  };
  const { exit } = await run({ config, http: {}, log: nullLog, stages });
  assert.equal(exit, EXIT.OK);
  assert.equal(mintCalls, 0);
});
