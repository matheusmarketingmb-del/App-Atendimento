---
type: policy
topic: shipping_policy
brand: Mibro
source: https://mibrobrasil.com.br/policies/shipping-policy
updated: 2026-09-18
---

# Política — Envio

## Objetivo

Este arquivo serve como referência oficial para o Bot em dúvidas relacionadas a:

- processamento de pedidos
- envio
- prazo
- transporte
- rastreamento
- endereço
- tentativas de entrega
- devolução ao remetente
- atrasos logísticos

Este arquivo deve ser usado como base de política.

Para troubleshooting operacional de pedidos, consultar também:

- `05_Pedidos/envio.md`
- `05_Pedidos/rastreamento.md`
- `05_Pedidos/pedido-nao-recebido.md`

---

# Regra principal

Quando existir diferença entre:

- informação estática da Knowledge
- status real do pedido
- rastreamento da transportadora

o Bot deve priorizar:

1. status real do pedido;
2. rastreamento real;
3. política oficial vigente.

Nunca inventar prazo ou movimentação.

---

# Processamento do pedido

Após a confirmação do pagamento, o pedido pode passar por etapas como:

- processamento
- separação
- faturamento
- preparação
- expedição

Essas etapas podem ocorrer antes da entrega à transportadora.

O Bot não deve tratar pagamento aprovado como envio concluído.

---

# Prazo de postagem

O prazo de postagem pode depender de:

- confirmação do pagamento
- disponibilidade do produto
- operação logística
- dias úteis
- feriados
- campanhas
- volume operacional

Sempre consultar a política vigente ou o status real antes de informar prazo específico.

---

# Prazo de entrega

O prazo de entrega pode variar conforme:

- CEP
- região
- transportadora
- modalidade de frete
- operação logística

Não prometer data exata quando houver apenas estimativa.

Preferir:

"previsão de entrega"

em vez de:

"vai chegar em".

---

# Frete

O valor do frete deve ser calculado pelo checkout/sistema oficial.

Pode depender de:

- CEP
- peso
- volume
- quantidade
- modalidade
- promoção ativa

O Bot não deve calcular frete manualmente sem fonte oficial.

---

# Frete grátis

Frete grátis pode existir como condição promocional.

O Bot só deve informar quando a regra estiver ativa e confirmada.

Não utilizar valor mínimo antigo como regra permanente.

---

# Transportadora

A transportadora pode variar conforme:

- região
- modalidade
- pedido
- operação logística

Não assumir que todos os pedidos utilizam Correios ou uma transportadora específica.

---

# Rastreamento

Quando existir rastreio:

usar sempre o código vinculado ao pedido real.

Nunca:

- inventar código
- reutilizar código antigo
- enviar código de outro cliente

---

# Código recém-gerado

Pode existir intervalo entre:

- geração do código
- primeira movimentação visível

Isso não significa automaticamente atraso ou extravio.

---

# Endereço

O cliente é responsável por informar corretamente os dados necessários para entrega.

Mesmo assim:

se o cliente identificar um erro antes do despacho, o Bot deve tentar encaminhar a correção o mais rápido possível.

Não prometer alteração depois do envio.

---

# Alteração antes do envio

Se o pedido ainda não foi despachado:

pode ser possível corrigir o endereço.

A alteração depende da confirmação da equipe/sistema.

---

# Alteração depois do envio

Se o pedido já estiver com a transportadora:

a alteração pode ser limitada ou impossível.

Não prometer redirecionamento.

---

# Tentativas de entrega

A quantidade de tentativas e procedimentos dependem da transportadora.

O Bot não deve inventar um número fixo.

Sempre consultar o rastreamento.

---

# Destinatário ausente

Se houver tentativa sem sucesso:

orientar acompanhamento pelo rastreamento.

A transportadora pode:

- tentar novamente
- redirecionar
- devolver ao remetente
- disponibilizar retirada

conforme o caso.

---

# Endereço insuficiente ou incorreto

Pode resultar em:

- atraso
- tentativa frustrada
- retorno ao remetente

O Bot deve encaminhar para logística quando necessário.

---

# Devolução ao remetente

Se o pedido estiver retornando:

não considerar devolução concluída antes de o produto realmente retornar e ser processado.

Pode haver etapas de:

- transporte de retorno
- recebimento
- conferência
- decisão sobre reenvio ou reembolso

---

# Atrasos

Atrasos podem ocorrer por:

- transportadora
- região
- eventos operacionais
- feriados
- força maior
- ocorrências logísticas

O Bot não deve inventar a causa.

Se o prazo já foi ultrapassado:

encaminhar para análise logística.

---

# Pedido parado

Ficar sem atualização por alguns períodos não significa automaticamente extravio.

Considerar:

- última movimentação
- previsão
- ocorrência

Se estiver fora da previsão:

encaminhar.

---

# Extravio

Somente tratar como extravio confirmado quando houver confirmação da logística/transportadora.

Não usar:

"Seu pedido foi perdido."

sem evidência.

---

# Pedido consta como entregue

Se o cliente disser que não recebeu:

orientar primeiro:

- verificar portaria
- recepção
- familiares
- outros responsáveis no endereço

Se não localizar:

encaminhar para investigação.

---

# Privacidade

Se houver rastreio incorreto:

não expor dados de outro destinatário.

Nunca informar:

- nome de terceiro
- endereço de terceiro
- telefone de terceiro

---

# Produto avariado na entrega

Se a embalagem ou produto chegar danificado:

orientar:

- preservar embalagem
- preservar etiquetas
- registrar fotos, quando possível

Encaminhar para troca/logística.

---

# Produto faltando

Antes de concluir erro:

verificar se existe envio parcial.

Se não houver:

encaminhar.

---

# Produto incorreto

Se chegou modelo/cor diferente do pedido:

consultar:

`06_Trocas_Reembolso/troca.md`

---

# Produto em lançamento

Produtos `coming_soon` não devem receber prazo de envio inventado.

Se ainda não há data oficial:

informar que não existe previsão confirmada.

---

# Pré-venda

Se houver pré-venda:

usar apenas prazo/documentação oficial daquela oferta.

Não aplicar automaticamente prazos de produtos em estoque.

---

# Atacado

Pedidos de atacado podem seguir fluxo diferente:

- aprovação
- pagamento
- faturamento
- NF-e
- expedição

Consultar:

`08_Atacado_Revenda`

---

# Comunicação recomendada

Evitar:

"Seu pedido vai chegar amanhã."

Preferir:

"A previsão atual do rastreamento é amanhã."

---

# Quando encaminhar

Encaminhar quando houver:

- atraso além da previsão
- rastreio inválido
- pedido parado de forma anormal
- entrega marcada como concluída e não recebida
- devolução ao remetente
- endereço incorreto
- avaria
- item faltante
- produto incorreto
- divergência logística

---

# O que o Bot pode fazer

Pode:

- explicar a política
- consultar status
- consultar rastreio
- orientar acompanhamento
- explicar diferenças entre processamento e envio
- encaminhar problemas logísticos

---

# O que o Bot NÃO deve fazer

Não deve:

- inventar prazo
- garantir data
- inventar transportadora
- declarar extravio sem confirmação
- prometer reenvio
- prometer alteração de endereço após despacho
- expor dados de terceiros

---

# Regra final

Política explica o fluxo.

Pedido real informa o status atual.

Rastreamento informa a movimentação logística.

O Bot deve combinar essas três fontes sem inventar informações.