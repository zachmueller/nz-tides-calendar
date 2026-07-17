import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// Owns the user-facing configuration surface: the user-private home, the
// config.json schema, and the flag > env > file > default precedence for the
// account-targeting fields. Secrets (the NIWA key and the SA key) are read by
// their own stages so each keeps its distinct failure reason; this module only
// loads config.json and resolves paths.

// A config/secret problem the caller maps to exit code 10. Carries a `.reason`
// string so run.js / doctor can classify it.
export class ConfigError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = "ConfigError";
    this.reason = reason;
  }
}

export const DEFAULTS = {
  // Default fetch-tides request coordinates (NIWA snaps to a nearby station in
  // the response metadata, which flows into the output location).
  location: { lat: -36.84278, long: 174.766953, name: "Auckland Downtown Ferry Terminal" },
  eventDurationMinutes: 60, // ±30 min → the original 1-hour block
  days: 14,
  tz: "Pacific/Auckland",
  datum: "MSL",
  logFormat: "json",
};

const CONFIG_NAME = "config.json";
const LEGACY_CONFIG_NAME = "long-bay-tides-config.json";
const SECRETS_MODE = 0o700;
const KEY_FILE_MODE = 0o600;

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// --- Home resolution + directory scaffolding --------------------------------

// Resolve TIDE_CAL_HOME (flag > env > ~/.tide-calendar), ensure secrets/ + work/
// exist, and lock secrets/ to owner-only. `create` is false for read-only
// commands that shouldn't materialize a home (kept true by default — mkdir is
// idempotent and cheap).
export function resolveHome({ homeFlag, env = process.env, create = true } = {}) {
  const raw = homeFlag || env.TIDE_CAL_HOME || path.join(os.homedir(), ".tide-calendar");
  const home = path.resolve(expandHome(raw));
  const secretsDir = path.join(home, "secrets");
  const workDir = path.join(home, "work");

  if (create) {
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    // mkdir mode is masked by umask; lock the private home + secrets dir
    // explicitly to owner-only (doctor hard-fails on a group/world-readable home).
    try {
      fs.chmodSync(home, SECRETS_MODE);
      fs.chmodSync(secretsDir, SECRETS_MODE);
    } catch {
      /* non-fatal here; doctor enforces, run.js warns */
    }
  }

  return { home, secretsDir, workDir };
}

export function secretsPath(secretsDir, name) {
  return path.isAbsolute(name) ? name : path.join(secretsDir, name);
}
export function workPath(workDir, name) {
  return path.join(workDir, name);
}

// Each target writes its artifacts into its own subdir so N targets never
// clobber each other's raw-tides.json / tide-events.*.
export function targetWorkDir(workDir, slug) {
  return path.join(workDir, slug);
}

// A per-target view of the loaded config: the flat shape the pipeline stages
// already expect (config.location / config.calendarId / config.workDir), with
// workDir swapped to the target's subdir. Lets fetch/transform/sync stay
// target-agnostic — they never learn there's more than one.
export function targetConfig(config, target) {
  return {
    ...config,
    workDir: targetWorkDir(config.workDir, target.slug),
    location: target.location,
    calendarId: target.calendarId,
    subject: target.subject,
  };
}

// Filesystem-safe, deterministic slug from a target name. Non-alphanumerics
// collapse to single dashes; empty results fall back to a short calendarId
// hash. Callers dedupe collisions by appending the same hash.
function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
function calendarHash(calendarId) {
  return crypto.createHash("sha256").update(String(calendarId)).digest("hex").slice(0, 8);
}

// --- Permissions ------------------------------------------------------------

