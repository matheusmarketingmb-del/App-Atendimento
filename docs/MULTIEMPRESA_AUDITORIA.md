# Multiempresa (Mibro Brasil + Sincrofit) — Fase 1: Auditoria

Data: 2026-10-06 · Branch auditada: `feature/flow-builder-only` (com alterações não commitadas do Flow Builder)
Status: **somente auditoria e proposta — nenhum código, schema ou dado foi alterado.**

---

## 1. Arquitetura atual (resumo)

- Express 5 + Prisma 6 + PostgreSQL, monolito (`server.js` → `src/app.js`), frontend estático em `public/` (JS puro).
- Autenticação: JWT em cookie `mibro_session`, `User.role` ∈ `ADMIN | SUPERVISOR | ATENDENTE | BOT`
  + flags booleanas por usuário (`canTransferConversations`, `canManageCampaigns`, …).
  "Master" = `role ADMIN`. **Não existem** roles `VENDEDOR` ou `REPRESENTANTE` — "Vendedor" é só o rótulo usado nos relatórios para quem atende.
- Autorização centralizada em `src/services/authorization-service.js`:
  `conversationScope(user)` é o **único** filtro Prisma usado por listagem, detalhe, mensagens, anexos, envio, busca, alertas e contadores.
  - ATENDENTE: conversas atribuídas a ele + fila sem responsável nas categorias liberadas (`UserCategoryAccess`) + "Sem categoria" se `canViewUncategorized`.
  - SUPERVISOR: `sectorScope` = tudo das categorias liberadas (inclusive assumidas por outros).
  - ADMIN: `{}` (tudo).
  - E-mail: restrito por `ChannelAccountUserAccess`.
- **Equipe do Supervisor = setores (categorias)**, não uma relação supervisor→agente. Não existe `SupervisorAssignment`.
- Realtime: SSE (`src/realtime/inbox-events.js`). `publish()` é um aviso **sem conteúdo** para todos; cada tela recarrega pela API (que aplica o escopo). `publishToUsers()` só no chat interno.
- Jobs: em processo (`setInterval`) — campanhas, inatividade/SLA, Flow Builder timers, Gmail sync.

## 2. Como cada entidade é identificada hoje

| Entidade | Identificação / unicidade atual | Observação multiempresa |
|---|---|---|
| **ChannelAccount** | `@@unique([channel, name])`; credenciais cifradas por conta | Usado por E-mail, Instagram, Facebook, ML etc. **NÃO é usado pelo WhatsApp.** |
| **WhatsApp (META)** | **Um único número via `.env`**: `PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_TOKEN` (`src/channels/meta-cloud-channel.js`) | **Bloqueador nº 1.** Todo envio vai para `process.env.PHONE_NUMBER_ID`. |
| Webhook WhatsApp | `POST /webhook/whatsapp` → `parseWebhook` | **Ignora `value.metadata.phone_number_id`** — hoje o sistema não sabe qual número recebeu a mensagem. |
| **Contact** | `@@unique([channel, externalId])` (externalId = telefone no WhatsApp) | Mesmo telefone = mesmo contato global. **Bloqueia** "mesmo cliente nas duas empresas". |
| ContactIdentity | Agrupa contatos de canais diferentes (fusão manual) | Fusão precisa ser proibida entre empresas. |
| **Conversation** | `@@unique([contactId, channel, channelScope])`; WhatsApp usa `channelScope="LEGACY"` e `channelAccountId = null` | Sem empresa. Como o contato passará a ser por empresa, a chave continua válida. |
| Message | `externalId @unique`, `channelAccountId` nulo no WhatsApp | Empresa derivável da conversa. |
| **User** | `email @unique`, `role` global | Role única para tudo. |
| **Category** (setor) | `code @unique` **global**, hierarquia `parentId` | Base de setor/fila/supervisor. |
| UserCategoryAccess | (userId, categoryId) | Se categoria tiver empresa, o acesso vira implicitamente por empresa. |
| **Bot / BotFlow** | Bot ligado a `channel`/`channels[]` (enum), sem conta/número | Bot ativo vale para **todo** WhatsApp. |
| BotResponse (biblioteca Flow Builder) | `key @unique` global | Textos são Mibro. |
| BotWebhookEndpoint | `key @unique` global | Pode continuar global. |
| **Campaign** | `channelAccountId?` ("null usa a conta padrão"), template por nome+idioma | Templates vêm do WABA do `.env`. |
| CampaignContact | (campaignId, phone) | OK, herda da campanha. |
| **OptOut** | `phone @unique` **global** | Opt-out da Mibro bloquearia Sincrofit. Decisão necessária. |
| **QuickReply** | `scope` ∈ `GLOBAL | PERSONAL`, `channels[]`, `categoryId?` | Falta `COMPANY`. Áudios rápidos usam o mesmo modelo (`contentType AUDIO`). |
| ConversationSettings (SLA) | Singleton `id="singleton"` | SLA único. |
| CampaignGlobalSettings / IntegrationGlobalSettings | Singletons | Podem continuar globais. |
| InternalChat | GENERAL / SECTOR (via categoria) / DIRECT / GROUP | SECTOR herda empresa da categoria; demais podem continuar globais. |
| AuditLog | actor + entityType/entityId | Sem empresa. |
| ConversationActivity (histórico) | por conversa | Herda empresa da conversa. |
| PushSubscription / notificação | `push-service.notifyIncomingMessage` → responsável | Título sem empresa. |
| Relatórios | `conversation-analytics-service.js` | Sem dimensão empresa. |

