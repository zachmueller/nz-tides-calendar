import crypto from "node:crypto";
import fs from "node:fs";
import { workPath } from "./config.js";

// Ported from the Notor `sync-calendar` step. The JWT construction, token
// exchange, base32hex event-id derivation, and insert→update-on-409 upsert are
// lifted verbatim; libs.crypto → node:crypto and obsidian.requestUrl → the
// injected http shim. mintAccessToken / eventId / base32hex are exported so
// doctor reuses the auth path and the tests snapshot the id derivation.

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/calendar.events";

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Deterministic event id per tide point: base32hex(SHA-256(calendarId|tideType|utc)).
// Google requires ids in [a-v0-9], length 5–1024. base32hex uses exactly 0-9 + a-v.
const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";
export function base32hex(bytes) {
  let bits = 0,
    value = 0,
    out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32HEX[(value << (5 - bits)) & 31];
  return out;
}

export function eventId(ev, calendarId) {
  const digest = crypto
    .createHash("sha256")
    .update(`${calendarId}|${ev.tideType}|${ev.utc}`)
    .digest();
  // 256-bit digest → 52 base32hex chars; well within Google's 5–1024 bound.
  return base32hex(digest);
}

// Mint a short-lived access token via the JWT-bearer grant (service account +
// domain-wide delegation). Signs the JWT in-process (RS256) so the private key
// never lands on a command line or in a log; impersonates config.subject via
// the `sub` claim. Throws on failure (caller maps to reason "token-exchange-failed").
export async function mintAccessToken({ config, sa, http }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    sub: config.subject, // impersonation target (DWD)
    scope: SCOPE,
    aud: TOKEN_URI,
    iat: now,
    exp: now + 3600, // Google caps assertion lifetime at 1h
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(sa.private_key);
  const assertion = `${signingInput}.${b64url(signature)}`;

  const tokenRes = await http({
    url: TOKEN_URI,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}` +
      `&assertion=${encodeURIComponent(assertion)}`,
  });
  if (tokenRes.status < 200 || tokenRes.status >= 300) {
    // Body may name the failure (e.g. invalid_grant if DWD/scope isn't authorized).
    throw new Error(
      `token exchange HTTP ${tokenRes.status}: ${JSON.stringify(tokenRes.json ?? tokenRes.text)?.slice(0, 300)}`
    );
  }
  const accessToken = tokenRes.json?.access_token;
  if (!accessToken) throw new Error("token response had no access_token");
  return accessToken;
}

// Build the Google Calendar event body for one tide event. Kept separate so
// --dry-run can log exactly what would be sent.
export function eventBody(ev, id) {
  return {
    id,
    status: "confirmed", // explicit: revive the event if it was cancelled (deleted)
    summary: ev.title,
    start: { dateTime: ev.start, timeZone: ev.timeZone },
    end: { dateTime: ev.end, timeZone: ev.timeZone },
    description:
      `${ev.tideType === "high" ? "HIGH TIDE" : "low tide"} • ${Number(ev.height).toFixed(2)} m • ` +
      `tide at ${ev.utc} (UTC). Auto-synced by the Tide Calendar CLI.`,
    transparency: "transparent", // free/busy: don't block time for an informational event
  };
}

// `accessToken` is optional: when the orchestrator (run.js) has already minted
// a token for the shared subject it injects it here so N targets reuse one
// token. When absent (e.g. a standalone single-target `sync`), we mint our own.
export async function syncCalendar({ config, http, log, accessToken: injectedToken } = {}) {
  const { workDir, calendarId, serviceAccountKeyPath, dryRun } = config;

  // --- 0. Load the transformed events (handoff artifact from transform-events). ---
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(workPath(workDir, "tide-events.json"), "utf8"));
  } catch (e) {
    log.notify("Tide Calendar: could not read tide-events.json — nothing to sync.");
    log.error("events-read-failed", { error: String(e?.message ?? e) });
    return { ok: false, reason: "events-read-failed" };
  }
  const events = Array.isArray(payload?.events) ? payload.events : [];
  if (events.length === 0) {
    log.notify("Tide Calendar: no tide events to sync.");
    return { ok: true, inserted: 0, updated: 0, failed: 0, total: 0 };
  }

  // --- Dry run: log the intended upsert plan, mutate nothing. Needs neither the
  // SA key nor a token. ---
  if (dryRun) {
    for (const ev of events) {
      const id = eventId(ev, calendarId);
      log.info("dry-run-upsert", { id, summary: ev.title, start: ev.start, end: ev.end });
    }
    log.notify(`Tide Calendar (dry-run): would upsert ${events.length} event(s); no calendar writes made.`);
    return { ok: true, inserted: 0, updated: 0, failed: 0, total: events.length, dryRun: true };
  }

  // --- 1. Obtain an access token. Reuse an injected one (shared across targets)
  // when present; otherwise read the SA key and mint our own. ---
  let accessToken = injectedToken;
  if (!accessToken) {
    let sa;
    try {
      sa = JSON.parse(fs.readFileSync(serviceAccountKeyPath, "utf8"));
      if (!sa.client_email || !sa.private_key) {
        throw new Error("service-account key missing client_email / private_key");
      }
    } catch (e) {
      log.notify("Tide Calendar: could not read the Google service-account key.");
      log.error("config-read-failed", { error: String(e?.message ?? e) });
      return { ok: false, reason: "config-read-failed" };
    }
    try {
      accessToken = await mintAccessToken({ config, sa, http });
    } catch (e) {
      log.notify("Tide Calendar: Google token exchange failed — check DWD scope authorization.");
      log.error("token-exchange-failed", { error: String(e?.message ?? e) });
      return { ok: false, reason: "token-exchange-failed" };
    }
  }

  // --- 3. Upsert each event so every run reconciles the calendar to desired state.
  // Try insert; on 409 (id exists, possibly cancelled) PUT update with the full
  // body, which overwrites fields AND flips status back to confirmed (un-delete).
  // Deliberately NOT guarded by any once-wrapper: a re-run SHOULD re-push edits.
  const calId = encodeURIComponent(calendarId);
  const eventsUrl = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events`;

  const gcal = (method, url, body) =>
    http({
      url,
      method,
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  let inserted = 0,
    updated = 0,
    failed = 0;
  for (const ev of events) {
    const id = eventId(ev, calendarId);
    const body = eventBody(ev, id);
    try {
      // 1) Try to create it.
      const ins = await gcal("POST", eventsUrl, body);
      if (ins.status >= 200 && ins.status < 300) {
        inserted++;
        continue;
      }
      if (ins.status !== 409) {
        throw new Error(`insert HTTP ${ins.status}: ${JSON.stringify(ins.json ?? ins.text)?.slice(0, 200)}`);
      }
      // 2) 409 → reconcile via update (PUT).
      const upd = await gcal("PUT", `${eventsUrl}/${id}`, body);
      if (upd.status >= 200 && upd.status < 300) {
        updated++;
        continue;
      }
      throw new Error(`update HTTP ${upd.status}: ${JSON.stringify(upd.json ?? upd.text)?.slice(0, 200)}`);
    } catch (e) {
      failed++;
      log.warn("upsert-failed", { id, tideType: ev.tideType, utc: ev.utc, error: String(e?.message ?? e) });
    }
  }

  const summary = { inserted, updated, failed, total: events.length };
  log.info("sync-complete", summary);
  log.notify(
    `Tide Calendar: synced tides — ${inserted} new, ${updated} updated` +
      (failed ? `, ${failed} failed` : "") +
      "."
  );
  return { ok: true, ...summary };
}
