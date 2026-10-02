# Bots: Flow Builder como único modelo (migração 2026-10)

O sistema antigo de Bots (intenções, IA/Qwen, RAG, Knowledge, Planner, Shadow,
triagem fixa) foi **arquivado** em `_archive/bot-legacy/` (ver
`BOT_LEGACY_ARCHIVE.md` lá) e **removido do runtime**. Todo Bot agora é:

```
Bots → Novo Bot (nome, descrição, canal) → Editor Visual
START → Mensagem → Menu → Pergunta → Condição → Resposta → Transferência → Fim
```

Sem IA, sem RAG, sem provider/model, sem shadow. O motor é determinístico.

## Commits

| Commit | Conteúdo |
|---|---|
| `f6b7d80` | `chore: archive legacy bot architecture before flow builder migration` — só o arquivo (172 arquivos), nenhum runtime alterado |
| commit seguinte | migração do runtime/UI/schema descrita aqui |

## Como funciona agora

- **Bot** = nome, descrição, canais, fuso, horário/feriados, status (`ACTIVE`/`PAUSED`) e
  **resposta automática** (desligada por padrão; só liga com o fluxo padrão publicado e ativo).
- **Fluxos** (`BotFlow`): o fluxo **padrão** começa as conversas novas; outros fluxos
  (Suporte, Comercial, Garantia...) são chamados pelo nó **Ir para fluxo**.
- **Versionamento**: `DRAFT/ACTIVE/INACTIVE`. Salvar altera só o rascunho; **Publicar** cria
  uma versão nova (imutável); **rollback** reaponta para uma versão anterior; dá para copiar
  uma versão para o rascunho. Conversas em andamento terminam na versão em que começaram.
- **Execução** (`BotFlowExecution`): nó a nó, persistindo `currentNodeKey`, versão, `context`
  e `status` (`RUNNING`, `WAITING_CUSTOMER`, `WAITING_TIMER`, `HANDED_OFF`, `COMPLETED`, `FAILED`).
  Menu/Pergunta pausam; a próxima mensagem do cliente retoma do ponto certo. Intervalo é
  retomado pelo worker em processo (`startVisualFlowWorker`).
- **Segurança**: só executa com Bot `ACTIVE` + resposta automática ligada + automação global
  ligada (kill switch). Nunca responde conversa assumida, pausada ("Cancelar Bot") ou finalizada.

### Tipos de nó (biblioteca à esquerda)

| Grupo | Nós |
|---|---|
| FLUXO | Início, Ir para fluxo, Finalizar |
| MENSAGENS | Mensagem (texto manual **ou** resposta da biblioteca), Menu (texto numerado ou lista do WhatsApp, opções com sinônimos), Pergunta (texto, número, telefone, e-mail, CPF/CNPJ, Sim/Não), Mídia (imagem, áudio, vídeo, documento) |
| CONTROLE | Condição (`== != contains not_contains exists not_exists > < >= <=`, E/OU), Intervalo |
| DADOS | Variável |
| ATENDIMENTO | Transferir para setor, Transferir para atendente, Solicitar humano |
| INTEGRAÇÕES | Webhook/API (endpoint pré-cadastrado) |

Variáveis: `contact.name|firstName|phone|email|greeting|greetingComma`,
`conversation.id|channel|withinBusinessHours`, `bot.name|businessHours|withinBusinessHours`,
`flow.selectedOption|lastAnswer|lastMessage`, e graváveis `customer.*`, `flow.*`, `vars.*`, `custom.*`.

### Respostas do Bot (biblioteca)

`Bots → Respostas do Bot`: textos controlados por código (ex.: `SUPORTE_CARREGAMENTO`) e
categoria (Geral, Atendimento, Suporte, Comercial, Garantia, Pedidos, Marketing, Parcerias).
Editar a resposta atualiza todos os fluxos que a usam. Excluir/desativar uma resposta em uso
é bloqueado.

### Webhook/API

`Bots → Webhooks/API`: URL **HTTPS** + cabeçalhos (cifrados com `INTEGRATION_ENCRYPTION_KEY`,
nunca exibidos). Bloqueia host em rede privada/local, sem redirect, timeout ≤ 15 s, resposta ≤ 256 KB.
O nó envia campos (GET = query, POST = JSON) e grava `{ ok, status, data }` na variável escolhida.

