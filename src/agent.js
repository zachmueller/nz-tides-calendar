import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// launchd LaunchAgent install/uninstall. Renders the plist template with the
// real node path, this repo's bin/cli.js, and TIDE_CAL_HOME, writes it to
// ~/Library/LaunchAgents/, and bootstraps it. A LaunchAgent (not a Daemon) runs
// as the logged-in user with Keychain/network access and catches up a missed
// StartCalendarInterval run on wake.

const LABEL = "nz.zach.tide-calendar";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const TEMPLATE = path.join(REPO_ROOT, "launchd", `${LABEL}.plist`);
const CLI_PATH = path.join(REPO_ROOT, "bin", "cli.js");
const LAUNCH_AGENTS = path.join(os.homedir(), "Library", "LaunchAgents");
const PLIST_DEST = path.join(LAUNCH_AGENTS, `${LABEL}.plist`);

// Resolve the absolute node path to pin in the plist. launchd has a minimal
// PATH, so a bare "node" or an nvm/asdf shim would fail — pin the real binary.
function resolveNodePath() {
  try {
    const which = execFileSync("/usr/bin/which", ["node"], { encoding: "utf8" }).trim();
    if (which) return which;
  } catch {
    /* fall through to defaults */
  }
  for (const p of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    if (fs.existsSync(p)) return p;
  }
  return process.execPath; // last resort: the node running this
}

function renderPlist({ node, home }) {
  const nodeDir = path.dirname(node);
  const launchPath = `${nodeDir}:/usr/bin:/bin`;
  return fs
    .readFileSync(TEMPLATE, "utf8")
    .replaceAll("{{NODE}}", node)
    .replaceAll("{{CLI}}", CLI_PATH)
    .replaceAll("{{HOME}}", home)
    .replaceAll("{{PATH}}", launchPath);
}

export function installAgent({ home, log }) {
  const node = resolveNodePath();
  fs.mkdirSync(LAUNCH_AGENTS, { recursive: true });
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  fs.writeFileSync(PLIST_DEST, renderPlist({ node, home }));
  log.info("agent-plist-written", { path: PLIST_DEST, node, cli: CLI_PATH, home });

  const uid = process.getuid();
  const domain = `gui/${uid}`;
  // Re-bootstrap cleanly: bootout any existing instance first (ignore failure).
  try {
    execFileSync("/bin/launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
  } catch {
    /* not loaded yet — fine */
  }
  try {
    execFileSync("/bin/launchctl", ["bootstrap", domain, PLIST_DEST], { stdio: "inherit" });
  } catch (e) {
    log.error("agent-bootstrap-failed", { error: String(e?.message ?? e) });
    process.stdout.write(
      `\nWrote ${PLIST_DEST} but \`launchctl bootstrap\` failed.\n` +
        `Load it manually:\n  launchctl bootstrap ${domain} ${PLIST_DEST}\n`
    );
    return { ok: false };
  }

  process.stdout.write(
    `\nInstalled LaunchAgent ${LABEL}.\n` +
      `  plist: ${PLIST_DEST}\n  node:  ${node}\n  runs:  Mondays 06:00 NZ\n\n` +
      `Test it now:\n  launchctl kickstart -k ${domain}/${LABEL}\n` +
      `Logs: ${home}/work/launchd.{out,err}.log and ${home}/work/run-*.log\n`
  );
  log.info("agent-installed", { label: LABEL });
  return { ok: true };
}

export function uninstallAgent({ log }) {
  const uid = process.getuid();
  const domain = `gui/${uid}`;
  try {
    execFileSync("/bin/launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "inherit" });
  } catch {
    process.stdout.write(`(${LABEL} was not loaded)\n`);
  }
  if (fs.existsSync(PLIST_DEST)) {
    fs.unlinkSync(PLIST_DEST);
    process.stdout.write(`Removed ${PLIST_DEST}\n`);
  }
  log.info("agent-uninstalled", { label: LABEL });
  return { ok: true };
}
