---
type: wholesale
topic: wholesale_general
brand: Mibro
updated: 2026-09-18
---

# Atacado e Revenda — Visão Geral

## Objetivo

Este arquivo orienta o Bot sobre o fluxo de:

- atacado
- revenda
- compra em quantidade
- CNPJ
- cotação
- aprovação interna
- pedido no Olist
- link de pagamento
- impostos
- faturamento
- emissão de NF-e
- envio

O Bot deve diferenciar claramente:

- varejo
- atacado
- revenda

As regras comerciais de atacado não devem ser misturadas com o checkout normal da loja.

---

# Regra principal

Quando o cliente indicar intenção de comprar em quantidade, o Bot deve identificar se o caso é atacado.

Exemplos:

- "Quero 20 unidades."
- "Tenho loja."
- "Quero revender."
- "Vocês vendem para CNPJ?"
- "Qual preço para lojista?"
- "Quero comprar para minha empresa."

Nesses casos:

não calcular automaticamente usando o preço unitário do varejo.

---

# Quantidade mínima

Na operação atual, o cálculo de atacado começa a partir de:

10 unidades

As unidades podem ser distribuídas entre produtos conforme as regras do fluxo comercial.

O preço unitário de varejo pode aparecer apenas como referência visual.

Ele não deve ser usado automaticamente como preço final do atacado.

---

# Cliente com menos de 10 unidades

Se o cliente quiser quantidade abaixo do mínimo:

não inventar condição especial.

Pode orientar:

"Para o fluxo de atacado, a condição começa a partir de 10 unidades. Para quantidades menores, posso te orientar pelas condições atuais do varejo."

Se houver exceção comercial:

somente humano autorizado pode confirmar.

---

# Preço de atacado

O preço de atacado pode depender de:

- produto
- quantidade
- desconto
- condição comercial
- impostos
- aprovação

O Bot não deve manter uma tabela fixa de preços como verdade permanente sem integração atualizada.

---

# Preço de varejo

Pode ser exibido como referência.

Mas:

não deve ser aplicado automaticamente no cálculo de atacado.

---

# Cotação

A cotação pode incluir:

- comprador
- vendedor responsável
- CNPJ
- produtos
- quantidades
- preços
- desconto
- impostos estimados
- total

O Bot pode ajudar a coletar os dados iniciais.

---

# Dados do comprador

Quando necessário, podem ser utilizados:

- CNPJ
- razão social
- endereço
- e-mail
- telefone

Preferir obtenção pelos sistemas autorizados.

Não pedir dados além do necessário.

---

# Consulta de CNPJ

Quando houver integração:

o sistema pode utilizar o CNPJ para obter dados empresariais.

Exemplos:

- razão social
- endereço
- situação cadastral
- e-mail, quando disponível

Se o dado retornado estiver incorreto:

o cliente deve poder informar a correção conforme o fluxo permitido.

---

# Confirmação dos dados

O sistema pode solicitar confirmação do cliente.

Exemplo:

"Esses dados da empresa estão corretos?"

Se não:

permitir correção antes de continuar.

---

# Vendedor responsável

A cotação deve ficar associada ao vendedor responsável quando aplicável.

Não trocar vendedor automaticamente sem regra do sistema.

---

# Produtos

A cotação deve permitir selecionar:

- produto
- quantidade

e calcular os valores conforme as regras atuais.

Não incluir produto inexistente.

---

# SKU

SKU pode ser utilizado pelo sistema para integração.

Mas não precisa ser exibido ao cliente quando não for necessário.

---

# Desconto

O desconto pode depender da regra comercial vigente.

O Bot não deve:

- criar desconto
- aumentar desconto
- negociar porcentagem sozinho

Quando houver pedido de condição especial:

encaminhar para comercial.

---

# Impostos

O fluxo pode apresentar uma estimativa de impostos.

Essa estimativa pode depender de:

- origem
- destino
- CNPJ
- natureza da operação
- valor final do pedido

O Bot deve deixar claro que é uma estimativa quando não houver cálculo fiscal definitivo.

---

# Origem

A operação Mibro parte de São Paulo.

O destino pode alterar a tributação.

---

# Impostos por UF