### Editor visual

Arrastar/soltar, zoom, pan, enquadrar, desfazer/refazer, duplicar, copiar/colar (Ctrl+C/V,
também entre fluxos), excluir, multi-seleção (Shift+clique, Shift+arrastar, Ctrl+A),
alinhar à esquerda/topo, distribuir, **auto organizar** e minimapa. Painel de propriedades
à direita. Validação antes de publicar: Início, nós desconectados, menu sem saída, condição
incompleta, variável inexistente, loop sem pausa, setor/usuário/subfluxo/resposta/endpoint/mídia
inexistentes (+ avisos para variáveis nunca preenchidas).

### Simulador

Aba **Testar**: mensagem do cliente → nós executados → resultado → saída → próximo nó,
com debug no canvas (verde executado, azul atual, vermelho erro). Opções de lista são
clicáveis como no WhatsApp. Nada é enviado; webhooks só são chamados se marcado.

## Bot de Triagem antigo

Convertido automaticamente (no boot, idempotente — `flow-builder-migration-service.js`) no
fluxo **"Triagem"** do mesmo Bot: horário/feriado → menu de setores (lista) → transferir;
opção Atendimento → "o que você precisa?" → palavras-chave → setor certo. Publicado como v1,
mas com a **resposta automática DESLIGADA**: **entre o deploy e o Master ligar o Bot, conversas
novas entram sem triagem automática** (decisão aprovada). Para ligar: Bots → Triagem Inicial →
testar no simulador → "Resposta automática".

Diferença consciente: fora do horário o fluxo envia a mensagem de fora do horário **e mostra o
menu** (antes só reenviava o menu na próxima mensagem dentro do horário). Ajustável no editor.

## Removidos do runtime (cópia literal em `_archive/bot-legacy/code/`)

- **Serviços (60)**: `src/services/ai/*` (13), `bot-tools/*` (9), `bot-knowledge/knowledge-provider.js`,
  `bot-agent-feedback`, `bot-agent-planner`, `bot-ai-gate`, `bot-ai-shadow`, `bot-ai-usage`,
  `bot-case-state`, `bot-constants`, `bot-conversation-state`, `bot-decision`, `bot-entity-extractor`,
  `bot-flow` (motor linear antigo), `bot-handoff`, `bot-intent-ranking`, `bot-interpreter`,
  `bot-knowledge-response`, `bot-knowledge-source`, `bot-learning(-sanitizer)`, `bot-loop-guard`,
  `bot-observation`, `bot-orchestrator`, `bot-personality(-constants)`, `bot-quality`, `bot-rating`,
  `bot-response`, `bot-semantic-normalizer`, `bot-simulator`, `bot-social-behavior`, `bot-suggestion`,
  `bot-tool-orchestrator`, `bot-version`, `global-intent`, `local-ai-queue|settings|status`, `triage-bot-service`.
- **Controller**: `local-ai-controller.js`. `bot-controller.js` foi reescrito (enxuto).
- **Telas**: `knowledge-base.html/js/css`; `bots.html/js/css` reescritos; abas Observações,
  Aprendizado, Desempenho, Versões, Ranking e Chaves de IA removidas; card "Motor do Bot"/modo
  Legacy do editor removido; nós IA/Conhecimento removidos; na Central: aba "Bot" (sugestão de IA),
  "Analisar para aprendizado", atalho "Conhecimento"; em Respostas Rápidas: vínculo com intenções.
- **Rotas**: 67 rotas (`/api/bots/:id/intents*`, `/simulate`, `/versions*`, `/personality*`,
  `/rating*`, `/quality*`, `/intent-*`, `/triage-options`, `/execution-mode`, `/api/bots/intents`,
  `/api/bot-observations*`, `/api/bot-learning*`, `/api/bot-ratings`, `/api/bot-ranking`,
  `/api/knowledge-sources*`, `/api/global-intents*`, `/api/bot-tools`, `/api/bot-ai-*`,
  `/api/local-ai/*`, `/api/conversations/:id/bot-suggestion|bot-feedback`, `GET .../bot-handoff`,
  `/api/bot-suggestion-feedback`, `PATCH /api/bot-settings`, página `/knowledge-base`).
