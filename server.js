#!/usr/bin/env node

/**
 * AI Usage Dashboard — static HTML generator.
 * Reads ~/.claude/session-usage.jsonl, generates a self-contained HTML dashboard
 * with embedded data + Chart.js (CDN), writes to /tmp/ai-usage-dashboard.html, and opens it.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import https from 'https';

const HOME = homedir();
const JSONL_PATH = join(HOME, '.claude', 'session-usage.jsonl');
const PRICING_CACHE_PATH = join(HOME, '.claude', 'model-pricing-cache.json');
const OUTPUT_PATH = '/tmp/ai-usage-dashboard.html';
const PRICING_CACHE_MAX_AGE_MS = 86400 * 1000; // 24h

// Provider prefix mapping for models.dev lookup
const PROVIDER_PREFIXES = { gpt: 'openai', o1: 'openai', o3: 'openai', claude: 'anthropic' };

function modelDevId(modelName) {
  for (const [prefix, provider] of Object.entries(PROVIDER_PREFIXES)) {
    if (modelName.startsWith(prefix)) return `${provider}/${modelName}`;
  }
  return modelName;
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

async function fetchModelsDev() {
  const data = await fetchJson('https://models.dev/api.json');
  const pricing = {};
  for (const [providerId, providerData] of Object.entries(data)) {
    if (!providerData || typeof providerData !== 'object') continue;
    const models = providerData.models;
    if (!models || typeof models !== 'object') continue;
    for (const [modelId, modelData] of Object.entries(models)) {
      if (!modelData || typeof modelData !== 'object') continue;
      const cost = modelData.cost;
      if (!cost || typeof cost !== 'object') continue;
      pricing[`${providerId}/${modelId}`] = {
        input: cost.input || 0,
        output: cost.output || 0,
        cache_read: cost.cache_read || 0,
        cache_write: cost.cache_write || 0,
      };
    }
  }
  return pricing;
}

async function loadPricingCache() {
  const now = Date.now();

  // Try cached file first
  if (existsSync(PRICING_CACHE_PATH)) {
    try {
      const cache = JSON.parse(readFileSync(PRICING_CACHE_PATH, 'utf8'));
      if (now - (cache.fetched_at * 1000) < PRICING_CACHE_MAX_AGE_MS) {
        return cache.models || {};
      }
    } catch { /* stale or corrupt — refresh */ }
  }

  // Refresh from models.dev
  try {
    const pricing = await fetchModelsDev();
    const cache = { fetched_at: now / 1000, models: pricing };
    writeFileSync(PRICING_CACHE_PATH, JSON.stringify(cache));
    return pricing;
  } catch (e) {
    process.stderr.write(`pricing fetch failed: ${e.message}\n`);
    // Fall back to stale cache
    if (existsSync(PRICING_CACHE_PATH)) {
      try {
        return JSON.parse(readFileSync(PRICING_CACHE_PATH, 'utf8')).models || {};
      } catch { /* give up */ }
    }
    return {};
  }
}

function computeCost(pricing, modelName, inputTokens, cachedTokens, outputTokens) {
  const devId = modelDevId(modelName);
  const rates = pricing[devId];
  if (!rates) return null;
  return (
    inputTokens * rates.input +
    cachedTokens * (rates.cache_read || 0) +
    outputTokens * rates.output
  ) / 1_000_000;
}

// --- Data loading & normalization ---

