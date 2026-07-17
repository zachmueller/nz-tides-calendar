# nz-tides-calendar

A small, dependency-free Node.js CLI that fetches [NIWA](https://niwa.co.nz/) tide
predictions for a location and syncs the high/low tides into a Google Calendar as
1-hour events. It runs unattended under macOS `launchd` (Mondays 06:00 NZ, with a
catch-up on wake) and is safe to run by hand any time.

It is a port of a deterministic three-stage pipeline: **fetch → transform → sync**.
Every run reconciles the calendar to the current forecast via an idempotent upsert,
so re-running never duplicates events and revives any you deleted.

## Requirements

- **Node 18+** (uses the global `fetch` and `node:crypto`). Install via Homebrew:
  `brew install node`.
- A **NIWA Tides API key** — <https://developer.niwa.co.nz/>.
- A **Google service account with domain-wide delegation (DWD)** authorized for the
  `https://www.googleapis.com/auth/calendar.events` scope, and a dedicated calendar
  it can write to. See [Google setup](#google-setup) below.

## Install

```bash
git clone <this-repo> && cd nz-tides-calendar
npm link           # or: npm install -g .   → provides the `tide-calendar` command
```

## Quick start

```bash
tide-calendar init      # interactive: creates ~/.tide-calendar, prompts for config + keys
tide-calendar doctor    # validates config, secret perms, and a live Google token exchange
tide-calendar run --dry-run   # full fetch + transform + a logged (not executed) upsert plan
tide-calendar run       # do it for real
tide-calendar install-agent   # schedule it under launchd (Mondays 06:00 NZ)
```

## Commands

| Command | Description |
|---|---|
| `run` (default) | Full pipeline: fetch → transform → sync. |
| `init` | Interactive first-run setup (creates the private home, writes config + keys). |
| `fetch` | Fetch only; writes `work/raw-tides.json`. |
| `transform` | Transform only; reads `raw-tides.json` → `tide-events.{json,md}`. |
| `sync` | Sync only; reads `tide-events.json` → Google Calendar. |
| `doctor` | Validate config, secret perms, and Google auth. **No calendar writes.** |
| `install-agent` | Write + load the `launchd` LaunchAgent. |
| `uninstall-agent` | Unload + remove the LaunchAgent. |

**Global options:** `--dry-run`, `--home <dir>`, `--subject <email>`,
`--calendar-id <id>`, `--days <n>`, `--log-format json|pretty`, `--verbose`,
`-h/--help`, `-v/--version`.

**Exit codes:** `0` success (incl. a clean 0-event no-op) · `10` config/secret error
(needs a human) · `20` NIWA fetch failure (transient) · `21` Google auth failure ·
`22` partial sync (some events failed; pipeline otherwise ran).

## Configuration & secrets

Everything private lives under **`TIDE_CAL_HOME`** (default `~/.tide-calendar`) — a
per-user, owner-only directory:

```
~/.tide-calendar/
├─ secrets/            # chmod 700; files chmod 600
│  ├─ config.json      # subject, key path, targets[] (location + calendar per target)
│  ├─ niwa.json        # { "apiKey": "…" }
│  └─ <sa-key>.json    # the Google service-account key JSON
└─ work/               # <slug>/{raw-tides,tide-events}.{json,md} per target, run-*.log, launchd.*.log
```

> **Keep `TIDE_CAL_HOME` private.** Never point it at a shared folder, a synced cloud
> drive, or inside an Obsidian vault. `init` refuses to run inside a vault, and
> `doctor` hard-fails on group/world-readable secrets.

### `secrets/config.json`

One or more **targets**, each a location (with its own GPS coordinates) synced into its
own Google Calendar. `subject` and the service-account key are shared across all targets.

```jsonc
{
  // Google account the service account impersonates via domain-wide delegation.
  "subject": "you@your-domain.com",
  // Path to the Google service-account key JSON. Absolute, or relative to secrets/.
  "serviceAccountKeyPath": "service-account.json",
  // Optional. Event length in minutes, centered on the tide time. Default 60.
  "eventDurationMinutes": 60,
  // One entry per location. Each has its own coordinates + calendar.
  "targets": [
    {
      "name": "Auckland Downtown Ferry Terminal",
      "location": { "lat": -36.84278, "long": 174.766953, "name": "Auckland Downtown Ferry Terminal" },
      "calendarId": "downtown_xxxx@group.calendar.google.com"
    },
    {
      "name": "Island Bay",
      "location": { "lat": -41.3446, "long": 174.7706, "name": "Island Bay" },
      "calendarId": "islandbay_yyyy@group.calendar.google.com"
      // Optional: "subject" here overrides the shared subject for this target only.
    }
  ]
}
```

`tide-calendar init` prompts for each location's coordinates and calendar in a loop, so
you rarely edit this by hand. `run` fans out over every target; if one target fails
(e.g. NIWA is down for it), the others still sync and the process exits with the most
severe code. The standalone `fetch` / `transform` / `sync` commands also process all
targets, or a single one via `--target <name|slug>`.

**Backward compatible:** a legacy single-target config (top-level `location` +
`calendarId`, no `targets`) still works unchanged — it's treated as one target.

`subject` can be overridden per-run — precedence is
**flag > env var > config.json > built-in default**:

| Var | Flag | Default | Purpose |
|---|---|---|---|
| `TIDE_CAL_HOME` | `--home` | `~/.tide-calendar` | private base dir |
| `TIDE_CAL_SUBJECT` | `--subject` | *(config)* | DWD subject for one run |
| `TIDE_CAL_CALENDAR_ID` | `--calendar-id` | *(config)* | target calendar (single-target configs only) |
| — | `--target` | *(all)* | fetch/transform/sync: limit to one location |
| `TIDE_CAL_TZ` | — | `Pacific/Auckland` | local tz for the window + events |
| `TIDE_CAL_DAYS` | `--days` | `14` | NIWA `numberOfDays` |
| `TIDE_CAL_LOG_FORMAT` | `--log-format` | `json` | `json` (lines) or `pretty` |

Secrets are never logged — the NIWA key is appended to the URL only at call time, and
the Google private key is only ever passed to the in-process signer.

## Google setup

1. Create a Google Cloud service account; download its JSON key.
2. In the Google Workspace Admin console, grant the service account **domain-wide
   delegation** for the scope `https://www.googleapis.com/auth/calendar.events`.
3. Create (or pick) a calendar and share it so the `subject` mailbox can edit it.
4. Put the SA key in `secrets/`, set `subject` to the impersonated mailbox and
   `calendarId` to that calendar. Run `tide-calendar doctor` — a green token exchange
   confirms DWD + scope are authorized.

## Scheduling with launchd

`tide-calendar install-agent` writes `~/Library/LaunchAgents/nz.zach.tide-calendar.plist`
(node path auto-detected and pinned; runs Mondays 06:00 NZ) and loads it. The Mac is
assumed to be in Auckland, so `Hour 6` fires at 06:00 NZ directly. A missed run (Mac
asleep/off) is caught up once on wake — the reliability win over a GUI-bound scheduler.

```bash
launchctl kickstart -k gui/$(id -u)/nz.zach.tide-calendar   # run now, to test
tide-calendar uninstall-agent                               # unload + remove
```

Logs land in `work/run-YYYY-MM-DD.log` (structured JSON lines; last ~8 kept) and
`work/launchd.{out,err}.log`. A failed run also fires a macOS notification banner.

## Migrating from the Notor orchestration

The CLI derives the **same** deterministic event id
(`base32hex(SHA-256(calendarId|tideType|utc))`) as the original orchestration, so it
**updates** the existing events rather than duplicating them.

1. `npm test` — confirm the transform suite is green.
2. `tide-calendar init` (or copy `niwa.json`, the SA key, and a migrated `config.json`
   into `secrets/` by hand — `chmod 600`; ensure `serviceAccountKeyPath` is relative to
   `secrets/`, not vault-relative). The old `long-bay-tides-config.json` filename is
   still accepted.
3. `tide-calendar run --dry-run` — the logged ids should match the calendar's existing
   events (proves idempotent equivalence).
4. `tide-calendar run` — expect mostly `updated`. Event summaries change to
   `HIGH TIDE (…)` / `low tide (…)` casing on this first run (a one-time cosmetic
   change; ids are unaffected).
5. `tide-calendar install-agent`, then `launchctl kickstart -k …` to verify under launchd.
6. Disable the Notor weekly schedule (both are idempotent, so brief overlap is harmless).
7. Keep the Notor flow as a documented fallback for a cycle or two before archiving.

## Development

```bash
npm test          # node --test — pure transform tests (classification, DST, ids, parity)
```

The one runtime shim is `src/http.js` (wraps `fetch` into the `{status,json,text}` shape
the ported network code expects). The three pipeline stages —
[src/fetch-tides.js](src/fetch-tides.js), [src/transform-events.js](src/transform-events.js),
[src/sync-calendar.js](src/sync-calendar.js) — are ported near-verbatim from the source
orchestration; [src/run.js](src/run.js) sequences them and maps failures to exit codes.

## License

MIT — see [LICENSE](LICENSE).