- **Webhook**: saíram `handleIncomingTriage`, `observeIncomingMessage` e `shadowIncomingMessage`.
- **Boot**: saiu o monitor da IA local (`localAiStatusService.start()`).
- **Scripts**: `planner-regression-live.js`, `send-decision-regression-live.js`.
- **Testes**: 57 testes legados (arquivados) + parte de `conversation-id-profile.test.js`.

Mantidos: `rag/` e `Info_Bots/` (intactos, fora do runtime), todas as migrations antigas,
"Cancelar/Retomar Bot" (`bot-pause-service.js`), kill switch (`bot-governance-service.js`).
`scripts/local-knowledge-server.js` (não versionado) não foi tocado; cópia sanitizada no arquivo.

## Rotas novas/atuais

`GET/POST /api/bots`, `GET /api/bots-legacy`, `GET/PATCH/DELETE /api/bots/:id`,
`PATCH /api/bots/:id/status`, `PATCH /api/bots/:id/auto-reply`, `PUT /api/bots/:id/schedules|holidays`,
`GET /api/bot-settings`, `POST /api/bot-settings/kill-switch/activate|deactivate`,
`POST /api/conversations/:id/bot-handoff/pause|resume`, `/api/bot-responses[/:id]`,
`/api/bot-webhooks[/:id]`, `POST/GET /api/bots/:id/flow-media[/:storageKey]` e todas as rotas
`/api/bots/:id/visual-flows*` (sem `execution-mode`).

## Banco de dados

Nada foi apagado. Migrations novas:

1. `20261002120000_flow_builder_only` (aditiva): `BotStatus += ARCHIVED_LEGACY`, tabelas
   `BotResponse` e `BotWebhookEndpoint`, default de `Bot.executionMode` = `FLOW_BUILDER`.
2. `20261002120100_archive_legacy_bots` (dados): Bots `STANDARD` sem fluxo visual →
   `ARCHIVED_LEGACY` + auto-resposta desligada (status anterior salvo em
   `featureFlags.legacyStatusBeforeArchive`); Bots que estavam em `LEGACY` com auto-resposta ligada
   têm a auto-resposta desligada (`featureFlags.legacyAutoReplyBeforeMigration`) — antes só
   `FLOW_BUILDER` executava fluxo, então nenhum Bot começa a responder sozinho.

**Deprecated (parar de usar → marcado → remover em migration futura após estabilidade):**
`Bot.executionMode` (+ enum `BotExecutionMode`), `highConfidenceThreshold`, `lowConfidenceThreshold`,
`featureFlags` (chaves de IA), `toolsEnabled`, `toolPermissions`, `introduceWithName`,
`presentationMessage`, `reintroduceOnNewSession`, `rating*`, `initialMessage`/`outsideHoursMessage`/
`fallbackMessage`/`handoffMessage`, `runOnNewConversation`/`runAfterReopen`; tabelas `BotIntent*`,
`GlobalIntent*`, `BotFlowStep`, `BotObservation`, `BotSuggestionFeedback`, `ConversationLearningState`,
`BotLearningSuggestion`, `BotAiUsage`, `BotVersion`, `BotRating`, `BotAgentFeedback`,
`KnowledgeSource*`, `BotHandoffContext`, `BotPersonality`, `BotTriageOption`, `QuickReplyIntent`,
`AiProviderCredential`, `LocalAiProviderSettings`, `BotAiShadowLog`; colunas de
`BotGlobalSettings` exceto `automationEnabled`/`killSwitch*`. `Campaign.replyBotId` continua:
o "Bot de resposta" da campanha tem prioridade para iniciar o fluxo padrão quando a conversa
entra sem setor.

## Deploy (não feito — checklist para quando autorizar)

1. `scripts/start-production.js` já roda `prisma migrate deploy` → aplica as 2 migrations.
2. No boot, a triagem é convertida em fluxo (log `[BOT_FLOW] Bot de Triagem convertido...`).
3. **Imediatamente**: Bots → Triagem Inicial → testar no simulador → ligar a resposta automática.
4. Revisar `Bots → Histórico técnico` (Bots arquivados) se necessário.
5. O PWA não teve `APP_VERSION` alterado (decisão de release); clientes antigos podem manter o
   cache das telas removidas até a próxima versão.
