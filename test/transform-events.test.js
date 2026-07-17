import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildEvents } from "../src/transform-events.js";
import { eventId, base32hex } from "../src/sync-calendar.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(path.join(__dirname, "fixtures", name), "utf8"));

const sample = fixture("niwa-sample.json"); // 54 real captured NIWA points (July → NZST)
const dst = fixture("niwa-dst-sample.json"); // straddles the 2026 NZDT→NZST transition
const FIXED = "2026-01-01T00:00:00.000Z"; // pin generatedAt so output is byte-stable

test("classify: alternating series → strict high/low alternation", () => {
  const { json, counts } = buildEvents(sample, { now: FIXED });
  const types = json.events.map((e) => e.tideType);
  // The real feed alternates; every neighbour pair must differ.
  for (let i = 1; i < types.length; i++) {
    assert.notEqual(types[i], types[i - 1], `points ${i - 1},${i} should alternate`);
  }
  assert.equal(counts.total, 54);
  assert.equal(counts.highs + counts.lows, 54);
});

test("classify: endpoints use their single neighbour", () => {
  // First point (-1.27) < next (1.21) → low; last point (1.08) > prev (-1.03) → high.
  const { json } = buildEvents(sample, { now: FIXED });
  assert.equal(json.events[0].tideType, "low");
  assert.equal(json.events.at(-1).tideType, "high");
});

test("classify: high wins an exact tie (>= checked before <=)", () => {
  const flat = { metadata: {}, values: [{ time: "2026-07-16T00:00:00Z", value: 1.0 }, { time: "2026-07-16T06:00:00Z", value: 1.0 }] };
  const { json } = buildEvents(flat, { now: FIXED });
  // Both equal → both satisfy >= all neighbours → both classified high.
  assert.deepEqual(json.events.map((e) => e.tideType), ["high", "high"]);
});

test("timezone: NZST (July) yields +12:00 offsets", () => {
  const { json } = buildEvents(sample, { now: FIXED });
  assert.ok(json.events.every((e) => e.start.endsWith("+12:00") && e.end.endsWith("+12:00")));
  // Spot-check the first event's exact window (center 15:00Z − 30m → 02:30 local).
  assert.equal(json.events[0].start, "2026-07-17T02:30:00+12:00");
  assert.equal(json.events[0].end, "2026-07-17T03:30:00+12:00");
});

test("timezone: series across the NZDT→NZST transition mixes +13:00 and +12:00", () => {
  const { json } = buildEvents(dst, { now: FIXED });
  const offsets = json.events.map((e) => e.start.slice(-6));
  assert.ok(offsets.includes("+13:00"), "expected some NZDT (+13:00) events");
  assert.ok(offsets.includes("+12:00"), "expected some NZST (+12:00) events");
  // The last point (after the transition) is NZST.
  assert.equal(json.events.at(-1).start, "2026-04-05T11:30:00+12:00");
});

test("timezone: a boundary on local midnight is not corrupted (24→00 guard)", () => {
  // Regression: the original fed Intl's hour "24" into Date.UTC, producing a
  // bogus "+37:00" offset. It must be clean local midnight at the right offset.
  const { json } = buildEvents(dst, { now: FIXED });
  const midnight = json.events[0]; // center 11:30Z − 30m = 11:00Z → 00:00 NZDT
  assert.equal(midnight.start, "2026-04-04T00:00:00+13:00");
  assert.ok(!/\+3\d:/.test(midnight.start), "offset must never exceed a real TZ offset");
});

test("eventDurationMinutes: default 60 → ±30-min (1-hour) block", () => {
  const { json } = buildEvents(sample, { now: FIXED });
  const e = json.events[0];
  assert.equal(new Date(e.end) - new Date(e.start), 60 * 60 * 1000);
});

test("eventDurationMinutes: custom 90 → ±45-min window centered on the tide", () => {
  const { json } = buildEvents(sample, { now: FIXED, eventDurationMinutes: 90 });
  const e = json.events[0]; // center 2026-07-16T15:00:00Z
  assert.equal(new Date(e.end) - new Date(e.start), 90 * 60 * 1000);
  assert.equal(e.start, "2026-07-17T02:15:00+12:00"); // 15:00Z − 45m = 02:15 local
  assert.equal(e.end, "2026-07-17T03:45:00+12:00"); // 15:00Z + 45m = 03:45 local
});

test("title: asymmetric caps (HIGH TIDE / low tide)", () => {
  const { json } = buildEvents(sample, { now: FIXED });
  assert.equal(json.events[0].title, "low tide (-1.27m)");
  assert.equal(json.events[1].title, "HIGH TIDE (1.21m)");
});

test("base32hex: encodes into Google's [a-v0-9] alphabet", () => {
  const out = base32hex(Buffer.from([0xff, 0x00, 0xab, 0xcd]));
  assert.match(out, /^[a-v0-9]+$/);
});

test("eventId: stable snapshot guards idempotency", () => {
  // SHA-256(calId|tideType|utc) base32hex — must never drift or existing events
  // would orphan. Snapshot against a placeholder calendar id.
  const calId = "test-calendar@group.calendar.google.com";
  assert.equal(
    eventId({ tideType: "high", utc: "2026-07-16T21:02:00Z" }, calId),
    "1mfqvk905fei2q0vjeeu1sm77hqcsl6rl653p7rqmdfh92shs97g"
  );
  assert.equal(
    eventId({ tideType: "low", utc: "2026-07-16T15:00:00Z" }, calId),
    "1a49ffiqvgcuvaj5e26flerdb4reo9vubrc4qm7vnkc7r9i3enpg"
  );
  // Id is independent of title/height — only tideType + utc + calId feed it.
  assert.equal(
    eventId({ tideType: "high", utc: "2026-07-16T21:02:00Z", height: 99, title: "x" }, calId),
    eventId({ tideType: "high", utc: "2026-07-16T21:02:00Z" }, calId)
  );
});

test("determinism: same input → byte-identical JSON (modulo generatedAt)", () => {
  const a = buildEvents(sample, { now: FIXED });
  const b = buildEvents(sample, { now: FIXED });
  assert.equal(JSON.stringify(a.json), JSON.stringify(b.json));
});

test("parity: matches the real captured artifact on every field except title", () => {
  // Same NIWA input the deployed Notor step consumed; the expected artifact was
  // produced by that step. All geometry/timing/id-driving fields must match; only
  // the deliberately-changed title casing differs (expected has old sentence case).
  const expected = fixture("tide-events-expected.json");
  const { json } = buildEvents(sample, {
    now: expected.generatedAt,
    tz: expected.timeZone,
    locationName: expected.location.name,
  });
  assert.equal(json.events.length, expected.events.length);
  for (let i = 0; i < expected.events.length; i++) {
    const got = json.events[i];
    const exp = expected.events[i];
    assert.equal(got.tideType, exp.tideType, `event ${i} tideType`);
    assert.equal(got.height, exp.height, `event ${i} height`);
    assert.equal(got.utc, exp.utc, `event ${i} utc`);
    assert.equal(got.start, exp.start, `event ${i} start`);
    assert.equal(got.end, exp.end, `event ${i} end`);
    assert.equal(got.timeZone, exp.timeZone, `event ${i} timeZone`);
  }
  assert.deepEqual(json.location, expected.location);
});

test("empty input: no values → zero events", () => {
  const { json, counts } = buildEvents({ metadata: {}, values: [] }, { now: FIXED });
  assert.equal(counts.total, 0);
  assert.deepEqual(json.events, []);
});
