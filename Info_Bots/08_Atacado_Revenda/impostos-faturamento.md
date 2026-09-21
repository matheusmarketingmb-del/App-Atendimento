---
type: wholesale
topic: taxes_billing
brand: Mibro
updated: 2026-09-18
---

# Atacado e Revenda — Impostos e Faturamento

## Objetivo

Este arquivo orienta o Bot sobre dúvidas relacionadas a:

- impostos
- estimativa tributária
- faturamento
- NF-e
- natureza da operação
- CNPJ
- UF de origem e destino
- divergência de valores fiscais
- pedido pago aguardando faturamento
- pedido faturado aguardando envio

O Bot deve explicar o fluxo sem transformar o atendimento em consultoria tributária.

---

# Regra principal

O Bot NÃO deve:

- inventar imposto
- inventar percentual
- afirmar isenção sem confirmação
- alterar natureza da operação
- alterar configuração fiscal
- prometer valor fiscal definitivo antes do faturamento
- interpretar regra tributária complexa por conta própria

Sempre que possível:

usar o valor calculado pelo sistema.

---

# Regime tributário

A operação Mibro está configurada como:

Lucro Presumido

Essa informação pode ser relevante para integrações e cálculos internos.

O Bot não deve usar isso para fornecer consultoria tributária ao cliente.

---

# Origem da operação

A operação parte de:

São Paulo / SP

A UF de destino pode influenciar a estimativa dos tributos.

---

# Dados utilizados no cálculo

O sistema pode considerar:

- CNPJ
- UF de origem
- UF de destino
- valor do pedido
- produtos
- natureza da operação
- dados fiscais do comprador

Não alterar esses dados apenas para gerar valor menor.

---

# Estimativa de impostos

Antes do faturamento:

o sistema pode apresentar uma estimativa.

Sempre utilizar linguagem como:

- estimativa
- valor aproximado
- cálculo preliminar

Evitar:

"Esse será exatamente o imposto da nota."

---

# Valor fiscal definitivo

O valor definitivo pode ser determinado durante:

- faturamento
- emissão da NF-e
- processamento fiscal

Por isso:

estimativa da cotação != valor fiscal definitivo.

---

# UF do comprador

A UF deve ser obtida a partir dos dados corretos da empresa.

Se o CNPJ indicar endereço divergente:

confirmar antes de continuar.

---

# Operação dentro de São Paulo

Operações SP → SP podem seguir tratamento diferente de operações interestaduais.

O Bot não deve explicar percentuais sem retorno do sistema.

---

# Operação interestadual

Exemplos:

- SP → ES
- SP → MG
- SP → RJ

podem ter composição fiscal diferente.

O Bot deve usar o cálculo retornado pelo sistema.

---

# Impostos exibidos

Dependendo da operação, o sistema pode retornar tributos como:

- ICMS
- IPI
- PIS
- COFINS
- outros componentes aplicáveis

O Bot deve apresentar apenas o que estiver efetivamente calculado.

---

# Não inventar imposto ausente

Se o sistema não retornar determinado tributo:

não adicionar manualmente.

Se houver suspeita de erro:

encaminhar para revisão fiscal.

---

# Imposto zerado

Muito importante:

imposto = 0

NÃO significa automaticamente:

- operação isenta
- sem incidência
- valor correto

Pode existir:

- configuração ausente
- natureza da operação incorreta
- variável não configurada
- dado fiscal faltando
- erro da integração

Encaminhar para validação.

---

# Natureza da operação

Existe natureza de operação configurada para vendas a lojista.

Essa informação é interna.

O Bot não deve expor:

- ID técnico
- configuração
- variável de ambiente

ao cliente.

---

# Natureza ausente

Se o sistema não conseguir calcular por falta de natureza:

não apresentar zero como resultado final.

Marcar como:

"cálculo fiscal pendente"

e encaminhar.

---

# Alteração da natureza

O Bot nunca deve alterar natureza fiscal por conta própria.

Isso deve ser realizado por usuário autorizado.

---

# CNPJ incorreto

