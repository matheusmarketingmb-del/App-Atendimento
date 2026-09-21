---
type: commercial
topic: pricing_promotions
brand: Mibro
updated: 2026-09-18
---

# Comercial — Preço, Promoções e Cupons

## Objetivo

Este arquivo orienta o Bot sobre dúvidas relacionadas a:

- preço
- preço promocional
- desconto
- PIX
- parcelamento
- cupom
- promoção
- estoque
- oferta temporária
- diferença entre preço do site e checkout
- condição comercial
- lançamentos

Essas informações são dinâmicas.

O Bot deve priorizar sempre o dado atual da loja/sistema.

---

# Regra principal

Preço NÃO deve ser tratado como informação fixa de Knowledge.

O Bot NÃO deve utilizar preço antigo salvo em arquivo de produto como fonte principal.

Sempre que possível:

consultar o preço atual.

---

# Informações dinâmicas

Devem ser consultadas em tempo real quando possível:

- preço
- preço promocional
- preço no PIX
- parcelamento
- quantidade de parcelas
- juros
- cupom
- estoque
- disponibilidade
- frete
- condição promocional

---

# Preço exibido no site

Se o cliente perguntar:

"Quanto custa o GS Pro 2?"

o Bot deve:

1. identificar o modelo correto;
2. consultar preço atual;
3. informar a condição vigente.

Não utilizar valor antigo de outra conversa.

---

# Preço pode mudar

O preço pode variar por:

- promoção
- campanha
- estoque
- condição comercial
- canal de venda
- período

Não prometer manutenção de preço sem confirmação.

---

# Preço no PIX

Quando existir preço/desconto no PIX:

usar o valor atual exibido na loja/checkout.

Não calcular manualmente percentual se o checkout já fornece o valor final.

---

# Desconto PIX

Se o cliente perguntar:

"Quanto é o desconto no PIX?"

consultar a condição atual.

Não assumir percentual fixo.

---

# Cartão

Quando houver pagamento com cartão:

consultar:

- valor total
- número de parcelas
- juros, se houver

Não usar informação histórica como se fosse atual.

---

# Parcelamento

Não afirmar automaticamente:

"10x sem juros."

A condição pode mudar.

Responder somente com dados atuais.

---

# Preço à vista x parcelado

Separar claramente:

- valor à vista
- valor parcelado
- quantidade de parcelas

Não apresentar valor da parcela como se fosse preço total.

---

# Preço "de" e "por"

Quando a loja exibir preço promocional:

pode existir:

- preço anterior
- preço atual

O Bot deve utilizar os valores reais da página.

Não inventar economia percentual.

---

# Compare at price

Se houver preço "de":

não assumir que é promoção válida sem verificar o estado atual do produto.

---

# Cupom

Cupons podem ter regras como:

- validade
- primeira compra
- produto específico
- coleção específica
- valor mínimo
- limite de uso
- não acumulativo

Nunca inventar regras.

---

# Cupom PRIMEIRACOMPRA

Se estiver ativo:

pode ser usado conforme as regras vigentes da loja.

Não assumir eternamente que está disponível.

Consultar condição atual antes de oferecer.

---

# Cupom ELETROMIBRO

Mesma regra.

Só informar quando:

- estiver ativo
- aplicável ao pedido
- condição estiver confirmada

---

# Cupom não funciona

Verificar, quando possível:

- código digitado
- validade
- produto elegível
- valor mínimo
- uso anterior
- condição de primeira compra
- acumulação com outra promoção

Se não houver acesso às regras:

encaminhar.

---

# Cupons acumulativos

Não afirmar que dois cupons podem ser usados juntos sem confirmação.

---

# Cupom + PIX

Pode haver restrição de acúmulo.

Não calcular manualmente combinação de descontos sem regra atual.

---

# Promoções

Promoções podem ser temporárias.

O Bot deve evitar frases como:

"Esse preço vai continuar."

Preferir:

"Esse é o valor promocional disponível agora."

---

# Data de término

Não informar fim de promoção sem dado oficial.

---

# Estoque

Estoque também é dinâmico.

Se o cliente perguntar:

"Tem disponível?"

consultar o estoque atual.

Não responder baseado em arquivo estático.

---

# Produto sem estoque

Se estiver indisponível:

não prometer reposição.

Pode informar:

"Neste momento aparece indisponível."

Se existir previsão oficial:

informar.

Caso contrário:

não inventar data.

---

# Últimas unidades

Não usar expressão:

"últimas unidades"

sem dado real.

Evitar criar urgência artificial.

---

# Reserva de estoque

Não prometer reserva sem funcionalidade real.

---

# Produto no carrinho

Adicionar ao carrinho normalmente não significa reserva automática de estoque.

Não afirmar o contrário sem confirmação do sistema.

---

# Produto em lançamento

Produtos classificados como:

coming_soon

não devem receber:

- preço inventado
- desconto inventado
- estoque inventado
- data inventada

Pode informar apenas o que estiver oficialmente publicado.

---

# Pré-lançamento

Se houver preço oficial publicado futuramente:

usar somente quando confirmado.

Até lá:

"Preço ainda não divulgado."

---

# Diferença de preço entre modelos

Quando comparar:

consultar valores atuais de ambos.

Não usar diferença histórica.

---

# Custo-benefício

Não afirmar automaticamente:

"Esse é o melhor custo-benefício."

Para avaliar:

considerar:

- necessidade do cliente
- recursos
- preço atual

Pode dizer:

"Para o que você descreveu, esse modelo entrega os recursos que você precisa por um valor menor que o modelo acima."

---

# Preço de marketplace

Preço de marketplace pode ser diferente do site oficial.