function loadRecords(pricing) {
  if (!existsSync(JSONL_PATH)) return [];

  const lines = readFileSync(JSONL_PATH, 'utf8').split('\n').filter(l => l.trim());
  const records = [];

  for (const line of lines) {
    try {
      const raw = JSON.parse(line);
      records.push(normalize(raw, pricing));
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

function normalize(r, pricing) {
  const source = r.source || 'claude-code';
  const projectPath = r.project_path || '';

  const inputTokens = r.total_input_tokens || 0;
  const outputTokens = r.total_output_tokens || 0;
  const cacheReadTokens = source === 'codex' ? (r.cached_input_tokens || 0) : (r.cache_read_tokens || 0);
  const cacheWriteTokens = source === 'codex' ? 0 : (r.cache_creation_tokens || 0);
  const models = r.models || [];

  // Use stored cost if available, otherwise compute from pricing cache
  let costUsd = r.cost_usd ?? null;
  if (costUsd == null && models.length > 0 && pricing) {
    const raw = computeCost(pricing, models[0], inputTokens, cacheReadTokens, outputTokens);
    if (raw != null) costUsd = Math.round(raw * 1000) / 1000;
  }

  return {
    source,
    session_id: r.session_id || null,
    date_closed: r.date_closed || null,
    duration_mins: r.duration_mins ?? null,
    session_summary: r.session_summary || null,
    first_prompt: r.first_prompt || null,
    cost_usd: costUsd,
    total_input_tokens: inputTokens,
    total_output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    reasoning_tokens: source === 'codex' ? (r.reasoning_output_tokens || 0) : 0,
    tool_calls: r.tool_calls || {},
    top_tool: r.top_tool,
    total_tool_calls: r.total_tool_calls || 0,
    models,
    agent_count: r.agent_count || 0,
    project: projectPath ? basename(projectPath) : '',
    git_branch: r.git_branch || null,
  };
}

// --- HTML generation ---

function generateHTML(records) {
  const dataJson = JSON.stringify(records).replace(/<\//g, '<\\/');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Usage Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"><\/script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0f0f23;
    color: #ccc;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Menlo', monospace;
    font-size: 13px;
    padding: 20px;
    line-height: 1.5;
  }
  h1 {
    color: #00cc7a;
    font-size: 20px;
    margin-bottom: 4px;
  }
  .subtitle {
    color: #666;
    font-size: 12px;
    margin-bottom: 20px;
  }
  .no-data {
    text-align: center;
    padding: 80px 20px;
    color: #666;
    font-size: 16px;
  }

  /* Summary cards */
  .cards {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: 20px;
  }
  .card {
    background: #1a1a2e;
    border: 1px solid #2a2a4a;
    border-radius: 8px;
    padding: 16px;
  }
  .card-label {
    color: #666;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 6px;
  }
  .card-value {
    font-size: 28px;
    font-weight: bold;
    color: #fff;
  }
  .card-detail {
    color: #888;
    font-size: 11px;
    margin-top: 4px;
  }

  /* Charts */
  .charts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 20px;
  }
  .chart-box {
    background: #1a1a2e;
    border: 1px solid #2a2a4a;
    border-radius: 8px;
    padding: 16px;
  }
  .chart-box h3 {
    color: #aaa;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 12px;
  }
  .chart-container {
    position: relative;
    height: 220px;
  }

  /* Table */
  .table-wrap {
    background: #1a1a2e;
    border: 1px solid #2a2a4a;
    border-radius: 8px;
    overflow: hidden;
  }
  .table-wrap h3 {
    color: #aaa;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 1px;
    padding: 16px 16px 8px;
  }
  .table-scroll {
    overflow-x: auto;
    max-height: 500px;
    overflow-y: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    min-width: 1000px;
  }
  th, td {
    text-align: left;
    padding: 8px 12px;
    border-bottom: 1px solid #1e1e38;
    white-space: nowrap;
  }
  th {
    background: #151530;
    color: #888;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    cursor: pointer;
    user-select: none;
    position: sticky;
    top: 0;
    z-index: 1;
  }
  th:hover { color: #00cc7a; }
  th .sort-arrow { margin-left: 4px; font-size: 10px; }
  tr:hover td { background: #1e1e3a; }
  tr.empty-session td { opacity: 0.4; }
  td.summary-cell {
    max-width: 250px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .source-badge {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: bold;
    text-transform: uppercase;
  }
  .source-badge.cc { background: #1a3a2a; color: #00cc7a; }
  .source-badge.codex { background: #2a2a1a; color: #ccaa00; }

  @media (max-width: 900px) {
    .cards { grid-template-columns: repeat(2, 1fr); }
    .charts { grid-template-columns: 1fr; }
  }
  @media (max-width: 500px) {
    .cards { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>

<h1>AI Usage Dashboard</h1>
<div class="subtitle">Generated ${new Date().toLocaleString()} from ~/.claude/session-usage.jsonl</div>

<div id="app"></div>

<script>
const DATA = ${dataJson};

const CC_COLOR = '#00cc7a';
const CODEX_COLOR = '#ccaa00';

// --- Helpers ---
function fmt(n) {
  if (n == null) return '-';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function fmtCost(n) {
  if (n == null) return '-';
  return '$' + n.toFixed(2);
}

function fmtDuration(mins) {
  if (mins == null) return '-';
  if (mins < 60) return mins + 'm';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h + 'h ' + m + 'm';
}

function dateStr(d) {
  if (!d) return '-';
  return d.slice(0, 10);
}

function shortDate(d) {
  if (!d) return '';
  return d.slice(5, 10); // MM-DD
}

const app = document.getElementById('app');

if (DATA.length === 0) {
  app.innerHTML = '<div class="no-data">No session data found.<br>Sessions will appear here after using Claude Code or Codex.</div>';
} else {
  renderDashboard();
}

function renderDashboard() {
  const ccSessions = DATA.filter(d => d.source === 'claude-code');
  const codexSessions = DATA.filter(d => d.source === 'codex');

  const ccCost = ccSessions.reduce((s, d) => s + (d.cost_usd || 0), 0);
  const codexCost = codexSessions.reduce((s, d) => s + (d.cost_usd || 0), 0);
  const totalCost = ccCost + codexCost;
  const totalInput = DATA.reduce((s, d) => s + d.total_input_tokens, 0);
  const totalOutput = DATA.reduce((s, d) => s + d.total_output_tokens, 0);
  const totalMins = DATA.reduce((s, d) => s + (d.duration_mins || 0), 0);
  const totalHours = (totalMins / 60).toFixed(1);
  const codexMissing = codexSessions.filter(d => d.cost_usd == null).length;
  const costNote = codexMissing > 0 ? ' (' + codexMissing + ' Codex sessions unpriced)' : '';

  // --- Summary Cards ---
  let html = '<div class="cards">';
  html += card('Sessions', DATA.length, 'CC: ' + ccSessions.length + ' / Codex: ' + codexSessions.length);
  html += card('Cost', fmtCost(totalCost), 'CC: ' + fmtCost(ccCost) + ' / Codex: ' + fmtCost(codexCost) + costNote);
  html += card('Tokens', fmt(totalInput + totalOutput), 'In: ' + fmt(totalInput) + ' / Out: ' + fmt(totalOutput));
  html += card('Time', totalHours + 'h', fmtDuration(totalMins) + ' total across all sessions');
  html += '</div>';

  // --- Charts ---
  html += '<div class="charts">';
  html += '<div class="chart-box"><h3>Sessions Over Time</h3><div class="chart-container"><canvas id="chart-sessions"></canvas></div></div>';
  html += '<div class="chart-box"><h3>Cost Over Time</h3><div class="chart-container"><canvas id="chart-cost"></canvas></div></div>';
  html += '<div class="chart-box"><h3>Token Breakdown by Source</h3><div class="chart-container"><canvas id="chart-tokens"></canvas></div></div>';
  html += '<div class="chart-box"><h3>Top Tools</h3><div class="chart-container"><canvas id="chart-tools"></canvas></div></div>';
  html += '<div class="chart-box" style="grid-column: 1 / -1;"><h3>Model Usage</h3><div class="chart-container"><canvas id="chart-models"></canvas></div></div>';
  html += '</div>';

  // --- Session Table ---
  html += '<div class="table-wrap"><h3>Sessions</h3><div class="table-scroll">';
  html += '<table id="session-table"><thead><tr>';
  const cols = [
    { key: 'date_closed', label: 'Date' },
    { key: 'source', label: 'Source' },
    { key: 'duration_mins', label: 'Duration' },
    { key: 'session_summary', label: 'Summary' },
    { key: 'cost_usd', label: 'Cost' },
    { key: 'total_input_tokens', label: 'Tokens' },
    { key: 'total_tool_calls', label: 'Tools' },
    { key: 'top_tool', label: 'Top Tool' },
    { key: 'project', label: 'Project' },
    { key: 'models', label: 'Model' },
  ];
  for (const c of cols) {
    html += '<th data-col="' + c.key + '">' + c.label + ' <span class="sort-arrow"></span></th>';
  }
  html += '</tr></thead><tbody id="table-body"></tbody></table>';
  html += '</div></div>';

  app.innerHTML = html;

  renderTable(DATA, 'date_closed', true);
  setupSort(DATA);
  renderCharts(DATA);
}

function card(label, value, detail) {
  return '<div class="card"><div class="card-label">' + label + '</div><div class="card-value">' + value + '</div><div class="card-detail">' + detail + '</div></div>';
}

// --- Table ---
let currentSort = 'date_closed';
let currentDesc = true;

function renderTable(data, sortKey, desc) {
  const sorted = [...data].sort((a, b) => {
    let va = getSortVal(a, sortKey);
    let vb = getSortVal(b, sortKey);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string') {
      const cmp = va.localeCompare(vb);
      return desc ? -cmp : cmp;
    }
    return desc ? vb - va : va - vb;
  });

  const tbody = document.getElementById('table-body');
  let html = '';
  for (const r of sorted) {
    const isEmpty = r.total_tool_calls === 0;
    const cls = isEmpty ? ' class="empty-session"' : '';
    const badge = r.source === 'codex'
      ? '<span class="source-badge codex">Codex</span>'
      : '<span class="source-badge cc">CC</span>';
    const summary = r.session_summary || r.first_prompt || '';
    const displaySummary = summary.length > 80 ? summary.slice(0, 80) + '...' : summary;
    const totalTok = r.total_input_tokens + r.total_output_tokens;
    const topToolName = r.top_tool ? r.top_tool.name + ' (' + r.top_tool.count + ')' : '-';
    const model = r.models && r.models.length ? r.models[0] : '-';

    html += '<tr' + cls + '>';
    html += '<td>' + dateStr(r.date_closed) + '</td>';
    html += '<td>' + badge + '</td>';
    html += '<td>' + fmtDuration(r.duration_mins) + '</td>';
    html += '<td class="summary-cell" title="' + escAttr(summary) + '">' + escHtml(displaySummary) + '</td>';
    html += '<td>' + fmtCost(r.cost_usd) + '</td>';
    html += '<td>' + fmt(totalTok) + '</td>';
    html += '<td>' + (r.total_tool_calls || '-') + '</td>';
    html += '<td>' + escHtml(topToolName) + '</td>';
    html += '<td>' + escHtml(r.project) + '</td>';
    html += '<td>' + escHtml(model) + '</td>';
    html += '</tr>';
  }
  tbody.innerHTML = html;

  // Update sort arrows
  document.querySelectorAll('#session-table th').forEach(th => {
    const arrow = th.querySelector('.sort-arrow');
    if (th.dataset.col === sortKey) {
      arrow.textContent = desc ? ' \\u25BC' : ' \\u25B2';
    } else {
      arrow.textContent = '';
    }
  });
}

function getSortVal(r, key) {
  if (key === 'top_tool') return r.top_tool ? r.top_tool.name : null;
  if (key === 'models') return r.models && r.models.length ? r.models[0] : null;
  if (key === 'total_input_tokens') return r.total_input_tokens + r.total_output_tokens;
  return r[key];
}

function setupSort(data) {
  document.querySelectorAll('#session-table th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (currentSort === col) {
        currentDesc = !currentDesc;
      } else {
        currentSort = col;
        currentDesc = true;
      }
      renderTable(data, currentSort, currentDesc);
    });
  });
}

function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Charts ---
function renderCharts(data) {
  const chartDefaults = {
    color: '#888',
    borderColor: '#2a2a4a',
  };
  Chart.defaults.color = '#888';
  Chart.defaults.borderColor = '#2a2a4a';

  sessionsChart(data);
  costChart(data);
  tokensChart(data);
  toolsChart(data);
  modelsChart(data);
}

function sessionsChart(data) {
  // Group by date and source
  const byDate = {};
  for (const r of data) {
    const d = dateStr(r.date_closed);
    if (d === '-') continue;
    if (!byDate[d]) byDate[d] = { cc: 0, codex: 0 };
    if (r.source === 'codex') byDate[d].codex++;
    else byDate[d].cc++;
  }
  const dates = Object.keys(byDate).sort();

  new Chart(document.getElementById('chart-sessions'), {
    type: 'bar',
    data: {
      labels: dates.map(shortDate),
      datasets: [
        { label: 'Claude Code', data: dates.map(d => byDate[d].cc), backgroundColor: CC_COLOR, borderRadius: 3 },
        { label: 'Codex', data: dates.map(d => byDate[d].codex), backgroundColor: CODEX_COLOR, borderRadius: 3 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1 } } },
      plugins: { legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } } },
    },
  });
}

function costChart(data) {
  // Aggregate cost by date and source
  const byDate = {};
  for (const r of data) {
    if (!r.cost_usd) continue;
    const d = dateStr(r.date_closed);
    if (d === '-') continue;
    if (!byDate[d]) byDate[d] = { cc: 0, codex: 0 };
    if (r.source === 'codex') byDate[d].codex += r.cost_usd;
    else byDate[d].cc += r.cost_usd;
  }
  const dates = Object.keys(byDate).sort();

  new Chart(document.getElementById('chart-cost'), {
    type: 'bar',
    data: {
      labels: dates.map(shortDate),
      datasets: [
        { label: 'Claude Code', data: dates.map(d => +byDate[d].cc.toFixed(2)), backgroundColor: CC_COLOR, borderRadius: 3 },
        { label: 'Codex', data: dates.map(d => +byDate[d].codex.toFixed(2)), backgroundColor: CODEX_COLOR, borderRadius: 3 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true },
        y: { stacked: true, beginAtZero: true, ticks: { callback: v => '$' + v } },
      },
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': $' + ctx.parsed.y.toFixed(2) } },
      },
    },
  });
}

