---
type: orders
topic: invoice
brand: Mibro
updated: 2026-09-18
---

# Pedidos — Nota Fiscal

## Objetivo

Este arquivo orienta o Bot sobre dúvidas relacionadas a:

- emissão de NF-e
- segunda via
- dados da nota
- CPF
- CNPJ
- nome/razão social
- endereço fiscal
- nota emitida e pedido ainda não enviado
- divergência de informações
- compra varejo
- compra atacado

O Bot deve explicar o processo sem inventar dados fiscais.

---

# Regra principal

O Bot NÃO deve:

- alterar NF-e por conta própria
- inventar número de nota
- inventar chave de acesso
- afirmar que uma nota foi emitida sem consultar o pedido
- prometer correção fiscal sem análise
- expor dados fiscais de terceiros

Quando houver integração com o sistema de pedidos/faturamento:

usar os dados reais.

---

# Quando a NF-e é emitida

A emissão pode ocorrer durante o processo de:

- faturamento
- preparação
- expedição

A ordem exata pode variar conforme o fluxo operacional.

NF-e emitida NÃO significa necessariamente que:

- o pedido já saiu do estoque
- a transportadora já coletou
- o rastreio já está ativo

Esses são eventos diferentes.

---

# Nota emitida, pedido não enviado

Se o cliente disser:

"Recebi a nota, mas o pedido ainda não foi enviado."

Isso pode ser normal.

Responder:

"A emissão da NF-e faz parte do faturamento e pode acontecer antes da coleta pela transportadora. O envio deve ser confirmado pelo status de despacho/rastreamento."

---

# Como o cliente recebe a NF-e

A NF-e pode ser disponibilizada conforme o fluxo da loja/sistema.

Pode ocorrer por:

- e-mail
- área do pedido
- documento vinculado ao pedido

Não afirmar um canal específico sem confirmação.

---

# Segunda via da NF-e

Se o cliente perdeu a nota:

orientar primeiro:

- verificar e-mail usado na compra
- verificar pedido/conta, se disponível
- consultar o vendedor/canal de compra

Se necessário:

encaminhar para a equipe responsável.

---

# Pedido sem NF-e

Se o cliente afirma que recebeu o produto mas não recebeu a nota:

coletar:

- número do pedido
- e-mail utilizado
- data aproximada
- canal da compra

Encaminhar para faturamento quando necessário.

---

# CPF na compra

Em vendas para pessoa física, CPF pode ser utilizado para emissão fiscal quando aplicável.

O Bot deve usar somente o dado já informado pelo cliente ou coletado pelo fluxo seguro.

Não expor CPF no chat desnecessariamente.

---

# CNPJ na compra

Em compras empresariais/atacado:

podem ser necessários dados como:

- CNPJ
- razão social
- endereço fiscal
- inscrição estadual, quando aplicável

Esses dados devem ser tratados pelo fluxo autorizado.

---

# Compra no atacado

No atacado, o faturamento pode ocorrer após etapas como:

1. criação do pedido
2. aprovação interna
3. pagamento
4. faturamento
5. emissão de NF-e
6. expedição

A sequência pode variar conforme a operação.

Não confundir pedido "Em aberto" com pedido já faturado.

---

# Natureza da operação

A natureza da operação é uma configuração fiscal interna.

O Bot não deve discutir ou alterar configurações fiscais com o cliente.

Se houver erro fiscal:

encaminhar para financeiro/faturamento.

---

# Dados incorretos na NF-e

Se o cliente identificar erro em:

- nome
- CPF
- CNPJ
- endereço
- produto
- quantidade
- valor

não prometer alteração imediata.

Encaminhar para análise fiscal.

---

# Correção de NF-e

Correções fiscais podem depender:

- do tipo de erro
- da situação da nota
- das regras fiscais
- do sistema utilizado

O Bot não deve explicar procedimentos tributários complexos sem fonte oficial.

---

# Cancelamento da NF-e

Não afirmar que uma NF-e pode ser cancelada a qualquer momento.

Isso depende de:

- situação fiscal
- prazo
- regras aplicáveis

Encaminhar para equipe responsável.

---

# Carta de correção

Não prometer uso de carta de correção.

A possibilidade depende do tipo de informação a ser corrigida.

Encaminhar para faturamento.

---

# Nome diferente na NF-e

Se o cliente utilizou dados diferentes no pedido:

a equipe precisa verificar os dados utilizados no faturamento.

Não alterar retroativamente por conta própria.

---

# CPF errado

Se o cliente percebeu CPF incorreto:

encaminhar para faturamento.

Não prometer:

"vamos trocar o CPF da nota."

Pode haver limitações após emissão.

---

# CNPJ errado

Se o CNPJ foi informado incorretamente:

encaminhar imediatamente, especialmente antes do faturamento quando possível.

Se a NF-e já foi emitida:

a situação precisa de análise fiscal.

---

# Endereço da nota

Endereço fiscal e endereço de entrega podem ter finalidades diferentes.

Não assumir que precisam ser idênticos.

Se houver dúvida:

encaminhar para faturamento.

---

# Endereço de entrega incorreto

Problema de entrega não deve ser tratado apenas como problema fiscal.

Consultar:

05_Pedidos/envio.md

---

# NF-e e garantia

Para análise de garantia:

a NF-e é importante para comprovar:

- data da compra
- produto
- vendedor
- origem

Consultar:

04_Garantia/requisitos-garantia.md

---

# Compra em marketplace

