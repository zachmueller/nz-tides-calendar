import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

// Structured logger preserving the orchestration's `(msg, { fields })` call shape
// so the ported step code needs no edits beyond dropping the `orchestration.`
// prefix. Every line is written to the per-day JSON-lines file under work/ and
// echoed to the console (pretty or json, per --log-format).
//
// Notifications:
//   - notify(msg)        → a quiet log line (the ported utils.notify calls).
//   - notifyFailure(msg) → a best-effort, non-fatal macOS banner, fired once by
//                          the CLI only when the final exit code is non-zero.

const LEVELS = { debug: 10, info: 20, notice: 20, warn: 30, error: 40 };
const KEEP_LOGS = 8; // retain ~8 weekly logs, prune older on startup

function pad(n) {
  return String(n).padStart(2, "0");
}

// Local calendar date (YYYY-MM-DD) for the log filename. The Mac runs in NZ, so
// this groups a run under its local day.
function localDateStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pruneOldLogs(workDir) {
  let names;
  try {
    names = fs.readdirSync(workDir);
  } catch {
    return; // work dir not readable yet — nothing to prune.
  }
  const logs = names
    .filter((n) => /^run-\d{4}-\d{2}-\d{2}\.log$/.test(n))
    .sort(); // lexical sort == chronological for YYYY-MM-DD
  const stale = logs.slice(0, Math.max(0, logs.length - KEEP_LOGS));
  for (const name of stale) {
    try {
      fs.unlinkSync(path.join(workDir, name));
    } catch {
      // best-effort; a failed prune must never break a run.
    }
  }
}

export function createLogger({ workDir, format = "json", verbose = false } = {}) {
  const threshold = verbose ? LEVELS.debug : LEVELS.info;
  const logFile = workDir ? path.join(workDir, `run-${localDateStamp()}.log`) : null;

  if (workDir) pruneOldLogs(workDir);

  function write(level, msg, fields) {
    if ((LEVELS[level] ?? LEVELS.info) < threshold) return;
    const entry = { ts: new Date().toISOString(), level, msg, ...(fields || {}) };

    // Persist the JSON line (best-effort — a logging failure must not abort a run).
    if (logFile) {
      try {
        fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
      } catch {
        /* ignore */
      }
    }

    // Echo to the console.
    const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
    if (format === "pretty") {
      const extra =
        fields && Object.keys(fields).length ? " " + JSON.stringify(fields) : "";
      stream.write(`${entry.ts} ${level.toUpperCase().padEnd(6)} ${msg}${extra}\n`);
    } else {
      stream.write(JSON.stringify(entry) + "\n");
    }
  }

  const log = {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    // The ported utils.notify(msg): a human-facing string, kept as a quiet line.
    notify: (msg) => write("notice", msg),
    logFile,
  };

  return log;
}

// Best-effort macOS banner for a failed run. Never throws. Prefers terminal-notifier
// (Homebrew) if installed, else falls back to the built-in osascript.
export function notifyFailure(message, { title = "Tide Calendar" } = {}) {
  return new Promise((resolve) => {
    const done = () => resolve();
    execFile("/usr/bin/which", ["terminal-notifier"], (err, stdout) => {
      const tn = !err && stdout.trim();
      if (tn) {
        execFile(tn, ["-title", title, "-message", message], done);
      } else {
        const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
        execFile("/usr/bin/osascript", ["-e", script], done);
      }
    });
  });
}