## 3. Suposições de "empresa única" encontradas

1. **WhatsApp single-number via `.env`** (envio, mídia, templates, mark-as-read) — `meta-cloud-channel.js` (≈12 pontos).
2. **Webhook não lê `phone_number_id`** — `parseWebhook`.
3. `findOrCreateMetaConversation` (`conversation-service.js`) faz upsert por `channel_externalId` fixo em `META`/`LEGACY`.
4. Unicidade global de contato por telefone (`Contact @@unique([channel, externalId])`) — 4 arquivos usam `channel_externalId` (campaign-worker, omnichannel-message, conversation-service, outbound-conversation).
5. `Category.code @unique` global — `external-lead-service.js` busca `code: "COMERCIAL"`, `prisma/seed.js` faz upsert por `code`.
6. Templates por `WHATSAPP_BUSINESS_ACCOUNT_ID` único (`meta-template-service.js`, `campaign-controller.js`).
7. `OptOut.phone @unique` global.
8. `BotResponse.key @unique` global + textos Mibro; `mibro-assistant-question-answer.js` é conteúdo Mibro (aceitável se vinculado a Bot Mibro).
9. `flow-builder-migration-service.js` seleciona Bots por nome "Assistente Mibro Brasil".
10. `external-lead-service.js` (LP Atacado Mibro) e `gmail-sync-service.js` (label `shopify--site-mibro-`) — fontes Mibro.
11. Assunto padrão de e-mail "Atendimento Mibro" (`message-service.js:150`).
12. Visual: `--orange:#ef5b2a` como cor global (36 usos só em `app.css`), `--shadow-glow` laranja, card selecionado laranja, logo Mibro, `mibro-theme`, `manifest.webmanifest`, título/login.
13. Identificadores internos `mibro_session`, `mibro-*` (localStorage), `MIBRO_FEATURES` — **manter** (renomear derrubaria sessões/preferências e não é visível).

## 4. Pontos já favoráveis

- Autorização num único ponto (`conversationScope`) → escopo de empresa entra em um lugar e propaga para listagem/detalhe/busca/IDOR.
- Erros 404/403 já padronizados (`conversationAccessError` não revela existência).
- SSE já não carrega conteúdo → risco de vazamento realtime é só "algo mudou".
- `channelScope` + `channelAccountId` já existem na Conversation (multi-conta pensado para canais novos).
- Já existe sistema `--channel-accent` no CSS (cor por canal) — a cor de empresa precisa ser **outra variável** para não colidir (`--company-*`).

## 5. Proposta de modelagem

```prisma
model Company {
  id           String   @id @default(cuid())
  name         String              // "Mibro Brasil"
  slug         String   @unique    // "mibro"
  displayName  String              // "MIBRO" (badge)
  primaryColor String              // "#FF6633"
  logoUrl      String?
  active       Boolean  @default(true)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}

model UserCompanyAccess {
  id        String   @id @default(cuid())
  userId    String
  companyId String
  role      UserRole           // ADMIN | SUPERVISOR | ATENDENTE por empresa
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@unique([userId, companyId])
  @@index([companyId, active])
}
```