// Inspect secrets/ (want 700) and every *.json under it (want 600). Returns a
// list of human-readable issue strings; empty means all good. run.js logs these
// as warnings; doctor treats a non-empty list as a hard failure.
export function checkSecretPerms(secretsDir) {
  const issues = [];
  let dirStat;
  try {
    dirStat = fs.statSync(secretsDir);
  } catch {
    return issues; // no secrets dir yet — nothing to check.
  }
  if ((dirStat.mode & 0o077) !== 0) {
    issues.push(
      `secrets/ is group/other-accessible (mode ${(dirStat.mode & 0o777).toString(8)}); expected 700`
    );
  }
  let names = [];
  try {
    names = fs.readdirSync(secretsDir);
  } catch {
    return issues;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const st = fs.statSync(path.join(secretsDir, name));
      if ((st.mode & 0o077) !== 0) {
        issues.push(
          `secrets/${name} is group/other-accessible (mode ${(st.mode & 0o777).toString(8)}); expected 600`
        );
      }
    } catch {
      /* skip unreadable entry */
    }
  }
  return issues;
}

// Best-effort tighten of secrets/ and its key files. Used by init.
export function enforceSecretPerms(secretsDir) {
  try {
    fs.chmodSync(secretsDir, SECRETS_MODE);
  } catch {
    /* ignore */
  }
  let names = [];
  try {
    names = fs.readdirSync(secretsDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      fs.chmodSync(path.join(secretsDir, name), KEY_FILE_MODE);
    } catch {
      /* ignore */
    }
  }
}

