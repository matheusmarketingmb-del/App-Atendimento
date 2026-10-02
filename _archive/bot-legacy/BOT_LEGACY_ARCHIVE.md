# Arquivo do sistema de Bots legado (IA / RAG / Planner / Knowledge / Shadow)

> Snapshot feito em **2026-10-02**, a partir da branch `feature/social-meta-native`
> (HEAD `47617a4`), **antes** da migração para o Flow Builder como único modelo de Bot.
>
> Nada aqui é carregado pelo app. O diretório `_archive/` não é importado por
> `src/`, não roda nos testes (`test/**/*.test.js`) e fica fora da imagem Docker
> (`.dockerignore`).

## 1. Conteúdo deste diretório

| Caminho | O que é |
|---|---|
| `BOT_LEGACY_ARCHIVE.md` | Este documento |
| `MANIFEST.txt` | Lista de todos os arquivos copiados + prefixo do SHA-256 (para conferir integridade) |
| `code/` | Cópia **literal** dos arquivos originais, preservando o caminho relativo à raiz do projeto |
| `code/src/services/…` | Serviços de Bot, IA, Planner, Knowledge, Tools, Shadow, Triagem e o Flow Builder (estado pré-migração) |
| `code/src/controllers/…` | `bot-controller.js`, `local-ai-controller.js`, `bot-visual-flow-controller.js` |
| `code/src/app.js`, `code/server.js` | Rotas e boot **como eram** (inclui o pipeline do webhook com triagem + shadow + observação) |
| `code/public/…` | Telas antigas: `bots.html/js/css`, `knowledge-base.html/js/css` e o editor `flow-builder.*` pré-migração |
| `code/test/…` | Todos os testes de Bot/IA/Planner/Knowledge/Triagem |
| `code/rag/…` | RAG local em Python (FastAPI + ChromaDB + Ollama) — **sem** `chroma_db/` e `__pycache__/` (são gerados) |
| `code/scripts/…` | Scripts de regressão ao vivo do Planner/decisão de envio e o servidor de conhecimento local (`local-knowledge-server.js`, com o IP privado substituído por `127.0.0.1`) |
| `code/prisma/schema.prisma`, `code/prisma/seed.js` | Schema e seed completos do momento do arquivo |
| `code/.env.example` | Variáveis de ambiente (somente placeholders; nenhum segredo) |
| `prisma/legacy-models.prisma` | Apenas os 48 models/enums de Bot/IA/Knowledge/Flow, com os comentários originais |
| `prisma/migrations/` | Cópia das 23 migrations relacionadas (as originais **continuam** em `prisma/migrations/`, nunca foram apagadas) |

**Não copiado de propósito:** `node_modules`, `.env`, tokens/segredos, banco de dados,
`rag/chroma_db` (índice vetorial gerado; ~14 MB, reconstruível com `index_knowledge.py`),
`rag/__pycache__`. `Info_Bots/` **não foi copiado nem movido**: ele continua na raiz do
projeto (`C:\App Whats\Info_Bots`), versionado no Git, e é a fonte do RAG. `rag/` também
continua no lugar original.

## 2. Visão geral — o que o sistema antigo fazia

Havia **quatro motores** convivendo:

1. **Bot de Triagem do sistema** (`triage-bot-service.js`) — o **único** que enviava
   mensagens reais. Bot `type = SYSTEM_TRIAGE`, criado por migration
   (`20260902170000_bot_system_triage`). Em conversa nova sem categoria: dentro do
   horário enviava um menu interativo (lista do WhatsApp) com as `BotTriageOption`
   (cada uma ligada a uma `Category`), fora do horário enviava `outsideHoursMessage`.
   Ao escolher, movia a conversa para a categoria (`status NOVO`) e enviava
   `handoffMessage`. Caso especial "Atendimento": perguntava o que o cliente precisava e
   reclassificava por palavras-chave (`atendimentoRoutingKeywords`). Placeholders:
   `{{saudacao}}`, `{{saudacao_virgula}}`, `{{horario}}`, `{{categoria}}`.