- **Master Global** = `User.role = ADMIN` (comportamento atual preservado: vê e gerencia todas as empresas).
- Demais usuários: role efetiva **por empresa** = `UserCompanyAccess.role`; sem linha ativa = sem acesso.
  `User.role` passa a ser só o "role padrão/legado" (exibição e compatibilidade).
- `conversationScope(user)` vira `OR` por empresa: `{ companyId: C, <regra atual com o role em C> }`.
  Como categorias passam a ter empresa, `UserCategoryAccess` já fica naturalmente por empresa ⇒ **Supervisor por empresa sem tabela nova**.
- Flags booleanas (`canTransferConversations` etc.) continuam globais nesta fase (decisão aberta).

Colunas `companyId` novas (FK `ON DELETE RESTRICT`):

| Tabela | Obrigatório ao final | Origem do valor |
|---|---|---|
| ChannelAccount | sim | cadastro (define a empresa) |
| Conversation | sim | `ChannelAccount.companyId` (desnormalizado p/ filtro rápido) |
| Contact | sim | empresa do canal de entrada |
| Category | sim | cadastro |
| Bot | sim | cadastro |
| Campaign | sim | seleção na criação |
| QuickReply | não (GLOBAL = null) | `scope COMPANY` exige |
| BotResponse | não (null = global) | cadastro |
| OptOut | conforme decisão | — |
| ConversationSettings | não (linha "singleton" = padrão global; linha com companyId = override futuro) | — |
| AuditLog | não | contexto da ação |
| User (preferência de filtro) | — | `User.companyFilterPreference String?` validado contra acesso |

WhatsApp: cada número vira um `ChannelAccount` (`channel=META`) com `config = { phoneNumberId, wabaId, displayNumber }`.
`MetaCloudChannel` passa a receber a conta (phoneNumberId/wabaId/token por conta). Mibro mantém fallback para o `.env` atual — zero mudança operacional no número atual.
Webhook: `metadata.phone_number_id` → ChannelAccount → companyId. **phone_number_id desconhecido nunca é atribuído "por padrão" a uma empresa**: o evento é registrado e ignorado (exceto o `PHONE_NUMBER_ID` do `.env`, que é a conta Mibro).

Unicidades:

| Atual | Proposta | Efeito |
|---|---|---|
| `Contact(channel, externalId)` | `Contact(companyId, channel, externalId)` | mais permissivo → não falha com dados atuais |
| `Category.code` | `Category(companyId, code)` | idem |
| `BotResponse.key` | `(companyId, key)` + índice parcial p/ null | idem |
| `OptOut.phone` | `(companyId, phone)` (se decidido por empresa) | idem |
| `ChannelAccount(channel, name)` | manter | nomes já incluem a marca |

Índices previstos (a confirmar com `EXPLAIN` nas queries reais da inbox/relatórios):
`Conversation(companyId, status, lastMessageAt)`, `Conversation(companyId, assignedUserId)`, `Conversation(companyId, categoryId, lastMessageAt)`,
`Contact(companyId, phone)`, `Category(companyId, parentId, displayOrder)`, `QuickReply(companyId, scope, active)`,
`Bot(companyId, status)`, `Campaign(companyId, status)`, `ChannelAccount(companyId, channel)`, `AuditLog(companyId, createdAt)`.

## 6. Plano de migração (não destrutivo)

| Passo | Tipo | Conteúdo | Reversível |
|---|---|---|---|
| M1 | aditiva | cria `Company`, `UserCompanyAccess`; insere Mibro Brasil e Sincrofit | DROP TABLE |
| M2 | aditiva | `companyId` **nullable** + FKs + índices em todas as tabelas acima | DROP COLUMN |
| M3 | dados | `UPDATE … SET companyId = <mibro> WHERE companyId IS NULL`; `UserCompanyAccess(mibro, role = User.role)` para todo usuário não-BOT; ChannelAccount META "Mibro Brasil" (via script, pois depende do `.env`) e `Conversation/Message.channelAccountId` do WhatsApp apontando para ela | colunas novas — dados antigos intactos |
| M4 | validação | script `scripts/multiempresa-report.js` (dry-run): contagens antes/depois, nulos por tabela, órfãos | — |
| M5 | constraint | `SET NOT NULL` onde seguro; troca das uniques (sempre mais permissivas) | DROP NOT NULL / recriar unique antiga (só falha se já houver dados Sincrofit duplicados) |

