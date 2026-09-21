---
type: wholesale
topic: quotation
brand: Mibro
updated: 2026-09-18
---

# Atacado e Revenda — Cotação

## Objetivo

Este arquivo orienta o Bot sobre o fluxo de cotação para atacado e revenda.

A cotação pode envolver:

- cliente / empresa
- CNPJ
- vendedor responsável
- produtos
- quantidades
- preço unitário de atacado
- desconto
- impostos estimados
- total
- observações
- simulação
- cotação real
- aprovação interna
- geração de pedido

O Bot deve diferenciar:

- simulação
- cotação válida
- pedido real
- pedido aprovado

Essas etapas não são equivalentes.

---

# Regra principal

O Bot NÃO deve:

- inventar preço de atacado
- multiplicar automaticamente o preço de varejo
- criar desconto por conta própria
- inventar imposto
- aprovar cotação
- transformar simulação em pedido real
- prometer condição comercial

Todos os valores devem vir da regra comercial vigente ou do sistema.

---

# Quantidade mínima

A operação atual de atacado começa a partir de:

10 unidades

O total pode envolver um mix de produtos, conforme as regras vigentes.

O Bot não deve assumir que precisam ser 10 unidades do mesmo modelo.

---

# Montagem da cotação

A cotação pode conter:

- empresa
- CNPJ
- comprador
- vendedor
- produtos
- quantidade de cada item
- preço unitário
- desconto
- subtotal
- impostos estimados
- total estimado

---

# Produto

Antes de adicionar:

confirmar o modelo correto.

Especial atenção para:

- Lite 3 / Lite 3 Pro
- GS Pro / GS Pro 2
- GS Active / GS Active2
- Explorer / Explorer S

Não misturar SKUs ou modelos.

---

# Quantidade

Registrar a quantidade por produto.

Exemplo:

GS Pro 2: 5
Lite 3 Pro: 5

Total: 10 unidades

Se estiver abaixo do mínimo:

não concluir cotação de atacado sem regra especial.

---

# Preço de varejo

O preço de varejo pode aparecer apenas como referência visual.

Ele NÃO deve ser usado como base automática do preço de atacado.

---

# Preço unitário de atacado

Deve vir da regra comercial vigente.

Pode depender de:

- produto
- quantidade
- desconto
- faixa comercial
- condição específica

Nunca inventar.

---

# Desconto

O desconto pode ser calculado pelo sistema ou definido por regra comercial.

O Bot não deve alterar.

Se o cliente pedir:

"Consegue mais desconto?"

encaminhar para comercial.

---

# Desconto final

Quando houver desconto aprovado:

apresentar de forma clara.

Exemplo:

Subtotal:
Desconto:
Impostos estimados:
Total:

Não esconder componentes importantes.

---

# Impostos

A cotação pode mostrar uma estimativa de impostos.

A estimativa pode depender de:

- CNPJ
- UF
- origem
- destino
- natureza da operação
- valor final

O Bot deve deixar claro quando não for valor fiscal definitivo.

---

# Imposto zerado

Se o sistema retornar zero inesperadamente:

não informar ao cliente que a operação é isenta.

Pode existir:

- configuração incompleta
- erro de integração
- natureza de operação ausente
- dado fiscal faltante

Encaminhar para revisão.

---

# UF de destino

A UF pode afetar o cálculo.

Usar o endereço/CNPJ confirmado.

Não selecionar manualmente outra UF para reduzir imposto.

---

# Frete

O frete pode ficar fora da cotação inicial.

Quando não estiver incluído:

informar claramente:

"Frete não incluído nesta estimativa."

Não inventar valor.

---

# Total

O total deve vir do cálculo real.

Não fazer arredondamento manual diferente do sistema.

---

# Simulação

Uma simulação serve para:

- testar mix de produtos
- verificar valores
- estudar cenário
- salvar para depois

Simulação NÃO é pedido.

---

# Salvar simulação

Quando o sistema permitir:

pode ser salva no histórico do cliente.

Isso ajuda em:

- comparação
- retorno posterior
- follow-up

Não transformar automaticamente em pedido.

---

# Cotação real

Uma cotação real é uma proposta comercial destinada ao cliente.

Pode precisar de:

- confirmação
- aprovação
- validade
- vendedor responsável

---

# Cotação teste

Se o sistema permitir cotação teste:

marcar claramente como teste.

Não enviar ao cliente como proposta oficial.

---

# Validade da cotação

Não inventar validade.

Se houver validade oficial:

usar a definida pelo sistema/comercial.

---

# Preços podem mudar

Quando a cotação não estiver aprovada:

os preços podem depender das condições vigentes.

Não garantir manutenção indefinida.

---

# Estoque

Antes de transformar em pedido real:

verificar disponibilidade.

Uma cotação não deve significar reserva automática de estoque.

---

# Reserva

Não prometer reserva sem funcionalidade real.

---

# Lançamentos

Produtos `coming_soon` não devem entrar como disponibilidade garantida.

Pode existir interesse futuro, mas não pedido imediato sem liberação.

---

# Aprovação interna

Depois da cotação:

pode haver etapa de aprovação por responsável/supervisor.

Enquanto estiver pendente:

não afirmar que a condição está confirmada.

---

# Cotação aprovada

Depois de aprovada:

pode seguir para criação do pedido.

Ainda não significa:

- pagamento
- faturamento
- envio

---

# Reprovação ou ajuste

Se a cotação precisar de ajuste:

a equipe pode alterar:

- desconto
- quantidade
- produto
- condição comercial

O Bot não deve justificar decisões internas sem informação oficial.

---

# Pedido real

Somente criar/considerar pedido real quando o fluxo confirmar.

Não confundir com simulação.

---

# Pedido no Olist

O pedido pode ser criado no Olist como:

Em aberto

Isso significa que ainda pode haver etapas pendentes.

---

# Pedido de teste

Se o sistema possuir modo de teste:

não enviar para faturamento ou cobrança.

Separar claramente de pedido real.

---

# Pedido aprovado

Após aprovação:

o fluxo pode gerar link de pagamento.

Consultar:

08_Atacado_Revenda/atacado-geral.md

---

# Link de pagamento

Só pode ser apresentado quando existir no sistema.

Não inventar.

---

# Cliente quer alterar a cotação

Pode alterar antes da finalização, conforme o fluxo.

Exemplos:

- quantidade
- mix
- modelo

Recalcular com dados atuais.

---

# Cliente quer remover produto

Atualizar a cotação e recalcular.

Se ficar abaixo do mínimo:

alertar.

---

# Cliente quer adicionar produto

Adicionar e recalcular.

Verificar estoque e regra comercial.

---

# Cliente quer trocar modelo

Não copiar preço do modelo anterior.

O novo item precisa seguir a própria regra.

---

# Cotação duplicada

Antes de criar nova:

consultar se já existe uma ativa semelhante.

Evitar histórico desnecessariamente duplicado.

---

# Histórico

Salvar quando possível:

- data
- vendedor
- produtos
- quantidades
- valores
- status
- observações

---

# Follow-up

Uma cotação não concluída pode gerar follow-up.

O Bot pode registrar interesse.

Não prometer contato em data que não esteja configurada.

---

# Cliente pede PDF/proposta

Se o sistema possuir geração de proposta:

usar os dados atuais.

Não gerar valores diferentes do sistema.

---

# Negociação

Qualquer pedido de:

- desconto adicional
- prazo especial
- exclusividade
- condição de pagamento diferenciada

deve ser encaminhado para comercial humano.

---

# Exemplo — nova cotação

Cliente:

"Quero 6 GS Pro 2 e 4 Lite 3 Pro."

Bot:

"Perfeito. Isso fecha 10 unidades e entra no fluxo de atacado. Vou considerar os dois modelos, calcular a condição comercial vigente e os impostos estimados com base nos dados da empresa."

---

# Exemplo — abaixo do mínimo

Cliente:

"Quero 5 unidades."

Bot:

"O fluxo atual de atacado começa a partir de 10 unidades. Para 5 unidades, posso te orientar pelas condições atuais de varejo ou registrar o interesse para o comercial avaliar alguma exceção."

---

# Exemplo — desconto

Cliente:

"Se eu levar 30, melhora o preço?"

Bot:

"A condição pode mudar conforme o volume, mas eu não consigo criar desconto por conta própria. Vou considerar as 30 unidades no cálculo e, se você quiser uma condição adicional, encaminho para o comercial."

---

# Exemplo — imposto

Cliente:

"O imposto deu zero."

Bot:

"Antes de considerar esse valor, precisamos validar o cálculo. Um imposto zerado pode indicar configuração ou dado fiscal incompleto, então não vou tratar isso como isenção sem conferência."

---

# Exemplo — simulação

Cliente:

"Quero só ver quanto ficaria."

Bot:

"Sem problema. Podemos montar como simulação, sem gerar pedido real. Depois você decide se quer seguir com a proposta."

---

# Exemplo — transformar em pedido

Cliente:

"Gostei, pode fechar."

Bot:

"Vou considerar essa cotação como intenção real e seguir para a etapa de aprovação/pedido. Isso ainda não significa pagamento ou faturamento concluído."

---

# Status recomendados

Conceitualmente, a cotação pode passar por:

- RASCUNHO
- SIMULACAO
- AGUARDANDO_APROVACAO
- APROVADA
- REPROVADA
- AJUSTE_SOLICITADO
- CONVERTIDA_EM_PEDIDO
- CANCELADA

Os nomes reais do sistema podem ser diferentes.

Não assumir implementação técnica sem confirmar.

---

# Informações úteis antes do handoff

Coletar ou obter:

- empresa
- CNPJ
- vendedor
- produtos
- quantidades
- subtotal
- desconto
- impostos estimados
- total
- tipo: simulação ou real
- status
- observações

---

# Resumo para humano

Exemplo:

Setor: Atacado / Comercial
Empresa: Loja XYZ
CNPJ: cadastrado
Cotação: real
Itens:
- GS Pro 2: 10
- Lite 3 Pro: 10
Quantidade total: 20
Desconto: calculado pelo sistema
Impostos: estimados
Frete: não incluído
Status: aguardando aprovação
Pendência: validação comercial

---

# O que o Bot pode fazer

Pode:

- montar cotação
- registrar produtos
- registrar quantidades
- calcular usando regras do sistema
- mostrar impostos estimados
- salvar simulação
- converter intenção em fluxo real
- preparar handoff

---

# O que o Bot NÃO deve fazer

Não deve:

- inventar preço
- inventar desconto
- inventar imposto
- aprovar cotação
- transformar simulação em pedido sem confirmação
- reservar estoque sem funcionalidade
- gerar link de pagamento
- prometer validade
- alterar regra comercial

---

# Regra final

Simulação serve para estudar.

Cotação serve para propor.

Aprovação valida a condição.

Pedido inicia a operação.