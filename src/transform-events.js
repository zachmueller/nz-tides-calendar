import fs from "node:fs";
import { workPath } from "./config.js";

// Ported from the Notor `transform-events` step — the purest stage. `classify`
// and `toLocalParts` are lifted verbatim. Two deliberate deltas vs. the source:
//   (a) the ±30-min window becomes a configurable eventDurationMinutes (default
//       60 reproduces the original 1-hour block exactly);
//   (b) the location name comes from config (default "Auckland Downtown Ferry Terminal").
// Title casing is unchanged from the current source (asymmetric caps:
// "HIGH TIDE" / "low tide"). The event id downstream keys off tideType|utc, so
// title casing never affects idempotency.
//
// buildEvents is pure (no I/O): feed it a parsed NIWA payload and options, get
// back { json, md, counts }. `now` is injectable so tests can assert byte-stable
// output. The transformEvents wrapper handles the raw-tides.json → tide-events.*
// file round-trip.

// Classify each point vs. its neighbours. NIWA returns alternating extrema, so a
// point >= the neighbour(s) present is a HIGH tide, <= is a LOW. Endpoints use
// their single available neighbour. High is checked first, so it wins ties.
function classify(values, i) {
  const cur = values[i].value;
  const prev = i > 0 ? values[i - 1].value : null;
  const next = i < values.length - 1 ? values[i + 1].value : null;
  const neighbours = [prev, next].filter((v) => v !== null);
  if (neighbours.every((n) => cur >= n)) return "high";
  if (neighbours.every((n) => cur <= n)) return "low";
  // Shouldn't happen with clean alternating data; fall back to sign of slope.
  return next !== null && cur >= next ? "high" : "low";
}

// Format a UTC instant as a local offset datetime string suitable for a calendar
// event, e.g. "2026-07-13T05:12:00+12:00". Recovers the real local offset from
// Intl parts, so it handles the NZDT/NZST transition automatically.
function toLocalParts(date, tz) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  // Intl (en-CA, hour12:false) reports local midnight as hour "24" on the
  // correct day, not "00". Normalize to 0 BEFORE the offset math: the original
  // step only guarded the *displayed* hour and still fed "24" into Date.UTC,
  // which rolls over a full day and corrupts the offset (e.g. a boundary on
  // local midnight yielded "…T00:00:00+37:00"). Non-midnight inputs are
  // unaffected (hourNum === +p.hour). This completes the author's evident intent.
  const hourNum = p.hour === "24" ? 0 : +p.hour;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hourNum, +p.minute, +p.second);
  const offsetMin = Math.round((asUTC - date.getTime()) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  const hh = String(hourNum).padStart(2, "0");
  return {
    iso: `${p.year}-${p.month}-${p.day}T${hh}:${p.minute}:${p.second}${sign}${oh}:${om}`,
    display: `${p.year}-${p.month}-${p.day} ${hh}:${p.minute}`,
  };
}

export function buildEvents(data, { tz = "Pacific/Auckland", eventDurationMinutes = 60, locationName = "Auckland Downtown Ferry Terminal", now } = {}) {
  const values = Array.isArray(data?.values) ? data.values : [];
  const halfWindowMs = (eventDurationMinutes / 2) * 60 * 1000;
  const generatedAt = now ?? new Date().toISOString();

  const events = values.map((pt, i) => {
    const tideType = classify(values, i);
    const height = pt.value;
    const center = new Date(pt.time); // NIWA time is UTC (Z-suffixed)
    const start = new Date(center.getTime() - halfWindowMs);
    const end = new Date(center.getTime() + halfWindowMs);
    const label = tideType === "high" ? "HIGH TIDE" : "low tide";
    return {
      title: `${label} (${height.toFixed(2)}m)`,
      tideType,
      height,
      utc: pt.time,
      start: toLocalParts(start, tz).iso,
      end: toLocalParts(end, tz).iso,
      timeZone: tz,
      _centerDisplay: toLocalParts(center, tz).display,
    };
  });

  const highs = events.filter((e) => e.tideType === "high").length;
  const lows = events.length - highs;

  // Machine-readable handoff. Strip the display-only field.
  const jsonEvents = events.map(({ _centerDisplay, ...e }) => e);
  const json = {
    location: { name: locationName, lat: data?.metadata?.latitude, long: data?.metadata?.longitude },
    generatedAt,
    timeZone: tz,
    events: jsonEvents,
  };

  // Human-readable review artifact.
  const durationLabel = eventDurationMinutes === 60 ? "1 hr" : `${eventDurationMinutes} min`;
  const rows = events
    .map(
      (e) =>
        `| ${e._centerDisplay} | ${e.tideType === "high" ? "🔼 High" : "🔽 Low"} | ${e.height.toFixed(2)} m | ${e.start} → ${e.end} |`
    )
    .join("\n");
  const md = `# Tide events — ${locationName}

Generated ${generatedAt} • ${events.length} events (${highs} high, ${lows} low) • times in ${tz}

| Tide (local) | Type | Height | Event window (${durationLabel}, local) |
|---|---|---|---|
${rows}

> These events are synced to the dedicated "${locationName} Tides" Google Calendar by the sync stage. The machine-readable source is \`tide-events.json\`.
`;

  return { json, md, counts: { total: events.length, highs, lows } };
}

// File wrapper: read raw-tides.json, build, and overwrite tide-events.{json,md}.
// Returns { ok, counts } or { ok:false, reason } (no-values | events-read-failed).
export function transformEvents({ config, log }) {
  const { workDir, tz, eventDurationMinutes, location } = config;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(workPath(workDir, "raw-tides.json"), "utf8"));
  } catch (e) {
    log.error("events-read-failed", { error: String(e?.message ?? e) });
    return { ok: false, reason: "events-read-failed" };
  }

  const values = Array.isArray(data?.values) ? data.values : [];
  if (values.length === 0) {
    log.notify("Tide Calendar: no tide points to transform.");
    return { ok: false, reason: "no-values" };
  }

  const { json, md, counts } = buildEvents(data, {
    tz,
    eventDurationMinutes,
    locationName: location.name,
  });

  fs.writeFileSync(workPath(workDir, "tide-events.json"), JSON.stringify(json, null, 2));
  fs.writeFileSync(workPath(workDir, "tide-events.md"), md);

  log.info("transformed", { events: counts.total, highs: counts.highs, lows: counts.lows });
  log.notify(
    `Tide Calendar: built ${counts.total} calendar event(s) — ${counts.highs} high / ${counts.lows} low. Syncing to Google Calendar…`
  );
  return { ok: true, counts };
}
