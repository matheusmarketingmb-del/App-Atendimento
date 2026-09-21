---
type: bot_flow
topic: warranty_orders_flow
brand: Mibro
updated: 2026-09-18
---

# Fluxo do Bot — Garantia, Pedidos, Trocas e Reembolso

## Objetivo

Este arquivo define como o Bot deve conduzir atendimentos relacionados a:

- garantia
- pedido
- pagamento
- envio
- rastreamento
- cancelamento
- devolução
- troca
- reembolso
- produto não recebido
- produto incorreto
- avaria
- possível defeito

O objetivo é manter continuidade entre os setores sem fazer o cliente repetir tudo.

---

# Regra principal

O Bot deve entender primeiro:

"Qual é o problema real agora?"

Depois disso:

- consultar o fluxo correto
- usar os dados já disponíveis
- evitar mudar de setor sem necessidade
- preservar todo o contexto
- encaminhar com resumo estruturado

---

# Não refazer triagem

Se o assunto já está claro:

não voltar para:

"Escolha uma opção."

Exemplo:

Cliente:

"Meu pedido chegou, mas o relógio não liga."

O fluxo já possui dois contextos:

- pedido entregue
- possível problema técnico/garantia

Não precisa refazer triagem.

---

# Contexto compartilhado

Informações coletadas em um fluxo devem continuar disponíveis nos próximos.

Exemplo:

Se já sabemos:

- pedido #1234
- GS Pro 2
- compra há 4 meses
- NF-e disponível

o fluxo de garantia não deve perguntar tudo novamente.

---

# Fluxos relacionados

## Garantia

Consultar:

`04_Garantia`

## Pedidos

Consultar:

`05_Pedidos`

## Trocas e reembolso

Consultar:

`06_Trocas_Reembolso`

---

# Caso 1 — problema técnico sem pedido envolvido

Cliente:

"Meu relógio não carrega."

Começar em:

`03_Suporte`

Se persistir e houver possível defeito:

migrar para:

`04_Garantia`

---

# Caso 2 — cliente já pede garantia

Cliente:

"Quero acionar a garantia porque não carrega."

O Bot pode fazer apenas verificações básicas e seguras.

Não obrigar troubleshooting longo.

Depois:

encaminhar para garantia.

---

# Caso 3 — pedido não chegou

Cliente:

"Meu pedido não chegou."

Consultar:

`05_Pedidos/rastreamento.md`

e:

`05_Pedidos/pedido-nao-recebido.md`

Não falar de reembolso antes de investigar entrega.

---

# Caso 4 — consta entregue, mas não recebeu

Prioridade:

1. verificar portaria/recepção
2. verificar comprovante
3. analisar rastreio
4. encaminhar logística

Não afirmar extravio imediatamente.

---

# Caso 5 — produto chegou errado

Cliente:

"Comprei GS Pro 2 e chegou Lite 3."

Não tratar como defeito.

Consultar:

`06_Trocas_Reembolso/troca.md`

Classificar como:

divergência de item / troca logística.

---

# Caso 6 — produto chegou quebrado

Pode envolver:

- avaria de transporte
- troca
- possível análise

Não iniciar troubleshooting técnico longo.

Preservar:

- embalagem
- etiquetas
- fotos

Encaminhar.

---

# Caso 7 — produto funcionou e depois apresentou defeito

Começar por:

- suporte técnico
- verificações seguras

Se persistir:

garantia.

---

# Caso 8 — cliente quer devolver porque não gostou

Não classificar como defeito.

Consultar:

`06_Trocas_Reembolso/arrependimento.md`

---

# Caso 9 — cliente quer cancelar antes do envio

Consultar:

`05_Pedidos/cancelamento.md`

Prioridade:

verificar status antes do despacho.

---

# Caso 10 — cliente quer cancelar depois do envio

Pode virar:

- recusa
- devolução
- reembolso

Não prometer bloqueio do transporte.

---

# Caso 11 — cliente devolveu e quer saber do reembolso

Consultar:

`06_Trocas_Reembolso/devolucao.md`

Depois:

`06_Trocas_Reembolso/reembolso.md`

Separar:

