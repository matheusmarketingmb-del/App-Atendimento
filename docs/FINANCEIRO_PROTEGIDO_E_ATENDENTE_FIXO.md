# Financeiro protegido e Atendente fixo

Duas regras independentes, ambas aplicadas no backend.

## 1. Setor com histórico protegido (Financeiro)

**Ativação:** Master → Categorias → no setor principal, marcar **🔒 Histórico protegido**
(`Category.visibilityMode = SECTOR_PRIVATE`). Subcategorias herdam. Nada depende do nome
"Financeiro".

**Quem lê:** Master sempre; membros do setor = quem tem acesso à categoria (ou a uma
subcategoria dela) em **Equipe** (`UserCategoryAccess`), numa empresa que ainda acessa.
Atendente fixo, responsável atual ou participação anterior **não** dão acesso.

**Como funciona:** toda `Message` / `ConversationActivity` criada enquanto a conversa está no
setor protegido (e não finalizada) recebe `privateCategoryId` — carimbo automático em
`src/database/prisma.js`, cobre todos os caminhos de criação. `ContactNote` criada a partir da
conversa no setor também é carimbada. Nada é apagado nem duplicado; só a leitura muda
(`src/services/private-segment-service.js`).

| Ponto | Comportamento para quem não é membro |
|---|---|
| Detalhe da conversa | Trechos privados viram um bloco `🔒 Atendimento <setor>` (sem texto, autor, mídia, contagem) |
| Eventos | Mantém o estrutural (entrou/saiu/transferiu/status) sem motivo, resumo ou prévia |
| Lista | Prévia da última mensagem e nota mais recente nunca vêm do trecho privado |
| Anexos / mensagem por ID | `403` (`GET /api/messages/:id/media`) |
| Notas do contato | Nota do Financeiro não aparece; fixar por ID → 404 |
| Push | Corpo vira "Conversa atualizada" |
| SSE | Já não trafega conteúdo (só aviso) |
| Busca | Não existe busca por texto de mensagem; o filtro `readableWhereFor` está pronto para ela |
| Exportações/relatórios/auditoria | Já são exclusivos do Master |

Membros veem os segmentos privados **mesmo antes** do corte de histórico normal (Ana/Emily
recuperam o Financeiro anterior quando a conversa volta). Membros também acompanham conversas
que estão no setor agora, mesmo assumidas por outro membro (como o Supervisor na área dele).

Finalizar encerra o segmento: a mensagem que abre um novo atendimento segue as regras normais.

**Histórico anterior ao flag:** `node scripts/backfill-private-segments.js --category=<id>`
(simulação) e `--apply` para gravar. Reconstrói os intervalos pelo histórico de transferências.
Notas antigas não são carimbadas.

## 2. Atendente fixo por cliente

`Contact.preferredAssigneeId/Enabled/SetById/SetAt` — por empresa (Contact já é por empresa).
Nunca substitui `Conversation.assignedUserId`.

- **Quem altera:** Supervisor na empresa do cliente ou Master. Atendente vê somente leitura.
- **Quem pode ser escolhido:** usuário ativo, não-Bot, com acesso ativo à empresa do cliente.
- **Roteamento** (`preferred-assignee-routing-service.js`), antes do Flow Builder no webhook do
  WhatsApp: conversa `NOVO`, sem responsável e sem setor + vínculo ativo e válido → atribui ao
  atendente fixo, status `AGUARDANDO_EQUIPE` (entra no SLA), envia a mensagem configurável
  (Configurações → Conversas → Atendente fixo) e notifica. Nenhum menu/triagem roda. Execução
  de fluxo que sobrou de um atendimento anterior é encerrada (sem apagar).
- **Ausente/offline:** continua com ele, sem redistribuição. Painel mostra "Aguardando atendente
  responsável"; SLA alerta Supervisor/Master normalmente.
- **Transferir/finalizar** mexem só em `assignedUserId`; o vínculo permanece.
- **Histórico:** `AuditLog` `PREFERRED_ASSIGNEE_SET | _CHANGED | _REMOVED` (anterior, novo, quem,
  quando, motivo) + `ConversationActivity` `ROUTED_TO_PREFERRED_ASSIGNEE`.
- **APIs:** `GET|PUT|DELETE /api/contacts/:contactId/preferred-assignee`,
  `GET …/preferred-assignee/candidates`, `GET …/preferred-assignee/history`.
- **Filtro da lista:** `?preferredAssignee=ANY|NONE|ME|<userId>` (outro usuário: Supervisor/Master).

Migration: `prisma/migrations/20261007120000_private_sector_and_preferred_assignee` (aditiva).
Testes: `test/private-segments*.test.js`, `test/preferred-assignee.test.js`.
