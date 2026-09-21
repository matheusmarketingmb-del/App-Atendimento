---
type: orders
topic: payment
brand: Mibro
updated: 2026-09-18
---

# Pedidos — Pagamento

## Objetivo

Este arquivo orienta o Bot sobre dúvidas relacionadas a:

- formas de pagamento
- PIX
- cartão
- parcelamento
- pagamento aprovado
- pagamento recusado
- pedido aguardando pagamento
- pagamento duplicado
- divergência de valor
- link de pagamento
- compra no varejo
- compra no atacado

O Bot deve explicar o processo, identificar o tipo de pedido e encaminhar quando necessário.

---

# Regra principal

Informações de pagamento podem variar conforme:

- canal de venda
- loja
- checkout
- meio de pagamento
- condição comercial
- campanha
- atacado ou varejo

O Bot NÃO deve inventar:

- taxa
- juros
- desconto
- número de parcelas
- prazo de compensação
- valor final

quando isso não estiver confirmado.

---

# Pedido no site oficial

Quando o cliente compra pelo site oficial:

o pagamento deve ser feito pelos meios disponíveis no checkout.

O Bot pode orientar o cliente a verificar:

- opções exibidas no checkout
- status do pedido
- confirmação recebida por e-mail
- comprovante de pagamento

Não inventar uma forma de pagamento que não apareça no checkout.

---

# PIX

Quando PIX estiver disponível no checkout:

o cliente deve seguir as instruções apresentadas no próprio pagamento.

O Bot não deve gerar manualmente:

- chave PIX
- QR Code
- código copia e cola

sem integração oficial.

Nunca pedir que o cliente envie PIX para uma chave não confirmada pelo sistema oficial.

---

# Desconto no PIX

Descontos de PIX podem existir conforme configuração comercial da loja.

O Bot não deve prometer percentual específico sem consulta atualizada.

Se perguntado:

"Tem desconto no PIX?"

responder de forma segura:

"O desconto pode variar conforme a condição comercial ativa no site. O valor final aparece no checkout antes da confirmação do pagamento."

---

# Cartão de crédito

O cliente pode utilizar cartão quando essa opção estiver disponível no checkout.

O Bot não deve pedir:

- número completo do cartão
- CVV
- senha
- código de autenticação

Esses dados devem ser inseridos apenas no ambiente seguro de pagamento.

---

# Parcelamento

A quantidade de parcelas e condições podem variar.

Não afirmar automaticamente:

- 10x
- sem juros
- com juros

sem consultar a condição vigente.

Quando houver ferramenta de consulta em tempo real:

usar os dados atuais do checkout.

---

# Pagamento recusado

Se o cartão for recusado:

o Bot pode orientar o cliente a:

1. conferir os dados inseridos;
2. verificar limite disponível;
3. tentar novamente;
4. consultar o banco/emissor;
5. testar outro meio de pagamento, se disponível.

Não afirmar o motivo exato da recusa.

A aprovação é feita pelo sistema financeiro/banco.

---

# PIX não reconhecido

Se o cliente pagou via PIX e o pedido não atualizou:

coletar:

- número do pedido
- horário aproximado do pagamento
- valor
- status exibido

Se houver comprovante:

a equipe humana pode solicitar.

Não pedir dados bancários desnecessários.

---

# Pagamento aprovado, pedido não atualiza

Se o pagamento foi aprovado, mas o pedido continua aguardando pagamento:

não orientar novo pagamento imediatamente.

Isso pode gerar duplicidade.

Encaminhar para análise do pedido.

---

# Pagamento duplicado

Se o cliente acredita que pagou duas vezes:

não prometer estorno imediato.

Coletar:

- número do pedido
- forma de pagamento
- valores
- datas/horários

Encaminhar para análise financeira.

---

# Cobrança duplicada no cartão

Uma segunda cobrança pode ser:

- tentativa
- pré-autorização
- lançamento pendente
- duplicidade real

O Bot não deve diagnosticar sozinho.

Orientar o cliente a verificar o extrato e encaminhar para análise.

---

# Divergência de valor

Se o cliente disser:

"O valor cobrado é diferente do site."

Verificar:

- produto
- quantidade
- frete
- desconto
- cupom
- parcelamento
- condição de pagamento

Não assumir erro imediatamente.

Se a diferença persistir:

encaminhar.

---

# Cupom

Se o cliente tentar usar cupom e não funcionar:

verificar:

- validade
- condições
- produtos elegíveis
- primeira compra, quando aplicável
- uso anterior
- valor mínimo, quando aplicável

Não inventar regra de cupom.

---

# Cupom não acumulativo

Alguns cupons podem não acumular com:

- promoções
- outros cupons
- desconto PIX
- condições comerciais

Não afirmar sem regra oficial.

---

# Pedido aguardando pagamento

Se o pedido estiver aguardando pagamento:

confirmar qual meio foi escolhido.

## PIX

Pode estar aguardando compensação/identificação.

## Cartão

Pode estar aguardando autorização.

## Link de pagamento

Pode ainda não ter sido concluído.

Não cancelar automaticamente.

---

# Link de pagamento

Em alguns fluxos, especialmente atacado, o pagamento pode ocorrer por link gerado após aprovação.

