# Mobile Reports

Relatorio semanal de falhas mobile em producao, gerado via GitHub Actions e enviado para o Teams.

Repositorio: https://github.com/JessZP/mobile-reports

## O que faz

Toda segunda-feira as 08h BRT:

1. consulta Sentry para iOS e Android;
2. considera apenas os environments de producao:
   - `medcel-production`
   - `afyapapers-production`
   - `internatoafya-production`
3. compara a ultima release com a anterior;
4. agrupa falhas por transaction;
5. consulta Jira por tasks com `[Sentry-Fix]` no titulo, somente issue pai;
6. envia **duas mensagens** no Teams pelo mesmo webhook:
   - uma para iOS
   - uma para Android

## Secrets do GitHub

Cadastre em `Settings -> Secrets and variables -> Actions`:

```text
SENTRY_AUTH_TOKEN
JIRA_API_TOKEN
JIRA_EMAIL
TEAMS_WEBHOOK_URL
```

## Config versionada

Arquivo: `config/products.json`

Contem:

- org Sentry
- projetos iOS/Android
- environments por produto
- transactions monitoradas
- limites do relatorio

## Teste local

Copie `.env.example` para `.env` e preencha os tokens.

```bash
node scripts/sentry-mobile-report.mjs --dry-run
node scripts/sentry-mobile-report.mjs --platform ios --dry-run
node scripts/sentry-mobile-report.mjs --platform android --dry-run
```

Sem `--dry-run`, o script envia para os webhooks do Teams.

## Power Automate / Teams Workflow

Crie um fluxo com:

```text
Trigger: When a Teams webhook request is received
Action: Post message in a chat or channel
```

Canal destino:

```text
[Daily] [AS IS] Mobile
```

O GitHub Actions envia duas mensagens POST JSON para a mesma URL:

```json
{ "text": "conteudo do relatorio" }
```

No Power Automate, use o corpo recebido como mensagem do canal.

## Regras

### Sentry

- org: `afya`
- iOS project: `apple-ios`
- Android project: `android`
- issues consideradas: `is:unresolved` na release atual
- filtro por environment de producao

### Jira

- base URL: `https://medcel.atlassian.net`
- busca por `summary ~ "Sentry-Fix"`
- somente issue pai
- sem filtro por projeto
- sem limite de tempo

### Usuarios impactados

- **estimativa**: soma de `userCount` das issues
- **minimo confirmado**: maior `userCount` entre as issues

A estimativa pode contar o mesmo usuario em mais de uma issue.

## Execucao manual

No GitHub:

```text
Actions -> Sentry Mobile Report -> Run workflow
```

Inputs:

- `platform`: `ios`, `android` ou `both`
- `dryRun`: `true` para testar sem enviar ao Teams

## Transactions monitoradas

- `auth.login`
- `auth.password_recovery`
- `video.play`
- `exam.view`
- `schedule_pace.view`
- `home.view`
- fallback: `Outros / Sem transaction`
