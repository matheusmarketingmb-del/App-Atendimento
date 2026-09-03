-- Case State (Contexto real da conversa, item 4 do plano de Inteligência de
-- Bots): memória estruturada do caso (sintoma, produto, app, SO, perguntas
-- feitas, soluções tentadas/falhadas, ferramentas usadas, pendências), em
-- nível de conversa. Migration 100% aditiva: uma coluna nullable nova,
-- nenhum dado existente é alterado. Uma conversa sem caseState continua
-- funcionando normalmente (bot-case-state-service.js trata null como caso
-- vazio).

ALTER TABLE "ConversationBotState" ADD COLUMN "caseState" JSONB;