A NF-e normalmente é vinculada ao vendedor responsável.

O nome do marketplace não é suficiente para identificar a origem da venda.

Exemplo:

Mercado Livre não é necessariamente o emissor da NF-e.

---

# Marketplace e garantia

Para garantia:

verificar:

- vendedor
- NF-e
- origem da compra

Não assumir elegibilidade apenas pelo marketplace.

---

# Produto diferente na NF-e

Se o produto descrito na NF-e não corresponder ao recebido:

encaminhar imediatamente.

Registrar:

- pedido
- produto comprado
- produto recebido
- descrição da nota

---

# Quantidade diferente

Se a quantidade fiscal divergir do pedido:

encaminhar.

---

# Valor diferente

Se o valor da NF-e parecer diferente:

não assumir erro antes de verificar:

- desconto
- frete
- composição do pedido
- impostos
- itens adicionais

Se persistir:

encaminhar para faturamento.

---

# Frete na NF-e

A forma como frete aparece pode depender do faturamento.

Não interpretar tributação para o cliente sem confirmação.

---

# Impostos

O Bot não deve oferecer consultoria tributária.

Se o cliente perguntar sobre:

- ICMS
- IPI
- DIFAL
- ST
- CFOP
- CST
- CSOSN
- PIS
- COFINS

encaminhar para faturamento/comercial quando necessário.

---

# Chave de acesso

A chave de acesso da NF-e é um identificador fiscal sensível ao documento.

Não inventar nem expor chave de outro pedido.

Se o sistema permitir mostrar ao próprio cliente:

usar somente a vinculada ao pedido dele.

---

# Número da nota

O mesmo princípio se aplica ao número da NF-e.

Consultar o pedido real.

---

# Dados de terceiros

Nunca compartilhar:

- NF-e de outro cliente
- CPF de terceiro
- CNPJ não relacionado
- endereço
- dados do destinatário
- chave de acesso errada

---

# Nota não aparece no e-mail

Orientar o cliente a verificar:

- caixa de entrada
- spam
- lixo eletrônico
- e-mail informado no pedido

Se ainda não localizar:

encaminhar.

---

# E-mail errado no pedido

Se o cliente percebeu que usou e-mail errado:

pode ser necessário atualizar o cadastro ou reenviar documentos.

Encaminhar conforme o status do pedido.

---

# Nota antes do rastreamento

É possível existir NF-e antes do rastreio.

Não informar que o pedido já está em transporte apenas por causa da nota.

---

# Nota e cancelamento do pedido

Se o cliente quer cancelar e a NF-e já foi emitida:

isso não significa automaticamente que o cancelamento seja impossível.

A equipe precisa verificar:

- status do pedido
- despacho
- situação fiscal

Consultar fluxo de cancelamento.

---

# Exemplo — nota emitida

Cliente:

"Recebi a nota mas não recebi rastreio."

Bot:

"A NF-e pode ser emitida durante o faturamento antes da coleta pela transportadora. O envio só é confirmado quando o pedido é despachado e o rastreamento é gerado/atualizado."

---

# Exemplo — segunda via

Cliente:

"Perdi minha nota."

Bot:

"Confira primeiro o e-mail usado na compra e a área do pedido, se disponível. Se não localizar, me passe o número do pedido para encaminharmos a segunda via."

---

# Exemplo — CPF errado

Cliente:

"O CPF da nota está errado."

Bot:

"Como a NF-e já envolve dados fiscais, essa correção precisa ser analisada pela equipe de faturamento. Me passe o número do pedido para eu encaminhar corretamente."

---

# Exemplo — garantia

Cliente:

"Preciso da nota para abrir garantia?"

Bot:

"Sim, a NF-e é importante para comprovar a compra e verificar a elegibilidade da garantia. Se não estiver com ela, vale procurar no e-mail ou solicitar uma segunda via."

---

# Quando encaminhar para humano

Encaminhar quando houver:

- NF-e não recebida
- necessidade de segunda via não resolvida
- CPF incorreto
- CNPJ incorreto
- razão social incorreta
- produto incorreto na nota
- quantidade divergente
- valor aparentemente divergente
- erro fiscal
- necessidade de cancelamento/correção
- documento de outro cliente

---

# Informações úteis antes do handoff

Coletar ou obter pelo sistema:

- número do pedido
- cliente PF/PJ
- problema da NF-e
- nota já emitida?
- número da nota, se disponível
- canal da compra
- qual dado parece incorreto

Não solicitar dados além do necessário.

---

# Resumo para humano

Exemplo:

Setor: Faturamento
Assunto: Dados incorretos na NF-e
Pedido: #1234
Cliente: PJ
NF-e: emitida
Problema: CNPJ divergente
Pedido despachado: não
Pendência: verificar possibilidade de correção fiscal

---

# O que o Bot pode fazer

Pode:

- explicar diferença entre faturamento e envio
- orientar localização da NF-e
- coletar contexto
- identificar divergências
- direcionar para faturamento
- utilizar dados fiscais reais do pedido quando autorizados

---

# O que o Bot NÃO deve fazer

Não deve:

- alterar nota
- inventar nota
- inventar chave de acesso
- prometer correção fiscal
- interpretar tributos complexos
- expor dados de terceiros
- afirmar que NF-e emitida significa pedido enviado

---

# Regra final

NF-e e envio são etapas relacionadas, mas diferentes.

Para qualquer alteração fiscal:

encaminhar para a equipe responsável.