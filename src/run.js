import fs from "node:fs";
import { fetchTides } from "./fetch-tides.js";
import { transformEvents } from "./transform-events.js";
import { syncCalendar, mintAccessToken } from "./sync-calendar.js";
import { targetConfig, targetWorkDir } from "./config.js";

// Orchestrates the pipeline over one or more targets. Each target is fetched,
// transformed, and synced independently into its own calendar + work subdir; a
// failure on one target does NOT stop the others. The shared access token is
// minted once per distinct subject and reused across targets. Returns a single
// aggregated exit code (worst-of) so launchd / log-monitoring sees one verdict.

export const EXIT = {
  OK: 0,
  CONFIG: 10, // config/secret error — needs a human, do not retry blindly
  FETCH: 20, // upstream NIWA failure — transient, safe to retry
  AUTH: 21, // Google auth/token failure
  PARTIAL: 22, // some per-event upserts failed
};

// Severity ordering for aggregation, most-actionable-for-a-human first. NOT the
// numeric order of the codes (PARTIAL=22 is the mildest, below FETCH/AUTH).
const RANK = {
  [EXIT.OK]: 0,
  [EXIT.PARTIAL]: 1,
  [EXIT.FETCH]: 2,
  [EXIT.AUTH]: 3,
  [EXIT.CONFIG]: 4,
};

// Collapse N per-target exit codes into one. Returns the worst by RANK; an
// unknown code is treated as most-severe (safest — surfaces the surprise).
export function aggregateExit(codes) {
  let worst = EXIT.OK;
  for (const code of codes) {
    const rank = RANK[code] ?? Number.POSITIVE_INFINITY;
    if (rank > (RANK[worst] ?? -1)) worst = code;
  }
  return worst;
}

// Map a stage's soft-failure reason to an exit code.
function reasonToExit(reason) {
  if (reason === "secret-read-failed" || reason === "config-read-failed" || reason === "events-read-failed") {
    return EXIT.CONFIG;
  }
  if (reason === "token-exchange-failed") return EXIT.AUTH;
  // All fetch/transform data problems are treated as transient upstream issues.
  return EXIT.FETCH;
}

// Run the three stages for a single target. Mirrors the original single-target
// sequencing, short-circuiting on the first soft failure. `accessToken` is the
// pre-minted shared token (undefined for dry-run). Returns a per-target result.
async function runTarget({ tcfg, target, http, log, accessToken, tokenError, stages }) {
  const fetch = stages.fetchTides || fetchTides;
  const transform = stages.transformEvents || transformEvents;
  const sync = stages.syncCalendar || syncCalendar;

  // If the shared token couldn't be minted for this target's subject, sync is
  // impossible — report AUTH without hammering NIWA.
  if (tokenError && !tcfg.dryRun) {
    return { name: target.name, slug: target.slug, exit: EXIT.AUTH, reason: "token-exchange-failed" };
  }

  const fetched = await fetch({ config: tcfg, http, log });
  if (!fetched.ok) {
    return { name: target.name, slug: target.slug, exit: reasonToExit(fetched.reason), reason: fetched.reason };
  }

  const transformed = await transform({ config: tcfg, log });
  if (!transformed.ok) {
    if (transformed.reason === "no-values") {
      return { name: target.name, slug: target.slug, exit: EXIT.OK, reason: "no-values", points: fetched.points, total: 0 };
    }
    return { name: target.name, slug: target.slug, exit: reasonToExit(transformed.reason), reason: transformed.reason };
  }

  const synced = await sync({ config: tcfg, http, log, accessToken });
  if (!synced.ok) {
    return { name: target.name, slug: target.slug, exit: reasonToExit(synced.reason), reason: synced.reason };
  }

  const exit = synced.failed > 0 ? EXIT.PARTIAL : EXIT.OK;
  return {
    name: target.name,
    slug: target.slug,
    exit,
    reason: exit === EXIT.PARTIAL ? "partial-sync" : synced.dryRun ? "dry-run" : "ok",
    points: fetched.points,
    inserted: synced.inserted,
    updated: synced.updated,
    failed: synced.failed,
    total: synced.total,
    dryRun: synced.dryRun || false,
  };
}

// Run the pipeline across all configured targets. `stages` is injectable for
// testing; `stages.mintToken({ subject, http, log })` overrides token minting.
export async function run({ config, http, log, stages = {} } = {}) {
  const started = Date.now();

  // --- Shared token minting: once per distinct subject, cached + reused. The SA
  // key is read at most once. Skipped entirely for dry-run. ---
  const tokenCache = new Map(); // subject -> { token } | { error }
  let sa = null;
  const defaultMintToken = async ({ subject }) => {
    if (!sa) {
      sa = JSON.parse(fs.readFileSync(config.serviceAccountKeyPath, "utf8"));
      if (!sa.client_email || !sa.private_key) {
        throw new Error("service-account key missing client_email / private_key");
      }
    }
    return mintAccessToken({ config: { ...config, subject }, sa, http });
  };
  const mintToken = stages.mintToken || defaultMintToken;

  const tokenFor = async (subject) => {
    if (config.dryRun) return { token: undefined };
    if (tokenCache.has(subject)) return tokenCache.get(subject);
    let entry;
    try {
      entry = { token: await mintToken({ subject, http, log }) };
    } catch (e) {
      log.error("token-exchange-failed", { subject, error: String(e?.message ?? e) });
      entry = { error: String(e?.message ?? e) };
    }
    tokenCache.set(subject, entry);
    return entry;
  };

  // --- Per-target loop. Every target runs even if a prior one failed. ---
  const results = [];
  for (const target of config.targets) {
    const tcfg = targetConfig(config, target);
    fs.mkdirSync(targetWorkDir(config.workDir, target.slug), { recursive: true });

    const { token, error } = await tokenFor(target.subject);
    const result = await runTarget({
      tcfg,
      target,
      http,
      log,
      accessToken: token,
      tokenError: error,
      stages,
    });
    results.push(result);
  }

  const exit = aggregateExit(results.map((r) => r.exit));
  const summary = {
    elapsedMs: Date.now() - started,
    stage: "done",
    targets: results,
    dryRun: Boolean(config.dryRun),
  };
  log.info("run-summary", summary);

  const worst = results.find((r) => r.exit === exit && exit !== EXIT.OK);
  const reason = exit === EXIT.OK ? "ok" : worst?.reason || "error";
  return { exit, reason, summary };
}