2. **Motor de intenções / orquestrador** (`bot-orchestrator-service.js`) — rodava em
   **modo observação** em toda mensagem (`bot-observation-service.js`), nunca enviava.
   Gerava `BotObservation` e a **sugestão de resposta** mostrada ao atendente na Central.
3. **IA local em modo shadow** (`bot-ai-shadow-service.js`) — para Bots com
   `featureFlags.useAi = true`, mandava a mensagem ao RAG Server (Qwen3 14B) e gravava
   `BotAiShadowLog` com o que **teria** respondido. Envio real estruturalmente bloqueado
   (`send-mode-service.js`: `DRY_RUN`; `LIVE` lança erro).
4. **Flow Builder** (`bot-visual-flow-*.js`) — só para `Bot.executionMode = FLOW_BUILDER`.
   Tinha nós de IA (`ai`) e Knowledge (`knowledge`) que reaproveitavam o shadow/RAG.

### Pipeline do webhook WhatsApp (ver `code/src/app.js`, ~linha 157)

```
saveIncoming(event)
  └─ (não duplicada, não reaction, sem flood)
       ├─ handleIncomingVisualFlow()  → true = Flow Builder é dono da mensagem
       ├─ senão handleIncomingTriage() → Bot SYSTEM_TRIAGE (envio real)
       ├─ observeIncomingMessage()    → orquestrador em OBSERVATION (sem envio)
       ├─ shadowIncomingMessage()     → IA local shadow (sem envio)
       ├─ pushService.notifyIncomingMessage()
       └─ campaignReplyService.handleInboundMessage()
```

Nos canais novos (`/webhooks/channels/:channel`) só havia `observeIncomingMessage` + push.

## 3. Componentes

### 3.1 Núcleo de intenções (motor "clássico")
| Arquivo | Papel |
|---|---|
| `bot-service.js` | CRUD de Bot, intenções, exemplos, horários, feriados, opções de triagem, simulação |
| `bot-orchestrator-service.js` | Escolhe o Bot, encadeia `interpret → decide/plan → respond`, governança, troca de Bot por categoria, loop guard |
| `bot-interpreter-service.js` | Classifica intenção (exemplos, normalização semântica, ranking, entidades, IA externa opcional) |
| `bot-intent-ranking-service.js`, `bot-semantic-normalizer.js`, `bot-entity-extractor.js` | Ranking de intenções, sinônimos/normalização, extração de pedido/CPF/serial etc. |
| `bot-decision-service.js` | Decide ação (`RESPOND`, `ASK_CLARIFICATION`, `HANDOFF_HUMAN`, `SWITCH_BOT`, `QUERY_TOOL`, `NO_ACTION`) por limiares de confiança |
| `bot-social-behavior-service.js` | Saudação/agradecimento/despedida/pedido de humano |
| `bot-response-service.js`, `bot-personality-service.js`, `bot-personality-constants.js` | Monta a resposta e aplica personalidade (preset, tom, tamanho) |
| `bot-flow-service.js` | **Flow Engine antigo**: etapas lineares (`BotFlowStep`) por intenção (perguntar, consultar tool, consultar knowledge, confirmar, transferir) |
| `bot-case-state-service.js`, `bot-conversation-state-service.js` | Estado do caso/conversa (`ConversationBotState`), contexto recente |
| `bot-loop-guard-service.js` | Evita ping-pong/respostas repetidas |
| `bot-handoff-service.js` | Contexto de transferência (`BotHandoffContext`), pausar/retomar Bot na conversa |
| `bot-governance-service.js`, `bot-constants.js` | `BotGlobalSettings` (kill switch `automationEnabled`), feature flags por Bot, toggles |
| `bot-version-service.js` | Snapshots `BotVersion` + restore; `assertBotManager` (só Master) |
| `global-intent-service.js` | Biblioteca global de intenções (`GlobalIntent`) associáveis a Bots |
| `bot-simulator-service.js` | Utilidades puras (`normalizeText`, `scheduleState`, `localDateParts`) + simulador antigo |

