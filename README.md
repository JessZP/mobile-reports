# Mobile Reports

Relatorio de falhas mobile em producao, gerado via GitHub Actions e enviado para um webhook do Teams consumido pelo Power Automate.

Repositorio: https://github.com/JessZP/mobile-reports

## O que faz

Toda segunda-feira as 08h BRT:

1. consulta Sentry para iOS e Android;
2. considera os environments de producao mapeados:
   - `medcel-production`
   - `afyapapers-production`
   - `internatoafya-production`
3. detecta a release atual mais recente por app/environment;
4. busca issues `is:unresolved` filtradas por `release` + `environment` dentro da janela configurada;
5. consolida um unico relatorio HTML com:
   - releases consideradas
   - issues ativas por plataforma/app
   - usuarios impactados por plataforma
   - transactions de maior impacto, separadas em `3.1 iOS` e `3.2 Android`
   - principais erros observados por plataforma
   - erros em atuacao no Jira
   - links para dashboards
6. envia **uma mensagem** em JSON para o webhook configurado.

## Secrets do GitHub

Cadastre em `Settings -> Secrets and variables -> Actions`:

```text
SENTRY_AUTH_TOKEN
JIRA_API_TOKEN
JIRA_EMAIL
TEAMS_WEBHOOK_URL
```

`SENTRY_AUTH_TOKEN` precisa incluir escopo de organizacao (`org:read` ou superior), alem dos escopos de projeto ja usados (`project:read`, `event:read`, `project:releases`). Sem `org:read`, a agregacao de eventos/usuarios por janela (Discover) falha silenciosamente e o relatorio cai no fallback de totais acumulados por issue (ver "Regras > Sentry").

## Config versionada

Arquivo: `config/products.json`

Contem:

- org Sentry
- projetos iOS/Android
- labels das plataformas
- dashboard URLs por plataforma
- environments por produto
- transactions monitoradas
- limites e janela do relatorio

## Teste local

Copie `.env.example` para `.env` e preencha os tokens.

```bash
node scripts/sentry-mobile-report.mjs --dry-run
node scripts/sentry-mobile-report.mjs --platform ios --dry-run
node scripts/sentry-mobile-report.mjs --platform android --dry-run
```

Sem `--dry-run`, o script envia para `TEAMS_WEBHOOK_URL`.

## Power Automate / Teams Workflow

Crie um fluxo com:

```text
Trigger: When a Teams webhook request is received
Action: Post message in a chat or channel
```

O script envia um POST JSON para a URL do webhook:

```json
{ "text": "conteudo do relatorio em HTML" }
```

No Power Automate, use o campo `text` recebido no trigger como mensagem da acao de post.

Expressao comum no campo `Message`:

```text
triggerBody()?['text']
```

## Regras

### Sentry

- org: `afya`
- iOS project: `apple-ios`
- Android project: `android`
- janela padrao: `14d`
- issues consideradas: `is:unresolved` na release atual mais recente de cada app/environment, com `lastSeen:-14d` (ou seja, precisam ter tido atividade nos ultimos 14 dias para entrar no relatorio)
- filtro por environment de producao
- **contagem por janela**: o endpoint de issues do Sentry nao oferece contagem de eventos/usuarios recortada por tempo (o parametro `statsPeriod` da API so afeta o campo `stats`/grafico, que este script nao usa). Por isso, `count`/`userCount` de cada issue sao obtidos via uma segunda chamada ao endpoint de eventos da organizacao (Discover: `/organizations/{org}/events/` com `count()` e `count_unique(user)`), que agrega de verdade dentro da janela configurada.
- essa chamada de Discover exige que o `SENTRY_AUTH_TOKEN` tenha escopo de organizacao (`org:read` ou superior). Se faltar esse escopo (ou a chamada falhar por qualquer motivo), o script registra um aviso no log e usa o total acumulado da issue (desde o primeiro evento) como fallback, sem quebrar a execucao.

### Releases consideradas

- a secao mostra uma linha para `iOS` e outra para `Android`
- o valor exibido usa o trecho da release apos `@`
- o objetivo e deixar visivel qual versao serviu de base para o recorte do relatorio

### Usuarios impactados

- a secao `2. Quantos usuarios foram impactados?` usa soma de `userCount` das issues que pertencem a release atual e tiveram atividade na janela configurada
- o `userCount` de cada issue reflete a janela configurada (via Discover); em caso de fallback (ver nota acima), reflete o total acumulado da issue
- o total e uma estimativa agregada por plataforma
- o mesmo usuario pode aparecer em mais de uma issue

### Transactions

- a secao `3. Quais transactions possuem maior impacto?` usa o campo `transaction` das issues
- a listagem e separada por plataforma em `3.1 iOS` e `3.2 Android`
- o impacto mostrado e baseado em usuarios impactados estimados por transaction

### Principais erros observados

- nao depende da secao de transactions
- mostra os erros mais relevantes por plataforma
- o ranking atual usa `count` das issues no periodo
- a lista exibe somente o erro e o link para uma issue representativa

### Jira

- base URL: `https://medcel.atlassian.net`
- busca por `summary ~ "Sentry-Fix"`
- somente issue pai
- secao final mostra somente itens ativos

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
