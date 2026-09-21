---
type: wholesale
topic: wholesale_payment
brand: Mibro
updated: 2026-09-18
---

# Atacado e Revenda — Pagamento

## Objetivo

Este arquivo orienta o Bot sobre a etapa de pagamento dos pedidos de atacado.

O fluxo pode envolver:

- pedido aprovado
- geração de link de pagamento
- envio do link ao cliente
- pagamento
- confirmação financeira
- faturamento
- emissão de NF-e
- envio

O Bot deve sempre diferenciar:

- pedido aprovado
- link gerado
- pagamento iniciado
- pagamento confirmado
- faturamento

Essas etapas não são equivalentes.

---

# Regra principal

O Bot NÃO deve:

- inventar link de pagamento
- gerar cobrança fora do sistema oficial
- afirmar pagamento sem confirmação
- considerar pedido aprovado como pago
- prometer faturamento imediatamente após pagamento
- alterar condição comercial
- pedir senha, CVV, token ou código bancário

---

# Fluxo geral

Fluxo esperado:

1. cotação aprovada;
2. pedido criado/aprovado;
3. link de pagamento gerado;
4. link enviado ao cliente;
5. cliente realiza pagamento;
6. sistema confirma pagamento;
7. pedido segue para faturamento;
8. NF-e é emitida;
9. pedido segue para expedição.

O Bot deve informar sempre a etapa real.

---

# Pedido aprovado

Pedido aprovado significa que a condição comercial foi liberada para seguir.

Isso NÃO significa:

- link já gerado
- cliente já pagou
- NF-e emitida
- pedido enviado

---

# Link de pagamento

O link deve ser gerado pelo sistema oficial.

O Bot nunca deve:

- montar URL manualmente
- inventar cobrança
- enviar chave PIX improvisada
- redirecionar para conta bancária não autorizada

---

# Link ainda não gerado

Se o pedido já está aprovado, mas o link não existe:

verificar:

- status do pedido
- integração
- geração da cobrança
- eventual erro operacional

Se necessário:

encaminhar para comercial/financeiro.

---

# Cliente pergunta pelo link

Resposta recomendada:

"Seu pedido já foi aprovado. Vou verificar se o link de pagamento já foi gerado. Se ainda não estiver disponível, encaminho essa etapa para a equipe responsável."

---

# Link gerado

Quando houver link real:

o Bot pode informar que ele está disponível.

Não alterar o conteúdo do link.

---

# Link expirado

Se o cliente informar que o link expirou:

não gerar outro manualmente.

Encaminhar para criação de nova cobrança pelo fluxo oficial.

---

# Link não abre

Se houver erro:

coletar:

- número do pedido
- mensagem apresentada
- dispositivo/navegador, quando relevante
- horário aproximado

Encaminhar se necessário.

---

# Link incorreto

Se o link abrir valor ou pedido diferente:

não orientar pagamento.

Encaminhar imediatamente.

---

# Valor do link

O valor deve corresponder ao pedido aprovado.

Se houver divergência:

não pedir que o cliente pague mesmo assim.

Verificar:

- produtos
- quantidade
- desconto
- impostos
- frete
- total aprovado

---

# Valor diferente da cotação

Se o link tiver valor diferente:

não afirmar automaticamente erro.

Pode existir diferença por:

- ajuste aprovado
- imposto
- frete
- alteração de pedido

Mas a divergência precisa ser explicada antes do pagamento.

---

# Forma de pagamento

As formas disponíveis dependem do sistema de cobrança utilizado.

O Bot deve consultar o que estiver realmente disponível.

Não inventar:

- boleto
- PIX
- cartão
- parcelamento

se não estiverem no link oficial.

---

# PIX

Se o link disponibilizar PIX:

o cliente deve utilizar o fluxo oficial da cobrança.

Não criar chave PIX manual.

---

# Cartão

Se cartão estiver disponível:

o cliente deve inserir os dados diretamente no ambiente seguro.

O Bot nunca deve pedir:

- número completo
- CVV
- senha
- token
- código de autenticação

---

# Parcelamento

As condições de parcelamento podem variar.

Não prometer quantidade de parcelas ou juros sem consultar o link/sistema.