### 3.2 Observação, aprendizado e qualidade
`bot-observation-service.js`, `bot-suggestion-service.js`, `bot-learning-service.js`,
`bot-learning-sanitizer.js`, `bot-agent-feedback-service.js`, `bot-quality-service.js`,
`bot-rating-service.js`, `bot-ai-usage-service.js`. Geravam `BotObservation`,
`BotSuggestionFeedback`, `BotLearningSuggestion` (sempre com revisão humana),
`BotAgentFeedback`, `BotRating`, `BotAiUsage`.

### 3.3 Tools (consultas)
`bot-tool-orchestrator-service.js` + `bot-tools/` (`order`, `tracking`, `product`,
`serial-number`, `warranty`, `invoice`, `payment`). Só `READ_ONLY`; ações sensíveis
bloqueadas por `ToolRiskLevel`. Implementações eram stubs/integrações mínimas.

### 3.4 Knowledge (Base de Conhecimento do app)
`bot-knowledge-source-service.js` (CRUD `KnowledgeSource`/`KnowledgeSourceBot`, vigência,
acesso por Bot), `bot-knowledge/knowledge-provider.js` (busca textual por tags/tipo/
produto/categoria — **sem vetor**), `bot-knowledge-response-service.js` (resposta a partir
da Knowledge). Tela: `public/knowledge-base.*`, rotas `/api/knowledge-sources`.

### 3.5 IA — providers
| Arquivo | Papel |
|---|---|
| `ai/ai-provider.js` | Interface base |
| `ai/get-ai-provider.js` | Seleção de provider (credencial do painel → env → fallback local) |
| `ai/anthropic-provider.js`, `ai/gemini-provider.js`, `ai/openai-provider.js` | Classificação via API externa |
| `ai/local-fallback-provider.js` | Similaridade local sem IA (fallback) |
| `ai/local-qwen-provider.js` | **LocalQwenProvider**: HTTP para o RAG Server (`/answer`), fila `local-ai-queue.js` |
| `ai/ai-credential-service.js` | Cofre cifrado de chaves (`AiProviderCredential`, via `secret-vault-service`) |
| `ai/classification-utils.js` | Parsing comum das respostas |
| `local-ai-settings-service.js`, `local-ai-status-service.js`, `local-ai-queue.js` | `LocalAiProviderSettings` (singleton: `enabled`, `baseUrl`, `defaultModel`, `timeoutMs`, `maxConcurrency`), monitor ONLINE/OFFLINE/DEGRADED iniciado no `server.js`, fila de concorrência |
| `controllers/local-ai-controller.js` | `/api/local-ai/status|settings|check` |

### 3.6 Planner, guards e Shadow
| Arquivo | Papel |
|---|---|
| `bot-agent-planner-service.js` | Agent Planner (flag `agentPlannerEnabled`): decide próxima ação (`RESPOND/ASK/CLARIFY/SEARCH_KNOWLEDGE/USE_TOOL/HANDOFF/WAIT/RESOLVE`), traduzido para a decisão legada (`planToLegacyDecision`) |
| `ai/planner-hint-service.js` | Sinais determinísticos **antes** do LLM: pedido de humano, risco de segurança (fumaça/bateria inchada), confirmação de solução, status de pedido |
| `ai/planner-output-guard.js` | Normaliza/valida a saída do Qwen (ação, confiança `HIGH/MEDIUM/LOW`, handoff com evidência) |
| `bot-ai-gate-service.js` | Separa `useAi` (IA roda) de `autoReplyEnabled` (pode enviar); `requiresAi` + `aiOfflineBehavior` (`NO_AUTO_REPLY`/`LOCAL_FLOW`/…) |
| `ai/send-mode-service.js`, `ai/dry-run-sender.js` | `SHADOW` / `DRY_RUN` / `LIVE` (LIVE bloqueado estruturalmente) |
| `bot-ai-shadow-service.js` | `shadowIncomingMessage` (grava `BotAiShadowLog`), `previewShadowReply` (simulador), `runFlowAiStep` (nó IA do Flow Builder) |

Feature flags de IA por Bot (`Bot.featureFlags`, defaults em `bot-constants.js`):
`useAi`, `aiProvider` (`LOCAL_QWEN`), `aiModel`, `aiMode` (`OFF`/`PRIMARY`/…),
`requiresAi`, `aiOfflineBehavior`, `agentPlannerEnabled`, `externalAiProvider`,
`externalAiModel`, além de toggles de observação/sugestão/contexto.

