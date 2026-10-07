# Controle de custos da Meta (estimativa)

Nunca bloqueia envio. Tela: **Custos Meta** (`/custos-meta`, só Master).

## Como o custo é registrado
- Ponto único: webhook de **status** do WhatsApp (`sent`/`delivered`/`read`), que traz
  `pricing` (`billable`, `pricing_model`, `category`, `type`). Cada mensagem ENVIADA
  no canal META ganha **um** `MetaMessageCharge` (resposta, Bot, template e campanha).
- Mensagem que falhou (sem status de envio) nunca vira custo.
- Categoria: `pricing.category` da Meta > categoria do template enviado > `SERVICE`.
  Mensagem comum nunca é classificada pelo texto.
- País: DDI do destinatário (`55` → `BR`; demais → `INTL`).
- Custo: `billable=false` ou tipo gratuito (`free_customer_service`, `free_entry_point`)
  = 0; senão o preço vigente em `MetaPricing` na data do envio; sem preço cadastrado
  = nulo (a tela avisa quantos envios estão sem preço).

## Preços e orçamento
- `MetaPricing` (país, categoria, preço, moeda, `effectiveFrom`/`effectiveTo`): cadastrar
  um preço novo encerra o vigente na data de início — histórico preservado. Nenhum
  preço vem pré-cadastrado: use a tabela oficial da Meta.
- `MetaCostBudget`: orçamento mensal por empresa, só alerta (80% laranja, 100% vermelho).

## Relatório
Filtros: período (hoje / 7 dias / mês), empresa e número. Por empresa: mensagens de
serviço, templates por categoria, custo estimado, uso do orçamento; por número quando
há mais de um.

## Migration e rollback
`prisma/migrations/20261007140000_meta_cost_control` — só tabelas e enum novos.
Rollback manual (apaga apenas os dados de custo):

```sql
DROP TABLE "MetaMessageCharge";
DROP TABLE "MetaPricing";
DROP TABLE "MetaCostBudget";
DROP TYPE "MetaPricingCategory";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261007140000_meta_cost_control';
```

e reverter o commit (o webhook de status volta a ignorar `pricing`).

Pendente: backfill opcional de envios anteriores à migration (não há `pricing` salvo
para eles — só a categoria do template).
