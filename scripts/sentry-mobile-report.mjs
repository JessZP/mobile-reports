#!/usr/bin/env node
/**
 * Builds weekly Sentry/Jira mobile production reports and posts them to Teams.
 *
 * Usage:
 *   node scripts/sentry-mobile-report.mjs --dry-run
 *   node scripts/sentry-mobile-report.mjs --platform ios --dry-run
 *   node scripts/sentry-mobile-report.mjs --platform android
 */

import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PLATFORMS = ['ios', 'android'];

/** HTML Helpers - Optimized for Teams Webhooks */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const html = {
  h2: (t) => `<h2>${t}</h2>`,
  h3: (t) => `<h3>${t}</h3>`,
  b: (t) => `<b>${t}</b>`,
  i: (t) => `<i>${t}</i>`,
  u: (t) => `<u>${t}</u>`,
  code: (t) => `<code>${t}</code>`,
  li: (t) => `<li>${t}</li>`,
  ul: (items) => `<ul>${items.join('')}</ul>`,
  a: (text, url) => `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`,
  br: () => `<br/>`,
  p: (t) => `<p>${t}</p>`,
  div: (t) => `<div>${t}</div>`,
  hr: () => `<hr/>`,
};

function parseArgs(argv) {
  const out = { platform: 'both', dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--platform') out.platform = argv[++i];
    else if (arg === '--dry-run') out.dryRun = true;
  }
  if (out.platform === 'all') out.platform = 'both';
  return out;
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config/products.json'), 'utf8'));
}

