---
type: orders
topic: cancellation
brand: Mibro
updated: 2026-09-18
---

# Pedidos — Cancelamento

## Objetivo

Este arquivo orienta o Bot sobre dúvidas relacionadas a:

- cancelamento de pedido
- cancelamento antes do envio
- cancelamento após faturamento
- cancelamento após emissão de NF-e
- cancelamento após despacho
- pedido em trânsito
- pagamento aprovado
- pedido ainda não pago
- devolução
- reembolso

O Bot deve primeiro identificar em qual etapa o pedido está.

---

# Regra principal

O cancelamento depende do status real do pedido.

Antes de orientar, verificar se o pedido está:

- aguardando pagamento
- pagamento aprovado
- em preparação
- faturado
- com NF-e emitida
- enviado
- em trânsito
- entregue

O Bot NÃO deve prometer cancelamento antes de confirmar o status.

---

# Pedido aguardando pagamento

Se o pedido ainda não foi pago:

pode não haver necessidade de processo financeiro de estorno.

Mesmo assim:

não assumir automaticamente que o pedido será cancelado sozinho.

Se o cliente deseja cancelar formalmente:

registrar a solicitação.

---

# PIX ainda não pago

Se o PIX não foi concluído:

não orientar pagamento.

O cliente pode solicitar cancelamento do pedido.

Não gerar novo PIX desnecessariamente.

---

# Cartão ainda em análise

Se o cartão ainda estiver em análise:

o Bot não deve dizer:

"é só cancelar no banco"

ou:

"o pedido já está cancelado".

Encaminhar conforme o status real.

---

# Pagamento aprovado

Se o pagamento já foi aprovado:

o cancelamento pode envolver:

- interrupção da preparação
- cancelamento do pedido
- eventual processo de estorno/reembolso

Não prometer que será imediato.

---

# Pedido em preparação

Se ainda não foi despachado:

pode existir possibilidade de cancelamento antes do envio.

O Bot deve encaminhar rapidamente.

Resposta recomendada:

"Seu pedido ainda está em preparação, então vou encaminhar a solicitação de cancelamento o quanto antes. A confirmação depende da equipe verificar se ele ainda não entrou na etapa de despacho."

---

# Pedido faturado

Faturamento não significa necessariamente despacho.

Se o pedido foi faturado:

a equipe ainda precisa verificar se é possível interromper o envio.

Não afirmar que o cancelamento é impossível.

---

# NF-e emitida

NF-e emitida também não significa necessariamente que o produto já saiu.

Pode ainda ser possível interromper o fluxo, dependendo da operação.

A equipe deve verificar:

- situação fiscal
- status logístico
- despacho

Não prometer cancelamento da NF-e.

---

# Pedido já enviado

Se o pedido já foi despachado:

pode não ser possível cancelar logisticamente antes da entrega.

Nesse caso:

o processo pode passar a ser de:

- recusa da entrega
- devolução
- direito de arrependimento
- reembolso

conforme a situação e política aplicável.

---

# Pedido em trânsito

Se está em trânsito:

não prometer bloqueio da transportadora.

O Bot pode informar:

"Como o pedido já está com a transportadora, a equipe precisa verificar o procedimento aplicável. Dependendo do caso, pode ser necessário aguardar ou recusar a entrega."

---

# Recusar a entrega

Se a equipe/política orientar recusa:

o produto poderá retornar ao remetente.

Não afirmar que reembolso ocorre imediatamente após a recusa.

Primeiro pode ser necessário confirmar o retorno.

---

# Pedido entregue

Se o produto já foi entregue:

a solicitação deixa de ser um simples cancelamento antes do envio.

Pode entrar em fluxo de:

- devolução
- arrependimento
- troca
- reembolso

Consultar:

06_Trocas_Reembolso/reembolso.md

e os demais arquivos do bloco de trocas/devoluções.

---

# Direito de arrependimento

Compras online podem estar sujeitas ao direito de arrependimento conforme legislação e política aplicável.

O Bot não deve inventar:

