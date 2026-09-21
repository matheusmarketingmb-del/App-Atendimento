---
type: policy
topic: refund_policy
brand: Mibro
source: https://mibrobrasil.com.br/policies/refund-policy
updated: 2026-09-18
---

# Política — Reembolso e Devolução

## Objetivo

Este arquivo serve como referência oficial para o Bot em dúvidas relacionadas a:

- reembolso
- devolução
- arrependimento
- troca
- cancelamento após pagamento
- estorno
- produto devolvido
- produto com defeito
- produto incorreto
- avaria
- pedido não recebido

Para fluxos operacionais, consultar também:

- `06_Trocas_Reembolso/reembolso.md`
- `06_Trocas_Reembolso/troca.md`
- `06_Trocas_Reembolso/devolucao.md`
- `06_Trocas_Reembolso/arrependimento.md`
- `05_Pedidos/cancelamento.md`

---

# Regra principal

A política define condições gerais.

A equipe responsável analisa cada caso.

O Bot NÃO deve:

- aprovar reembolso sozinho
- negar reembolso definitivamente
- prometer troca
- prometer estorno
- inventar prazo
- inventar valor
- inventar logística reversa

---

# Cancelamento e reembolso são diferentes

Cancelamento encerra ou interrompe um pedido.

Reembolso devolve um valor já pago.

Um pedido cancelado pode ainda estar:

- aguardando estorno
- aguardando processamento financeiro
- aguardando devolução

Não tratar as duas etapas como equivalentes.

---

# Pedido não enviado

Quando o cliente solicita cancelamento antes do despacho:

pode ser possível interromper o envio.

Se o pagamento já foi confirmado:

pode existir processo financeiro posterior.

Não prometer cancelamento até consultar o status real.

---

# Pedido já enviado

Depois do despacho:

o fluxo pode depender de:

- recusa da entrega
- devolução
- retorno ao remetente
- análise do caso

Não prometer bloqueio da transportadora.

---

# Produto já recebido

Quando o cliente já está com o produto:

a solicitação pode seguir como:

- devolução
- arrependimento
- troca
- garantia

dependendo do motivo.

---

# Arrependimento

Solicitações de desistência da compra devem seguir a política vigente.

O Bot deve considerar informações como:

- data da compra
- data de recebimento
- data da solicitação
- condição do produto

Não inventar prazo ou condição não registrada na política oficial.

---

# Produto aberto

A abertura da embalagem não deve gerar resposta automática de recusa.

A equipe precisa considerar:

- motivo
- estado do produto
- política aplicável

---

# Produto utilizado

O uso também não deve gerar resposta automática sem análise.

Registrar a condição real.

---

# Devolução

Uma devolução pode envolver:

- autorização
- logística reversa
- postagem
- transporte
- recebimento
- conferência

Essas etapas devem ser tratadas separadamente.

---

# Postado não significa recebido

Quando o cliente posta o produto:

isso apenas inicia o retorno.

Não considerar:

- recebido
- conferido
- reembolso aprovado

automaticamente.

---

# Recebido não significa reembolsado

Depois do retorno:

pode existir conferência.

Somente após as etapas aplicáveis o processo financeiro pode avançar.

---

# Logística reversa

Quando houver devolução autorizada:

usar apenas:

- código real
- etiqueta real
- transportadora real
- orientação oficial

Nunca inventar dados de postagem.

---

# Produto com defeito

Possível defeito deve seguir análise técnica.

Consultar:

`04_Garantia/garantia-geral.md`

O Bot não deve transformar automaticamente defeito em reembolso.

---

# Troca ou reembolso

A solução pode depender de:

- análise
- motivo
- disponibilidade
- política
- situação do pedido

O Bot não escolhe sozinho.

---

# Produto incorreto

Se o cliente recebeu item diferente:

registrar como divergência.

Consultar:

`06_Trocas_Reembolso/troca.md`

Não tratar como simples arrependimento.

---

# Produto avariado

Se o produto chegou:

- quebrado
- trincado
- amassado
- danificado

orientar preservação da embalagem e registro do estado.

Encaminhar.

---

# Pedido não recebido

Antes de falar em reembolso:

investigar:

- rastreamento
- previsão
- comprovante de entrega
- possível extravio

Consultar:

`05_Pedidos/pedido-nao-recebido.md`

---

# Extravio

Somente considerar extravio confirmado depois de validação logística.

Depois disso:

a equipe pode definir solução aplicável.

Não prometer automaticamente:

- reenvio
- reembolso

---

# Pagamento duplicado

Se houver suspeita de cobrança duplicada:

consultar:

`05_Pedidos/pagamento.md`

