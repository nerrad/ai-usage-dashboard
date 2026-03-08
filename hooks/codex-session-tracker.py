#!/usr/bin/env python3
"""
Codex session tracker — polls SQLite for idle sessions, appends stats to JSONL.
Designed for launchd: runs briefly, writes results, exits. No persistent process.
"""

import json
import os
import sqlite3
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

CODEX_DB = Path.home() / ".codex" / "state_5.sqlite"
TRACKING_FILE = Path.home() / ".claude" / "session-usage.jsonl"
STATE_FILE = Path.home() / ".claude" / "codex-tracker-state.json"

# Consider a session "done" if not updated in 10 minutes
IDLE_THRESHOLD_SECS = 600

PRICING_CACHE = Path.home() / ".claude" / "model-pricing-cache.json"
PRICING_CACHE_MAX_AGE_SECS = 86400  # refresh daily

# Provider prefix mapping for models.dev lookup
PROVIDER_PREFIXES = {"gpt": "openai", "o1": "openai", "o3": "openai", "claude": "anthropic"}


def _model_dev_id(model_name):
    """Map a bare model name to a models.dev provider/model ID."""
    for prefix, provider in PROVIDER_PREFIXES.items():
        if model_name.startswith(prefix):
            return f"{provider}/{model_name}"
    return model_name


def _fetch_models_dev():
    """Fetch models.dev API and extract pricing into a flat dict."""
    import urllib.request

    url = "https://models.dev/api.json"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        print(f"codex-tracker: models.dev fetch failed: {e}", file=sys.stderr)
        return None

    pricing = {}
    for provider_id, provider_data in data.items():
        if not isinstance(provider_data, dict):
            continue
        models = provider_data.get("models", {})
        if not isinstance(models, dict):
            continue
        for model_id, model_data in models.items():
            if not isinstance(model_data, dict):
                continue
            cost = model_data.get("cost")
            if not cost or not isinstance(cost, dict):
                continue
            full_id = f"{provider_id}/{model_id}"
            pricing[full_id] = {
                "input": cost.get("input", 0),
                "output": cost.get("output", 0),
                "cache_read": cost.get("cache_read", 0),
                "cache_write": cost.get("cache_write", 0),
            }
    return pricing


def _load_pricing_cache():
    """Load or refresh the shared pricing cache."""
    now = datetime.now(timezone.utc).timestamp()

    # Use cache if fresh enough
    if PRICING_CACHE.exists():
        try:
            cache = json.loads(PRICING_CACHE.read_text())
            if now - cache.get("fetched_at", 0) < PRICING_CACHE_MAX_AGE_SECS:
                return cache.get("models", {})
        except (json.JSONDecodeError, KeyError):
            pass

    # Refresh from models.dev
    pricing = _fetch_models_dev()
    if pricing is None:
        # API failed — return stale cache if available, else empty
        if PRICING_CACHE.exists():
            try:
                return json.loads(PRICING_CACHE.read_text()).get("models", {})
            except Exception:
                pass
        return {}

    cache = {"fetched_at": now, "models": pricing}
    try:
        PRICING_CACHE.write_text(json.dumps(cache))
    except OSError as e:
        print(f"codex-tracker: cache write failed: {e}", file=sys.stderr)

    return pricing


def compute_cost(model, input_tokens, cached_tokens, output_tokens):
    """Estimate USD cost from token counts using models.dev pricing. Returns None if unknown."""
    pricing = _load_pricing_cache()
    dev_id = _model_dev_id(model)
    rates = pricing.get(dev_id)
    if not rates:
        return None
    return (
        input_tokens * rates["input"]
        + cached_tokens * rates.get("cache_read", 0)
        + output_tokens * rates["output"]
    ) / 1_000_000


def load_state():
    """Load set of already-tracked Codex session IDs."""
    if STATE_FILE.exists():
        try:
            return set(json.loads(STATE_FILE.read_text()).get("tracked_ids", []))
        except (json.JSONDecodeError, KeyError):
            pass
    return set()


def save_state(tracked_ids):
    """Persist tracked session IDs."""
    STATE_FILE.write_text(json.dumps({"tracked_ids": sorted(tracked_ids)}))


