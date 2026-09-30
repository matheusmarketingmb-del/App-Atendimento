# Revisão do material local — 30/09/2026

Base examinada: `0ca3182` (v0.34.10), em uso na VPS.

## Reaproveitado

- `deploy-new/test/planner-hint-service.test.js`: testes do planejador já presente no app, anteriormente não rastreados nesta base. Validam pedidos de humano, risco, resolução contextual e motivos de encaminhamento. Não enviam mensagens nem acessam banco.
- Manuais de Supervisor e Master: atualizados para equipes explícitas e supervisão somente leitura por trechos.
- Botão **Ver atendimentos**: integrado ao Histórico da supervisão, sem restringir ao responsável atual ou a conversas ativas.
- FAQ do Supervisor: alinhado às regras atuais.

## Não reaplicar automaticamente

- `hotfix-ai-reply` e `learning-pair-fix`: são cópias anteriores. A base atual já exige texto nas ações da IA e sanitiza apresentações e nomes nas respostas aprendidas.
- `.tmp-*` e `.tmp-email-spam`: material de preparação de prioridade, filtros e e-mail. As funcionalidades correspondentes já existem na base atual; substituir serviços inteiros reverteria alterações recentes de supervisão e envio em massa.
- `deploy-merge` e `deploy-new`: árvores antigas de preparação, não releases para republicar. Scripts denominados `*-regression-live.js` não foram executados.
- Migration `20260827160000_bot_realtime_observation_quality`: não copiar isoladamente sem reconciliar com as migrations já aplicadas e o schema atual.
- `scripts/local-knowledge-server.js`: já presente na base atual; não duplicar nem iniciar outro servidor.
- `Info_Bots`: conteúdo de conhecimento local, não uma correção de código. Preservar sem importar automaticamente para o banco ou publicar no Git.
- Branches antigas com hashes não alcançáveis pelos remotos: não equivalem a funcionalidades inéditas. Não aplicar em bloco sobre a versão atual.
- Worktrees antigos em Temp com arquivos ausentes: não representam exclusões a publicar.

Nenhum arquivo antigo, backup, credencial, volume ou conversa foi removido. O material de preparação foi mantido para recuperação e consulta.
