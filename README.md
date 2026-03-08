# AI Usage Dashboard

A self-contained HTML dashboard for visualizing Claude Code and Codex session usage. Reads `~/.claude/session-usage.jsonl`, fetches live model pricing from [models.dev](https://models.dev), and generates an interactive dashboard with charts and a sortable session table.

## What it shows

- **Session counts** — by source (Claude Code / Codex)
- **Cost tracking** — per-session and aggregate, live pricing from models.dev
- **Token breakdown** — input, output, cache read/write, reasoning
- **Tool usage** — top tools across all sessions
- **Model usage** — sessions and cost per model
- **Session table** — sortable by date, cost, tokens, duration, project, etc.

## Prerequisites

- Node.js 18+ (ES modules, top-level await)
- Python 3 (for Codex tracker)
- macOS (for launchd-based Codex polling; cron works elsewhere)

## Install

```sh
git clone https://github.com/nerrad/ai-usage-dashboard.git ~/.claude/usage-dashboard
~/.claude/usage-dashboard/install.sh
```

The install script will:

1. **Symlink hooks** into `~/.claude/hooks/` (backing up existing files)
2. **Print Claude Code config** — the `SessionEnd` hook entry for `~/.claude/settings.json`
3. **Install a launchd agent** (macOS) to poll Codex sessions every 10 minutes

Then add to your `~/.zshrc`:

```sh
source ~/.claude/usage-dashboard/init.sh
```

## Usage

```sh
# Generate and open the dashboard
ai-dashboard

# Backfill historical sessions from Claude Code transcripts
ai-dashboard-backfill

# Dry run — see what would be backfilled without writing
ai-dashboard-backfill --dry-run
```

The dashboard is written to `/tmp/ai-usage-dashboard.html` and opened in your default browser.

## How it works

### Data collection

**`hooks/session-tracker.js`** — Claude Code `SessionEnd` hook. Fires when a session closes, parses the transcript for token usage / tool calls / cost, and appends a record to `~/.claude/session-usage.jsonl`.

**`hooks/codex-session-tracker.py`** — Polls the Codex SQLite database (`~/.codex/state_5.sqlite`) for idle sessions, extracts stats from rollout files, and appends records. Runs via launchd every 10 minutes.

### Dashboard

**`server.js`** — Reads session data, fetches model pricing (cached 24h in `~/.claude/model-pricing-cache.json`), and generates a single self-contained HTML file with embedded data and Chart.js.

### Backfill

**`backfill.js`** — Scans `~/.claude/projects/*/sessions-index.json` for historical Claude Code sessions, parses transcripts, deduplicates, and appends new entries.

## Claude Code settings.json

The `SessionEnd` hook should look like this in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "~/.claude/hooks/session-tracker.js"
      }]
    }]
  }
}
```

## License

MIT