function tokensChart(data) {
  const cc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  const codex = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

  for (const r of data) {
    const t = r.source === 'codex' ? codex : cc;
    t.input += r.total_input_tokens;
    t.output += r.total_output_tokens;
    t.cacheRead += r.cache_read_tokens;
    t.cacheWrite += r.cache_write_tokens;
    t.reasoning += r.reasoning_tokens;
  }

  const categories = ['Input', 'Output', 'Cache Read', 'Cache Write', 'Reasoning'];

  new Chart(document.getElementById('chart-tokens'), {
    type: 'bar',
    data: {
      labels: categories,
      datasets: [
        {
          label: 'Claude Code',
          data: [cc.input, cc.output, cc.cacheRead, cc.cacheWrite, cc.reasoning],
          backgroundColor: CC_COLOR,
          borderRadius: 3,
        },
        {
          label: 'Codex',
          data: [codex.input, codex.output, codex.cacheRead, codex.cacheWrite, codex.reasoning],
          backgroundColor: CODEX_COLOR,
          borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, ticks: { callback: v => fmt(v) } } },
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + fmt(ctx.parsed.y) } },
      },
    },
  });
}

function toolsChart(data) {
  // Aggregate tool usage across all sessions, split by source
  const ccTools = {};
  const codexTools = {};
  for (const r of data) {
    const bucket = r.source === 'codex' ? codexTools : ccTools;
    for (const [tool, count] of Object.entries(r.tool_calls)) {
      bucket[tool] = (bucket[tool] || 0) + count;
    }
  }

  // Merge and sort by total
  const allTools = new Set([...Object.keys(ccTools), ...Object.keys(codexTools)]);
  const toolTotals = [];
  for (const tool of allTools) {
    toolTotals.push({ tool, cc: ccTools[tool] || 0, codex: codexTools[tool] || 0, total: (ccTools[tool] || 0) + (codexTools[tool] || 0) });
  }
  toolTotals.sort((a, b) => b.total - a.total);
  const top = toolTotals.slice(0, 15);

  new Chart(document.getElementById('chart-tools'), {
    type: 'bar',
    data: {
      labels: top.map(t => t.tool),
      datasets: [
        { label: 'Claude Code', data: top.map(t => t.cc), backgroundColor: CC_COLOR, borderRadius: 3 },
        { label: 'Codex', data: top.map(t => t.codex), backgroundColor: CODEX_COLOR, borderRadius: 3 },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true, beginAtZero: true },
        y: { stacked: true },
      },
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
      },
    },
  });
}