O Bot não deve criar link manualmente sem integração oficial.

---

# Atacado

No fluxo de atacado:

o pedido pode ficar inicialmente como:

Em aberto

Depois pode passar por:

- aprovação interna
- geração de link de pagamento
- pagamento
- emissão
- faturamento/envio

O Bot deve diferenciar atacado de compra normal no site.

---

# Aprovação interna no atacado

Se o cliente de atacado perguntar:

"Por que ainda não recebi o link?"

pode ser porque o pedido ainda está aguardando aprovação.

Não prometer prazo específico sem confirmação.

---

# Pedido aprovado no atacado

Após aprovação, o sistema responsável pode gerar o link de pagamento.

Se o link não chegar:

encaminhar para equipe comercial/financeira.

---

# Pagamento no atacado

O Bot não deve alterar:

- preço
- desconto
- imposto
- condição comercial
- prazo

sem autorização.

---

# CNPJ

Em pedidos de atacado, dados de CNPJ podem ser necessários no processo comercial/fiscal.

Coletar apenas pelo fluxo autorizado.

Não pedir dados desnecessários em chat aberto.

---

# Pagamento por boleto

Não afirmar que existe boleto sem confirmar que essa opção está disponível.

Se o checkout não mostrar:

não prometer.

---

# Transferência bancária

Não oferecer transferência direta sem processo oficial.

Evitar compartilhar dados bancários manualmente.

---

# Segurança

O Bot nunca deve pedir:

- senha bancária
- senha do cartão
- CVV
- token bancário
- código 2FA
- código SMS do banco

---

# Fraude

Se houver suspeita de fraude ou cobrança desconhecida:

não tentar investigar de forma improvisada.

Encaminhar para atendimento humano/financeiro.

---

# Pedido não encontrado

Se o cliente pagou, mas o pedido não aparece:

coletar:

- e-mail utilizado
- número do pedido, se houver
- data aproximada
- valor aproximado

Não pedir dados completos de cartão.

---

# Pagamento em análise

Se o sistema mostrar:

"Em análise"

explicar que a confirmação ainda não foi concluída.

Não prometer aprovação.

---

# Cancelamento antes da confirmação

Se o cliente deseja cancelar e o pagamento ainda está em processamento:

encaminhar para análise do pedido.

Não dizer que "é só não pagar" se já existe transação em andamento.

---

# Reembolso

Pagamento e reembolso são processos diferentes.

Para reembolso, consultar:

06_Trocas_Reembolso/reembolso.md

---

# Estorno no cartão

Não informar prazo específico de estorno sem política/processador confirmado.

O prazo pode depender:

- adquirente
- banco
- fechamento da fatura

Encaminhar quando necessário.

---

# Devolução via PIX

Não prometer devolução imediata.

O reembolso deve seguir o processo oficial.

---

# Exemplo — PIX pago e pedido pendente

Cliente:

"Paguei o PIX e ainda aparece aguardando pagamento."

Bot:

"Não faça um segundo pagamento. Me informe o número do pedido e o horário aproximado do PIX para eu encaminhar a conferência."

---

# Exemplo — cartão recusado

Cliente:

"Meu cartão foi recusado."

Bot:

"A recusa é feita pelo sistema financeiro/banco e nem sempre recebemos o motivo específico. Vale conferir os dados, limite e, se necessário, tentar outro meio de pagamento disponível no checkout."

---

# Exemplo — cobrança duplicada

Cliente:

"Apareceram duas cobranças."

Bot:

"Não faça uma nova tentativa de pagamento. Me passe o número do pedido e os valores/horários das cobranças para a equipe conferir se houve duplicidade ou uma autorização pendente."

---

# Quando encaminhar para humano

Encaminhar quando houver:

- PIX pago e não reconhecido
- pagamento duplicado
- cobrança desconhecida
- pedido aprovado sem atualização
- divergência de valor
- problema com link de pagamento
- atacado aguardando aprovação/link
- estorno
- suspeita de fraude
- erro recorrente no checkout
- comportamento não documentado

---

# Informações úteis antes do handoff

Coletar somente o necessário:

- número do pedido
- meio de pagamento
- valor
- horário aproximado
- status exibido
- cliente possui comprovante?
- atacado ou varejo

---

# Resumo para humano

Exemplo:

Setor: Financeiro / Pedidos
Assunto: PIX não reconhecido
Pedido: #1234
Pagamento: PIX
Valor: informado pelo cliente
Horário: aproximadamente 14:30
Status: aguardando pagamento
Comprovante: disponível
Pendência: conferência financeira

---

# O que o Bot pode fazer

Pode:

- explicar fluxo
- orientar segurança
- diferenciar PIX/cartão/atacado
- evitar pagamento duplicado
- coletar dados do pedido
- encaminhar

---

# O que o Bot NÃO deve fazer

Não deve:

- pedir dados completos do cartão
- pedir senha
- pedir CVV
- pedir código bancário
- gerar chave PIX manualmente
- prometer aprovação
- prometer estorno
- inventar taxas
- inventar parcelamento
- alterar condição comercial

---

# Regra final

Se existir qualquer risco de cobrança duplicada:

orientar o cliente a NÃO pagar novamente até a conferência.