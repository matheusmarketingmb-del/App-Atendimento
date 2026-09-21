---
type: returns_refunds
topic: refund
brand: Mibro
source: https://mibrobrasil.com.br/policies/refund-policy
updated: 2026-09-18
---

# Trocas e Reembolso — Reembolso

## Objetivo

Este arquivo orienta o Bot sobre situações relacionadas a:

- reembolso
- estorno
- devolução de pagamento
- cancelamento com pagamento aprovado
- devolução de produto
- pedido não recebido
- produto com problema
- pagamento duplicado
- reembolso via PIX
- estorno em cartão

O Bot deve explicar o processo sem prometer:

- aprovação
- prazo
- valor
- forma final de devolução

quando essas informações ainda não estiverem confirmadas.

---

# Regra principal

Reembolso depende do motivo e da análise do caso.

O Bot NÃO deve dizer:

- "seu reembolso foi aprovado"
- "o dinheiro volta hoje"
- "vai cair em X dias"
- "vamos estornar"
- "você receberá o valor integral"

sem confirmação real do sistema ou da equipe responsável.

---

# Reembolso não é o mesmo que cancelamento

Cancelamento significa interromper ou encerrar um pedido.

Reembolso significa devolver um valor já pago.

Um pedido pode:

- ser cancelado antes de cobrança
- ser cancelado e depois reembolsado
- exigir devolução antes do reembolso
- ter reembolso parcial

Não tratar como a mesma etapa.

---

# Situações que podem gerar análise de reembolso

Exemplos:

- pedido cancelado após pagamento
- devolução aprovada
- produto devolvido
- pedido extraviado confirmado
- cobrança duplicada
- produto indisponível
- problema com entrega
- arrependimento de compra
- defeito com solução financeira aprovada

Esses exemplos não significam aprovação automática.

---

# Reembolso por PIX

Quando a compra foi paga por PIX:

a devolução deve seguir o processo financeiro oficial.

O Bot não deve pedir de forma improvisada:

- chave PIX
- senha
- código bancário
- token

Se o sistema já possui fluxo seguro:

seguir esse fluxo.

---

# PIX e dados bancários

Nunca pedir:

- senha bancária
- token
- código SMS
- acesso ao aplicativo bancário

Se houver necessidade de informação bancária adicional:

o processo deve ser conduzido por canal autorizado.

---

# Reembolso no cartão

Quando a compra foi feita no cartão:

a devolução pode ocorrer por estorno no meio de pagamento.

A visualização do crédito pode depender de:

- processador
- banco emissor
- fechamento da fatura
- regras da operadora

O Bot não deve inventar prazo exato.

---

# Fatura já fechada

Mesmo após estorno:

o valor pode aparecer de forma diferente conforme o banco e a fatura.

O Bot não deve dar explicação financeira definitiva sem dados do processador.

Pode orientar o cliente a acompanhar a fatura e, se necessário, verificar com o emissor do cartão.

---

# Parcelamento

Em compras parceladas:

a forma como o estorno aparece pode variar conforme a operadora.

Não afirmar automaticamente:

- todas as parcelas serão removidas de uma vez
- cada parcela será devolvida separadamente
- valor aparecerá na próxima fatura

sem confirmação.

---

# Pagamento duplicado

Se houver cobrança duplicada:

consultar:

05_Pedidos/pagamento.md

Não prometer estorno antes da confirmação da duplicidade.

---

# Pedido cancelado antes do envio

Se o pagamento já foi aprovado e o cancelamento for confirmado:

o caso pode seguir para reembolso.

Consultar:

05_Pedidos/cancelamento.md

Não considerar o reembolso concluído apenas porque o pedido foi cancelado.

---

# Pedido já enviado

Se o pedido foi enviado:

pode ser necessário:

- recusar entrega
- devolver o produto
- aguardar retorno
- passar por conferência

antes do reembolso.

---

# Pedido entregue

Se o cliente já recebeu:

o reembolso pode depender de devolução.

Não orientar o cliente a descartar ou ficar com o produto salvo se houver autorização explícita.

---

# Devolução