def parse_rollout(rollout_path):
    """Parse a Codex rollout JSONL for tool calls and final token counts."""
    tool_calls = Counter()
    total_usage = {}
    models = set()
    first_ts = None
    last_ts = None

    if not os.path.exists(rollout_path):
        return tool_calls, total_usage, models, first_ts, last_ts

    with open(rollout_path) as f:
        for line in f:
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            ts = obj.get("timestamp")
            if ts:
                if first_ts is None:
                    first_ts = ts
                last_ts = ts

            t = obj.get("type")
            payload = obj.get("payload", {})

            if t == "response_item" and payload.get("type") == "function_call":
                name = payload.get("name", "unknown")
                tool_calls[name] += 1

            if t == "turn_context":
                m = payload.get("model")
                if m:
                    models.add(m)

            # Keep the last token_count event (has cumulative totals)
            if t == "event_msg" and payload.get("type") == "token_count":
                info = payload.get("info") or {}
                total_usage = info.get("total_token_usage") or {}

    return tool_calls, total_usage, models, first_ts, last_ts


def main():
    if not CODEX_DB.exists():
        return

    tracked_ids = load_state()
    now_epoch = int(datetime.now(timezone.utc).timestamp())

    # Read-only connection, short timeout to avoid blocking Codex
    conn = sqlite3.connect(f"file:{CODEX_DB}?mode=ro", uri=True, timeout=2)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT id, title, model_provider, tokens_used,
                   created_at, updated_at, cwd, git_branch,
                   cli_version, first_user_message, agent_nickname,
                   rollout_path
            FROM threads
            WHERE (? - updated_at) > ?
            ORDER BY updated_at DESC
            """,
            (now_epoch, IDLE_THRESHOLD_SECS),
        ).fetchall()
    except sqlite3.OperationalError as e:
        # Database locked or schema mismatch — try next poll
        print(f"codex-tracker: sqlite error: {e}", file=sys.stderr)
        return
    finally:
        conn.close()

    new_records = []
    for row in rows:
        sid = row["id"]
        if sid in tracked_ids:
            continue

        rollout_path = row["rollout_path"] or ""
        tool_calls, usage, models, first_ts, last_ts = parse_rollout(rollout_path)

        # Duration from rollout timestamps
        duration_mins = None
        if first_ts and last_ts:
            try:
                t0 = datetime.fromisoformat(first_ts.replace("Z", "+00:00"))
                t1 = datetime.fromisoformat(last_ts.replace("Z", "+00:00"))
                duration_mins = max(0, round((t1 - t0).total_seconds() / 60))
            except (ValueError, TypeError):
                pass

        # Fallback duration from SQLite timestamps
        if duration_mins is None and row["created_at"] and row["updated_at"]:
            duration_mins = max(0, round((row["updated_at"] - row["created_at"]) / 60))

        total_input = usage.get("input_tokens", 0)
        cached_input = usage.get("cached_input_tokens", 0)
        total_output = usage.get("output_tokens", 0)
        reasoning_output = usage.get("reasoning_output_tokens", 0)

        # Top tool
        top_tool = None
        if tool_calls:
            top_name, top_count = tool_calls.most_common(1)[0]
            top_tool = {"name": top_name, "count": top_count}

        # Use rollout models, fall back to model_provider from DB
        model_list = sorted(models) if models else [row["model_provider"]]

        # Cost estimate from models.dev pricing
        model_name = model_list[0] if model_list else None
        cost_usd = None
        if model_name:
            raw_cost = compute_cost(model_name, total_input, cached_input, total_output)
            if raw_cost is not None:
                cost_usd = round(raw_cost, 3)

        record = {
            "source": "codex",
            "session_id": sid,
            "date_closed": datetime.fromtimestamp(
                row["updated_at"], tz=timezone.utc
            ).isoformat(),
            "duration_mins": duration_mins,
            "session_summary": row["title"] or None,
            "first_prompt": (row["first_user_message"] or "")[:300] or None,
            "cost_usd": cost_usd,
            "total_input_tokens": total_input,
            "cached_input_tokens": cached_input,
            "total_output_tokens": total_output,
            "reasoning_output_tokens": reasoning_output,
            "total_tokens": row["tokens_used"],
            "tool_calls": dict(tool_calls) if tool_calls else {},
            "top_tool": top_tool,
            "total_tool_calls": sum(tool_calls.values()),
            "models": model_list,
            "agent_count": 0,
            "project_path": row["cwd"] or None,
            "git_branch": row["git_branch"] or None,
            "codex_version": row["cli_version"] or None,
        }

        new_records.append(record)
        tracked_ids.add(sid)

    if new_records:
        with open(TRACKING_FILE, "a") as f:
            for record in new_records:
                f.write(json.dumps(record) + "\n")
        save_state(tracked_ids)
        print(f"codex-tracker: recorded {len(new_records)} session(s)")


if __name__ == "__main__":
    main()