---

# Pagamento iniciado

Pagamento iniciado não significa pagamento confirmado.

Pode existir status como:

- aguardando
- em análise
- processando

Não avançar para faturamento apenas porque o cliente diz que pagou.

---

# Cliente diz que já pagou

Verificar a confirmação real do sistema.

Se ainda não constar:

não pedir pagamento novamente imediatamente.

Pode haver atraso de conciliação.

---

# Pagamento não reconhecido

Se o cliente afirma ter pago, mas o sistema não atualizou:

coletar:

- pedido
- valor
- forma de pagamento
- horário aproximado
- comprovante disponível?

Encaminhar para financeiro.

---

# Comprovante

Pode ser solicitado pela equipe quando necessário.

O Bot não deve tratar o comprovante sozinho como prova definitiva de liquidação se o sistema ainda não confirmou.

---

# Pagamento duplicado

Se o cliente acredita que pagou duas vezes:

não criar nova cobrança.

Registrar:

- pedido
- valores
- horários
- meios de pagamento

Encaminhar imediatamente ao financeiro.

---

# Cartão recusado

Se houver recusa:

o Bot pode orientar:

- conferir dados
- verificar limite
- tentar outro meio disponível
- consultar o banco emissor

Não afirmar o motivo exato da recusa.

---

# PIX vencido

Se o PIX do link expirar:

não reutilizar código vencido.

Encaminhar ou gerar nova cobrança apenas pelo fluxo autorizado.

---

# Pedido aguardando pagamento

Se o link existe, mas o cliente ainda não pagou:

status deve continuar como aguardando pagamento.

Não considerar faturado.

---

# Pagamento confirmado

Somente quando o sistema confirmar.

Depois disso:

o pedido pode seguir para faturamento.

---

# Pagamento confirmado não significa faturado

Separar:

## Pago

Transação confirmada.

## Em faturamento

Pedido sendo processado fiscalmente.

## Faturado

NF-e/processo fiscal concluído.

## Enviado

Produto despachado.

---

# Pagamento e estoque

Pagamento confirmado não deve levar o Bot a prometer despacho imediato.

Ainda podem existir etapas:

- faturamento
- separação
- logística

---

# Pagamento e NF-e

A NF-e pode ser emitida após confirmação financeira conforme o fluxo.

Não dizer:

"Pagou, então a nota já foi emitida."

sem confirmação.

---

# Pagamento e impostos

O valor fiscal definitivo pode depender do faturamento.

Se a cotação utilizou impostos estimados:

não tratar estimativa como resultado fiscal final antes da emissão.

---

# Pagamento e frete

Se o frete não estava incluído:

a equipe precisa garantir que a cobrança final esteja correta.

O Bot não deve acrescentar valor manualmente.

---

# Alteração depois do pagamento

Se o cliente quiser alterar:

- produto
- quantidade
- endereço
- CNPJ
- condição

depois do pagamento:

encaminhar imediatamente.

Pode ser necessário:

- ajuste fiscal
- cancelamento
- nova cotação
- reembolso parcial/total

Não alterar sozinho.

---

# Cancelamento depois do pagamento

Pode envolver financeiro e faturamento.

Não prometer estorno imediato.

Consultar também:

06_Trocas_Reembolso/reembolso.md

---

# Reembolso de atacado

Pedidos B2B podem seguir fluxo diferente do varejo.

Encaminhar para:

- comercial
- financeiro
- fiscal

Não aplicar automaticamente regras de varejo.

---

# Pagamento parcial

Se o sistema suportar pagamento parcial:

usar apenas quando houver regra oficial.

Não criar sinal/entrada por conta própria.

---

# Prazo de pagamento

Não inventar prazo de validade da cobrança.

Usar apenas o prazo configurado no link/sistema.

---

# Pedido sem pagamento

Não seguir para faturamento se a operação exigir pagamento prévio.

O Bot deve respeitar o status real.

---

# Cliente quer pagar por outro meio

Se o meio desejado não aparece:

não oferecer alternativa informal.

Encaminhar para comercial/financeiro avaliar.

---

# Cliente quer transferência bancária