- prazo
- condição
- procedimento

sem consultar a política oficial correspondente.

Quando aplicável:

encaminhar para fluxo de devolução/reembolso.

---

# Produto aberto

Não decidir sozinho se um produto aberto pode ou não ser devolvido.

A equipe deve considerar:

- motivo
- condição
- política
- prazo
- tipo de produto

---

# Produto usado

Mesma regra.

Não responder automaticamente:

"não pode devolver porque usou."

Encaminhar para análise conforme a política.

---

# Cancelamento por arrependimento

Se o cliente simplesmente mudou de ideia:

identificar:

- pedido foi enviado?
- pedido foi entregue?
- quando recebeu?
- produto foi aberto/usado?

Não transformar em interrogatório.

Coletar o necessário e encaminhar.

---

# Cancelamento por atraso

Se o cliente quer cancelar porque o pedido está atrasado:

verificar primeiro:

- previsão
- última movimentação
- status logístico

Consultar:

05_Pedidos/rastreamento.md

Se houver atraso confirmado:

encaminhar para logística/comercial avaliar cancelamento, reenvio ou outra solução.

---

# Cancelamento por produto indisponível

Se a operação não conseguir atender o pedido:

não inventar solução.

A equipe pode avaliar:

- cancelamento
- substituição
- reembolso

conforme disponibilidade e autorização.

---

# Cancelamento de parte do pedido

Se o cliente quer cancelar apenas um item:

não prometer.

Pode depender de:

- status
- faturamento
- expedição
- composição da NF-e

Encaminhar.

---

# Pedido com vários produtos

Se alguns itens já foram enviados e outros não:

o cancelamento pode precisar ser parcial.

Não tratar como um único status sem consultar o pedido.

---

# Pedido duplicado

Se o cliente fez dois pedidos por engano:

identificar:

- números dos pedidos
- quais foram pagos
- quais foram enviados

Encaminhar rapidamente para evitar despacho do pedido duplicado.

---

# Pagamento duplicado não é o mesmo que pedido duplicado

Separar:

## Pedido duplicado

Existem dois pedidos.

## Pagamento duplicado

Pode existir apenas um pedido com duas cobranças.

Consultar também:

05_Pedidos/pagamento.md

---

# Cancelamento no cartão

Se houver cancelamento aprovado:

o valor pode seguir processo de estorno.

O prazo de visualização pode depender do banco/emissor.

Não inventar prazo exato.

---

# Cancelamento no PIX

Se o pagamento PIX já foi confirmado:

a devolução deve seguir processo oficial de reembolso.

Não pedir chave PIX de forma improvisada se o sistema já possui meio seguro para isso.

---

# Pedido não pago

Se não houve cobrança:

não falar em "estorno".

Pode existir apenas cancelamento do pedido.

---

# Reembolso

Cancelamento e reembolso são etapas diferentes.

Exemplo:

Pedido cancelado no sistema não significa necessariamente que o dinheiro já voltou naquele instante.

Consultar:

06_Trocas_Reembolso/reembolso.md

---

# Pedido de atacado

Pedidos de atacado possuem fluxo diferente.

Podem estar em:

- aberto
- aguardando aprovação
- aguardando pagamento
- faturamento
- expedição

Se o cliente de atacado pedir cancelamento:

encaminhar para comercial antes de qualquer promessa.

---

# Pedido de atacado ainda em aberto

Pode ser mais simples interromper antes da aprovação/pagamento.

Mesmo assim:

registrar solicitação e encaminhar.

---

# Pedido de atacado pago

Pode envolver:

- aprovação
- faturamento
- NF-e
- logística
- financeiro

Encaminhar para comercial/financeiro.

---

# Produto em lançamento ou pré-venda

Se existir pedido válido de pré-venda:

o cancelamento deve seguir a condição comercial/política informada na compra.

Não inventar regra específica.

---

# Alteração em vez de cancelamento

Se o cliente quer cancelar porque:

- colocou endereço errado
- escolheu cor errada
- escolheu modelo errado

