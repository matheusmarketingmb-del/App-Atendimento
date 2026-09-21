---
type: wholesale
topic: order_approval
brand: Mibro
updated: 2026-09-18
---

# Atacado e Revenda — Aprovação de Pedido

## Objetivo

Este arquivo orienta o Bot sobre a etapa de aprovação interna dos pedidos de atacado.

O fluxo pode envolver:

- cotação
- criação do pedido
- pedido em aberto
- análise interna
- aprovação
- reprovação
- solicitação de ajuste
- geração de link de pagamento
- pagamento
- faturamento
- envio

O Bot deve sempre informar a etapa real do pedido.

---

# Regra principal

Aprovação NÃO significa:

- pagamento realizado
- faturamento concluído
- NF-e emitida
- pedido enviado

São etapas diferentes.

---

# Fluxo geral

Fluxo esperado:

1. cliente solicita cotação;
2. cotação é montada;
3. condição comercial é definida;
4. pedido pode ser criado no Olist;
5. pedido fica em aberto;
6. responsável interno analisa;
7. pedido é aprovado ou ajustado;
8. link de pagamento pode ser gerado;
9. cliente realiza pagamento;
10. pedido segue para faturamento;
11. NF-e é emitida;
12. pedido segue para expedição.

O Bot não deve pular etapas.

---

# Pedido em aberto

Quando o pedido aparece como:

Em aberto

isso pode significar que ainda está aguardando etapas como:

- aprovação interna
- confirmação comercial
- processamento

Não dizer:

"Seu pedido já está aprovado."

---

# Cliente pergunta o que significa "Em aberto"

Resposta recomendada:

"Seu pedido já foi registrado, mas ainda está em uma etapa anterior à conclusão. Ele pode estar aguardando aprovação interna antes de seguir para pagamento e faturamento."

---

# Aprovação interna

A aprovação é feita por responsável autorizado da operação.

Pode envolver análise de:

- valores
- quantidades
- desconto
- cliente
- CNPJ
- impostos
- disponibilidade
- condição comercial

O Bot não aprova pedidos por conta própria.

---

# Responsável pela aprovação

O sistema pode encaminhar a solicitação para:

- supervisor
- responsável comercial
- chefe
- usuário autorizado

O cliente não precisa receber detalhes internos desnecessários.

---

# Aprovação por e-mail/link

O fluxo pode utilizar:

- e-mail
- link interno
- painel administrativo

para aprovação.

O Bot deve tratar isso como processo interno.

---

# Pedido aguardando aprovação

Se o cliente perguntar:

"Por que ainda não recebi o link de pagamento?"

verificar primeiro:

- pedido existe?
- está em aberto?
- aprovação foi concluída?

Se ainda aguarda aprovação:

explicar isso.

---

# Resposta recomendada

"Seu pedido ainda está aguardando a etapa de aprovação interna. O link de pagamento só deve ser gerado depois que essa etapa for concluída."

---

# Não prometer prazo de aprovação

O Bot NÃO deve dizer:

- "será aprovado hoje"
- "leva 10 minutos"
- "em uma hora chega o link"

sem prazo real confirmado.

---

# Pedido aprovado

Quando houver confirmação real:

o Bot pode informar:

"Seu pedido foi aprovado."

Mas deve deixar claro que:

a aprovação não significa pagamento concluído.

---

# Próxima etapa após aprovação

Depois da aprovação:

o fluxo pode seguir para geração do link de pagamento.

Se o link ainda não existir:

não inventar.

---

# Link ainda não gerado

Se o pedido está aprovado, mas o link não apareceu:

verificar:

- integração
- status do pedido
- geração da cobrança

Se houver atraso ou falha:

encaminhar para comercial/financeiro.

---

# Pedido aprovado sem link

Resposta recomendada:

"Seu pedido já foi aprovado, mas o link de pagamento ainda não aparece como gerado. Vou encaminhar para verificarem essa etapa."

---

# Link gerado

Somente informar quando existir de fato.

O Bot não deve montar URL manualmente.

---

# Pedido reprovado

Se houver reprovação:

não inventar motivo.

Usar somente o motivo registrado.

Se não houver motivo disponível:

informar que será necessária análise comercial.

---

# Linguagem recomendada

Evitar:

"Seu pedido foi recusado porque..."

sem motivo confirmado.

Preferir:

"O pedido não seguiu para aprovação final e precisa de uma revisão comercial."

---

# Solicitação de ajuste

A aprovação pode retornar com necessidade de:

- ajustar quantidade
- alterar produto
- revisar desconto
- corrigir dados
- revisar condição comercial

Nesse caso:

o pedido não deve ser tratado como aprovado.

---

# Cliente precisa alterar quantidade

Se o pedido ainda está em análise:

pode ser possível ajustar.

Encaminhar para o vendedor responsável.

Não alterar valores sozinho.

---

# Cliente quer adicionar produto

Pode exigir:

- nova cotação
- recálculo
- nova aprovação

Não adicionar diretamente a um pedido aprovado sem seguir o fluxo.

---

# Cliente quer remover produto

Mesma lógica.

Alterações podem afetar:

- total
- desconto
- impostos
- aprovação

---

# Mudança após aprovação

Se o cliente alterar:

- quantidade
- mix
- produto
- condição

a aprovação anterior pode deixar de ser válida.

O Bot não deve assumir que continuará aprovada.

---

# Aprovação e estoque

Um pedido aprovado comercialmente ainda pode depender de estoque.

Não tratar aprovação como reserva automática se o sistema não fizer isso.

---

# Aprovação e impostos

A aprovação pode considerar valores estimados.

O faturamento posterior pode gerar cálculo fiscal definitivo.

Não prometer valor fiscal final apenas com base na aprovação comercial.

---

# Aprovação e frete