function request(method, url, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (chunk) => (buf += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const sentryHeaders = () => ({ Authorization: `Bearer ${requireEnv('SENTRY_AUTH_TOKEN')}` });
const jiraHeaders = () => {
  const email = process.env.JIRA_EMAIL || requireEnv('JIRA_EMAIL');
  const token = requireEnv('JIRA_API_TOKEN');
  return { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` };
};

async function sentryGetPage(pathOrUrl, params = {}) {
  const url = pathOrUrl.startsWith('http') ? new URL(pathOrUrl) : new URL(`https://sentry.io/api/0${pathOrUrl}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
    else url.searchParams.set(k, v);
  }
  const { status, body, headers } = await request('GET', url.toString(), sentryHeaders());
  if (status < 200 || status >= 300) throw new Error(`Sentry error (${status}): ${body.slice(0, 300)}`);
  return { data: JSON.parse(body), headers };
}

async function sentryGetPaginated(path, params = {}, maxPages = 5) {
  const rows = [];
  let nextUrl = path;
  for (let page = 0; nextUrl && page < maxPages; page++) {
    const { data, headers } = await sentryGetPage(nextUrl, page === 0 ? params : {});
    rows.push(...data);
    const link = headers?.link || '';
    const next = link.split(',').find(p => p.includes('rel="next"') && p.includes('results="true"'));
    nextUrl = next?.match(/<([^>]+)>/)?.[1] || null;
  }
  return rows;
}

// Same idea as sentryGetPaginated, but for endpoints (like organization events)
// whose payload is `{ data: [...] }` instead of a bare array.
async function sentryGetPaginatedEnvelope(path, params = {}, maxPages = 3) {
  const rows = [];
  let nextUrl = path;
  for (let page = 0; nextUrl && page < maxPages; page++) {
    const { data, headers } = await sentryGetPage(nextUrl, page === 0 ? params : {});
    rows.push(...(Array.isArray(data) ? data : (data?.data || [])));
    const link = headers?.link || '';
    const next = link.split(',').find(p => p.includes('rel="next"') && p.includes('results="true"'));
    nextUrl = next?.match(/<([^>]+)>/)?.[1] || null;
  }
  return rows;
}

const projectIdCache = new Map();
async function getProjectId(org, projectSlug) {
  const key = `${org}/${projectSlug}`;
  if (projectIdCache.has(key)) return projectIdCache.get(key);
  const { data } = await sentryGetPage(`/projects/${org}/${projectSlug}/`);
  projectIdCache.set(key, data.id);
  return data.id;
}

/**
 * Fetches per-issue event/user counts that are ACTUALLY scoped to `period`.
 * The project issues endpoint (used in getIssues) cannot do this: its `count`/
 * `userCount` fields are lifetime totals regardless of `statsPeriod`. The only
 * way to get a real windowed aggregate is the organization events (Discover)
 * endpoint, which supports `count()` / `count_unique(user)` grouped by issue
 * with a real `statsPeriod`/date range.
 * Requires the Sentry token to have org-level read access; if that's missing
 * (or the call fails for any reason) we log a warning and return an empty map
 * so callers fall back to lifetime totals instead of breaking the report.
 */
async function getWindowedIssueMetrics(org, projectSlug, release, environment, period) {
  const metrics = new Map();
  if (release === 'n/a' || !period) return metrics;
  try {
    const projectId = await getProjectId(org, projectSlug);
    const query = `is:unresolved release:"${release}" environment:"${environment}"`;
    const rows = await sentryGetPaginatedEnvelope(`/organizations/${org}/events/`, {
      field: ['issue', 'issue.id', 'count()', 'count_unique(user)'],
      query,
      project: [projectId],
      statsPeriod: period,
      sort: '-count()',
      per_page: 100,
    });
    for (const row of rows) {
      const id = String(row['issue.id'] ?? '');
      if (!id) continue;
      metrics.set(id, {
        count: Number(row['count()'] || 0),
        userCount: Number(row['count_unique(user)'] || 0),
      });
    }
  } catch (err) {
    console.warn(`Aviso: falha ao buscar métricas por janela (${period}) para ${projectSlug}/${release} (${err.message}). Usando total acumulado da issue como fallback.`);
  }
  return metrics;
}

/**
 * Release Detection: Tries to find the most recent releases for a specific product and flavor.
 * Logic:
 * 1. Filter by environment to find releases active in that environment.
 * 2. Filter by product ID strictly (e.g. 'afyapapers' shouldn't match 'internatoafya').
 * 3. Match flavors strictly (e.g. current flavor 'com.afyapapers.app.qa' should compare with previous '.qa').
 */
async function getReleasesForProduct(org, project, product) {
  // Fetch releases active in the specific environment to narrow down candidates
  const releases = await sentryGetPaginated(`/projects/${org}/${project}/releases/`, {
    per_page: 100,
    environment: product.environment
  }, 10);

  const versions = releases.map(r => r.version).filter(Boolean);
  const pId = product.id.toLowerCase();

  // Strict segment matching for product ID (e.g. "afyapapers" in "com.afyapapers.v4")
  const productVersions = versions.filter(v => {
    const segments = v.toLowerCase().split(/[^a-z0-9]/);
    return segments.includes(pId);
  });

  if (productVersions.length === 0) {
    // Second try: partial match if strict segment fails
    const fallbackVersions = versions.filter(v => v.toLowerCase().includes(pId));
    if (fallbackVersions.length === 0) return { current: 'n/a', previous: 'n/a', isFallback: true };
    return { current: fallbackVersions[0], previous: fallbackVersions[1] || 'n/a', isFallback: true };
  }

  const current = productVersions[0];
  const flavor = current.split('@')[0]; // Extract "com.package.name" part

  // Find previous release with the EXACT same flavor
  const previous = productVersions.find(v => v !== current && v.split('@')[0] === flavor) || productVersions[1] || 'n/a';

  return { current, previous, isFallback: false };
}

async function getIssues(org, project, release, environment, activeWindow) {
  if (release === 'n/a') return [];
  // Combine release and environment for precision. The project issues endpoint
  // does NOT scope `count`/`userCount` to a `statsPeriod` param - that param only
  // controls the `stats` sparkline field. To respect the report window we do two
  // things: (1) filter issues by `lastSeen`, a documented issue-search token
  // (https://docs.sentry.io/concepts/search/searchable-properties/issues/), so
  // stale/inactive issues from the release are excluded, and (2) overwrite
  // count/userCount with a real windowed aggregate from the organization events
  // (Discover) endpoint, which does support a genuine date-range aggregate.
  let query = `is:unresolved release:"${release}" environment:"${environment}"`;
  if (activeWindow) query += ` lastSeen:-${activeWindow}`;

  const [issues, windowed] = await Promise.all([
    sentryGetPaginated(`/projects/${org}/${project}/issues/`, {
      query,
      per_page: 100,
      sort: 'freq'
    }),
    getWindowedIssueMetrics(org, project, release, environment, activeWindow),
  ]);

  return issues.map(i => {
    const w = windowed.get(String(i.id));
    return {
      id: i.id, shortId: i.shortId, title: i.title || i.culprit || 'Sem título',
      // Prefer the real windowed count/users (Discover aggregate). Falls back to
      // the issue's lifetime total if the windowed lookup failed (e.g. missing
      // org:read scope) or didn't include this issue.
      count: w ? w.count : Number(i.count || i.events || 0),
      userCount: w ? w.userCount : Number(i.userCount || i.users || 0),
      windowed: Boolean(w),
      url: i.permalink, transaction: i.metadata?.transaction || ''
    };
  });
}

function summarize(issues) {
  return {
    issueCount: issues.length,
    eventCount: issues.reduce((s, i) => s + i.count, 0),
    userCount: issues.reduce((s, i) => s + i.userCount, 0),
    maxUser: issues.length ? Math.max(...issues.map(i => i.userCount)) : 0
  };
}

async function buildProductSection(config, platformKey, product) {
  const org = config.sentryOrg;
  const project = config.platforms[platformKey].project;
  const releases = await getReleasesForProduct(org, project, product);

  // Only unresolved issues from the current release with activity within the
  // configured window are considered "current" (see getIssues for details on
  // what activeWindow does and doesn't scope).
  const currentIssues = await getIssues(org, project, releases.current, product.environment, config.report.statsPeriod);

  const buckets = config.transactions.map(t => ({
    label: t,
    issues: currentIssues.filter(i => (i.transaction || '').toLowerCase().includes(t.toLowerCase()) || i.title.toLowerCase().includes(t.toLowerCase()))
  }));

  const taggedIds = new Set(buckets.flatMap(b => b.issues.map(i => i.id)));
  const otherIssues = currentIssues.filter(i => !taggedIds.has(i.id));

  return {
    product,
    releases,
    currentIssues,
    current: summarize(currentIssues),
    buckets,
    otherIssues,
  };
}

async function jiraSearch(config, jql) {
  const url = `${config.jira.baseUrl.replace(/\/$/, '')}/rest/api/3/search/jql`;
  const { status, body } = await request('POST', url, jiraHeaders(), { jql, maxResults: 50, fields: ['summary', 'status'] });
  return status === 200 ? JSON.parse(body).issues : [];
}

async function buildJiraData(config, platformKey) {
  const tag = config.jira.titleTag;
  const base = `summary ~ "${tag}" AND issuetype not in subTaskIssueTypes()`;
  const active = await jiraSearch(config, `${base} AND statusCategory != Done`);
  const done = await jiraSearch(config, `${base} AND statusCategory = Done AND resolved >= -14d`);

  const map = i => ({ key: i.key, title: i.fields.summary, status: i.fields.status.name, url: `${config.jira.baseUrl}/browse/${i.key}` });
  const filter = i => {
    const t = i.title.toLowerCase();
    const pk = platformKey.toLowerCase();
    // Keep if mentions platform or doesn't mention the other one
    const otherPk = pk === 'android' ? 'ios' : 'android';
    return t.includes(pk) || !t.includes(otherPk);
  };

  return { active: active.map(map).filter(filter), done: done.map(map).filter(filter) };
}

function getPeriodDates(period) {
  const now = new Date();
  let start = new Date(now);
  const m = period.match(/(\d+)([dw])/);
  if (m) {
    const v = parseInt(m[1]);
    if (m[2] === 'd') start.setDate(now.getDate() - v);
    else start.setDate(now.getDate() - v * 7);
  }
  const f = d => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  return { start, end: now, text: `${f(start)} a ${f(now)}` };
}

function fmtInt(n) {
  return Number(n || 0).toLocaleString('pt-BR');
}

function fmtApproxUsers(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `~${(v / 1_000_000).toFixed(1).replace('.', ',')} mi`;
  if (v >= 1_000) return `~${(v / 1_000).toFixed(1).replace('.', ',')} mil`;
  return fmtInt(v);
}

function table(headers, rows) {
  const th = headers.map(h => `<th align="left">${escapeHtml(h)}</th>`).join('');
  const trs = rows
    .map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`)
    .join('');
  return `<table><tr>${th}</tr>${trs}</table>`;
}

function releaseAfterAt(release) {
  const r = String(release ?? '');
  const idx = r.indexOf('@');
  return idx >= 0 ? r.slice(idx + 1) : r;
}

function computeTransactionImpact(allIssues, config) {
  return config.transactions.map((t) => {
    const issues = allIssues.filter(i => (i.transaction || '').toLowerCase().includes(t.toLowerCase()) || (i.title || '').toLowerCase().includes(t.toLowerCase()));
    const users = issues.reduce((s, i) => s + (Number(i.userCount) || 0), 0);
    return { transaction: t, users, issues: issues.length };
  })
    .filter(x => x.users > 0)
    .sort((a, b) => b.users - a.users);
}

function topProblemsByPlatform(platformResults, maxItems = 3) {
  const out = new Map();
  for (const pr of platformResults) {
    const issues = pr.productSections.flatMap(s => s.currentIssues || []);
    const grouped = new Map();

    for (const issue of issues) {
      const key = (issue.title || 'Sem título').trim();
      const current = grouped.get(key) || {
        title: key,
        count: 0,
        maxSingleIssueCount: 0,
        shortId: issue.shortId,
        url: issue.url,
      };

      current.count += Number(issue.count) || 0;

      // Mantém o link da issue com maior impacto para representar o problema.
      if ((Number(issue.count) || 0) > current.maxSingleIssueCount) {
        current.maxSingleIssueCount = Number(issue.count) || 0;
        current.shortId = issue.shortId;
        current.url = issue.url;
      }

      grouped.set(key, current);
    }

    out.set(
      pr.label,
      [...grouped.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, maxItems)
    );
  }
  return out;
}

function buildDashboardsSection(config, platformResults) {
  const items = [];
  for (const pr of platformResults) {
    const url = config.platforms?.[pr.pk]?.dashboardUrl;
    if (!url) continue;
    items.push(html.li(`${escapeHtml(pr.label)}: ${html.a('Abrir dashboard', url)}`));
  }
  return items.length ? html.h3('Dashboards') + html.ul(items) : '';
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig();
  const platformKeys = args.platform === 'both' ? PLATFORMS : [args.platform];

  const platformResults = [];

  for (const pk of platformKeys) {
    console.log(`Buscando dados para ${pk}...`);
    const productSections = await Promise.all(config.products.map(p => buildProductSection(config, pk, p)));
    const jira = await buildJiraData(config, pk);
    platformResults.push({ pk, productSections, jira, label: config.platforms[pk].label });
  }

  const period = config.report.statsPeriod;
  const periodRange = getPeriodDates(period);

  const platformReleaseRows = platformResults.map(pr => {
    const productionSections = pr.productSections.filter(s => /production/i.test(s.product.environment || ''));
    const counts = new Map();
    const order = [];

    for (const s of productionSections) {
      const suffix = releaseAfterAt(s.releases.current);
      if (!suffix || suffix === 'n/a') continue;
      if (!counts.has(suffix)) order.push(suffix);
      counts.set(suffix, (counts.get(suffix) || 0) + 1);
    }

    let best = 'n/a';
    let bestCount = -1;
    for (const k of order) {
      const c = counts.get(k) || 0;
      if (c > bestCount) {
        best = k;
        bestCount = c;
      }
    }

    return [escapeHtml(pr.label), html.code(escapeHtml(best))];
  });

  const issuesRows = [];
  let totalIssues = 0;
  for (const pr of platformResults) {
    const sections = [...pr.productSections].sort((a, b) => b.current.issueCount - a.current.issueCount);
    for (const s of sections) {
      totalIssues += s.current.issueCount;
      issuesRows.push([escapeHtml(pr.label), escapeHtml(s.product.displayName), fmtInt(s.current.issueCount)]);
    }
  }
  issuesRows.push([html.b('Total'), '', html.b(fmtInt(totalIssues))]);

  const usersPerPlatform = platformResults.map(pr => {
    const totalUsers = pr.productSections.reduce((s, p) => s + (Number(p.current.userCount) || 0), 0);
    return { platform: pr.label, users: totalUsers };
  });
  const totalUsersAll = usersPerPlatform.reduce((s, p) => s + p.users, 0);

  const usersRows = usersPerPlatform.map(p => [escapeHtml(p.platform), fmtApproxUsers(p.users)]);
  usersRows.push([html.b('Total estimado'), html.b(fmtApproxUsers(totalUsersAll))]);

  const txByPlatform = platformResults.map(pr => {
    const platformIssues = pr.productSections.flatMap(s => s.currentIssues || []);
    return {
      label: pr.label,
      rows: computeTransactionImpact(platformIssues, config)
        .slice(0, 5)
        .map(t => [escapeHtml(t.transaction), fmtApproxUsers(t.users)]),
    };
  });

  const topByPlatform = topProblemsByPlatform(platformResults, 3);

  let report =
    html.h2('📊 Relatório Sentry Mobile — Últimos 14 dias') +
    html.div(`${html.b('Período:')} ${escapeHtml(periodRange.text)}`) +
    html.div(html.i(`Escopo: issues não resolvidas filtradas pela release atual mais recente de cada app/environment; métricas de eventos/usuários dentro de ${escapeHtml(period)}.`)) +
    html.br() +
    html.h3('Releases consideradas') +
    table(['Plataforma', 'Release'], platformReleaseRows) +
    html.hr() +
    html.h2('1. Quantos erros ativos estamos?') +
    table(['Plataforma', 'App', 'Issues Ativas'], issuesRows) +
    html.br() +
    html.h2('2. Quantos usuários foram impactados?') +
    table(['Plataforma', 'Usuários Impactados'], usersRows) +
    html.div(html.i('O mesmo usuário pode aparecer em mais de uma issue.')) +
    html.br() +
    html.h2('3. Quais transactions possuem maior impacto?') +
    txByPlatform.map((p, idx) => (
      html.div(`${html.b(`3.${idx + 1}`)} ${html.b(escapeHtml(p.label))}`) +
      (p.rows.length
        ? table(['Transaction', 'Usuários Impactados'], p.rows)
        : html.div('Sem transactions com impacto no período.'))
    )).join('') +
    html.br() +
    html.h2('Principais erros observados') +
    platformResults.map(pr => {
      const issues = topByPlatform.get(pr.label) || [];
      if (!issues.length) return html.div(`${html.b(escapeHtml(pr.label))}: sem issues no período.`);
      const items = issues.map(i => html.li(`${html.a(i.title || i.shortId, i.url)}`));
      return html.div(html.b(escapeHtml(pr.label))) + html.ul(items);
    }).join('') +
    html.br() +
    html.h2('4. Quais erros estamos atuando atualmente?') +
    platformResults.map(pr => {
      const active = pr.jira?.active || [];
      const title = html.div(html.b(escapeHtml(pr.label)));
      if (!active.length) return title + html.div('Nenhuma task ativa.');
      const items = active.slice(0, config.report.maxJiraIssues || 20).map(i => html.li(`${html.a(i.key, i.url)} — ${escapeHtml(i.title)}`));
      return title + html.ul(items);
    }).join('') +
    html.br() +
    buildDashboardsSection(config, platformResults);

  if (args.dryRun) {
    console.log('\n===== RELATÓRIO HTML (Dry Run) =====\n');
    console.log(report);
  } else {
    await request('POST', requireEnv('TEAMS_WEBHOOK_URL'), {}, { text: report });
    console.log('Relatório enviado ao Teams.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