function modelsChart(data) {
  // Count sessions and total cost per model
  const modelStats = {};
  for (const r of data) {
    const model = r.models && r.models.length ? r.models[0] : null;
    if (!model) continue;
    if (!modelStats[model]) modelStats[model] = { sessions: 0, cost: 0, tokens: 0 };
    modelStats[model].sessions++;
    modelStats[model].cost += r.cost_usd || 0;
    modelStats[model].tokens += r.total_input_tokens + r.total_output_tokens;
  }

  const sorted = Object.entries(modelStats).sort((a, b) => b[1].sessions - a[1].sessions);
  const labels = sorted.map(([m]) => m);
  const sessions = sorted.map(([, s]) => s.sessions);
  const costs = sorted.map(([, s]) => +s.cost.toFixed(2));

  // Assign colors — CC models get green shades, Codex models get gold shades
  const colors = labels.map(m => m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') ? CODEX_COLOR : CC_COLOR);

  new Chart(document.getElementById('chart-models'), {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Sessions',
          data: sessions,
          backgroundColor: colors.map(c => c + 'cc'),
          borderRadius: 3,
          yAxisID: 'y',
        },
        {
          label: 'Cost (USD)',
          data: costs,
          type: 'line',
          borderColor: '#ff6b6b',
          backgroundColor: '#ff6b6b33',
          pointRadius: 4,
          tension: 0.3,
          yAxisID: 'y1',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true, position: 'left', title: { display: true, text: 'Sessions', color: '#888' }, ticks: { stepSize: 1 } },
        y1: { beginAtZero: true, position: 'right', title: { display: true, text: 'Cost ($)', color: '#ff6b6b' }, ticks: { callback: v => '$' + v }, grid: { drawOnChartArea: false } },
      },
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            afterBody: function(items) {
              const idx = items[0].dataIndex;
              return 'Tokens: ' + fmt(sorted[idx][1].tokens);
            }
          }
        },
      },
    },
  });
}
<\/script>
</body>
</html>`;
}

// --- Main ---

const pricing = await loadPricingCache();
const pricedModels = Object.keys(pricing).length;
const records = loadRecords(pricing);
const html = generateHTML(records);
writeFileSync(OUTPUT_PATH, html);
const withCost = records.filter(r => r.cost_usd != null).length;
console.log(`Dashboard written to ${OUTPUT_PATH} (${records.length} sessions, ${withCost} with cost data, ${pricedModels} models in pricing cache)`);
execSync('open /tmp/ai-usage-dashboard.html');
