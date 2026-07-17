import fs from "node:fs";
import { loadConfig, checkSecretPerms, findVaultAncestor, secretsPath, ConfigError } from "./config.js";
import { mintAccessToken } from "./sync-calendar.js";
import { EXIT } from "./run.js";

// Offline smoke test: validate config presence, enforce user-private secret
// perms (hard failure on loose perms or a vault-nested home), and perform a live
// token exchange (no calendar writes) — the fastest way to confirm DWD/scope is
// still authorized. Prints a checklist; returns an exit code.

export async function doctor({ home, secretsDir, workDir, http, log, cli = {}, env = process.env } = {}) {
  const results = [];
  const check = (label, ok, detail) => {
    results.push({ label, ok, detail });
    log.info("doctor-check", { label, ok, detail });
    process.stdout.write(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}\n`);
  };

  process.stdout.write(`Tide Calendar doctor — ${home}\n`);

  // --- Config ---
  let config;
  try {
    config = loadConfig({ home, secretsDir, workDir, cli, env });
    check("config.json loads with subject + calendarId", true, `subject=${config.subject}`);
  } catch (e) {
    check("config.json loads with subject + calendarId", false, e.message);
    return EXIT.CONFIG; // can't proceed without config
  }

  // --- Secret files present + well-formed ---
  let sa = null;
  try {
    sa = JSON.parse(fs.readFileSync(config.serviceAccountKeyPath, "utf8"));
    const ok = Boolean(sa.client_email && sa.private_key);
    check("service-account key resolvable with client_email + private_key", ok, ok ? sa.client_email : "missing fields");
    if (!ok) sa = null;
  } catch (e) {
    check("service-account key resolvable with client_email + private_key", false, e.message);
  }

  try {
    const niwa = JSON.parse(fs.readFileSync(secretsPath(secretsDir, "niwa.json"), "utf8"));
    check("niwa.json has apiKey", Boolean(niwa.apiKey));
  } catch (e) {
    check("niwa.json has apiKey", false, e.message);
  }

  // --- Perms (hard failures) ---
  const permIssues = checkSecretPerms(secretsDir);
  check("secrets/ + key files are owner-only (700/600)", permIssues.length === 0, permIssues.join("; ") || undefined);

  const vault = findVaultAncestor(home);
  check("TIDE_CAL_HOME is not inside an Obsidian vault", !vault, vault ? `vault at ${vault}` : undefined);

  let homeMode = null;
  try {
    homeMode = fs.statSync(home).mode & 0o777;
  } catch {
    /* ignore */
  }
  check(
    "TIDE_CAL_HOME is not group/world-readable",
    homeMode !== null && (homeMode & 0o077) === 0,
    homeMode !== null ? `mode ${homeMode.toString(8)}` : undefined
  );

  // --- Live token exchange (no writes) ---
  let tokenOk = false;
  if (sa) {
    try {
      const token = await mintAccessToken({ config, sa, http });
      tokenOk = Boolean(token);
      check("Google token exchange (DWD/scope authorized)", tokenOk);
    } catch (e) {
      check("Google token exchange (DWD/scope authorized)", false, String(e?.message ?? e));
    }
  } else {
    check("Google token exchange (DWD/scope authorized)", false, "skipped — SA key not loaded");
  }

  // --- Verdict ---
  const configOk = results
    .filter((r) => r.label !== "Google token exchange (DWD/scope authorized)")
    .every((r) => r.ok);

  if (!configOk) {
    process.stdout.write("\nDoctor: FAILED (config/perms). Fix the ✗ items above.\n");
    return EXIT.CONFIG;
  }
  if (!tokenOk) {
    process.stdout.write("\nDoctor: FAILED (Google auth). Config/perms OK; token exchange did not succeed.\n");
    return EXIT.AUTH;
  }
  process.stdout.write("\nDoctor: OK — config, perms, and Google auth all pass. No calendar writes made.\n");
  return EXIT.OK;
}