// Walk up from `dir` looking for a `.obsidian` directory — a strong signal the
// home was mistakenly pointed inside an Obsidian vault (defeats the privacy
// guarantee and risks committing keys). Returns the vault root or null.
export function findVaultAncestor(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, ".obsidian"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// --- config.json loading (JSONC) --------------------------------------------

// Strip full-line `//` comments and `/* */` blocks so the wizard-written,
// commented template parses. Field values here never contain `//`, so this
// line-anchored stripping is safe.
function stripJsonc(text) {
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlocks
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

function pick(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return undefined;
}

// Normalize one target's location block, defaulting to the exact original
// coords and validating any explicitly-provided lat/long as finite numbers.
function normalizeLocation(loc = {}, { label }) {
  const num = (v, field) => {
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      throw new ConfigError("config-read-failed", `${label} ${field} must be a number, got ${JSON.stringify(v)}`);
    }
    return n;
  };
  return {
    lat: num(loc.lat, "location.lat") ?? DEFAULTS.location.lat,
    long: num(loc.long, "location.long") ?? DEFAULTS.location.long,
    name: loc.name ?? DEFAULTS.location.name,
  };
}

// Turn the raw parsed config file into the effective configuration. Pure (no
// I/O): callers supply the parsed `file`, cli/env for precedence, and the
// resolved shared paths. Always returns a normalized `targets` array (≥1),
// collapsing the legacy single-target shape into a one-element array so the
// pipeline has a single code path. Throws ConfigError on any problem.
export function normalizeConfig(file, { cli = {}, env = process.env, home, secretsDir, workDir, configPath } = {}) {
  const subject = pick(cli.subject, env.TIDE_CAL_SUBJECT, file.subject);
  if (!subject) {
    throw new ConfigError(
      "config-read-failed",
      "config missing subject (set in config.json or via --subject)"
    );
  }

  const keyPathRaw = file.serviceAccountKeyPath;
  if (!keyPathRaw) {
    throw new ConfigError("config-read-failed", "config missing serviceAccountKeyPath");
  }
  const serviceAccountKeyPath = secretsPath(secretsDir, keyPathRaw);

  // --- Determine the target list. New shape wins; else synthesize one from the
  // legacy top-level location + calendarId (with flag/env calendarId override). ---
  const hasTargets = Array.isArray(file.targets) && file.targets.length > 0;
  const calendarOverride = pick(cli["calendar-id"], env.TIDE_CAL_CALENDAR_ID);
  if (hasTargets && calendarOverride) {
    throw new ConfigError(
      "config-read-failed",
      "--calendar-id / TIDE_CAL_CALENDAR_ID cannot be combined with a multi-target config; edit config.json"
    );
  }

  const rawTargets = hasTargets
    ? file.targets
    : [{ name: file.location?.name, location: file.location, calendarId: calendarOverride ?? file.calendarId }];

  const seenSlugs = new Set();
  const seenCalendars = new Set();
  const targets = rawTargets.map((t, i) => {
    const label = `target[${i}]${t?.name ? ` (${t.name})` : ""}`;
    const calendarId = t?.calendarId;
    if (!calendarId) {
      throw new ConfigError("config-read-failed", `${label} missing calendarId`);
    }
    if (seenCalendars.has(calendarId)) {
      throw new ConfigError(
        "config-read-failed",
        `duplicate calendarId ${calendarId} across targets — each target needs a distinct calendar`
      );
    }
    seenCalendars.add(calendarId);

    const location = normalizeLocation(t?.location, { label });
    const name = t?.name ?? location.name;

    // Stable, collision-free slug for the per-target work subdir.
    let slug = slugify(name);
    const hash = calendarHash(calendarId);
    if (!slug || seenSlugs.has(slug)) slug = slug ? `${slug}-${hash}` : hash;
    while (seenSlugs.has(slug)) slug = `${slug}-${hash}`;
    seenSlugs.add(slug);

    return { name, slug, location, calendarId, subject: t?.subject ?? subject };
  });

  // eventDurationMinutes: default 60, must be a positive finite number.
  let eventDurationMinutes = DEFAULTS.eventDurationMinutes;
  if (file.eventDurationMinutes !== undefined) {
    const n = Number(file.eventDurationMinutes);
    if (!Number.isFinite(n) || n <= 0) {
      throw new ConfigError(
        "config-read-failed",
        `eventDurationMinutes must be a positive number, got ${JSON.stringify(file.eventDurationMinutes)}`
      );
    }
    eventDurationMinutes = n;
  }

  // days: flag > env > default (not a config.json field).
  let days = DEFAULTS.days;
  const daysRaw = pick(cli.days, env.TIDE_CAL_DAYS);
  if (daysRaw !== undefined) {
    const n = Number(daysRaw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ConfigError("config-read-failed", `--days/TIDE_CAL_DAYS must be a positive integer, got ${daysRaw}`);
    }
    days = n;
  }

  const tz = pick(env.TIDE_CAL_TZ, DEFAULTS.tz);
  const logFormat = pick(cli["log-format"], env.TIDE_CAL_LOG_FORMAT, DEFAULTS.logFormat);

  return {
    home,
    secretsDir,
    workDir,
    configPath,
    subject,
    serviceAccountKeyPath,
    targets,
    eventDurationMinutes,
    days,
    tz,
    datum: DEFAULTS.datum,
    logFormat,
    dryRun: Boolean(cli["dry-run"]),
  };
}

// Load + validate the effective configuration from disk. Reads config.json
// (JSONC) from secrets/ and delegates to the pure normalizeConfig. Throws
// ConfigError (reason "config-read-failed") on any problem.
export function loadConfig({ home, secretsDir, workDir, cli = {}, env = process.env } = {}) {
  const configPath = path.join(secretsDir, CONFIG_NAME);
  const legacyPath = path.join(secretsDir, LEGACY_CONFIG_NAME);
  const activePath = fs.existsSync(configPath)
    ? configPath
    : fs.existsSync(legacyPath)
      ? legacyPath
      : null;

  if (!activePath) {
    throw new ConfigError(
      "config-read-failed",
      `no ${CONFIG_NAME} in ${secretsDir} — run \`tide-calendar init\` or create it`
    );
  }

  let file;
  try {
    file = JSON.parse(stripJsonc(fs.readFileSync(activePath, "utf8")));
  } catch (e) {
    throw new ConfigError("config-read-failed", `invalid ${path.basename(activePath)}: ${e.message}`);
  }

  return normalizeConfig(file, { cli, env, home, secretsDir, workDir, configPath: activePath });
}

export const constants = { CONFIG_NAME, LEGACY_CONFIG_NAME, SECRETS_MODE, KEY_FILE_MODE };