Se o frete ainda não estiver definido:

deixar claro.

Pedido aprovado não significa necessariamente frete calculado.

---

# Aprovação e pagamento

Separar:

## Aprovado

Pedido autorizado a seguir.

## Link gerado

Cobrança criada.

## Pago

Cliente concluiu o pagamento.

Esses status não são equivalentes.

---

# Aprovação e faturamento

Pagamento confirmado ainda pode ser etapa anterior ao faturamento.

Não dizer:

"Já está faturado."

sem confirmação.

---

# Aprovação e NF-e

NF-e pode ser emitida depois do pagamento/faturamento.

Não confundir aprovação interna com emissão fiscal.

---

# Aprovação e envio

Pedido aprovado não significa:

- separado
- despachado
- em transporte

Esses são status logísticos posteriores.

---

# Cancelamento antes da aprovação

Se o cliente quiser cancelar enquanto está em aberto:

encaminhar para comercial.

Pode ser mais simples interromper o fluxo antes do pagamento.

Não prometer exclusão automática.

---

# Cancelamento depois da aprovação

Se ainda não houve pagamento:

encaminhar.

Se já houve pagamento:

também pode envolver financeiro.

---

# Pedido duplicado

Se existirem dois pedidos semelhantes:

não aprovar ambos automaticamente.

Encaminhar para revisão.

---

# Cotação convertida em pedido

Somente considerar convertida quando houver confirmação real.

Não confundir cotação aprovada com pedido criado.

---

# Pedido de teste

Pedidos de teste não devem entrar no fluxo real de cobrança/faturamento.

Se existir flag de teste:

respeitar.

---

# Pedido real

Pedido real pode seguir para:

- aprovação
- cobrança
- faturamento

Não misturar com simulação.

---

# Histórico da aprovação

Quando possível, registrar:

- pedido
- cotação de origem
- vendedor
- aprovador
- status
- data/hora
- observação
- motivo de ajuste/reprovação

---

# Auditoria

Alterações importantes devem ficar registradas.

Exemplos:

- valor alterado
- desconto alterado
- quantidade alterada
- aprovação
- reprovação

---

# Cliente não precisa ver tudo

Detalhes internos como:

- usuário aprovador
- regra interna
- margem
- estrutura de desconto

não precisam ser expostos ao cliente.

---

# Exemplo — aguardando aprovação

Cliente:

"Meu pedido ainda está em aberto."

Bot:

"Isso significa que ele ainda está em uma etapa anterior à conclusão, normalmente aguardando aprovação interna antes de seguir para pagamento."

---

# Exemplo — aprovado

Cliente:

"Foi aprovado, já está pago?"

Bot:

"Não. A aprovação libera o pedido para seguir, mas o pagamento é uma etapa separada. O próximo passo normalmente é a geração do link de pagamento."

---

# Exemplo — aprovado sem link

Cliente:

"Já aprovaram, mas não recebi nada."

Bot:

"Vou verificar se o link de pagamento já foi gerado. Se o pedido está aprovado e o link ainda não existe, encaminho essa etapa para o comercial/financeiro."

---

# Exemplo — alteração

Cliente:

"Quero trocar 5 Lite 3 por GS Pro 2."

Bot:

"Como isso altera a composição e o valor da cotação, o pedido precisa ser recalculado e pode exigir uma nova aprovação antes do pagamento."

---

# Exemplo — cliente quer cancelar

Cliente:

"Desisti e ainda está em aberto."

Bot:

"Como o pedido ainda não chegou à etapa de pagamento, vou encaminhar a solicitação para o comercial interromper o fluxo antes que ele avance."

---

# Status conceituais

O fluxo pode ser representado por estados como:

- EM_ABERTO
- AGUARDANDO_APROVACAO
- AJUSTE_SOLICITADO
- APROVADO
- REPROVADO
- AGUARDANDO_LINK_PAGAMENTO
- LINK_GERADO
- AGUARDANDO_PAGAMENTO
- PAGO
- FATURAMENTO
- FATURADO
- ENVIADO

Os nomes técnicos reais podem ser diferentes.

Não assumir implementação sem verificar o sistema.

---

# Quando encaminhar para humano

Encaminhar quando houver:

- aprovação demorando além do normal
- pedido aprovado sem link
- reprovação sem motivo
- necessidade de ajuste
- negociação
- alteração de produtos
- alteração de quantidades
- pedido duplicado
- erro de status
- pedido travado
- condição comercial especial

---

# Informações úteis antes do handoff

Coletar ou obter:

- empresa
- CNPJ
- número do pedido
- vendedor responsável
- status atual
- cotação de origem
- valor
- quantidade
- aprovação concluída?
- link gerado?
- pagamento realizado?
- observação

---

# Resumo para humano

Exemplo:

Setor: Atacado / Comercial
Empresa: Loja XYZ
Pedido: #1234
Status: aprovado
Valor: conforme cotação
Aprovação: concluída
Link de pagamento: ainda não gerado
Pagamento: não realizado
Pendência: verificar geração da cobrança

---

# O que o Bot pode fazer

Pode:

- explicar status
- verificar aprovação
- informar próxima etapa
- identificar inconsistência
- organizar handoff
- diferenciar aprovação de pagamento

---

# O que o Bot NÃO deve fazer

Não deve:

- aprovar pedido
- reprovar pedido
- inventar motivo
- inventar prazo
- gerar link manualmente
- considerar aprovado como pago
- considerar pago como faturado
- alterar cotação sem regra
- expor informações internas desnecessárias

---

# Regra final

Pedido em aberto não está aprovado.

Pedido aprovado não está pago.

Pedido pago não está faturado.

Pedido faturado não está necessariamente enviado.

O Bot deve sempre dizer exatamente em qual etapa o pedido está.