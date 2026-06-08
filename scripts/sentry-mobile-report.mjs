#!/usr/bin/env node
/**
 * Builds weekly Sentry/Jira mobile production reports and posts them to Teams.
 *
 * Usage:
 *   node scripts/sentry-mobile-report.mjs --dry-run
 *   node scripts/sentry-mobile-report.mjs --platform ios --dry-run
 *   node scripts/sentry-mobile-report.mjs --platform android
 *
 * Secrets (GitHub Actions or local .env):
 *   SENTRY_AUTH_TOKEN
 *   JIRA_API_TOKEN
 *   TEAMS_WEBHOOK_URL
 *
 * Config:
 *   JIRA_EMAIL (optional locally; use GitHub secret in CI)
 *   config/products.json
 */

import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PLATFORMS = ['ios', 'android'];

function parseArgs(argv) {
  const out = {
    platform: 'both',
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--platform') out.platform = argv[++i];
    else if (arg === '--dry-run') out.dryRun = true;
  }

  if (out.platform === 'all') out.platform = 'both';
  if (!['both', ...PLATFORMS].includes(out.platform)) {
    throw new Error('Invalid --platform. Use ios, android or both.');
  }

  return out;
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config/products.json'), 'utf8'));
}

function request(method, url, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: {
          Accept: 'application/json',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => (buf += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

function sentryHeaders() {
  return { Authorization: `Bearer ${requireEnv('SENTRY_AUTH_TOKEN')}` };
}

function jiraHeaders() {
  const email = process.env.JIRA_EMAIL || requireEnv('JIRA_EMAIL');
  const token = requireEnv('JIRA_API_TOKEN');
  return { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` };
}

async function sentryGetPage(pathOrUrl, params = {}) {
  const url = pathOrUrl.startsWith('http')
    ? new URL(pathOrUrl)
    : new URL(`https://sentry.io/api/0${pathOrUrl}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, value);
  }
  const { status, headers, body } = await request('GET', url.toString(), sentryHeaders());
  if (status < 200 || status >= 300) {
    throw new Error(`Sentry request failed (${status}): ${body.slice(0, 500)}`);
  }
  return { data: JSON.parse(body), headers };
}

function nextSentryPageUrl(headers) {
  const link = headers?.link || '';
  const next = link
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.includes('rel="next"') && part.includes('results="true"'));
  return next?.match(/<([^>]+)>/)?.[1] || null;
}

async function sentryGetPaginated(path, params = {}, maxPages = 5) {
  const rows = [];
  let nextUrl = path;

  for (let page = 0; nextUrl && page < maxPages; page++) {
    const { data, headers } = await sentryGetPage(nextUrl, page === 0 ? params : {});
    rows.push(...data);
    nextUrl = nextSentryPageUrl(headers);
  }

  return rows;
}

async function getLatestReleases(org, project) {
  const releases = await sentryGetPaginated(`/projects/${org}/${project}/releases/`, { per_page: 10 });
  const versions = releases.map((release) => release.version).filter(Boolean);
  if (versions.length < 2) {
    throw new Error(`Could not resolve current and previous releases for ${project}.`);
  }
  return { current: versions[0], previous: versions[1] };
}

function buildSentryQuery({ release, transaction, environment }) {
  const parts = [`is:unresolved`, `release:"${release}"`, `environment:"${environment}"`];
  if (transaction) parts.push(`transaction:"${transaction}"`);
  return parts.join(' ');
}

async function getIssuesForRelease({ org, project, release, transaction, environment, statsPeriod }) {
  const issues = await sentryGetPaginated(`/projects/${org}/${project}/issues/`, {
    query: buildSentryQuery({ release, transaction, environment }),
    statsPeriod,
    per_page: 100,
    sort: 'freq',
  });

  return issues.map((issue) => ({
    id: issue.id,
    shortId: issue.shortId,
    title: issue.title || issue.metadata?.title || issue.culprit || 'Issue sem titulo',
    count: Number(issue.count || 0),
    userCount: Number(issue.userCount || 0),
    transaction,
    url: issue.permalink || `https://${org}.sentry.io/issues/${issue.id}/`,
  }));
}

function summarizeIssues(issues) {
  const userCounts = issues.map((issue) => issue.userCount);
  return {
    issueCount: issues.length,
    eventCount: issues.reduce((sum, issue) => sum + issue.count, 0),
    usersEstimate: userCounts.reduce((sum, count) => sum + count, 0),
    usersMinimum: userCounts.length ? Math.max(...userCounts) : 0,
  };
}

async function buildProductSection({ config, platformKey, product }) {
  const org = config.sentryOrg;
  const project = config.platforms[platformKey].project;
  const releases = await getLatestReleases(org, project);
  const statsPeriod = config.report.statsPeriod;
  const otherLabel = config.report.otherTransactionLabel;
  const buckets = [];

  for (const transaction of config.transactions) {
    const issues = await getIssuesForRelease({
      org,
      project,
      release: releases.current,
      transaction,
      environment: product.environment,
      statsPeriod,
    });
    buckets.push({ transaction, issues, summary: summarizeIssues(issues) });
  }

  const allCurrentIssues = await getIssuesForRelease({
    org,
    project,
    release: releases.current,
    transaction: null,
    environment: product.environment,
    statsPeriod,
  });

  const knownIssueIds = new Set(buckets.flatMap((bucket) => bucket.issues.map((issue) => issue.id)));
  const otherIssues = allCurrentIssues.filter((issue) => !knownIssueIds.has(issue.id));
  buckets.push({
    transaction: otherLabel,
    issues: otherIssues,
    summary: summarizeIssues(otherIssues),
  });

  const previousIssues = await getIssuesForRelease({
    org,
    project,
    release: releases.previous,
    transaction: null,
    environment: product.environment,
    statsPeriod,
  });

  const currentSummary = summarizeIssues(buckets.flatMap((bucket) => bucket.issues));

  return {
    product,
    releases,
    current: currentSummary,
    previous: summarizeIssues(previousIssues),
    buckets,
  };
}

async function jiraSearch(config, jql, maxResults) {
  const baseUrl = config.jira.baseUrl.replace(/\/$/, '');
  const url = `${baseUrl}/rest/api/3/search`;
  const { status, body } = await request('POST', url, jiraHeaders(), {
    jql,
    maxResults,
    fields: ['summary', 'status', 'resolutiondate', 'updated'],
  });
  if (status < 200 || status >= 300) {
    throw new Error(`Jira search failed (${status}): ${body.slice(0, 500)}`);
  }
  return JSON.parse(body).issues || [];
}

function jiraIssueUrl(config, key) {
  return `${config.jira.baseUrl.replace(/\/$/, '')}/browse/${key}`;
}

function extractTransaction(summary, transactions) {
  return transactions.find((transaction) => summary.includes(transaction)) || 'Sem transaction';
}

function detectPlatform(summary) {
  if (/\bandroid\b|\[android\]/i.test(summary)) return 'android';
  if (/\bios\b|\[ios\]|iphone|ipad/i.test(summary)) return 'ios';
  return 'unknown';
}

function mapJiraIssue(config, issue) {
  const fields = issue.fields || {};
  const summary = fields.summary || issue.key;
  return {
    key: issue.key,
    title: summary,
    status: fields.status?.name || 'Sem status',
    platform: detectPlatform(summary),
    transaction: extractTransaction(summary, config.transactions),
    updated: fields.updated,
    resolutionDate: fields.resolutiondate,
    url: jiraIssueUrl(config, issue.key),
  };
}

async function buildJiraSection(config, platformKey) {
  const tag = config.jira.titleTag;
  const baseJql = `summary ~ "${tag}" AND issuetype not in subTaskIssueTypes()`;
  const activeJql = `${baseJql} AND statusCategory != Done ORDER BY updated DESC`;
  const doneJql = `${baseJql} AND statusCategory = Done ORDER BY resolutiondate DESC, updated DESC`;
  const max = config.report.maxJiraIssues;

  const [active, done] = await Promise.all([
    jiraSearch(config, activeJql, max),
    jiraSearch(config, doneJql, max),
  ]);

  const mappedActive = active.map((issue) => mapJiraIssue(config, issue));
  const mappedDone = done.map((issue) => mapJiraIssue(config, issue));

  return {
    active: mappedActive.filter((issue) => issue.platform === platformKey || issue.platform === 'unknown'),
    done: mappedDone.filter((issue) => issue.platform === platformKey || issue.platform === 'unknown'),
  };
}

function formatMonth(dateString) {
  const date = new Date(dateString);
  return new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Sao_Paulo',
  }).format(date);
}