- postado
- recebido
- conferido
- reembolso processado

---

# Caso 12 — cliente pagou duas vezes

Consultar:

`05_Pedidos/pagamento.md`

Não pedir novo pagamento.

Encaminhar financeiro.

---

# Caso 13 — compra não reconhecida

Priorizar:

- segurança
- financeiro
- possível fraude

Não pedir dados completos do cartão.

---

# Garantia

## Quando usar

Quando houver:

- possível defeito de fabricação
- produto ainda dentro do período aplicável
- problema persistente
- cliente quer análise formal

Consultar:

`04_Garantia/garantia-geral.md`

---

# Requisitos

Quando necessário:

consultar:

`04_Garantia/requisitos-garantia.md`

Coletar apenas o essencial.

---

# Exclusões

Quando houver:

- queda
- água
- reparo externo
- importação
- vendedor não autorizado

consultar:

`04_Garantia/exclusoes-garantia.md`

IMPORTANTE:

O Bot não deve negar garantia sozinho.

---

# Dano físico

Consultar:

`04_Garantia/defeito-fisico.md`

Se houver risco:

parar troubleshooting.

---

# Encaminhamento de garantia

Consultar:

`04_Garantia/encaminhamento-garantia.md`

Gerar resumo curto.

---

# Pedidos

## Pagamento

Consultar:

`05_Pedidos/pagamento.md`

## Envio

Consultar:

`05_Pedidos/envio.md`

## Rastreamento

Consultar:

`05_Pedidos/rastreamento.md`

## NF-e

Consultar:

`05_Pedidos/nota-fiscal.md`

## Cancelamento

Consultar:

`05_Pedidos/cancelamento.md`

## Não recebido

Consultar:

`05_Pedidos/pedido-nao-recebido.md`

---

# Troca

Consultar:

`06_Trocas_Reembolso/troca.md`

Antes de afirmar qualquer solução:

identificar motivo.

---

# Devolução

Consultar:

`06_Trocas_Reembolso/devolucao.md`

Separar claramente as etapas.

---

# Reembolso

Consultar:

`06_Trocas_Reembolso/reembolso.md`

Não inventar prazo.

---

# Arrependimento

Consultar:

`06_Trocas_Reembolso/arrependimento.md`

Não confundir com garantia.

---

# Regra de transição entre setores

O Bot deve migrar de fluxo quando o contexto realmente mudar.

Exemplo:

Pedido → produto recebido → defeito detectado.

Fluxo:

Pedidos → Suporte → Garantia

Não precisa criar nova conversa.

---

# Preservar dados

Ao trocar de fluxo:

manter:

- pedido
- produto
- data
- NF-e
- status
- procedimentos
- contexto

---

# Não apagar contexto anterior

Mesmo que o setor mude:

o histórico ainda é útil.

---

# Exemplo — pedido atrasado vira devolução

Cliente:

"Meu pedido atrasou muito, quero cancelar."

Fluxo:

Pedidos → Cancelamento

Se já estiver em trânsito:

pode virar:

Cancelamento → Devolução

---

# Exemplo — defeito vira garantia

Cliente:

"Meu GS Pro 2 não carrega."

Depois de verificações básicas:

"Continua sem funcionar."

Fluxo:

Suporte → Garantia

---

# Exemplo — devolução vira reembolso

Cliente:

"Já devolvi o produto."

Fluxo:

Devolução → verificar recebimento → Reembolso

Não pular diretamente para:

"seu dinheiro já vai voltar."

---

# Exemplo — entregue não recebido

Cliente:

"Consta entregue."

Fluxo:

Pedido → Rastreamento → Investigação logística

Não ir diretamente para reembolso.

---

# Handoff entre setores

Quando mudar de responsável:

gerar resumo.

Exemplo:

Setor atual: Suporte
Destino: Garantia
Produto: GS Pro 2
Problema: não carrega
Procedimentos: contatos limpos, outra fonte testada
Resultado: sem resposta
Compra: 5 meses
NF-e: disponível
Pendência: análise de garantia

---

# Handoff para logística

Exemplo:

Setor atual: Pedidos
Destino: Logística
Pedido: #1234
Status: entregue
Cliente recebeu: não
Portaria verificada: sim
Comprovante: ainda não analisado
Pendência: investigação de entrega