Nenhum DELETE, nenhuma alteração de ID existente. Sincrofit **nunca** é atribuída a registro antigo.
Rollback: `pg_dump` antes de aplicar; M1–M3 revertem com DROP das colunas/tabelas novas; M5 revertido por migration inversa.

Consulta para rodar **em produção antes** (somente leitura) — contagem base:
```sql
SELECT 'Contact', count(*) FROM "Contact" UNION ALL
SELECT 'Conversation', count(*) FROM "Conversation" UNION ALL
SELECT 'Message', count(*) FROM "Message" UNION ALL
SELECT 'User', count(*) FROM "User" UNION ALL
SELECT 'Category', count(*) FROM "Category" UNION ALL
SELECT 'Bot', count(*) FROM "Bot" UNION ALL
SELECT 'Campaign', count(*) FROM "Campaign" UNION ALL
SELECT 'QuickReply', count(*) FROM "QuickReply" UNION ALL
SELECT 'ChannelAccount', count(*) FROM "ChannelAccount" UNION ALL
SELECT 'OptOut', count(*) FROM "OptOut" UNION ALL
SELECT 'AuditLog', count(*) FROM "AuditLog";
```

## 7. Riscos identificados

1. **Alto — WhatsApp por conta.** Refatorar `MetaCloudChannel` toca todos os envios. Mitigação: conta Mibro usa exatamente o `.env` atual; testes de envio/mídia/template por conta.
2. **Alto — webhook único para dois números.** Se a Sincrofit usar **outro App da Meta**, a assinatura (`META_APP_SECRET`) e o `VERIFY_TOKEN` mudam → precisa de secret por conta. Mesmo App/WABA diferente → só roteamento por `phone_number_id`.
3. **Médio — chaves compostas Prisma** (`channel_externalId`, `code`) usadas em 6+ arquivos; trocar a unique quebra esses upserts em tempo de execução se algum for esquecido. Mitigação: grep + testes.
4. **Médio — respostas rápidas GLOBAL existentes** têm texto Mibro; se continuarem GLOBAL aparecerão na Sincrofit.
5. **Médio — Bots ativos** hoje respondem em qualquer WhatsApp; sem `companyId` o Bot Mibro responderia clientes Sincrofit.
6. **Médio — OptOut global**: decisão jurídica/comercial.
7. **Baixo — SSE** envia "inbox.updated" a todos (sem dados). Melhoria: publicar com companyId e filtrar conexões.
8. **Atenção (fora do escopo, mas relevante):** o working tree altera uma migration já existente (`20261002120100_archive_legacy_bots/migration.sql`). Se ela já foi aplicada em produção, o checksum diverge e o `prisma migrate deploy` acusa drift.

## 8. Decisões tomadas (2026-10-06)

- WhatsApp Sincrofit: mesmo App Meta, outro número → roteamento por `phone_number_id`; token próprio opcional por conta.
- Respostas rápidas GLOBAL e textos da biblioteca do Bot existentes → viram da Mibro (`COMPANY`/`companyId` Mibro).
- Opt-out → por empresa (existentes ficam com a Mibro).
- Branch: Flow Builder commitado (`2c955c1`) e trabalho em `feature/multiempresa` (sem push, sem commit desta fase).

## 9. Implementação (Fases 2–14)

| Área | Onde |
|---|---|
| Modelo Company / UserCompanyAccess | `prisma/schema.prisma`, migrations `20261006100000/100100/100200` |
| Empresas, acesso, cargo por empresa, filtro/preferência | `src/services/company-service.js`, `src/controllers/company-controller.js` (`/api/companies`, `/api/admin/companies`) |
| RBAC por empresa (escopo único, IDOR → 404) | `authorization-service.js` (`conversationScope`, `sectorScope`, `companyScope`) |
| WhatsApp por número | `whatsapp-account-service.js`, `meta-cloud-channel.js#forAccount`, webhook em `app.js` |
| Conversa/contato por empresa | `conversation-service.js`, `omnichannel-message-service.js`, `outbound-conversation-service.js` |
| Realtime filtrado por empresa | `realtime/inbox-events.js` (`publish(companyIds)`, `publishForConversation`) |
| Categorias, Bots/Flow Builder, respostas rápidas/áudios, biblioteca do Bot | `inbox-service.js`, `bot-service.js`, `bot-visual-flow-service.js`, `quick-reply-service.js`, `bot-response-library-service.js` |
| Campanhas, templates (WABA do número), opt-out | `campaign-*.js`, `meta-template-service.js` |
| Relatórios, resumo, equipe, auditoria | `conversation-analytics-service.js` (`company-breakdown`), `user-management-service.js`, `audit-service.js` |
| UI | `public/js/app.js`, `public/css/app.css` (bloco "Identidade por empresa"), `public/js/company-context.js`, telas de Bots/Campanhas/Respostas/Integrações/Relatório |
| Testes | `test/multiempresa.test.js`, `test/multiempresa-ui.test.js`, prévia visual `docs/multiempresa-cards-preview.html` |