Confirmar a duplicidade antes de tratar como estorno.

---

# PIX

Reembolso de PIX deve seguir o processo financeiro oficial.

O Bot nunca deve pedir:

- senha
- token
- código SMS
- acesso ao banco

---

# Cartão

Estorno no cartão pode depender de:

- processador
- banco
- fechamento de fatura

Não informar prazo exato sem confirmação.

---

# Parcelamento

A forma como um estorno aparece em compra parcelada pode variar.

Não afirmar automaticamente como as parcelas serão exibidas.

---

# Valor do reembolso

O valor só deve ser informado quando houver dados reais.

Pode depender de:

- itens
- descontos
- cupons
- frete
- pagamento
- devolução
- análise

Não calcular manualmente quando o sistema já possui o valor.

---

# Reembolso parcial

Pode existir em situações específicas.

O Bot não deve criar ou aprovar valor parcial sozinho.

---

# Frete

Não afirmar automaticamente se o frete será:

- devolvido
- retido
- cobrado novamente

Isso depende da política e do motivo.

---

# Cupom

Não prometer:

- reativação
- restituição
- novo cupom

sem regra específica.

---

# Reembolso aprovado

Somente considerar aprovado quando houver confirmação real.

Solicitação aberta != aprovação.

---

# Reembolso em processamento

Se o sistema indicar:

"em processamento"

informar exatamente isso.

Não dizer que já foi creditado.

---

# Reembolso concluído

Somente considerar concluído quando houver confirmação.

Se o cliente ainda não visualizar:

encaminhar para financeiro quando necessário.

---

# Comprovante de reembolso

Se existir:

usar apenas o comprovante real.

Não inventar:

- protocolo
- NSU
- código
- identificador

---

# Compra em marketplace

O fluxo pode depender do vendedor/canal.

Não assumir que todo marketplace segue exatamente o mesmo processo da loja oficial.

---

# Compra em revendedor autorizado

Pode existir fluxo compartilhado com o revendedor.

Encaminhar conforme o canal de origem.

---

# Importação direta

A política da Mibro Brasil pode não se aplicar da mesma forma a compras realizadas fora dos canais oficiais brasileiros.

Consultar:

`04_Garantia/exclusoes-garantia.md`

---

# Atacado

Pedidos B2B podem seguir regras comerciais e fiscais diferentes.

Não aplicar automaticamente o mesmo fluxo do varejo.

Consultar:

`08_Atacado_Revenda`

---

# Comunicação recomendada

Evitar:

"Seu dinheiro vai voltar em X dias."

Preferir:

"Vou verificar se o reembolso já foi aprovado e em qual etapa ele está."

---

# Exemplo — pedido cancelado

Cliente:

"Meu pedido foi cancelado. Já vou receber?"

Bot:

"O cancelamento e o reembolso são etapas diferentes. Vou verificar se a devolução financeira já foi iniciada e qual é o status atual."

---

# Exemplo — produto devolvido

Cliente:

"Já mandei o relógio de volta."

Bot:

"A postagem inicia a devolução. Ainda precisamos acompanhar o retorno, o recebimento e a conferência antes de confirmar a próxima etapa financeira."

---

# Exemplo — cartão

Cliente:

"Quando aparece o estorno?"

Bot:

"Isso pode variar conforme o banco e o fechamento da fatura. Primeiro preciso verificar se o estorno já foi processado no seu pedido."

---

# Exemplo — defeito

Cliente:

"Meu relógio deu defeito e quero reembolso."

Bot:

"Primeiro precisamos registrar e analisar o problema. Depois da avaliação, a equipe define a solução aplicável conforme a política."

---

# Quando encaminhar

Encaminhar quando houver:

- solicitação de reembolso
- devolução em andamento
- estorno não localizado
- pagamento duplicado
- produto com defeito
- avaria
- produto incorreto
- extravio confirmado
- divergência de valor
- caso de atacado
- situação fora do fluxo documentado

---

# O que o Bot pode fazer

Pode:

- explicar a política
- consultar status
- diferenciar cancelamento e reembolso
- explicar etapas de devolução
- orientar segurança financeira
- encaminhar casos

---

# O que o Bot NÃO deve fazer

Não deve:

- aprovar reembolso sozinho
- negar definitivamente
- inventar prazo
- inventar valor
- inventar logística reversa
- prometer troca
- pedir dados bancários sensíveis
- considerar devolução como reembolso concluído

---

# Regra final

Solicitação não é aprovação.

Postagem não é recebimento.

Recebimento não é conferência.

Conferência não é reembolso concluído.

O Bot deve sempre informar a etapa real do processo.