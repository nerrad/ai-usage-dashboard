# AI Usage Dashboard

A self-contained HTML dashboard for visualizing Claude Code and Codex session usage. Reads `~/.claude/session-usage.jsonl`, fetches live model pricing from [models.dev](https://models.dev), and generates an interactive dashboard with charts and a sortable session table.

![Dashboard](https://img.shields.io/badge/output-HTML-blue)

## What it shows

- **Session counts** — broken down by source (Claude Code / Codex)
- **Cost tracking** — per-session and aggregate, with live pricing from models.dev
- **Token breakdown** — input, output, cache read/write, reasoning
- **Tool usage** — top tools across all sessions
- **Model usage** — sessions and cost per model
- **Session table** — sortable by date, cost, tokens, duration, project, etc.

## Prerequisites

- Node.js 18+ (uses ES modules, top-level await)
- `~/.claude/session-usage.jsonl` — produced by [Claude Code](https://docs.anthropic.com/en/docs/claude-code) session tracking or by the included backfill script

## Setup

Clone the repo and source the init script in your shell config:

```sh
git clone https://github.com/nerrad/ai-usage-dashboard.git ~/.claude/usage-dashboard
echo 'source ~/.claude/usage-dashboard/init.sh' >> ~/.zshrc
source ~/.zshrc
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

**`server.js`** — Reads session data from `~/.claude/session-usage.jsonl`, fetches model pricing (cached for 24h in `~/.claude/model-pricing-cache.json`), and generates a single self-contained HTML file with embedded data and Chart.js.

**`backfill.js`** — Scans `~/.claude/projects/*/sessions-index.json` for historical Claude Code sessions, parses their transcripts, deduplicates against existing records, and appends new entries to the JSONL file.

## License

MIT
