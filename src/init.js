import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolveHome, enforceSecretPerms, findVaultAncestor, constants } from "./config.js";

// Interactive first-run setup. Creates the user-private home with owner-only
// perms, prompts for the account-targeting fields + secrets, and writes a
// commented config.json. Refuses to proceed if it cannot lock secrets/ to
// owner-only, which is the whole point of the private home.

// Build a commented config.json body from the collected answers. Values here
// never contain `//`, so the JSONC line-stripping in config.js is safe. Each
// target is one location + its own calendar; subject + key are shared.
export function renderConfigTemplate({ subject, serviceAccountKeyPath, targets }) {
  const targetBlocks = targets
    .map(
      (t) => `    {
      "name": ${JSON.stringify(t.name)},
      "location": { "lat": ${t.lat}, "long": ${t.long}, "name": ${JSON.stringify(t.name)} },
      "calendarId": ${JSON.stringify(t.calendarId)}
    }`
    )
    .join(",\n");

  return `{
  // Google account the service account impersonates via domain-wide delegation.
  // This is the mailbox that "owns" the target calendars.
  "subject": ${JSON.stringify(subject)},

  // Path to the Google service-account key JSON. Absolute, or relative to
  // secrets/. Leave as the filename if you dropped the key into secrets/.
  "serviceAccountKeyPath": ${JSON.stringify(serviceAccountKeyPath)},

  // Optional: length of each calendar event in minutes, centered on the tide
  // time. Defaults to 60 (a 1-hour block) if omitted.
  "eventDurationMinutes": 60,

  // One entry per location. Each has its own coordinates and its own Google
  // Calendar; subject + key above are shared across all of them.
  "targets": [
${targetBlocks}
  ]
}
`;
}

async function prompt(rl, question, { required = true, defaultValue } = {}) {
  for (;;) {
    const suffix = defaultValue !== undefined && defaultValue !== "" ? ` [${defaultValue}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    if (answer) return answer;
    if (defaultValue !== undefined && defaultValue !== "") return String(defaultValue);
    if (!required) return "";
    stdout.write("  (required)\n");
  }
}

// Prompt for a finite number, re-prompting on non-numeric input.
async function promptNumber(rl, question, { defaultValue } = {}) {
  for (;;) {
    const raw = await prompt(rl, question, { defaultValue });
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    stdout.write("  (must be a number)\n");
  }
}

export async function init({ homeFlag, log } = {}) {
  const { home, secretsDir, workDir } = resolveHome({ homeFlag });

  // Guardrail: never let the private home live inside an Obsidian vault.
  const vault = findVaultAncestor(home);
  if (vault) {
    log.error("home-inside-vault", { home, vault });
    stdout.write(
      `\nRefusing to initialize: TIDE_CAL_HOME (${home}) is inside an Obsidian vault (${vault}).\n` +
        `Point --home / TIDE_CAL_HOME at a private path like ~/.tide-calendar and re-run.\n`
    );
    return { ok: false, reason: "home-inside-vault" };
  }

  // Enforce + verify owner-only secrets/. Refuse if we can't lock it down.
  enforceSecretPerms(secretsDir);
  const st = fs.statSync(secretsDir);
  if ((st.mode & 0o077) !== 0) {
    log.error("secrets-not-lockable", { secretsDir, mode: (st.mode & 0o777).toString(8) });
    stdout.write(`\nRefusing to write secrets: could not lock ${secretsDir} to owner-only (700).\n`);
    return { ok: false, reason: "secrets-not-lockable" };
  }

  stdout.write(`\nTide Calendar setup — writing to ${home}\n\n`);
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const subject = await prompt(rl, "Google subject email (DWD impersonation target)");

    // Location loop: one or more targets, each with its own coordinates and
    // calendar. First location defaults to the Auckland Downtown Ferry Terminal
    // coords so a bare-enter single-location setup is a sensible starting point.
    const targets = [];
    const seenCalendars = new Set();
    for (;;) {
      const n = targets.length + 1;
      stdout.write(`\nLocation ${n}:\n`);
      const name = await prompt(rl, "  Location name", { defaultValue: "Auckland Downtown Ferry Terminal" });
      const lat = await promptNumber(rl, "  Latitude", { defaultValue: -36.84278 });
      const long = await promptNumber(rl, "  Longitude", { defaultValue: 174.766953 });

      let calendarId;
      for (;;) {
        calendarId = await prompt(rl, "  Target calendarId (…@group.calendar.google.com)");
        if (!seenCalendars.has(calendarId)) break;
        stdout.write("  (that calendarId is already used by another location — each needs its own)\n");
      }
      seenCalendars.add(calendarId);
      targets.push({ name, lat, long, calendarId });

      const again = (await prompt(rl, "Add another location? [y/N]", { required: false, defaultValue: "n" }))
        .toLowerCase();
      if (again !== "y" && again !== "yes") break;
    }

    // NIWA key: write secrets/niwa.json.
    const apiKey = await prompt(rl, "NIWA API key");
    const niwaPath = path.join(secretsDir, "niwa.json");
    fs.writeFileSync(niwaPath, JSON.stringify({ apiKey }, null, 2));
    fs.chmodSync(niwaPath, constants.KEY_FILE_MODE);

    // Service-account key: copy an existing file into secrets/, or point at an
    // absolute path already in place.
    const saSource = await prompt(rl, "Path to your Google service-account key JSON");
    let serviceAccountKeyPath;
    const resolvedSource = path.resolve(saSource.replace(/^~(?=\/|$)/, process.env.HOME || ""));
    if (!fs.existsSync(resolvedSource)) {
      stdout.write(`  Note: ${resolvedSource} does not exist yet — recording the path; place the key there before running.\n`);
      serviceAccountKeyPath = resolvedSource;
    } else if (path.dirname(resolvedSource) === secretsDir) {
      serviceAccountKeyPath = path.basename(resolvedSource); // already in secrets/
    } else {
      const dest = path.join(secretsDir, path.basename(resolvedSource));
      fs.copyFileSync(resolvedSource, dest);
      fs.chmodSync(dest, constants.KEY_FILE_MODE);
      serviceAccountKeyPath = path.basename(dest);
      stdout.write(`  Copied SA key into secrets/${serviceAccountKeyPath}\n`);
    }

    const configPath = path.join(secretsDir, constants.CONFIG_NAME);
    fs.writeFileSync(configPath, renderConfigTemplate({ subject, serviceAccountKeyPath, targets }));
    fs.chmodSync(configPath, constants.KEY_FILE_MODE);
    enforceSecretPerms(secretsDir);

    const locList = targets.map((t) => `${t.name} → ${t.calendarId}`).join("\n           ");
    stdout.write(
      `\nDone.\n  config:  ${configPath}\n  secrets: ${secretsDir} (700)\n  work:    ${workDir}\n` +
        `  targets: ${locList}\n\n` +
        `Next: \`tide-calendar doctor\` to validate config, perms, and Google auth.\n`
    );
    log.info("init-complete", { home });
    return { ok: true, home };
  } finally {
    rl.close();
  }
}
