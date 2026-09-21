---
type: sources
topic: official_sources
brand: Mibro
updated: 2026-09-18
---

# Fontes Oficiais — Mibro Brasil

## Objetivo

Este arquivo define quais fontes o Bot deve considerar confiáveis para:

- produtos
- políticas
- garantia
- suporte
- lançamentos
- preços
- estoque
- pedidos
- atendimento

O objetivo é reduzir respostas inventadas, conflitantes ou desatualizadas.

---

# Regra principal

Quando houver dúvida:

o Bot deve preferir uma fonte oficial específica em vez de conhecimento genérico do modelo de IA.

A IA NÃO deve preencher lacunas com suposições.

---

# Prioridade geral das fontes

Ordem recomendada:

1. dado real do sistema/integrador
2. página oficial específica do produto
3. política oficial específica
4. arquivo individual da Knowledge
5. página oficial de coleção/categoria
6. página geral oficial
7. conteúdo interno validado
8. inferência da IA

Quanto mais específica a fonte:

maior a prioridade.

---

# Dados dinâmicos

Para informações que mudam frequentemente:

usar sistema em tempo real sempre que possível.

Exemplos:

- preço
- estoque
- promoção
- cupom
- prazo
- rastreamento
- status do pedido
- pagamento
- reembolso
- disponibilidade

Knowledge estática não deve ser tratada como fonte final para esses dados.

---

# Dados relativamente estáticos

Knowledge pode ser utilizada para:

- especificações técnicas
- recursos
- resistência
- compatibilidade
- fluxos
- políticas
- troubleshooting
- comportamento do Bot

Ainda assim:

a fonte oficial específica deve ter prioridade.

---

# Loja oficial Mibro Brasil

Base principal:

https://mibrobrasil.com.br/

---

# Todos os produtos

https://mibrobrasil.com.br/collections/todos-os-produtos

Pode ser utilizado para:

- catálogo atual
- produtos listados
- categorias gerais

Não utilizar sozinho para afirmar especificações detalhadas.

---

# Essential Series

https://mibrobrasil.com.br/collections/essential-series-watch

Modelos associados na Knowledge:

- Mibro C4
- Mibro A3

Consultar primeiro os arquivos individuais.

---

# Lifestyle Series

https://mibrobrasil.com.br/collections/lifestyle-series-watch

Modelos associados na Knowledge:

- Lite 3
- Lite 3 Pro

Lançamentos podem ser classificados separadamente conforme página oficial.

---

# Professional Sport Series

https://mibrobrasil.com.br/collections/professional-sport-series

Modelos associados:

- GS Active
- GS Active2
- GS Pro
- GS Pro 2

Além de modelos futuros quando oficialmente incluídos.

---

# Lançamentos

https://mibrobrasil.com.br/pages/lancamentos

Utilizar para identificar produtos anunciados.

Regra:

produto anunciado não significa automaticamente produto disponível.

---

# Produtos em lançamento registrados

Knowledge atual inclui:

- Mibro FIT
- Mibro GT
- Mibro GS Explorer
- Mibro GS Explorer S
- Mibro Earbuds Open Ear
- Mibro Earbuds Open Ear Pro
- Mibro Earbuds 5

Enquanto estiverem marcados como:

`coming_soon`

não inventar:

- preço
- estoque
- data de lançamento
- prazo de entrega

---

# Mibro C4

https://mibrobrasil.com.br/products/mibro-c4

Arquivo local:

`02_Produtos/Essential/mibro-c4.md`

---

# Mibro A3

https://mibrobrasil.com.br/products/mibro-a3

Arquivo local:

`02_Produtos/Essential/mibro-a3.md`

ATENÇÃO:

existem informações oficiais potencialmente divergentes relacionadas a GPS/autonomia.

Não resolver a divergência por suposição.

---

# Mibro Lite 3

https://mibrobrasil.com.br/products/mibro-lite-3

Arquivo local:

`02_Produtos/Lifestyle/mibro-lite-3.md`

---

# Mibro Lite 3 Pro

https://mibrobrasil.com.br/products/mibro-lite-3-pro

Arquivo local:

`02_Produtos/Lifestyle/mibro-lite-3-pro.md`

---

# Mibro GS Pro

https://mibrobrasil.com.br/products/mibro-gs-pro

Arquivo local:

`02_Produtos/Professional/mibro-gs-pro.md`

ATENÇÃO:

a página pode conter divergências internas de especificação/autonomia.

Consultar observações do arquivo individual.

---

# Mibro GS Pro 2

https://mibrobrasil.com.br/products/mibro-gs-pro-2

Arquivo local:

`02_Produtos/Professional/mibro-gs-pro-2.md`

---

# Mibro GS Active

https://mibrobrasil.com.br/products/mibro-gs-active

Arquivo local:

`02_Produtos/Professional/mibro-gs-active.md`

Usar abordagem conservadora.

Não transferir recursos do GS Active2 ou GS Pro.

---

# Mibro GS Active2

https://mibrobrasil.com.br/products/mibro-gs-active2

Arquivo local:

`02_Produtos/Professional/mibro-gs-active-2.md`

---

# Mibro Fit App

https://mibrobrasil.com.br/pages/app-mibro

Utilizar como referência oficial para:

- aplicativo
- instalação
- acesso ao Mibro Fit

Também consultar:

`03_Suporte/aplicativo-mibro-fit.md`

---

# Garantia

https://mibrobrasil.com.br/pages/termos-de-garantia

Arquivos locais:

- `04_Garantia/garantia-geral.md`
- `04_Garantia/requisitos-garantia.md`
- `04_Garantia/exclusoes-garantia.md`
- `04_Garantia/defeito-fisico.md`
- `04_Garantia/encaminhamento-garantia.md`

Regra:

o Bot explica.

A equipe humana decide.

---

# Reembolso

https://mibrobrasil.com.br/policies/refund-policy

Consultar também:

- `06_Trocas_Reembolso`
- `09_Politicas/politica-reembolso.md`

---

# Envio

https://mibrobrasil.com.br/policies/shipping-policy

Consultar também:

- `05_Pedidos/envio.md`
- `05_Pedidos/rastreamento.md`
- `09_Politicas/politica-envio.md`

---

# Privacidade

https://mibrobrasil.com.br/policies/privacy-policy

Consultar:

`09_Politicas/privacidade-termos.md`

---

# Termos de serviço

https://mibrobrasil.com.br/policies/terms-of-service

Consultar:

`09_Politicas/privacidade-termos.md`

---

# Sobre a empresa

https://mibrobrasil.com.br/pages/sobre-nos

Pode ser utilizado para dúvidas institucionais.

Não utilizar como fonte técnica de produtos.

---

# Informações de contato

https://mibrobrasil.com.br/policies/contact-information

Consultar também:

`09_Politicas/contato-regras-gerais.md`

---

# Aviso legal

https://mibrobrasil.com.br/policies/legal-notice

Usar quando necessário para questões institucionais/jurídicas.

Não interpretar juridicamente além do conteúdo publicado.

---

# FAQ

Fonte recomendada:

https://mibrobrasil.com.br/pages/faq

Quando disponível e atualizada:

pode complementar suporte geral.

Não deve sobrescrever página específica de produto ou política oficial.

---

# Hierarquia para produto

Quando o cliente perguntar sobre um modelo específico:

1. arquivo local específico do produto
2. página oficial específica
3. página da categoria
4. catálogo geral

Não usar característica de outro modelo da mesma linha.

---

# Hierarquia para suporte

Quando houver problema técnico:

1. arquivo específico de suporte
2. arquivo do produto
3. página oficial
4. política aplicável
5. fluxo geral

---

# Hierarquia para garantia

1. termos oficiais de garantia
2. arquivos `04_Garantia`
3. dados reais da compra
4. análise humana

Nunca:

IA → decisão final.

---

# Hierarquia para pedido

1. integração/sistema real
2. status do pedido
3. rastreamento
4. política oficial
5. Knowledge

---

# Hierarquia para preço

1. preço atual do sistema/Shopify
2. página oficial atual
3. promoção ativa confirmada