### Passos para deploy (NÃO executados nesta sessão)

1. `pg_dump` completo e `node scripts/multiempresa-report.js > antes.txt` (somente leitura).
2. `prisma migrate deploy` aplica `20261006100000` → `100100` → `100200` → `100300`. O passo 100200 aborta sozinho (sem alterar nada) se algum registro ficar sem empresa.
3. `node scripts/multiempresa-report.js > depois.txt`: totais iguais aos de antes (ChannelAccount +1, o WhatsApp Mibro original) e todas as verificações `ok`.
4. Opcional: `node scripts/multiempresa-backfill-messages.js` (simulação) e, se desejado, `--apply` (lotes) para gravar o número nas mensagens antigas.
5. Opcional: `WHATSAPP_DISPLAY_NUMBER` no `.env` para exibir o número Mibro no composer.
6. Cadastrar o número Sincrofit em Integrações → WhatsApp (Phone Number ID, WABA ID, empresa Sincrofit), criar setores da Sincrofit e liberar usuários (Equipe → Empresas e cargo por empresa).

A migration `20261002120100_archive_legacy_bots` foi editada no Flow Builder, mas **não existe em `main`, `origin/main` nem no ref `vps/restored-current`** — nunca foi publicada, então a edição não gera divergência de checksum. Não aplicá-la em nenhum ambiente antes da versão final.

Ambiente de teste local: o schema `app_whats_test` com dados antigos precisa receber as migrations `100000` e `100100` (via `prisma db execute`) antes do `npm test`, porque `db push` não cria coluna obrigatória sobre linhas existentes.

## 10. Pendências finalizadas (2026-10-06)

| Item | Solução |
|---|---|
| Testes de UI com CRLF | Leitura normalizada para LF nos testes. |
| Integrações do Flow Builder (banco QA) | Fixtures com empresa; passam no banco isolado (20/20); fora dele ficam "puladas", nunca falham. Migrations multiempresa validadas também no banco QA (contagens idênticas). |
| Layout no celular (bug anterior) | A lista caía na coluna de 0px da grade quando a barra lateral vira gaveta fixa; corrigido. Barra superior sem transbordar; filtro de empresa repetido no topo da lista. |
| SLA por empresa | `ConversationSettings` com override por empresa (cópia da global na 1ª edição; "voltar à global" remove). Monitor de SLA, finalização automática, reabertura e SLA dos cards usam a configuração da empresa. Tela Configurações → Conversas: Global / Mibro / Sincrofit. |
| Permissões por empresa | `UserCompanyAccess.permissions` (migration `100300`). Permissões recalculadas para o cargo de cada empresa — corrige vazamento em que um Supervisor padrão herdava "gerenciar campanhas" numa empresa onde é Atendente. Categorias, fundir contatos, iniciar conversa, prioridade, transferência e campanhas avaliados na empresa do recurso. Página de Campanhas abre se houver permissão em alguma empresa. UI: "Personalizar permissões nesta empresa". |
| Áudios rápidos | Áudio da empresa/global criado pelo Master (Respostas Rápidas → Conteúdo: Áudio); áudio pessoal com "Vale para" (todas ou uma empresa). |
| Busca Ctrl+K | Resultados mostram a empresa (mesmo cliente nas duas empresas fica diferenciado); dados já vêm filtrados pela API. |
| Mensagens antigas | `scripts/multiempresa-backfill-messages.js` (simulação por padrão, lotes). |
| Relatório de consistência | `scripts/multiempresa-report.js` (somente leitura; contagens, por empresa e 12 verificações). |

Suíte: 410 passando, 0 falhas, 2 puladas (integrações que exigem o banco QA isolado).

Decisões mantidas: equipe do Supervisor continua definida por setor (cada setor é de uma empresa); não existe tela separada de Contatos (o filtro de empresa vale na lista de conversas); chat interno sem escopo de empresa (grupos de setor seguem a empresa do setor).
