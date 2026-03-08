#!/usr/bin/env node

/**
 * SessionEnd hook: captures session stats and appends to a JSONL tracking file.
 *
 * Tracked fields:
 *   session_id, reason, date_closed, duration_mins,
 *   session_summary, first_prompt,
 *   cost_usd, total_input_tokens, total_output_tokens,
 *   tool_calls (count per tool), top_tool, total_tool_calls,
 *   models, agent_count, project_path, git_branch
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { stdin } from 'process';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import https from 'https';

const HOME = homedir();
const TRACKING_FILE = join(HOME, '.claude', 'session-usage.jsonl');
const PRICING_CACHE_PATH = join(HOME, '.claude', 'model-pricing-cache.json');
const PRICING_CACHE_MAX_AGE_MS = 86400 * 1000;

const PROVIDER_PREFIXES = { gpt: 'openai', o1: 'openai', o3: 'openai', claude: 'anthropic' };

function modelDevId(name) {
  for (const [prefix, provider] of Object.entries(PROVIDER_PREFIXES)) {
    if (name.startsWith(prefix)) return `${provider}/${name}`;
  }
  return name;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function loadPricingCache() {
  const now = Date.now();
  if (existsSync(PRICING_CACHE_PATH)) {
    try {
      const cache = JSON.parse(readFileSync(PRICING_CACHE_PATH, 'utf8'));
      if (now - (cache.fetched_at * 1000) < PRICING_CACHE_MAX_AGE_MS) {
        return cache.models || {};
      }
    } catch { /* refresh */ }
  }
  try {
    const data = await fetchJson('https://models.dev/api.json');
    const pricing = {};
    for (const [pid, pdata] of Object.entries(data)) {
      if (!pdata?.models || typeof pdata.models !== 'object') continue;
      for (const [mid, mdata] of Object.entries(pdata.models)) {
        const cost = mdata?.cost;
        if (!cost || typeof cost !== 'object') continue;
        pricing[`${pid}/${mid}`] = {
          input: cost.input || 0, output: cost.output || 0,
          cache_read: cost.cache_read || 0, cache_write: cost.cache_write || 0,
        };
      }
    }
    writeFileSync(PRICING_CACHE_PATH, JSON.stringify({ fetched_at: now / 1000, models: pricing }));
    return pricing;
  } catch {
    if (existsSync(PRICING_CACHE_PATH)) {
      try { return JSON.parse(readFileSync(PRICING_CACHE_PATH, 'utf8')).models || {}; } catch {}
    }
    return {};
  }
}

function computeCost(pricing, model, inputTok, cacheWriteTok, cacheReadTok, outputTok) {
  const rates = pricing[modelDevId(model)];
  if (!rates) return null;
  return (
    inputTok * rates.input +
    cacheWriteTok * (rates.cache_write || 0) +
    cacheReadTok * (rates.cache_read || 0) +
    outputTok * rates.output
  ) / 1_000_000;
}

async function parseTranscript(transcriptPath) {
  const stats = {
    total_input_tokens: 0,
    total_output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    tool_calls: {},
    total_tool_calls: 0,
    models: new Set(),
    agent_count: 0,
    first_prompt: null,
    first_timestamp: null,
    last_timestamp: null,
  };

  if (!existsSync(transcriptPath)) {
    return stats;
  }

  const agentToolIds = new Set();

  const rl = createInterface({
    input: createReadStream(transcriptPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    // Track timestamps for duration
    const ts = obj.timestamp;
    if (ts) {
      if (!stats.first_timestamp) stats.first_timestamp = ts;
      stats.last_timestamp = ts;
    }

    // First user prompt
    if (obj.type === 'user' && stats.first_prompt === null) {
      const content = obj.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text') {
            stats.first_prompt = block.text?.slice(0, 300) || '';
            break;
          }
        }
      } else if (typeof content === 'string') {
        stats.first_prompt = content.slice(0, 300);
      }
    }

    const msg = obj.message || {};

    // Models
    if (msg.model) {
      stats.models.add(msg.model);
    }

    // Token usage
    const usage = msg.usage;
    if (usage) {
      stats.total_input_tokens += usage.input_tokens || 0;
      stats.total_output_tokens += usage.output_tokens || 0;
      stats.cache_creation_tokens += usage.cache_creation_input_tokens || 0;
      stats.cache_read_tokens += usage.cache_read_input_tokens || 0;
    }

    // Tool calls
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use') {
          const name = block.name || 'unknown';
          stats.tool_calls[name] = (stats.tool_calls[name] || 0) + 1;
          stats.total_tool_calls++;

          // Track Agent/subagent tool calls
          if (name === 'Agent') {
            agentToolIds.add(block.id);
            stats.agent_count++;
          }
        }
      }
    }
  }

  return stats;
}