function groupDoneByMonth(issues) {
  return issues.reduce((groups, issue) => {
    const month = formatMonth(issue.resolutionDate || issue.updated);
    groups[month] ||= [];
    groups[month].push(issue);
    return groups;
  }, {});
}

function mdLink(label, url) {
  return `[${label}](${url})`;
}

function formatProductSection(section, config) {
  const topN = config.report.topIssuesPerTransaction;
  const lines = [
    `### ${section.product.displayName}`,
    `Environment: \`${section.product.environment}\``,
    `Release atual: \`${section.releases.current}\``,
    `Release anterior: \`${section.releases.previous}\``,
    `Falhas ativas: ${section.current.issueCount} issues / ${section.current.eventCount} eventos`,
    `Usuarios impactados: ${section.current.usersEstimate} (estimativa) | minimo confirmado: ${section.current.usersMinimum}`,
    `Release anterior: ${section.previous.issueCount} issues / ${section.previous.usersEstimate} usuarios (estimativa)`,
    '',
  ];

  for (const bucket of section.buckets) {
    lines.push(`**${bucket.transaction}**: ${bucket.summary.issueCount} issues / ${bucket.summary.usersEstimate} usuarios`);
    for (const issue of bucket.issues.slice(0, topN)) {
      lines.push(`- ${mdLink(issue.shortId, issue.url)} - ${issue.title} (${issue.userCount} usuarios)`);
    }
  }

  return lines.join('\n');
}