### 3.7 RAG local (Python) — `code/rag/` (original em `C:\App Whats\rag`)
| Arquivo | Papel |
|---|---|
| `index_knowledge.py` | Lê `Info_Bots/**/*.md` (frontmatter), quebra em chunks, gera embeddings `nomic-embed-text` via Ollama (`127.0.0.1:11434/api/embeddings`), grava no ChromaDB (`rag/chroma_db`, coleção `mibro_knowledge`) |
| `search_knowledge.py` | Busca híbrida: embedding + detecção de produto + roteamento por intenção + diversidade |
| `answer_with_ai.py` | Prompt + geração com `qwen3:14b` (`/api/chat`), fast paths (humano, risco de segurança), saída JSON (action, intent, confidence, needsHuman, answer…) |
| `rag_server.py` | FastAPI em `127.0.0.1:8992`: `GET /health`, `POST /search {query, limit}`, `POST /answer {message, chunks, history[]}` |
| `test_planner.py` | Casos de teste do Planner contra o RAG |
| `requirements.txt` | `chromadb requests python-frontmatter fastapi uvicorn` |

Produção usava o PC do operador via Tailscale: `LocalAiProviderSettings.baseUrl` apontava
para o RAG Server (nunca direto para o Ollama).

## 4. Modelos Prisma (ver `prisma/legacy-models.prisma`)

- **Bot e configuração:** `Bot` (campos legados: `highConfidenceThreshold`, `lowConfidenceThreshold`,
  `featureFlags`, `toolPermissions`, `toolsEnabled`, `introduceWithName`, `presentationMessage`,
  `executionMode`…), `BotPersonality`, `BotTriageOption`, `BotSchedule`, `BotHoliday`, `BotVersion`,
  `BotGlobalSettings`.
- **Intenções:** `BotIntent`, `BotIntentExample`, `GlobalIntent`, `GlobalIntentExample`,
  `BotFlowStep` (+ enums `BotFlowStepAction`, `FlowResolutionStatus`), `QuickReplyIntent`.
- **Estado/observação/aprendizado:** `ConversationBotState`, `ConversationLearningState`,
  `BotObservation`, `BotSuggestionFeedback`, `BotLearningSuggestion`, `BotAgentFeedback`,
  `BotRating`, `BotAiUsage`, `BotHandoffContext`.
- **Knowledge:** `KnowledgeSource`, `KnowledgeSourceBot`.
- **IA:** `AiProviderCredential`, `LocalAiProviderSettings`, `BotAiShadowLog`.
- **Flow Builder:** `BotFlow`, `BotFlowVersion`, `BotFlowExecution`, `BotFlowExecutionLog`,
  enums `BotExecutionMode`, `BotFlowStatus`, `BotFlowExecutionStatus`.

Migrations relacionadas (cópia em `prisma/migrations/`): de `20260812170000_bot_triage_categories`
até `20260925150000_bot_visual_flow_builder`, incluindo `ai_provider_credentials`,
`local_ai_provider` e `mibro_assistant_enable_local_ai_shadow` (esta última ligava
`useAi`/shadow no Bot "Mibro Assistant").

## 5. Endpoints (todos em `code/src/app.js`)

