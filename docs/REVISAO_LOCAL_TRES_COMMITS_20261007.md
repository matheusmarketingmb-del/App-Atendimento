# Revisão e prévia local — 2026-10-07

Base revisada: `b4f5287` (Financeiro protegido/atendente fixo), `8dd246c`
(Central de Operação), `67f8698` (Custos Meta).

Os três commits já estavam no HEAD local. Os ajustes não commitados de layout,
respostas rápidas, integrações e bordas de empresa foram preservados. Não houve
push, publicação ou alteração da VPS.

## Correções da revisão

- Status sem `pricing` preserva a categoria previamente informada pela Meta.
- Template sem categoria não é classificado automaticamente como marketing.
- Relatório/orçamento em BRL: cadastro de outras moedas é rejeitado, pois não
  existe conversão cambial. Períodos seguem America/Sao_Paulo.
- Preços retroativos terminam na próxima vigência; início duplicado é rejeitado.
- Cadastro preenche custos ainda sem preço, somente na vigência correspondente.
- Orçamento sem empresa e períodos invertidos são rejeitados.
- Resposta atrasada de um filtro de custos não substitui o relatório mais recente.

## Validação

- Suíte completa: 432 testes, 430 aprovados, 2 ignorados, nenhuma falha.
- Navegador: Operação e Custos Meta em 1366, 390 e 320 px, sem overflow horizontal
  ou erro JavaScript; menus Master presentes; Atendente recebe 403 nas páginas/APIs.
- Regressão local: histórico privado, modal de atendente fixo com requisição lenta,
  cancelamento, gravação única e bordas de empresa.

## Como testar

Prévia: http://127.0.0.1:3339. Conta Master: `bot-qa@teste.local`;
senha exclusivamente fictícia: `teste-local-bots`.

- `/`: Financeiro/atendente fixo, com os ajustes visuais anteriores.
- `/operacao`: pendências e equipe.
- `/custos-meta`: filtros, tabela de preços e orçamento.

Banco: PostgreSQL de QA em loopback 25432, schema `financeiro_preview_20261007`.
Schema sincronizado sem descarte de dados; Prisma Client regenerado. As migrations
não foram aplicadas na VPS. O runner usa outro schema isolado, `app_whats_test`.

Os novos exemplos são identificados como fictícios. Contas sem credenciais e
envio real bloqueado. Não foram inventadas tarifas oficiais: o painel demonstra
um envio gratuito e outros sem preço cadastrado. Valores são estimativas, não
uma fatura da Meta; BR/INTL permanece uma classificação simplificada de país.

Os ajustes desta revisão continuam na cópia de trabalho, sem novo commit.