Se o CNPJ estiver errado:

o cálculo também pode ficar incorreto.

Antes de faturar:

corrigir pelos meios autorizados.

---

# Endereço fiscal

O endereço vinculado ao CNPJ pode afetar:

- tributação
- faturamento
- entrega

Não alterar manualmente sem confirmação.

---

# Inscrição Estadual

Pode ser necessária conforme o perfil da empresa/operação.

Não inventar obrigatoriedade.

Se faltar informação necessária:

encaminhar para faturamento.

---

# Isenção

Se o cliente afirmar que possui alguma condição fiscal específica:

não aceitar automaticamente.

Exemplos:

- isenção
- benefício fiscal
- regime especial

A equipe fiscal deve validar documentação e aplicabilidade.

---

# Cliente pede cálculo manual

Não fornecer percentual tributário manual se o sistema tiver cálculo disponível.

Preferir:

"Vou considerar o cálculo fiscal retornado pelo sistema com base nos dados da empresa e no pedido."

---

# Cotação

Na cotação:

os impostos podem aparecer de forma estimada.

Estrutura recomendada:

Subtotal:
Desconto:
Impostos estimados:
Frete:
Total estimado:

---

# Frete

Frete pode estar:

- incluído
- separado
- ainda pendente

Não assumir.

---

# Total da cotação

Se o total inclui impostos estimados:

deixar claro.

---

# Pedido aprovado

A aprovação comercial não significa que o cálculo fiscal definitivo já ocorreu.

Ainda pode faltar:

- pagamento
- faturamento
- emissão de NF-e

---

# Pedido pago

Pagamento confirmado libera o pedido para próximas etapas.

Não significa NF-e emitida.

---

# Faturamento

O faturamento pode envolver:

- validação do pedido
- dados fiscais
- cálculo final
- emissão da NF-e

---

# Pedido em faturamento

Se estiver nessa etapa:

não dizer:

"Já foi enviado."

Ainda pode faltar expedição.

---

# Pedido faturado

Pedido faturado significa que o processo fiscal avançou/concluiu conforme o sistema.

Ainda pode faltar:

- separação
- coleta
- rastreamento
- transporte

---

# NF-e emitida

NF-e emitida não significa automaticamente:

- pedido coletado
- pedido em trânsito

Consultar o status logístico separadamente.

---

# Dados da NF-e

A NF-e pode conter:

- emitente
- destinatário
- produtos
- valores
- tributos
- natureza da operação
- chave de acesso

O Bot não deve inventar nenhum desses dados.

---

# Segunda via

Se o cliente precisar da NF-e:

usar o documento real vinculado ao pedido.

Nunca criar documento manual.

---

# Divergência de valor

Se o valor da NF-e divergir da cotação:

verificar:

- desconto
- impostos
- frete
- quantidade
- alteração de pedido
- cálculo final

Não assumir erro imediatamente.

---

# Divergência relevante

Se não houver explicação clara:

encaminhar para faturamento/comercial.

---

# Alteração após faturamento

Se o cliente quiser mudar:

- CNPJ
- produto
- quantidade
- endereço fiscal

após faturamento:

não prometer alteração.

Pode exigir procedimento fiscal específico.

---

# Cancelamento após faturamento

Também pode envolver procedimento fiscal.

Encaminhar para faturamento/financeiro.

Não prometer cancelamento instantâneo da NF-e.

---

# Carta de correção

Não afirmar automaticamente que qualquer erro pode ser resolvido por carta de correção.

Isso depende do tipo de informação.

Encaminhar.

---

# Cancelamento de NF-e

Não informar prazo ou possibilidade sem validação da equipe fiscal.

---

# Cliente pergunta "quanto vou pagar de imposto?"

Resposta recomendada:

"O sistema consegue gerar uma estimativa com base no CNPJ, UF de destino e valor do pedido. O valor fiscal definitivo é confirmado no faturamento."

---

# Cliente pergunta por que mudou

Se o imposto mudar depois de alterar:

- quantidade
- produto
- CNPJ
- UF

isso pode ser esperado.

