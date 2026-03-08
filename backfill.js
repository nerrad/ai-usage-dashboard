#!/usr/bin/env node

/**
 * One-shot backfill: finds all Claude Code session transcripts still on disk,
 * parses them with the same logic as session-tracker.js, deduplicates against
 * existing session-usage.jsonl entries, and appends new records.
 *
 * Usage: node ~/.claude/usage-dashboard/backfill.js [--dry-run]
 */

import { readFileSync, appendFileSync, existsSync, createReadStream } from 'fs';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { globSync } from 'fs';
import { readdirSync } from 'fs';

const HOME = homedir();
const PROJECTS_DIR = join(HOME, '.claude', 'projects');
const TRACKING_FILE = join(HOME, '.claude', 'session-usage.jsonl');
const DRY_RUN = process.argv.includes('--dry-run');

// --- Transcript parser (same logic as session-tracker.js) ---

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

  if (!existsSync(transcriptPath)) return stats;

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

    const ts = obj.timestamp;
    if (ts) {
      if (!stats.first_timestamp) stats.first_timestamp = ts;
      stats.last_timestamp = ts;
    }

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

    if (msg.model) stats.models.add(msg.model);

    const usage = msg.usage;
    if (usage) {
      stats.total_input_tokens += usage.input_tokens || 0;
      stats.total_output_tokens += usage.output_tokens || 0;
      stats.cache_creation_tokens += usage.cache_creation_input_tokens || 0;
      stats.cache_read_tokens += usage.cache_read_input_tokens || 0;
    }

    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use') {
          const name = block.name || 'unknown';
          stats.tool_calls[name] = (stats.tool_calls[name] || 0) + 1;
          stats.total_tool_calls++;
          if (name === 'Agent') stats.agent_count++;
        }
      }
    }
  }

  return stats;
}

// --- Find all sessions from index files ---

function findAllSessions() {
  const sessions = [];

  let projectDirs;
  try {
    projectDirs = readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => join(PROJECTS_DIR, d.name));
  } catch {
    return sessions;
  }

  for (const dir of projectDirs) {
    const indexPath = join(dir, 'sessions-index.json');
    if (!existsSync(indexPath)) continue;

    let data;
    try {
      data = JSON.parse(readFileSync(indexPath, 'utf8'));
    } catch {
      continue;
    }

    for (const entry of data.entries || []) {
      const transcriptPath = entry.fullPath;
      if (!transcriptPath || !existsSync(transcriptPath)) continue;

      sessions.push({
        sessionId: entry.sessionId,
        transcriptPath,
        summary: entry.summary || null,
        firstPromptIndex: entry.firstPrompt || null,
        gitBranch: entry.gitBranch || null,
        messageCount: entry.messageCount || 0,
        created: entry.created || null,
        modified: entry.modified || null,
        projectPath: entry.projectPath || null,
      });
    }
  }

  return sessions;
}

// --- Load existing session IDs to deduplicate ---

function loadExistingIds() {
  const ids = new Set();
  if (!existsSync(TRACKING_FILE)) return ids;

  const lines = readFileSync(TRACKING_FILE, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.session_id) ids.add(r.session_id);
    } catch {
      // skip
    }
  }
  return ids;
}

// --- Main ---

async function main() {
  const existingIds = loadExistingIds();
  const allSessions = findAllSessions();

  const toProcess = allSessions.filter(s => !existingIds.has(s.sessionId));

  console.log(`Found ${allSessions.length} sessions with transcripts on disk`);
  console.log(`Already tracked: ${allSessions.length - toProcess.length}`);
  console.log(`To backfill: ${toProcess.length}`);

  if (toProcess.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  let appended = 0;

  for (const session of toProcess) {
    const stats = await parseTranscript(session.transcriptPath);

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

    // Estimate cost (Opus pricing)
    const costUsd =
      (stats.total_input_tokens * 15 +
        stats.cache_creation_tokens * 3.75 +
        stats.cache_read_tokens * 0.3 +
        stats.total_output_tokens * 75) / 1_000_000;

    // Use modified timestamp as date_closed (best approximation for historical sessions)
    const dateClosed = session.modified || session.created || null;

    const record = {
      source: 'claude-code',
      session_id: session.sessionId,
      reason: 'backfill',
      date_closed: dateClosed,
      duration_mins: durationMins,
      session_summary: session.summary || null,
      first_prompt: stats.first_prompt || session.firstPromptIndex || null,
      cost_usd: Math.round(costUsd * 1000) / 1000,
      total_input_tokens: stats.total_input_tokens,
      total_output_tokens: stats.total_output_tokens,
      cache_creation_tokens: stats.cache_creation_tokens,
      cache_read_tokens: stats.cache_read_tokens,
      tool_calls: stats.tool_calls,
      top_tool: topTool ? { name: topTool, count: topCount } : null,
      total_tool_calls: stats.total_tool_calls,
      models: Array.from(stats.models),
      agent_count: stats.agent_count,
      project_path: session.projectPath,
      git_branch: session.gitBranch || null,
      message_count: session.messageCount || null,
    };

    const line = JSON.stringify(record) + '\n';

    if (DRY_RUN) {
      const summary = record.session_summary || record.first_prompt || '(no summary)';
      const display = summary.length > 60 ? summary.slice(0, 60) + '...' : summary;
      console.log(`  [dry-run] ${(dateClosed || '?').slice(0, 10)}  $${costUsd.toFixed(2).padStart(6)}  ${display}`);
    } else {
      appendFileSync(TRACKING_FILE, line);
    }
    appended++;
  }

  if (DRY_RUN) {
    console.log(`\n${appended} records would be appended. Run without --dry-run to commit.`);
  } else {
    console.log(`\nAppended ${appended} records to ${TRACKING_FILE}`);
  }
}

main().catch(err => {
  console.error('backfill error:', err.message);
  process.exit(1);
});