function getSessionMeta(sessionId, transcriptPath) {
  // Derive the project directory from the transcript path
  // e.g. ~/.claude/projects/-Users-dethier/SESSION.jsonl -> look in that directory
  const indexPath = join(dirname(transcriptPath), 'sessions-index.json');

  if (!existsSync(indexPath)) {
    return {};
  }

  try {
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    const entry = (index.entries || []).find(e => e.sessionId === sessionId);
    if (entry) {
      return {
        summary: entry.summary || null,
        first_prompt_index: entry.firstPrompt || null,
        git_branch: entry.gitBranch || null,
        message_count: entry.messageCount || 0,
        created: entry.created || null,
        modified: entry.modified || null,
      };
    }
  } catch {
    // ignore
  }
  return {};
}

async function main() {
  // Read hook input from stdin
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString('utf8');
  const hookData = JSON.parse(input);

  const {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    reason,
  } = hookData;

  // Parse transcript for stats
  const stats = await parseTranscript(transcriptPath);

  // Get session metadata from index
  const meta = getSessionMeta(sessionId, transcriptPath);

  // Compute duration from transcript timestamps
  let durationMins = null;
  if (stats.first_timestamp && stats.last_timestamp) {
    const start = new Date(stats.first_timestamp).getTime();
    const end = new Date(stats.last_timestamp).getTime();
    durationMins = Math.round((end - start) / 60000);
  }

  // Find top tool
  let topTool = null;
  let topCount = 0;
  for (const [tool, count] of Object.entries(stats.tool_calls)) {
    if (count > topCount) {
      topTool = tool;
      topCount = count;
    }
  }

  // Estimate cost from models.dev pricing cache
  const pricing = await loadPricingCache();
  const primaryModel = stats.models.size > 0 ? Array.from(stats.models)[0] : null;
  let costUsd = null;
  if (primaryModel) {
    const raw = computeCost(
      pricing, primaryModel,
      stats.total_input_tokens, stats.cache_creation_tokens,
      stats.cache_read_tokens, stats.total_output_tokens
    );
    if (raw != null) costUsd = Math.round(raw * 1000) / 1000;
  }

  const record = {
    source: 'claude-code',
    session_id: sessionId,
    reason,
    date_closed: new Date().toISOString(),
    duration_mins: durationMins,
    session_summary: meta.summary || null,
    first_prompt: stats.first_prompt || meta.first_prompt_index || null,
    cost_usd: costUsd,
    total_input_tokens: stats.total_input_tokens,
    total_output_tokens: stats.total_output_tokens,
    cache_creation_tokens: stats.cache_creation_tokens,
    cache_read_tokens: stats.cache_read_tokens,
    tool_calls: stats.tool_calls,
    top_tool: topTool ? { name: topTool, count: topCount } : null,
    total_tool_calls: stats.total_tool_calls,
    models: Array.from(stats.models),
    agent_count: stats.agent_count,
    project_path: cwd,
    git_branch: meta.git_branch || null,
    message_count: meta.message_count || null,
  };

  // Ensure directory exists
  const dir = dirname(TRACKING_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Append as JSONL
  appendFileSync(TRACKING_FILE, JSON.stringify(record) + '\n');
}

main().catch(err => {
  process.stderr.write(`session-tracker error: ${err.message}\n`);
  process.exit(1);
});