A devolução pode exigir:

- autorização
- orientação de postagem/coleta
- produto
- acessórios
- embalagem, quando aplicável
- documentação

Os requisitos exatos devem seguir a política e o caso específico.

---

# Produto precisa voltar?

Não responder automaticamente:

"Sim"

ou:

"Não."

Depende do motivo e da orientação da equipe.

---

# Produto com defeito

Se o cliente solicita dinheiro de volta por possível defeito:

primeiro pode ser necessária avaliação.

Consultar:

04_Garantia/garantia-geral.md

O Bot não deve transformar automaticamente uma reclamação técnica em reembolso.

---

# Troca ou reembolso

A decisão pode depender de:

- análise técnica
- disponibilidade
- política
- motivo da solicitação

O Bot não deve escolher sozinho entre:

- troca
- reparo
- reembolso

---

# Arrependimento

Solicitações de arrependimento devem seguir a política aplicável.

O Bot deve verificar:

- quando recebeu
- estado do pedido
- situação do produto

Não inventar prazo se não estiver consultando a política vigente.

---

# Produto aberto

Não negar automaticamente reembolso porque a embalagem foi aberta.

A situação precisa ser analisada conforme:

- motivo
- condição do produto
- política
- tipo de compra

---

# Produto usado

Não dizer automaticamente:

"produto usado não pode ser devolvido."

Encaminhar para análise conforme o caso.

---

# Produto incompleto

Se devolução chegar sem:

- acessórios
- itens
- componentes

isso pode afetar a análise.

O Bot não deve decidir sozinho o resultado.

---

# Produto danificado pelo cliente

Se houver dano físico:

registrar o contexto.

Não prometer reembolso.

Consultar:

04_Garantia/defeito-fisico.md

---

# Pedido extraviado

Somente depois de confirmação logística.

Consultar:

05_Pedidos/pedido-nao-recebido.md

Se o extravio for formalmente confirmado:

a equipe poderá definir solução.

O Bot não deve escolher sozinho.

---

# Pedido marcado como entregue

Não conceder reembolso automaticamente.

Primeiro deve haver investigação da entrega.

---

# Produto errado

Se o cliente recebeu produto diferente:

registrar:

- pedido
- produto comprado
- produto recebido
- estado da embalagem

Encaminhar para troca/devolução.

---

# Produto faltando

Pode haver:

- envio parcial
- erro de separação
- ocorrência logística

Verificar antes de falar em reembolso.

---

# Valor do reembolso

Não informar valor até confirmar:

- itens
- frete
- descontos
- cupons
- forma de pagamento
- devolução
- decisão financeira

---

# Frete

Não afirmar automaticamente se o frete será ou não reembolsado.

Isso depende:

- do motivo
- da política
- do tipo de devolução

---

# Cupom

Se a compra utilizou cupom:

não assumir que o cupom será:

- reativado
- devolvido
- transformado em saldo

sem confirmação.

---

# Desconto PIX

O valor de referência para qualquer reembolso deve ser o valor efetivamente pago/aprovado, conforme análise financeira.

Não calcular manualmente sem dados reais.

---

# Reembolso parcial

Pode existir em situações específicas.

Exemplos:

- apenas um item do pedido
- divergência de cobrança
- solução comercial autorizada

O Bot não pode criar reembolso parcial sozinho.

---

# Reembolso de pedido atacado

Pedidos B2B/atacado podem seguir fluxo diferente.

Podem envolver:

- comercial
- financeiro
- fiscal
- logística
- NF-e

Encaminhar para equipe responsável.

---

# NF-e e devolução

Uma devolução pode envolver procedimentos fiscais.

O Bot não deve orientar emissão/cancelamento fiscal de forma improvisada.

Consultar:

05_Pedidos/nota-fiscal.md

---

# Reembolso aprovado

Somente considerar aprovado quando houver confirmação real.

Depois disso, o Bot pode informar o status existente no sistema.

Não transformar "solicitação aberta" em "reembolso aprovado".

---

# Reembolso em processamento

Se estiver em processamento:

informar exatamente isso.