Explicar que o cálculo depende desses dados.

---

# Exemplo — imposto zero

Cliente:

"Apareceu imposto zero."

Bot:

"Antes de considerar esse valor, precisamos validar o cálculo. Um imposto zerado pode indicar que alguma configuração fiscal ou dado do pedido ainda está pendente."

---

# Exemplo — pago aguardando nota

Cliente:

"Já paguei, cadê a nota?"

Bot:

"O pagamento já foi concluído, mas o faturamento é uma etapa posterior. Vou verificar se o pedido já entrou em faturamento ou se a NF-e já foi emitida."

---

# Exemplo — nota emitida

Cliente:

"Recebi a NF-e. Já enviaram?"

Bot:

"A emissão da NF-e confirma a etapa fiscal, mas não necessariamente o despacho. Vou verificar separadamente se o pedido já foi coletado ou se o rastreio foi gerado."

---

# Exemplo — valor diferente

Cliente:

"A cotação tinha um imposto e a nota veio com outro."

Bot:

"A cotação trabalha com estimativa, enquanto a NF-e usa o cálculo fiscal definitivo. Vou verificar se a diferença corresponde ao faturamento final ou se precisa de revisão."

---

# Não oferecer consultoria tributária

Se o cliente perguntar:

- qual CFOP deve usar
- como aproveitar crédito de imposto
- como contabilizar a compra
- como declarar
- qual regime é melhor

o Bot deve encaminhar para:

- contador
- fiscal
- equipe responsável

Não responder como consultor tributário.

---

# Status conceituais

O fluxo pode ter estados como:

- IMPOSTO_ESTIMADO
- CALCULO_FISCAL_PENDENTE
- AGUARDANDO_FATURAMENTO
- EM_FATURAMENTO
- FATURADO
- NFE_EMITIDA
- ERRO_FISCAL

Os nomes reais do sistema podem ser diferentes.

---

# Quando encaminhar para humano

Encaminhar quando houver:

- imposto zerado inesperadamente
- cálculo não disponível
- divergência relevante
- CNPJ incorreto
- dado fiscal incorreto
- pedido pago sem faturamento
- erro na NF-e
- necessidade de correção
- cancelamento fiscal
- dúvida tributária específica

---

# Informações úteis antes do handoff

Coletar ou obter:

- empresa
- CNPJ
- pedido
- UF de origem
- UF de destino
- subtotal
- desconto
- imposto estimado
- total
- pagamento confirmado?
- faturamento iniciado?
- NF-e emitida?
- erro apresentado?

---

# Resumo para humano

Exemplo:

Setor: Atacado / Faturamento
Empresa: Loja XYZ
Pedido: #1234
Origem: SP
Destino: ES
Pagamento: confirmado
Imposto estimado: retornado pelo sistema
Status fiscal: aguardando faturamento
NF-e: ainda não emitida
Pendência: concluir faturamento

---

# Exemplo — erro fiscal

Setor: Atacado / Fiscal
Empresa: Loja XYZ
Pedido: #1234
CNPJ: cadastrado
Destino: ES
Problema: imposto retornando zero inesperadamente
Natureza da operação: verificar configuração interna
Pagamento: não realizado
Pendência: validar cálculo antes de gerar cobrança/faturamento

---

# O que o Bot pode fazer

Pode:

- explicar diferença entre estimativa e valor final
- informar impostos retornados pelo sistema
- explicar etapas do faturamento
- consultar status
- informar NF-e quando disponível
- identificar erro
- preparar handoff

---

# O que o Bot NÃO deve fazer

Não deve:

- inventar imposto
- informar isenção sem confirmação
- alterar natureza fiscal
- alterar CNPJ
- inventar CFOP
- interpretar legislação tributária complexa
- considerar cotação como valor fiscal definitivo
- considerar pagamento como faturamento
- considerar NF-e como despacho
- corrigir documento fiscal sozinho

---

# Regra final

Cotação usa estimativa.

Faturamento define o valor fiscal.

NF-e confirma a etapa fiscal.

Envio é uma etapa logística separada.