Não enviar dados bancários manualmente sem processo oficial.

---

# Cliente quer pagar direto para vendedor

Não permitir fluxo informal.

Pagamento deve seguir o canal oficial da empresa.

---

# Segurança

Nunca solicitar:

- senha
- CVV
- código SMS
- token
- acesso bancário
- print contendo dados sensíveis completos

---

# Fraude / cobrança suspeita

Se o cliente não reconhece cobrança ou link:

não pedir pagamento.

Encaminhar para verificação de segurança/financeiro.

---

# Link enviado por terceiro

Se o cliente recebeu link diferente do canal oficial:

não validar automaticamente.

Encaminhar para confirmar autenticidade.

---

# Exemplo — aprovado sem link

Cliente:

"Meu pedido foi aprovado, mas ainda não recebi o pagamento."

Bot:

"A aprovação é uma etapa anterior. Vou verificar se o link de pagamento já foi gerado. Se ainda não estiver disponível, encaminho para a equipe responsável."

---

# Exemplo — já pagou

Cliente:

"Já paguei."

Bot:

"Vou verificar se o pagamento já foi confirmado no sistema. Assim que essa etapa constar como concluída, o pedido pode seguir para faturamento."

---

# Exemplo — comprovante

Cliente:

"Tenho o comprovante, mas continua como pendente."

Bot:

"Não faça um novo pagamento. Vou registrar que você possui o comprovante e encaminhar para o financeiro conferir a conciliação."

---

# Exemplo — valor diferente

Cliente:

"A cotação era R$ 8.000 e o link veio R$ 8.500."

Bot:

"Não conclua o pagamento enquanto essa diferença não estiver explicada. Vou encaminhar para verificarem a composição final do pedido e da cobrança."

---

# Exemplo — cartão recusado

Cliente:

"Meu cartão não passou."

Bot:

"A aprovação é feita pelo banco/processador e nem sempre recebemos o motivo específico. Você pode conferir os dados, limite ou tentar outro meio disponível no link. Se o erro persistir, encaminho para o financeiro."

---

# Status conceituais

O pagamento pode passar por estados como:

- AGUARDANDO_LINK
- LINK_GERADO
- AGUARDANDO_PAGAMENTO
- PAGAMENTO_PROCESSANDO
- PAGAMENTO_CONFIRMADO
- PAGAMENTO_FALHOU
- PAGAMENTO_CANCELADO

Os nomes técnicos reais podem ser diferentes.

Não assumir implementação sem verificar.

---

# Quando encaminhar para humano

Encaminhar quando houver:

- pedido aprovado sem link
- link expirado
- link incorreto
- divergência de valor
- pagamento não reconhecido
- cobrança duplicada
- recusa recorrente
- necessidade de outro meio
- alteração após pagamento
- suspeita de fraude
- status travado

---

# Informações úteis antes do handoff

Coletar ou obter:

- empresa
- CNPJ
- pedido
- valor aprovado
- valor cobrado
- link gerado?
- meio de pagamento
- pagamento realizado?
- horário aproximado
- status atual
- comprovante disponível?

---

# Resumo para humano

Exemplo:

Setor: Atacado / Financeiro
Empresa: Loja XYZ
Pedido: #1234
Status: aprovado
Link: gerado
Valor da cobrança: conforme sistema
Cliente informa pagamento: sim
Sistema confirma pagamento: não
Comprovante: disponível
Pendência: conciliação financeira

---

# O que o Bot pode fazer

Pode:

- consultar status
- informar link real
- explicar etapas
- evitar pagamento duplicado
- registrar comprovante
- direcionar para financeiro
- informar quando pagamento estiver confirmado

---

# O que o Bot NÃO deve fazer

Não deve:

- criar cobrança
- inventar link
- inventar PIX
- pedir dados sensíveis
- considerar comprovante como liquidação automática
- considerar aprovado como pago
- considerar pago como faturado
- alterar valor
- negociar condição de pagamento
- prometer reembolso

---

# Regra final

Aprovado não é pago.

Link gerado não é pagamento.

Cliente dizer que pagou não substitui confirmação do sistema.

Pagamento confirmado libera o pedido para as próximas etapas.