Não usar valor antigo salvo em Markdown como verdade definitiva.

---

# Hierarquia para estoque

1. sistema real
2. Shopify
3. página atual

Nunca inferir estoque apenas porque existe uma página de produto.

---

# Hierarquia para lançamento

1. página oficial de lançamentos
2. página individual oficial, se existir
3. arquivo local validado

Se não houver data:

responder que não há data confirmada.

---

# Divergência dentro da mesma página

Algumas páginas podem apresentar valores diferentes entre:

- descrição
- tabela técnica
- banner
- imagem
- FAQ

Quando isso ocorrer:

não escolher automaticamente o valor "mais provável".

Registrar a divergência.

---

# Divergência entre fontes oficiais

Ordem de decisão:

1. identificar qual fonte é mais específica
2. verificar qual é mais recente
3. consultar arquivo local de observações
4. se ainda houver conflito, não afirmar como certeza

Pode responder:

"Há informações oficiais divergentes sobre esse ponto. Vou evitar te passar um dado incerto."

---

# Conhecimento do modelo de IA

Conhecimento prévio do modelo pode ajudar a:

- interpretar linguagem
- organizar resposta
- entender contexto
- detectar intenção

Mas não deve ser usado como fonte principal de:

- especificações
- políticas
- preço
- estoque
- garantia
- status

---

# Pesquisa externa

O Bot de atendimento não deve usar automaticamente:

- fóruns
- Reddit
- YouTube
- lojas não oficiais
- blogs
- reviews

como fonte oficial.

Esses conteúdos podem conter informação incorreta ou referente a versões internacionais diferentes.

---

# Mibro global vs Mibro Brasil

Produtos podem variar por:

- região
- versão
- firmware
- homologação
- disponibilidade

Não assumir que informação encontrada sobre versão global se aplica à operação brasileira.

---

# Marketplaces

Uma página de marketplace pode ser utilizada para localizar pedido/canal quando integrada.

Não deve substituir a documentação oficial do produto.

---

# Revendedores

Informação de revendedor só deve ser tratada como oficial quando houver validação pela operação.

Não confirmar revendedor com base apenas no nome da loja.

---

# Informação histórica

Arquivos antigos podem ser úteis como histórico.

Mas não devem substituir uma fonte atual em:

- preço
- estoque
- promoções
- política atualizada

---

# Data da fonte

Sempre que possível, a indexação deve registrar:

- URL
- data de coleta
- tipo de fonte
- produto/assunto

Isso facilita atualização futura.

---

# Metadados recomendados

Cada documento indexado pode possuir:

- `source`
- `source_type`
- `product`
- `category`
- `updated`
- `status`
- `confidence`

---

# Tipos de fonte sugeridos

Exemplos:

`official_product_page`

`official_policy`

`official_collection`

`internal_validated`

`system_dynamic`

---

# Confiança

Sugestão conceitual:

## Alta

Fonte oficial específica e consistente.

## Média

Fonte oficial geral ou informação interna validada.

## Baixa

Informação incompleta, conflitante ou não confirmada.

Informação de baixa confiança não deve gerar afirmação categórica.

---

# Atualização da Knowledge

Quando uma página oficial mudar:

a Knowledge correspondente deve ser revisada.

Especialmente:

- produto
- garantia
- política
- lançamento

---

# Preço e estoque não precisam de reindexação manual constante

Esses dados devem preferencialmente vir de integração em tempo real.

---

# O que o Bot pode fazer

Pode:

- selecionar fonte correta
- consultar Knowledge
- detectar conflito
- priorizar dado real
- informar incerteza
- encaminhar para humano

---

# O que o Bot NÃO deve fazer

Não deve:

- inventar fonte
- misturar modelos
- usar fórum como oficial
- transformar dado global em brasileiro automaticamente
- escolher arbitrariamente entre valores conflitantes
- usar preço antigo como atual
- usar estoque antigo como atual
- substituir política oficial por conhecimento da IA

---

# Regra final

Fonte específica vence fonte genérica.

Dado real vence Knowledge estática.

Fonte oficial vence conhecimento do modelo.

Quando não houver certeza:

não inventar.
