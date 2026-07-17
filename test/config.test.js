import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeConfig, targetConfig, targetWorkDir, DEFAULTS } from "../src/config.js";

const BASE = {
  home: "/home",
  secretsDir: "/home/secrets",
  workDir: "/home/work",
  configPath: "/home/secrets/config.json",
};

const shared = { subject: "tides@example.com", serviceAccountKeyPath: "sa-key.json" };

test("legacy config: top-level location + calendarId → one-element targets[]", () => {
  const file = { ...shared, location: { lat: -41.3, long: 174.7, name: "Island Bay" }, calendarId: "cal-a@g" };
  const cfg = normalizeConfig(file, { ...BASE });
  assert.equal(cfg.targets.length, 1);
  assert.deepEqual(cfg.targets[0].location, { lat: -41.3, long: 174.7, name: "Island Bay" });
  assert.equal(cfg.targets[0].calendarId, "cal-a@g");
  assert.equal(cfg.targets[0].subject, "tides@example.com");
  assert.equal(cfg.targets[0].name, "Island Bay");
});

test("legacy config: missing location defaults to Long Bay coords", () => {
  const file = { ...shared, calendarId: "cal-a@g" };
  const cfg = normalizeConfig(file, { ...BASE });
  assert.deepEqual(cfg.targets[0].location, DEFAULTS.location);
});

test("multi-target: two distinct slugs + preserved per-target locations", () => {
  const file = {
    ...shared,
    targets: [
      { name: "Long Bay", location: { lat: -36.68, long: 174.74, name: "Long Bay" }, calendarId: "lb@g" },
      { name: "Island Bay", location: { lat: -41.34, long: 174.77, name: "Island Bay" }, calendarId: "ib@g" },
    ],
  };
  const cfg = normalizeConfig(file, { ...BASE });
  assert.equal(cfg.targets.length, 2);
  assert.deepEqual(cfg.targets.map((t) => t.slug), ["long-bay", "island-bay"]);
  assert.equal(cfg.targets[0].calendarId, "lb@g");
  assert.equal(cfg.targets[1].location.lat, -41.34);
});

test("multi-target: duplicate slug from identical names gets a hash suffix", () => {
  const file = {
    ...shared,
    targets: [
      { name: "Bay", calendarId: "a@g" },
      { name: "Bay", calendarId: "b@g" },
    ],
  };
  const cfg = normalizeConfig(file, { ...BASE });
  const [s1, s2] = cfg.targets.map((t) => t.slug);
  assert.equal(s1, "bay");
  assert.notEqual(s1, s2);
  assert.match(s2, /^bay-[0-9a-f]{8}$/);
});

test("multi-target: duplicate calendarId is rejected", () => {
  const file = {
    ...shared,
    targets: [
      { name: "A", calendarId: "same@g" },
      { name: "B", calendarId: "same@g" },
    ],
  };
  assert.throws(() => normalizeConfig(file, { ...BASE }), /duplicate calendarId/);
});

test("target missing calendarId is rejected", () => {
  const file = { ...shared, targets: [{ name: "A" }] };
  assert.throws(() => normalizeConfig(file, { ...BASE }), /missing calendarId/);
});

test("non-numeric coordinate is rejected", () => {
  const file = { ...shared, targets: [{ name: "A", location: { lat: "north" }, calendarId: "a@g" }] };
  assert.throws(() => normalizeConfig(file, { ...BASE }), /must be a number/);
});

test("--calendar-id override applies to a single-target legacy config", () => {
  const file = { ...shared, calendarId: "orig@g" };
  const cfg = normalizeConfig(file, { ...BASE, cli: { "calendar-id": "override@g" } });
  assert.equal(cfg.targets[0].calendarId, "override@g");
});

test("--calendar-id with a multi-target config is rejected", () => {
  const file = { ...shared, targets: [{ name: "A", calendarId: "a@g" }, { name: "B", calendarId: "b@g" }] };
  assert.throws(
    () => normalizeConfig(file, { ...BASE, cli: { "calendar-id": "x@g" } }),
    /cannot be combined with a multi-target config/
  );
});

test("missing subject / serviceAccountKeyPath are rejected", () => {
  assert.throws(() => normalizeConfig({ serviceAccountKeyPath: "k", calendarId: "a@g" }, { ...BASE }), /missing subject/);
  assert.throws(() => normalizeConfig({ subject: "s", calendarId: "a@g" }, { ...BASE }), /missing serviceAccountKeyPath/);
});

test("per-target subject override is honored", () => {
  const file = { ...shared, targets: [{ name: "A", calendarId: "a@g", subject: "other@example.com" }] };
  const cfg = normalizeConfig(file, { ...BASE });
  assert.equal(cfg.targets[0].subject, "other@example.com");
});

test("targetWorkDir + targetConfig produce a per-target view", () => {
  const file = { ...shared, targets: [{ name: "Long Bay", location: { lat: 1, long: 2, name: "Long Bay" }, calendarId: "lb@g" }] };
  const cfg = normalizeConfig(file, { ...BASE });
  const t = cfg.targets[0];
  assert.equal(targetWorkDir(cfg.workDir, t.slug), "/home/work/long-bay");
  const view = targetConfig(cfg, t);
  assert.equal(view.workDir, "/home/work/long-bay");
  assert.equal(view.calendarId, "lb@g");
  assert.deepEqual(view.location, { lat: 1, long: 2, name: "Long Bay" });
});