pode ser possível que ele queira apenas alteração.

Antes de cancelar, entender o objetivo.

Não prometer troca de item/endereço dentro do pedido.

---

# Endereço errado

Consultar:

05_Pedidos/envio.md

Se ainda não foi despachado:

encaminhar com urgência.

---

# Modelo/cor errada

Se o cliente selecionou produto incorreto:

a equipe deve verificar se o pedido ainda pode ser alterado.

Se não puder:

pode ser necessário cancelar e refazer.

Não orientar nova compra antes de confirmar, para evitar duplicidade.

---

# Cliente quer comprar novamente

Se ainda existe pedido pago ativo:

evitar recomendar nova compra antes de resolver o anterior, quando isso puder gerar cobrança duplicada.

---

# Fraude / compra não reconhecida

Se o cliente diz:

"Não fui eu que fiz essa compra."

priorizar segurança.

Coletar apenas:

- número do pedido, se houver
- e-mail
- informação de que não reconhece

Não pedir dados completos de cartão.

Encaminhar para financeiro/segurança.

---

# Exemplo — pedido em preparação

Cliente:

"Quero cancelar minha compra."

Bot:

"Vou verificar em qual etapa o pedido está. Se ainda não tiver sido despachado, encaminho a solicitação para tentar interromper o envio."

---

# Exemplo — já enviado

Cliente:

"Quero cancelar, mas já está com a transportadora."

Bot:

"Como o pedido já foi despachado, normalmente não é possível tratar como um cancelamento simples antes do envio. Vou encaminhar para a equipe verificar se o procedimento será recusa da entrega ou devolução após o recebimento."

---

# Exemplo — NF-e emitida

Cliente:

"Já emitiram a nota, então não posso cancelar?"

Bot:

"A emissão da NF-e não significa necessariamente que o pedido já foi enviado. A equipe precisa verificar o status logístico e fiscal antes de confirmar se ainda é possível interromper o pedido."

---

# Exemplo — pedido duplicado

Cliente:

"Comprei duas vezes sem querer."

Bot:

"Não faça outro pagamento ou pedido agora. Me passe os dois números dos pedidos para a equipe verificar qual ainda pode ser cancelado antes do envio."

---

# Quando encaminhar para humano

Encaminhar quando houver:

- solicitação de cancelamento
- pagamento já aprovado
- pedido em preparação
- NF-e emitida
- pedido enviado
- pedido duplicado
- cancelamento parcial
- fraude/compra não reconhecida
- pedido de atacado
- cliente solicita estorno
- situação não documentada

---

# Informações úteis antes do handoff

Coletar ou obter no sistema:

- número do pedido
- status
- pagamento confirmado?
- NF-e emitida?
- pedido despachado?
- motivo do cancelamento
- cancelamento total ou parcial
- atacado ou varejo

---

# Resumo para humano

Exemplo:

Setor: Pedidos / Financeiro
Assunto: Cancelamento
Pedido: #1234
Status: em preparação
Pagamento: aprovado
NF-e: não emitida
Despacho: não
Motivo: cliente desistiu da compra
Tipo: cancelamento total
Pendência: verificar interrupção antes da expedição e processo financeiro

---

# O que o Bot pode fazer

Pode:

- identificar etapa do pedido
- registrar solicitação
- diferenciar cancelamento e devolução
- evitar compra/pagamento duplicado
- encaminhar rapidamente
- explicar que estorno é etapa separada

---

# O que o Bot NÃO deve fazer

Não deve:

- garantir cancelamento
- garantir estorno
- afirmar que NF-e impede cancelamento
- prometer bloqueio da transportadora
- inventar prazo de reembolso
- mandar cliente comprar novamente antes de resolver possível duplicidade
- cancelar pedido por conta própria sem ferramenta/autorização

---

# Regra final

Antes do despacho:

tentar interromper rapidamente.

Depois do despacho:

o caso pode virar recusa/devolução.

Depois da entrega:

seguir o fluxo de trocas e reembolso.