---

# Handoff para financeiro

Exemplo:

Setor atual: Pedidos
Destino: Financeiro
Pedido: #1234
Problema: pagamento duplicado
Forma: PIX
Valores: registrados
Comprovante: disponível
Pendência: conciliação/reembolso

---

# Handoff para trocas

Exemplo:

Setor atual: Pedidos
Destino: Trocas
Pedido: #1234
Comprado: GS Pro 2
Recebido: Lite 3
Produto usado: não
Fotos: disponíveis
Pendência: troca por item incorreto

---

# Handoff para reembolso

Exemplo:

Setor atual: Devoluções
Destino: Financeiro
Pedido: #1234
Produto devolvido: sim
Recebimento confirmado: sim
Conferência: aprovada
Forma de pagamento: cartão
Pendência: processar/verificar estorno

---

# Não pedir tudo de uma vez

Mesmo nesses fluxos:

perguntar somente o necessário.

Exemplo ruim:

"Informe pedido, CPF, NF-e, endereço, modelo, forma de pagamento, data, fotos, vídeo..."

Exemplo melhor:

"Me passa o número do pedido para eu verificar o status primeiro."

---

# Dados do sistema têm prioridade

Se o sistema já possui:

- pedido
- pagamento
- rastreio
- NF-e
- produto

não pedir novamente.

---

# Dados dinâmicos

Sempre consultar sistema para:

- status
- rastreamento
- pagamento
- reembolso
- estoque
- emissão fiscal

Não confiar em Knowledge estática.

---

# Informações de política

Knowledge pode explicar:

- regras
- requisitos
- etapas

Mas o status real sempre deve vir do sistema.

---

# Cliente quer humano

Encaminhar.

Não forçar conclusão pelo Bot.

---

# Cliente frustrado

Se ele já passou por vários fluxos:

priorizar handoff com contexto.

Não reiniciar perguntas.

---

# Cliente volta depois

Se retornar:

usar histórico.

Mas entender se o assunto atual é o mesmo.

---

# Planner

Este fluxo pode usar:

- RESPOND
- ASK
- CLARIFY
- SEARCH_KNOWLEDGE
- USE_TOOL
- HANDOFF
- WAIT
- RESOLVE

---

# USE_TOOL

Usar quando precisar consultar:

- pedido
- pagamento
- entrega
- NF-e
- devolução
- reembolso

Não inventar resposta se a ferramenta não retornar dados.

---

# HANDOFF

Usar quando:

- precisa decisão humana
- precisa logística
- precisa financeiro
- precisa garantia
- cliente pediu humano
- há conflito de informação
- há risco

---

# WAIT

Usar quando:

- aguardando cliente fazer verificação
- aguardando atualização operacional
- aguardando retorno de rastreio

Mas não usar WAIT como desculpa para não encaminhar atraso real.

---

# RESOLVE

Usar quando:

- questão foi resolvida
- cliente confirmou solução
- nenhuma ação adicional está pendente

---

# Auto-finalização

Não finalizar automaticamente se:

a última mensagem válida foi do cliente.

Somente considerar quando:

- houve resposta da operação
- período de inatividade foi atingido
- não há ação pendente

---

# Pendência humana

Se existe:

- investigação
- garantia
- financeiro
- troca
- logística

não tratar como caso resolvido apenas porque o Bot encerrou a mensagem.

---

# O que o Bot pode fazer

Pode:

- identificar fluxo correto
- mover entre setores
- preservar contexto
- consultar Knowledge
- consultar sistema
- organizar handoff
- explicar status
- resolver casos simples

---

# O que o Bot NÃO deve fazer

Não deve:

- fazer cliente repetir tudo
- confundir pedido com garantia
- confundir devolução com reembolso
- confundir troca com defeito
- prometer resultado
- inventar status
- aprovar garantia
- aprovar reembolso
- declarar extravio sem confirmação
- esconder contexto na transferência

---

# Regra final

O cliente tem uma conversa.

Os setores são detalhes internos.

O Bot deve manter a continuidade mesmo quando o fluxo muda.