function formatJiraSection(jira, platformLabel) {
  const lines = [`### Jira - ${platformLabel}`];

  lines.push('', '**Em atuacao**');
  if (!jira.active.length) {
    lines.push('Nenhuma task `[Sentry-Fix]` em atuacao.');
  } else {
    for (const issue of jira.active) {
      lines.push(`- ${mdLink(issue.key, issue.url)} - ${issue.title} - ${issue.status} - ${issue.transaction}`);
    }
  }

  lines.push('', '**Concluidas**');
  const doneByMonth = groupDoneByMonth(jira.done);
  if (!Object.keys(doneByMonth).length) {
    lines.push('Nenhuma task `[Sentry-Fix]` concluida.');
  } else {
    for (const [month, issues] of Object.entries(doneByMonth)) {
      lines.push(`**${month}**`);
      for (const issue of issues) {
        lines.push(`- ${mdLink(issue.key, issue.url)} - ${issue.title} - ${issue.status} - ${issue.transaction}`);
      }
    }
  }

  return lines.join('\n');
}

function buildReport({ config, platformKey, productSections, jira }) {
  const platformLabel = config.platforms[platformKey].label;
  const date = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(new Date());

  return [
    `## Relatorio Sentry Mobile - ${platformLabel}`,
    `Gerado em: ${date}`,
    `Janela Sentry: \`${config.report.statsPeriod}\``,
    '',
    ...productSections.map((section) => formatProductSection(section, config)),
    '',
    formatJiraSection(jira, platformLabel),
    '',
    '_Usuarios impactados: estimativa agregada; o mesmo usuario pode aparecer em mais de uma issue._',
  ].join('\n');
}

async function postToTeams(webhookUrl, text) {
  const { status, body } = await request('POST', webhookUrl, {}, { text });
  if (status < 200 || status >= 300) {
    throw new Error(`Teams webhook failed (${status}): ${body.slice(0, 500)}`);
  }
}

function teamsWebhookUrl() {
  return requireEnv('TEAMS_WEBHOOK_URL');
}

async function buildPlatformReport(config, platformKey) {
  const productSections = await Promise.all(
    config.products.map((product) => buildProductSection({ config, platformKey, product }))
  );
  const jira = await buildJiraSection(config, platformKey);
  return buildReport({ config, platformKey, productSections, jira });
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig();
  const platforms = args.platform === 'both' ? PLATFORMS : [args.platform];

  for (const platformKey of platforms) {
    const report = await buildPlatformReport(config, platformKey);
    const label = config.platforms[platformKey].label;

    if (args.dryRun) {
      console.log(`\n===== ${label} =====\n`);
      console.log(report);
      continue;
    }

    await postToTeams(teamsWebhookUrl(), report);
    console.log(`Posted ${label} report to Teams.`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
