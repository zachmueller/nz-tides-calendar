import fs from "node:fs";
import { secretsPath, workPath } from "./config.js";

// Ported from the Notor `fetch-tides` step. The NIWA request logic is lifted
// verbatim; only the ambient calls change:
//   - the NIWA key is read from secrets/niwa.json (was a vault-relative read),
//   - LAT/LONG/DATUM/numberOfDays come from config (were hardcoded constants),
//   - obsidian.requestUrl → the injected httpRequest shim,
//   - orchestration.emit(...) → a returned { ok, ... } / { ok:false, reason }.
//
// Returns { ok:true, points } on success, or { ok:false, reason } for a
// soft failure (run.js maps the reason to an exit code). The URL is assembled
// WITHOUT the key first; `&apikey=` is appended only at call time so the key
// never lands in a log.

const NIWA_SECRET_NAME = "niwa.json";

export async function fetchTides({ config, http, log }) {
  const { secretsDir, workDir, location, datum, days } = config;

  // --- 1. Read the API key from the gitignored secrets file (never inline it). ---
  let apiKey;
  try {
    const keyFile = secretsPath(secretsDir, NIWA_SECRET_NAME);
    apiKey = JSON.parse(fs.readFileSync(keyFile, "utf8")).apiKey;
    if (!apiKey) throw new Error("apiKey missing from secrets file");
  } catch (e) {
    log.notify(`Tide Calendar: could not read NIWA API key from secrets/${NIWA_SECRET_NAME}.`);
    log.error("secret-read-failed", { error: String(e?.message ?? e) });
    return { ok: false, reason: "secret-read-failed" };
  }

  // --- 2. Compute today's date in NZ local time (YYYY-MM-DD). ---
  // The NIWA startDate is a calendar date; anchor it to Pacific/Auckland so the
  // window lines up with local days regardless of where this runs.
  const nzDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()); // en-CA → "YYYY-MM-DD"
  log.info("window", { startDate: nzDate, days });

  // --- 3. Call the NIWA Tides API. Build the URL WITHOUT the key first; the key
  // is only appended at call time and is never echoed to a log.
  const baseUrl =
    `https://api.niwa.co.nz/tides/data?lat=${location.lat}&long=${location.long}` +
    `&datum=${datum}&numberOfDays=${days}&startDate=${nzDate}`;
  const fullUrl = `${baseUrl}&apikey=${apiKey}`;

  let res;
  try {
    res = await http({ url: fullUrl, method: "GET" });
  } catch (e) {
    log.error("request-threw", { error: String(e?.message ?? e) });
    return { ok: false, reason: "request-threw" };
  }
  if (res.status < 200 || res.status >= 300) {
    // Include the body (not the URL) so an API error message is visible in the log.
    log.error("http-nonzero", { status: res.status, body: (res.text || "").slice(0, 500) });
    log.notify(`Tide Calendar: NIWA request failed (HTTP ${res.status}).`);
    return { ok: false, reason: `http-error-${res.status}` };
  }

  // --- 4. Validate the JSON shape. ---
  let data;
  try {
    data = res.json ?? JSON.parse(res.text);
  } catch {
    log.notify("Tide Calendar: NIWA response was not valid JSON.");
    return { ok: false, reason: "invalid-json" };
  }
  const values = Array.isArray(data?.values) ? data.values : null;
  if (!values || values.length === 0) {
    log.notify("Tide Calendar: NIWA response contained no tide values.");
    return { ok: false, reason: "no-values" };
  }
  // Spot-check the first point has the fields transform-events depends on.
  const first = values[0];
  if (typeof first?.time !== "string" || typeof first?.value !== "number") {
    log.notify("Tide Calendar: tide values missing time/value fields.");
    return { ok: false, reason: "missing-fields" };
  }

  // --- 5. Persist raw JSON (overwrite-only, re-run safe). Key is NOT stored. ---
  fs.writeFileSync(workPath(workDir, "raw-tides.json"), JSON.stringify(data, null, 2));

  log.notify(`Tide Calendar: fetched ${values.length} tide point(s) for the ${days} days from ${nzDate}.`);
  return { ok: true, points: values.length };
}
