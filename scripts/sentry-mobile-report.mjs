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
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
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

async function getIssues(org, project, release, environment, statsPeriod) {
  if (release === 'n/a') return [];
  // Use a query that combines release and environment for precision
  const query = `is:unresolved release:"${release}" environment:"${environment}"`;

  // We fetch without statsPeriod first to see all unresolved issues for that release.
  // The 'count' and 'userCount' in the result will be specific to the query.
  const issues = await sentryGetPaginated(`/projects/${org}/${project}/issues/`, {
    query,
    statsPeriod, // Use statsPeriod to get counts within the window
    per_page: 100,
    sort: 'freq'
  });

  return issues.map(i => ({
    id: i.id, shortId: i.shortId, title: i.title || i.culprit || 'Sem título',
    // Fallback to events/users if count/userCount are missing (depends on API version/statsPeriod usage)
    count: Number(i.count || i.events || 0),
    userCount: Number(i.userCount || i.users || 0),
    url: i.permalink, transaction: i.metadata?.transaction || ''
  }));
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

  // statsPeriod is important for the current release to show the recent impact
  const currentIssues = await getIssues(org, project, releases.current, product.environment, config.report.statsPeriod);

  // For the previous release, we want its total impact to compare "health"
  const previousIssues = await getIssues(org, project, releases.previous, product.environment, null);

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
    previous: summarize(previousIssues),
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

function fmtApproxInteger(n) {
  const v = Number(n || 0);
  return v >= 1000 ? `~${fmtInt(Math.round(v / 10) * 10)}` : fmtInt(v);
}

function table(headers, rows) {
  const th = headers.map(h => `<th align="left">${escapeHtml(h)}</th>`).join('');
  const trs = rows
    .map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`)
    .join('');
  return `<table><tr>${th}</tr>${trs}</table>`;
}

function computeTransactionImpact(allIssues, config) {
  const impacts = config.transactions.map((t) => {
    const issues = allIssues.filter(i => (i.transaction || '').toLowerCase().includes(t.toLowerCase()) || (i.title || '').toLowerCase().includes(t.toLowerCase()));
    const users = issues.reduce((s, i) => s + (Number(i.userCount) || 0), 0);
    return { transaction: t, users, issues: issues.length };
  }).filter(x => x.users > 0);

  const byKey = new Map(impacts.map(i => [i.transaction, i]));
  const home = byKey.get('home.view');
  const schedule = byKey.get('schedule_pace.view');
  if (home && schedule) {
    byKey.delete('home.view');
    byKey.delete('schedule_pace.view');
    byKey.set('home.view / schedule_pace.view', { transaction: 'home.view / schedule_pace.view', users: home.users + schedule.users, issues: home.issues + schedule.issues });
  }

  return [...byKey.values()].sort((a, b) => b.users - a.users);
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
        userCount: 0,
        count: 0,
        maxSingleIssueUsers: 0,
        shortId: issue.shortId,
        url: issue.url,
      };

      current.userCount += Number(issue.userCount) || 0;
      current.count += Number(issue.count) || 0;

      // Mantém o link da issue com maior impacto para representar o problema.
      if ((Number(issue.userCount) || 0) > current.maxSingleIssueUsers) {
        current.maxSingleIssueUsers = Number(issue.userCount) || 0;
        current.shortId = issue.shortId;
        current.url = issue.url;
      }

      grouped.set(key, current);
    }

    out.set(
      pr.label,
      [...grouped.values()]
        .sort((a, b) => (b.userCount - a.userCount) || (b.count - a.count))
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

  const allIssues = platformResults.flatMap(pr => pr.productSections.flatMap(s => s.currentIssues || []));

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

  const txRows = computeTransactionImpact(allIssues, config)
    .slice(0, 5)
    .map(t => [escapeHtml(t.transaction), fmtApproxInteger(t.users)]);

  const topByPlatform = topProblemsByPlatform(platformResults, 3);

  let report =
    html.h2('📊 Relatório Sentry Mobile — Últimos 14 dias') +
    html.div(`${html.b('Período:')} ${escapeHtml(periodRange.text)}`) +
    html.hr() +
    html.h3('1. Quantos erros ativos estamos?') +
    table(['Plataforma', 'App', 'Issues Ativas'], issuesRows) +
    html.br() +
    html.h3('2. Quantos usuários foram impactados?') +
    table(['Plataforma', 'Usuários Impactados'], usersRows) +
    html.div(html.i('O mesmo usuário pode aparecer em mais de uma issue.')) +
    html.br() +
    html.h3('3. Quais transactions possuem maior impacto?') +
    (txRows.length ? table(['Transaction', 'Usuários Impactados'], txRows) : html.div('Sem transactions com impacto no período.')) +
    html.br() +
    html.h3('Principais erros observados') +
    platformResults.map(pr => {
      const issues = topByPlatform.get(pr.label) || [];
      if (!issues.length) return html.div(`${html.b(escapeHtml(pr.label))}: sem issues no período.`);
      const items = issues.map(i => html.li(`${html.a(i.title || i.shortId, i.url)} ${html.i(`(${fmtApproxUsers(i.userCount)} usuários)`)}`));
      return html.div(html.b(escapeHtml(pr.label))) + html.ul(items);
    }).join('') +
    html.br() +
    html.h3('4. Quais erros estamos atuando atualmente?') +
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