**Bots:** `GET/POST /api/bots`, `GET /api/bots/intents`, `GET/PATCH/DELETE /api/bots/:botId`,
`PATCH …/status`, `PUT …/schedules|holidays|triage-options`, `POST …/simulate`.
**Intenções/fluxo antigo:** `POST/PATCH/DELETE /api/bots/:botId/intents[/:intentId]`,
`…/intents/:intentId/flow-steps[/:stepId|/reorder]`, `…/intent-conflicts`, `…/intent-metrics`,
`/api/global-intents…`, `/api/bots/:botId/global-intents/:globalIntentId`,
`/api/bots/:botId/intent-associations/:botIntentId`.
**Observação/aprendizado/qualidade:** `/api/bot-observations[/metrics|/:id/feedback]`,
`/api/bot-learning/…`, `/api/bots/:botId/quality-metrics|quality-alerts|observation-timeseries`,
`/api/conversations/:id/bot-suggestion`, `/api/bot-suggestion-feedback`, `/api/conversations/:id/bot-feedback`.
**Avaliação:** `/api/bot-ratings`, `/api/bots/:botId/rating-metrics|rating-timeseries|rating-config`, `/api/bot-ranking`.
**Governança/versões:** `/api/bot-settings[/kill-switch/activate|deactivate]`, `/api/bots/:botId/versions…`.
**Handoff:** `/api/conversations/:conversationId/bot-handoff[/pause|/resume]`.
**Personalidade:** `/api/bot-personality-presets`, `/api/bots/:botId/personality[/preset|/copy]`.
**Knowledge:** `/api/knowledge-sources[/:sourceId]`.
**Tools/IA:** `/api/bot-tools`, `/api/bot-ai-providers`, `/api/bot-ai-provider-status[/test]`,
`/api/bot-ai-credentials[/:provider]`, `/api/local-ai/status|settings|check`.
**Flow Builder (pré-migração):** `/api/bots/:botId/visual-flows…`, `…/visual-flow-options`,
`PATCH /api/bots/:botId/execution-mode`.
**Páginas:** `/bots`, `/knowledge-base`, `/flow-builder`.

Sem SSE próprio de Bot: as mudanças chegavam à Central via `inboxEvents.publish()`.
Jobs em processo (`server.js`): `localAiStatusService.start()` (monitor da IA local) e
`startVisualFlowWorker` (timers do Flow Builder). Sem cron externo.

## 6. Como reativar / reaproveitar no futuro

1. **Recuperar arquivos exatos:** `git show <commit-do-arquivo>:caminho` ou copie de
   `_archive/bot-legacy/code/<caminho>` de volta para `<caminho>`. Confira com `MANIFEST.txt`.
2. **Banco:** as tabelas legadas **não foram removidas** na migração (ver relatório final /
   `docs/BOT_FLOW_BUILDER_MIGRATION.md`). Se alguma for removida no futuro, recrie a partir de
   `prisma/legacy-models.prisma` + `prisma migrate dev`.
3. **IA local como plugin futuro (caminho recomendado):** em vez de ressuscitar o
   orquestrador inteiro, crie um **nó opcional** no Flow Builder que chame o RAG Server:
   - copie `ai/local-qwen-provider.js`, `local-ai-queue.js`, `local-ai-settings-service.js`,
     `local-ai-status-service.js` e `ai/planner-output-guard.js`/`ai/planner-hint-service.js`;
   - registre o tipo `ai` em `bot-visual-flow-graph.js#NODE_TYPES` com saídas
     `next/handoff/error` (como em `code/src/services/bot-visual-flow-graph.js`) e um handler em
     `bot-visual-flow-engine.js` (veja o handler `ai` no snapshot);
   - mantenha o envio passando por um gate equivalente a `bot-ai-gate-service.js` +
     `send-mode-service.js` (nunca enviar direto).
4. **Subir o RAG:** `cd rag && pip install -r requirements.txt`, Ollama com `qwen3:14b` e
   `nomic-embed-text`, `python index_knowledge.py` (reconstrói `chroma_db`),
   `uvicorn rag_server:app --host 127.0.0.1 --port 8992`.
5. **Knowledge do app:** reaproveite `knowledge-provider.js` (busca textual) como nó
   "Consultar conhecimento" opcional, ou importe `Info_Bots/*.md` para a biblioteca de
   **Respostas do Bot** do Flow Builder.
6. **Triagem antiga:** a lógica de menu por setor / horário / reclassificação de
   Atendimento está em `code/src/services/triage-bot-service.js` e pode ser remontada
   como fluxo visual (Início → Condição de horário → Menu → Transferir para setor).

## 7. Arquivos removidos do runtime

Preenchido ao final da migração — ver seção **"Removidos do runtime"** em
`docs/BOT_FLOW_BUILDER_MIGRATION.md`. Todos os arquivos removidos estão
listados em `MANIFEST.txt` e têm cópia em `code/`.