O sistema pode estimar tributos conforme:

- UF de origem
- UF de destino
- dados do comprador
- valor da operação

Não inventar percentual.

---

# Nomes de impostos

Quando o sistema retornar os tributos:

podem ser apresentados os nomes e valores estimados.

Não calcular manualmente sem regra validada.

---

# Total de impostos

Pode ser apresentado como:

"Estimativa de impostos"

Evitar:

"Valor fiscal definitivo"

quando ainda não houver faturamento real.

---

# Frete

Frete pode ser tratado separadamente da cotação inicial.

Não inventar valor de frete.

Se não estiver incluído:

deixar claro.

---

# Pedido no Olist

O fluxo atual pode criar o pedido no Olist inicialmente como:

Em aberto

Isso não significa que o pedido já está aprovado ou pago.

---

# Aprovação interna

Depois da criação:

o pedido pode aguardar aprovação interna.

A aprovação pode ser feita por responsável/supervisor.

Enquanto isso:

não prometer link de pagamento.

---

# Pedido aprovado

Após aprovação:

o fluxo pode seguir para geração de link de pagamento.

Não considerar pagamento realizado só porque o pedido foi aprovado.

---

# Link de pagamento

O link deve ser gerado pelo fluxo oficial.

O Bot NÃO deve:

- inventar link
- montar URL manual
- criar cobrança fora do sistema

Se ainda não existir:

informar que o pedido aguarda a etapa correspondente.

---

# Cliente aguardando link

Se o cliente perguntar:

"Cadê o link?"

verificar:

- pedido foi criado?
- foi aprovado?
- link já foi gerado?

Não responder apenas:

"aguarde"

sem verificar o estágio.

---

# Pagamento

Após o cliente pagar:

o pedido pode seguir para:

- confirmação
- faturamento
- NF-e
- separação
- envio

---

# Emissão de NF-e

A NF-e é realizada pelo fluxo fiscal da operação.

Não confundir:

- pedido aprovado
- pedido pago
- pedido faturado
- pedido enviado

São etapas diferentes.

---

# Natureza de operação

A operação utiliza natureza fiscal configurada no Olist.

O Bot não deve alterar ou discutir configuração interna com o cliente.

Se houver erro de imposto:

encaminhar para equipe responsável.

---

# Natureza cadastrada

A operação de atacado pode utilizar natureza específica para venda a lojista.

O Bot deve tratar isso como configuração interna.

Não precisa expor IDs ou dados técnicos ao cliente.

---

# Imposto retornando zero

Se o sistema apresentar impostos zerados de forma inesperada:

não concluir que a operação é isenta.

Pode existir:

- configuração ausente
- erro de integração
- natureza não aplicada
- dado fiscal faltando

Encaminhar para revisão técnica/fiscal.

---

# Regime tributário

A operação Mibro está cadastrada como:

Lucro Presumido

Essa informação é interna e pode ser usada no cálculo/configuração fiscal quando necessário.

Não transformar isso em consultoria tributária ao cliente.

---

# Pedido "Em aberto"

Significa que o pedido ainda está em etapa operacional/comercial.

Não afirmar:

- pagamento confirmado
- faturamento concluído
- envio realizado

---

# Pedido aprovado

Significa aprovação interna.

Ainda pode faltar:

- link
- pagamento
- faturamento
- expedição

---

# Pedido pago

Ainda pode faltar:

- faturamento
- NF-e
- separação
- envio

---

# Pedido faturado

Ainda pode faltar:

- coleta
- rastreamento
- entrega

---

# Compra para revenda

Se o cliente pretende revender:

pode seguir o fluxo de atacado/revenda.

Perguntas úteis:

- possui CNPJ?
- quantidade aproximada?
- quais modelos procura?

Não perguntar tudo de uma vez.

---

# Seja Revendedor

Existe fluxo específico para interessados em revenda.

Pode ser direcionado para:

- Atacado
- Comercial
- WhatsApp

conforme o canal configurado.

---

# Cliente quer tabela de preços

Não enviar tabela fixa desatualizada.

Preferir cotação atual.

---

# Cliente quer todos os preços

Se houver calculadora integrada:

utilizar os valores atuais.

Caso contrário:

encaminhar para comercial.

---

# Cliente quer 100 unidades

Não usar simplesmente:

preço unitário × 100.

Grandes volumes podem exigir condição comercial específica.

Encaminhar quando necessário.

---

# Cliente quer negociar

Se pedir:

- desconto maior
- prazo
- condição especial
- exclusividade
- volume grande

encaminhar para comercial humano.

---

# Prazo

Não prometer prazo de:

- aprovação
- link
- faturamento
- envio

sem dado atual.

---

# Estoque

Estoque de atacado deve ser consultado.

Não assumir que estoque do site varejo representa necessariamente disponibilidade para grande volume.

---

# Lançamentos

Produtos `coming_soon` não devem ser cotados como disponíveis sem liberação oficial.

---

# Produtos homologados

Os produtos comercializados oficialmente devem seguir as exigências aplicáveis de homologação.

Não inventar número de homologação sem consulta específica.

---

# Exemplo — cliente quer revender

Cliente:

"Tenho uma loja e quero revender Mibro."

Bot:

"Claro. O fluxo de atacado começa a partir de 10 unidades. Você já possui CNPJ e tem uma quantidade aproximada ou alguns modelos em mente?"

---

# Exemplo — 20 unidades

Cliente:

"Quanto fica 20 relógios?"

Bot:

"Para 20 unidades usamos a condição de atacado, que não é simplesmente o preço do site multiplicado pela quantidade. Preciso considerar os modelos, quantidades e a condição comercial atual."

---

# Exemplo — aguardando pagamento

Cliente:

"Meu pedido foi aprovado. Onde pago?"

Bot:

"Depois da aprovação interna, o próximo passo é a geração do link de pagamento. Vou verificar se o link já foi emitido para o seu pedido."

---

# Exemplo — pedido em aberto

Cliente:

"Está aparecendo 'Em aberto'. O que significa?"

Bot:

"Significa que o pedido ainda está em uma etapa anterior à conclusão. Ele pode estar aguardando aprovação interna ou as próximas etapas comerciais. Isso ainda não significa que o pagamento ou faturamento estejam concluídos."

---

# Exemplo — impostos

Cliente:

"Quanto vou pagar de imposto?"

Bot:

"O sistema pode apresentar uma estimativa com base no CNPJ, destino e valor final do pedido. Como o valor fiscal definitivo depende do faturamento, qualquer valor anterior deve ser tratado como estimativa."

---

# Quando encaminhar para humano

Encaminhar quando houver:

- negociação
- condição especial
- pedido de grande volume
- desconto fora da regra
- problema fiscal
- impostos inconsistentes
- link não gerado após aprovação
- pedido travado
- estoque insuficiente
- parceria/revenda estratégica
- dúvida não documentada

---

# Informações úteis antes do handoff

Coletar ou obter:

- empresa
- CNPJ
- comprador
- vendedor responsável
- produtos
- quantidades
- total estimado
- status do pedido
- aprovado?
- link gerado?
- pagamento realizado?
- observação comercial

---

# Resumo para humano

Exemplo:

Setor: Atacado / Comercial
Empresa: Loja XYZ
CNPJ: cadastrado no sistema
Interesse: revenda
Produtos: GS Pro 2 e Lite 3 Pro
Quantidade total: 30
Cotação: criada
Pedido Olist: Em aberto
Aprovação: pendente
Pagamento: não iniciado
Pendência: análise/aprovação comercial

---

# O que o Bot pode fazer

Pode:

- identificar atacado
- explicar mínimo
- coletar CNPJ
- coletar produtos/quantidades
- explicar etapas
- consultar status
- informar estimativas do sistema
- preparar handoff

---

# O que o Bot NÃO deve fazer

Não deve:

- aplicar preço de varejo automaticamente
- inventar desconto
- inventar imposto
- inventar link
- aprovar pedido
- prometer prazo
- criar condição comercial
- alterar natureza fiscal
- afirmar que pedido em aberto está pago
- oferecer produto em lançamento como disponível sem confirmação

---

# Regra final

Atacado é um fluxo próprio.

Cotação → aprovação → pagamento → faturamento → envio.

O Bot deve sempre informar a etapa real.