Não prometer igualar.

---

# Site oficial x marketplace

Podem existir:

- promoções diferentes
- vendedores diferentes
- fretes diferentes
- condições diferentes

O Bot deve deixar isso claro.

---

# Preço de revendedor

Não controlar preço de terceiros.

Se a dúvida for sobre compra oficial:

consultar preço do canal oficial.

---

# Cliente viu preço diferente ontem

Promoções podem mudar.

Não acusar erro.

Responder:

"Os valores podem variar conforme campanhas e condições vigentes. Vou considerar o preço disponível agora."

---

# Preço diferente no checkout

Se página e checkout divergirem:

não concluir imediatamente qual está correto.

Verificar:

- produto
- variante
- cupom
- frete
- PIX/cartão
- quantidade

Se persistir:

encaminhar.

---

# Variante

Cores ou versões podem ter condições diferentes, se configurado.

Não assumir que todas possuem exatamente o mesmo preço sem verificar.

---

# Frete

Frete não deve ser misturado com preço do produto.

Separar:

Produto:
Frete:
Total:

quando necessário.

---

# Frete grátis

Não prometer valor mínimo sem regra vigente.

Consultar checkout/política atual.

---

# Atacado

Preço de atacado NÃO deve ser tratado como preço de varejo.

O fluxo atacado pode depender de:

- quantidade
- vendedor
- desconto
- aprovação
- impostos
- condição comercial

Consultar:

08_Atacado_Revenda

---

# Quantidade mínima

Não inventar quantidade mínima.

Se houver regra oficial:

usar a atual.

---

# Negociação

O Bot não deve oferecer desconto adicional por conta própria.

Se o cliente pedir:

"Faz desconto?"

pode verificar:

- promoções atuais
- cupons disponíveis
- condição de atacado, se aplicável

Para negociação especial:

encaminhar ao comercial.

---

# Cliente quer desconto maior

Não criar cupom.

Não prometer:

"Consigo 10%."

Encaminhar se houver possibilidade comercial.

---

# Brinde

Não prometer brinde sem campanha vigente.

---

# Combo

Se houver kit ou combo:

consultar condição atual.

Não montar combo manualmente com desconto não autorizado.

---

# Produto usado como comparação

Se o cliente disser:

"Na outra loja está mais barato."

O Bot não deve atacar concorrente.

Pode responder:

"Posso te informar a condição atual do canal oficial e os benefícios/documentação correspondentes à compra oficial."

---

# Preço e garantia

Comprar por preço menor em outro canal não significa automaticamente ausência de garantia.

A elegibilidade depende:

- vendedor
- canal
- NF-e
- autorização

Consultar:

04_Garantia/garantia-geral.md

---

# Erro de preço

Se houver valor claramente anormal ou divergente:

não garantir venda naquele valor.

Encaminhar para validação comercial.

---

# Bot não deve alterar preço

Mesmo se tiver permissão de consulta:

não alterar:

- preço
- desconto
- cupom
- parcelamento

sem ação autorizada específica.

---

# Exemplo — preço

Cliente:

"Quanto está o Lite 3 Pro?"

Bot:

"Vou considerar o valor atual da loja. Hoje ele aparece por [VALOR ATUAL], com as condições de pagamento disponíveis no checkout."

Usar apenas se o sistema forneceu o valor.

---

# Exemplo — PIX

Cliente:

"Tem desconto no PIX?"

Bot:

"Vou verificar a condição atual. Se houver desconto no PIX, o valor final aparece no checkout antes do pagamento."

---

# Exemplo — cupom

Cliente:

"Tem cupom?"

Bot:

"Posso verificar quais condições estão ativas agora. Os cupons podem variar conforme produto, campanha e elegibilidade."

---

# Exemplo — produto em lançamento

Cliente:

"Quanto vai custar o Explorer?"

Bot:

"O Explorer ainda está classificado como lançamento e o preço não está confirmado na base atual. Prefiro não te passar um valor estimado como se fosse oficial."

---

# Exemplo — promoção acabou

Cliente:

"Ontem estava mais barato."

Bot:

"Os valores podem mudar conforme campanhas promocionais. Vou considerar a condição disponível agora para não te passar um preço antigo."

---

# Quando encaminhar para humano

Encaminhar quando houver:

- negociação
- desconto especial
- divergência entre página e checkout
- erro aparente de preço
- cupom válido não funciona
- condição empresarial
- atacado
- preço não disponível no sistema
- estoque inconsistente
- promoção não documentada

---

# Informações úteis antes do handoff

Coletar ou obter:

- produto
- variante
- preço exibido
- preço no checkout
- cupom
- forma de pagamento
- quantidade
- canal
- print, quando útil

---

# Resumo para humano

Exemplo:

Setor: Comercial
Assunto: Divergência de preço
Produto: Mibro GS Pro 2
Página: R$ X
Checkout: R$ Y
Pagamento: PIX
Cupom: nenhum
Quantidade: 1
Pendência: validar condição comercial

---

# O que o Bot pode fazer

Pode:

- consultar preço atual
- consultar estoque
- informar condição vigente
- explicar PIX/cartão
- verificar promoções
- verificar cupom
- comparar valores atuais
- encaminhar negociação

---

# O que o Bot NÃO deve fazer

Não deve:

- usar preço antigo como atual
- inventar promoção
- inventar estoque
- inventar cupom
- criar desconto
- criar urgência falsa
- prometer reserva
- garantir manutenção de preço
- alterar preço sem autorização

---

# Regra final

Produto e especificação podem ficar na Knowledge.

Preço, estoque e promoção devem vir do dado atual sempre que possível.