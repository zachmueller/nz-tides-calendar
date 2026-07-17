#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { resolveHome, loadConfig, checkSecretPerms, targetConfig, targetWorkDir, ConfigError } from "../src/config.js";
import fs from "node:fs";
import { createLogger, notifyFailure } from "../src/logger.js";
import { httpRequest } from "../src/http.js";
import { run, aggregateExit, EXIT } from "../src/run.js";
import { fetchTides } from "../src/fetch-tides.js";
import { transformEvents } from "../src/transform-events.js";
import { syncCalendar } from "../src/sync-calendar.js";
import { doctor } from "../src/doctor.js";
import { init } from "../src/init.js";
import { installAgent, uninstallAgent } from "../src/agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HELP = `tide-calendar <command> [options]

Commands:
  run                 Run the full pipeline (fetch → transform → sync). Default.
  init                Interactive first-run setup (create ~/.tide-calendar, prompt for config + keys).
  fetch               Fetch only; write raw-tides.json.
  transform           Transform only; read raw-tides.json → tide-events.{json,md}.
  sync                Sync only; read tide-events.json → Google Calendar.
  doctor              Validate config, secret perms, and Google token exchange (no writes).
  install-agent       Write + load the launchd LaunchAgent (Mondays 06:00 NZ).
  uninstall-agent     Unload + remove the LaunchAgent.

Global options:
  --dry-run           Do everything except mutate the calendar; log intended upserts.
  --home <dir>        Override TIDE_CAL_HOME.
  --subject <email>   Override the Google DWD subject for this run.
  --calendar-id <id>  Override the target calendar (single-target configs only).
  --target <name>     fetch/transform/sync only: limit to one location (name or slug).
  --days <n>          Override the 14-day fetch window.
  --log-format <fmt>  json | pretty
  --verbose           Debug-level logging.
  -h, --help          Show this help.
  -v, --version       Show version.

Exit codes: 0 ok · 10 config/secret · 20 NIWA fetch · 21 Google auth · 22 partial sync.
`;

const OPTIONS = {
  "dry-run": { type: "boolean", default: false },
  home: { type: "string" },
  subject: { type: "string" },
  "calendar-id": { type: "string" },
  target: { type: "string" },
  days: { type: "string" },
  "log-format": { type: "string" },
  verbose: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
};

function version() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    return pkg.version;
  } catch {
    return "unknown";
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true });
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${HELP}`);
    return 2;
  }
  const { values: cli, positionals } = parsed;
  const command = positionals[0] || "run";

  if (cli.help) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }
  if (cli.version) {
    process.stdout.write(`${version()}\n`);
    return EXIT.OK;
  }

  // Resolve the home + logger up front (shared by every command). init resolves
  // its own home, but we still want a logger for its diagnostics.
  const { home, secretsDir, workDir } = resolveHome({ homeFlag: cli.home });
  const log = createLogger({
    workDir,
    format: cli["log-format"] || process.env.TIDE_CAL_LOG_FORMAT || "json",
    verbose: cli.verbose,
  });

  // Commands that don't need a loaded config.
  if (command === "init") {
    const r = await init({ homeFlag: cli.home, log });
    return r.ok ? EXIT.OK : EXIT.CONFIG;
  }
  if (command === "uninstall-agent") {
    uninstallAgent({ log });
    return EXIT.OK;
  }
  if (command === "install-agent") {
    const r = installAgent({ home, log });
    return r.ok ? EXIT.OK : EXIT.CONFIG;
  }
  if (command === "doctor") {
    return doctor({ home, secretsDir, workDir, http: httpRequest, log, cli, env: process.env });
  }

  // Pipeline commands need config. A config error is exit 10 for all of them.
  let config;
  try {
    config = loadConfig({ home, secretsDir, workDir, cli, env: process.env });
  } catch (e) {
    if (e instanceof ConfigError) {
      log.error(e.reason, { error: e.message });
      log.notify(`Tide Calendar: ${e.message}`);
      return EXIT.CONFIG;
    }
    throw e;
  }

  // Warn (don't fail) on loose secret perms at runtime — doctor is the hard gate.
  for (const issue of checkSecretPerms(secretsDir)) log.warn("loose-perms", { issue });

  // Resolve which targets a standalone stage acts on. Default: all. --target
  // <name|slug> (case-insensitive) narrows to one; unknown → config error.
  const selectTargets = () => {
    if (!cli.target) return config.targets;
    const want = cli.target.toLowerCase();
    const match = config.targets.filter((t) => t.slug === want || t.name.toLowerCase() === want);
    if (match.length === 0) {
      throw new ConfigError("config-read-failed", `no target matches --target "${cli.target}"`);
    }
    return match;
  };

  // Run one stage across the selected targets, aggregating exit codes. `stage`
  // returns an exit code for a single per-target config view.
  const runStage = async (stage) => {
    let selected;
    try {
      selected = selectTargets();
    } catch (e) {
      if (e instanceof ConfigError) {
        log.error(e.reason, { error: e.message });
        return EXIT.CONFIG;
      }
      throw e;
    }
    const codes = [];
    for (const target of selected) {
      const tcfg = targetConfig(config, target);
      fs.mkdirSync(targetWorkDir(config.workDir, target.slug), { recursive: true });
      codes.push(await stage(tcfg));
    }
    return aggregateExit(codes);
  };

  switch (command) {
    case "run": {
      const { exit } = await run({ config, http: httpRequest, log });
      return exit;
    }
    case "fetch":
      return runStage(async (tcfg) => {
        const r = await fetchTides({ config: tcfg, http: httpRequest, log });
        return r.ok ? EXIT.OK : EXIT.FETCH;
      });
    case "transform":
      return runStage(async (tcfg) => {
        const r = transformEvents({ config: tcfg, log });
        return r.ok || r.reason === "no-values" ? EXIT.OK : EXIT.CONFIG;
      });
    case "sync":
      return runStage(async (tcfg) => {
        const r = await syncCalendar({ config: tcfg, http: httpRequest, log });
        if (!r.ok) return r.reason === "token-exchange-failed" ? EXIT.AUTH : EXIT.CONFIG;
        return r.failed > 0 ? EXIT.PARTIAL : EXIT.OK;
      });
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

main()
  .then(async (code) => {
    process.exitCode = code;
    // Failure-only macOS banner: fire once for any non-zero exit (best-effort).
    if (code && code !== 0 && process.platform === "darwin") {
      await notifyFailure(`Run failed (exit ${code}). Check the logs.`);
    }
  })
  .catch(async (e) => {
    process.stderr.write(`Fatal: ${e?.stack || e}\n`);
    process.exitCode = 1;
    if (process.platform === "darwin") {
      await notifyFailure("Run crashed unexpectedly. Check the logs.");
    }
  });