Não afirmar que já foi creditado.

---

# Reembolso concluído

Somente usar "concluído" quando houver confirmação do sistema/equipe.

Se o cliente ainda não visualizar:

pode ser necessário acompanhar com o meio de pagamento.

---

# Cliente quer comprovante de reembolso

Se houver comprovante ou identificador no sistema:

encaminhar ou fornecer conforme autorização.

Não inventar:

- NSU
- ID
- protocolo
- comprovante

---

# Reembolso não apareceu

Se consta concluído internamente, mas o cliente não recebeu:

coletar:

- pedido
- forma de pagamento
- data da conclusão
- valor confirmado

Encaminhar ao financeiro.

---

# Fraude / compra não reconhecida

Não tratar como reembolso comum.

Encaminhar para financeiro/segurança.

Não pedir dados completos do cartão.

---

# Exemplo — pedido cancelado

Cliente:

"Meu pedido foi cancelado. Quando vou receber?"

Bot:

"O cancelamento e o reembolso são etapas diferentes. Vou verificar se o reembolso já foi iniciado e qual é o status. O prazo pode variar conforme a forma de pagamento e só consigo confirmar com os dados do processo."

---

# Exemplo — cartão

Cliente:

"Quanto tempo demora o estorno?"

Bot:

"O prazo de visualização pode variar conforme o banco e o fechamento da fatura. Primeiro vou verificar se o estorno já foi efetivamente processado no seu pedido."

---

# Exemplo — PIX

Cliente:

"Paguei no PIX. Como recebo de volta?"

Bot:

"Se o reembolso for aprovado, a devolução precisa seguir o processo financeiro oficial. Não é necessário enviar senha, token ou qualquer código bancário pelo atendimento."

---

# Exemplo — produto com defeito

Cliente:

"Meu relógio deu problema, quero meu dinheiro de volta."

Bot:

"Primeiro precisamos registrar o problema e encaminhar para análise. Dependendo da avaliação e da situação da compra, a equipe define a solução aplicável, que pode envolver troca, outro atendimento ou reembolso."

---

# Quando encaminhar para humano

Encaminhar quando houver:

- solicitação de reembolso
- estorno não localizado
- cobrança duplicada
- devolução concluída
- pedido cancelado com pagamento
- produto devolvido
- extravio confirmado
- divergência de valor
- reembolso parcial
- pedido de atacado
- fraude
- dúvida financeira não documentada

---

# Informações úteis antes do handoff

Coletar ou obter pelo sistema:

- pedido
- motivo do reembolso
- forma de pagamento
- valor pago
- pedido cancelado?
- produto enviado?
- produto recebido?
- devolução realizada?
- reembolso já iniciado?
- status atual

---

# Resumo para humano

Exemplo:

Setor: Financeiro / Reembolso
Assunto: Reembolso após cancelamento
Pedido: #1234
Pagamento: PIX
Valor: conforme pedido
Cancelamento: confirmado
Despacho: não realizado
Reembolso: status não confirmado
Pendência: iniciar/verificar devolução financeira

---

# Exemplo de resumo — cartão

Setor: Financeiro / Reembolso
Assunto: Estorno não visualizado
Pedido: #1234
Pagamento: cartão de crédito
Reembolso interno: informado como concluído
Data: registrada no sistema
Cliente visualizou crédito: não
Pendência: verificar comprovante/status com processador

---

# O que o Bot pode fazer

Pode:

- explicar diferença entre cancelamento e reembolso
- consultar status real
- orientar segurança financeira
- organizar documentação
- explicar que cartão e PIX podem ter fluxos diferentes
- encaminhar

---

# O que o Bot NÃO deve fazer

Não deve:

- aprovar reembolso
- inventar prazo
- inventar valor
- prometer estorno
- pedir senha bancária
- pedir CVV
- pedir token
- escolher sozinho troca ou reembolso
- afirmar que devolução já foi recebida sem confirmação
- marcar reembolso como concluído sem evidência

---

# Regra final

O Bot informa o status real.

A equipe responsável decide a aprovação.

O sistema financeiro confirma a conclusão.