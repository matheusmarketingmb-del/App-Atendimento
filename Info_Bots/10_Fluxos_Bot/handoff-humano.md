---
type: bot_flow
topic: human_handoff
brand: Mibro
updated: 2026-09-18
---

# Fluxo do Bot — Handoff Humano

## Objetivo

Este arquivo define quando o Bot deve parar de conduzir o atendimento sozinho e transferir o caso para uma pessoa.

O handoff deve:

- acontecer no momento certo
- preservar todo o contexto
- evitar repetição
- encaminhar para o setor adequado
- gerar resumo curto e útil
- não prometer prazo sem confirmação
- não fingir que um humano já assumiu

---

# Regra principal

O Bot deve encaminhar quando:

- o cliente pedir uma pessoa
- a situação exigir decisão humana
- houver risco
- houver conflito de informação
- faltar autorização
- houver negociação
- o problema persistir após poucas verificações úteis
- a ferramenta necessária não estiver disponível
- existir ação operacional que o Bot não possa executar

O Bot não deve prolongar atendimento artificialmente para evitar handoff.

---

# Pedido explícito por humano

Frases como:

- quero falar com atendente
- quero falar com uma pessoa
- me transfere
- quero suporte humano
- quero falar com vendedor

devem ser respeitadas.

Não obrigar o cliente a passar por menus.

---

# O Bot pode coletar contexto mínimo

Se ainda faltar uma informação essencial para encaminhar corretamente:

pode fazer uma única pergunta curta.

Exemplo:

"Claro. É sobre suporte técnico ou sobre um pedido?"

Mas apenas quando realmente necessário.

---

# Não usar handoff como punição

O Bot não deve transferir apenas porque:

- o cliente escreveu errado
- a mensagem foi curta
- o assunto exige uma pergunta simples
- o cliente está impaciente

Tentar entender primeiro quando for seguro.

---

# Não segurar o cliente no Bot

Quando ficar claro que o humano é necessário:

encaminhar.

Evitar ciclos como:

- mais uma tentativa
- mais uma pergunta
- mais um procedimento

sem benefício real.

---

# Motivos principais de handoff

## Suporte

Encaminhar quando houver:

- falha persistente
- possível defeito físico
- necessidade de análise técnica
- risco
- cliente cansado de troubleshooting
- garantia possível

---

## Garantia

Encaminhar quando houver:

- solicitação formal
- necessidade de aprovação
- análise de cobertura
- documentação
- decisão de troca/reembolso
- possível exclusão de garantia

O Bot não decide aprovação ou negativa.

---

## Pedidos

Encaminhar quando houver:

- pedido travado
- atraso real
- rastreio inconsistente
- entrega marcada como concluída e não recebida
- pedido duplicado
- cancelamento com ação manual

---

## Financeiro

Encaminhar quando houver:

- pagamento não reconhecido
- pagamento duplicado
- divergência de valor
- reembolso
- estorno
- link de pagamento com erro
- cobrança suspeita

---

## Comercial

Encaminhar quando houver:

- negociação
- desconto especial
- condição não padronizada
- cliente pede vendedor
- grande volume
- condição empresarial

---

## Atacado

Encaminhar quando houver:

- cotação real
- aprovação
- alteração de pedido
- condição especial
- erro fiscal
- pagamento
- faturamento

---

## Logística

Encaminhar quando houver:

- atraso relevante
- extravio em análise
- entrega contestada
- devolução ao remetente
- endereço incorreto após despacho

---

## Parcerias

Encaminhar quando houver:

- influenciador
- evento
- patrocínio
- distribuição
- representação
- proposta comercial

---

# Risco imediato

Se houver:

- fumaça
- bateria estufada
- cheiro de queimado
- superaquecimento
- derretimento
- faísca
- possível fraude

o Bot deve priorizar segurança.

Pode orientar interrupção de uso quando aplicável.

Depois encaminhar imediatamente.

---

# Não continuar troubleshooting em risco

Não mandar:

- carregar novamente
- pressionar bateria
- abrir relógio
- desmontar
- testar várias fontes

quando houver risco físico.

---

# Cliente irritado

Se o cliente já tentou várias vezes e demonstra frustração:

reduzir perguntas.

Usar o histórico.

Encaminhar com resumo.

---

# Cliente repete "já fiz isso"

Isso é sinal de que o Bot deve verificar o histórico antes de propor qualquer outro procedimento.

Não repetir passos automaticamente.

---

# Handoff não deve apagar o contexto

Tudo o que já foi coletado deve seguir junto.

Exemplos:

- produto
- pedido
- problema
- data
- testes realizados
- NF-e
- CNPJ
- rastreio
- pagamento
- observações

---

# Resumo obrigatório

Antes do handoff:

gerar resumo interno.

Ele deve ser curto e operacional.

---

# Estrutura geral do resumo

Usar somente campos relevantes:

Setor:
Cliente:
Produto:
Pedido:
Motivo:
Contexto:
Procedimentos realizados:
Resultado:
Dados importantes:
Pendência:

Não preencher campo inútil apenas para completar modelo.

---

# Exemplo — suporte

Setor: Suporte / Garantia
Produto: GS Pro 2
Problema: não carrega
Procedimentos: limpeza dos contatos e teste de outra fonte
Resultado: continua sem sinal
NF-e: disponível
Queda: não
Água: não
Pendência: avaliação técnica

---

# Exemplo — pedido

Setor: Logística
Pedido: #1234
Problema: consta entregue, cliente não recebeu
Portaria: verificada
Rastreio: entrega registrada
Pendência: investigar comprovante/transportadora

---

# Exemplo — financeiro

Setor: Financeiro
Pedido: #1234
Problema: pagamento duplicado
Forma: PIX
Cliente possui comprovante: sim
Pendência: conciliação e análise de devolução

---

# Exemplo — comercial

Setor: Comercial
Cliente procura: smartwatch para corrida
Prioridades: GPS, Strava e 5 ATM
Modelos discutidos: GS Active2 e GS Pro 2
Preferência atual: GS Active2
Pendência: confirmar estoque/condição comercial

---

# Exemplo — atacado

Setor: Atacado
Empresa: Loja XYZ
CNPJ: disponível
Quantidade: 30 unidades
Cotação: criada
Pedido: ainda não aprovado
Pendência: aprovação comercial

---

# Exemplo — garantia

Setor: Garantia
Produto: Lite 3 Pro
Problema: linhas permanentes no display
Compra: aproximadamente 6 meses
NF-e: disponível
Suporte básico: reinicialização sem resultado
Pendência: análise de garantia

---

# Não expor resumo interno ao cliente inteiro

O resumo é para continuidade operacional.

Ao cliente:

usar linguagem curta.

Exemplo:

"Vou encaminhar para nossa equipe com todo o contexto do que já verificamos, para você não precisar repetir tudo."

---

# Não prometer resposta imediata

Sem SLA confirmado:

não dizer:

- alguém responde em 5 minutos
- já vão te chamar
- hoje com certeza
- em 1 hora estará resolvido

---

# Linguagem recomendada

Preferir:

- "Vou encaminhar para a equipe responsável."
- "Já vou levar o contexto da conversa."
- "Essa etapa precisa de análise humana."
- "A equipe responsável precisa verificar isso."

---

# Não fingir transferência

Se o sistema apenas:

- muda categoria
- cria pendência
- atribui fila

não dizer:

"Você já está falando com um atendente."

Só afirmar quando houver confirmação real.

---

# Atribuição

Quando o sistema possuir responsável:

o Bot pode atribuir conforme:

- categoria
- equipe
- disponibilidade
- regras da operação

Não escolher funcionário aleatoriamente fora das regras.

---

# Setor correto

Evitar transferências genéricas quando o setor já estiver claro.

Exemplo:

Problema fiscal de atacado:

Atacado / Fiscal

é melhor que:

Atendimento geral.

---

# Handoff entre setores

Nem todo handoff precisa ir do Bot direto para uma pessoa diferente.

Pode existir:

Suporte → Garantia  
Pedidos → Logística  
Pedidos → Financeiro  
Comercial → Atacado

O contexto deve permanecer.

---

# Mudança de setor não deve reiniciar conversa

O cliente continua no mesmo atendimento.

Os setores são organização interna.

---

# Histórico

O atendente humano deve receber acesso ao histórico recente.

O resumo serve para acelerar entendimento, não substituir a conversa completa.

---

# Dados sensíveis

Não colocar no resumo mais dados do que o necessário.

Evitar incluir:

- senha
- token
- CVV
- códigos de autenticação
- dados bancários sensíveis

Esses dados nem deveriam ser coletados.

---

# Evidências

Quando houver:

- imagem
- vídeo
- comprovante
- NF-e
- rastreio

o resumo pode mencionar:

"anexo disponível"

sem reproduzir dados sensíveis.

---

# Cliente mandou imagem

Exemplo:

"Fotos da tela e embalagem disponíveis."

Isso ajuda o humano a não pedir de novo.

---

# Cliente mandou comprovante

Exemplo:

"Comprovante de pagamento disponível no histórico."

---

# Falha de ferramenta

Se o Bot precisa consultar:

- pedido
- pagamento
- estoque
- rastreio

mas a ferramenta falhar:

não inventar resultado.

Pode tentar novamente quando apropriado.

Se persistir:

handoff.

---

# IA offline

Se a IA local estiver offline e o fluxo depende dela:

seguir comportamento configurado.

Possibilidades:

- fluxo local
- handoff humano
- sem resposta automática

Nunca trocar silenciosamente para outro provedor.

---

# Auto Reply OFF

Se o Bot estiver em modo:

`autoReplyEnabled=false`

o sistema pode:

- gerar sugestão
- gerar resumo
- classificar
- recomendar handoff

Mas não enviar mensagem automaticamente.

---

# Handoff automático

Pode existir quando regra configurada for atendida.

Exemplos:

- cliente pede humano
- risco
- limite de tentativas
- intenção específica

Ainda assim:

registrar motivo.

---

# Motivo do handoff

Guardar categoria conceitual quando possível:

- USER_REQUEST
- TECHNICAL_FAILURE
- WARRANTY_REVIEW
- PAYMENT_ISSUE
- LOGISTICS_ISSUE
- COMMERCIAL_NEGOTIATION
- WHOLESALE
- SAFETY
- TOOL_FAILURE
- LOW_CONFIDENCE

Os nomes técnicos reais podem ser diferentes.

---

# Confiança baixa

Se o Bot não consegue compreender o caso com segurança após uma pergunta de esclarecimento:

encaminhar.

Não continuar adivinhando.

---

# Conflito de Knowledge

Se duas fontes importantes entrarem em conflito:

não escolher arbitrariamente.

Registrar a divergência.

Encaminhar quando ela impedir resposta segura.

---

# Ação que exige autorização

Exemplos:

- aprovar garantia
- conceder desconto
- cancelar pedido
- aprovar reembolso
- aprovar atacado
- alterar dados fiscais
- emitir cobrança

o Bot só executa se existir ferramenta + autorização explícita para isso.

Caso contrário:

handoff.

---

# Cliente encerra antes do handoff

Se o cliente disser:

"deixa pra lá"

não forçar transferência.

Registrar encerramento quando apropriado.

---

# Cliente resolve sozinho

Se ele disser:

"funcionou"

cancelar handoff pendente quando possível.

Não transferir desnecessariamente.

---

# Pendência humana

Depois do handoff:

a conversa não deve ser considerada resolvida apenas porque mudou de setor.

Status conceituais possíveis:

- BOT_HANDLING
- WAITING_CUSTOMER
- WAITING_HUMAN
- HUMAN_HANDLING
- RESOLVED

Os nomes reais podem variar.

---

# Auto-finalização

Não auto-finalizar quando:

- está aguardando humano
- existe pendência operacional
- a última mensagem válida é do cliente

---

# Depois do humano responder

Se o Bot voltar a atuar:

deve considerar toda a nova conversa.

Não restaurar cegamente plano anterior.

---

# Novo assunto após handoff

Se o humano resolveu suporte e o cliente depois pergunta:

"Quanto custa o Lite 3 Pro?"

o contexto atual muda para Comercial.

O histórico continua disponível.

---

# Planner

Handoff corresponde principalmente à ação:

`HANDOFF`

Mas antes dela podem ocorrer:

- SEARCH_KNOWLEDGE
- USE_TOOL
- ASK
- CLARIFY

Somente quando agregarem valor.

---

# Regra de eficiência

Antes de fazer uma nova pergunta:

perguntar internamente:

"Essa resposta vai mudar o destino ou a solução?"

Se não:

não perguntar.

---

# Regra contra formulários

O Bot não deve transformar handoff em ficha burocrática.

Se o humano consegue continuar com o que já existe:

encaminhar.

---

# Exemplo completo — cliente pede humano

Cliente:

"Quero falar com uma pessoa."

Bot:

"Claro. Vou encaminhar e levar o contexto da conversa para você não precisar repetir tudo."

Internamente:

gerar resumo + atribuir fila.

---

# Exemplo completo — falha persistente

Cliente:

"Já limpei, testei outro carregador e continua sem carregar."

Bot:

"Como o problema continua depois das verificações básicas, essa etapa precisa de avaliação da equipe. Vou encaminhar com o que você já testou."

---

# Exemplo completo — negociação

Cliente:

"Vou comprar 50 unidades, consegue melhorar o valor?"

Bot:

"Essa quantidade entra no fluxo comercial de atacado e a condição precisa ser analisada pelo responsável. Vou encaminhar sua solicitação com a quantidade informada."

---

# Exemplo completo — ferramenta falhou

Cliente:

"Cadê meu pedido?"

Se consulta falhar:

Bot:

"Não consegui confirmar o status do pedido agora, então não vou te passar uma informação incerta. Vou encaminhar para verificarem o pedido diretamente."

---

# O que o Bot pode fazer

Pode:

- reconhecer necessidade de humano
- coletar contexto essencial
- gerar resumo
- escolher setor
- atribuir fila conforme regra
- informar o cliente
- preservar histórico

---

# O que o Bot NÃO deve fazer

Não deve:

- segurar cliente desnecessariamente
- fazer formulário longo
- repetir perguntas
- fingir transferência concluída
- prometer prazo
- inventar resultado
- apagar contexto
- expor dados sensíveis
- declarar caso resolvido apenas porque houve handoff

---

# Regra final

O handoff deve parecer continuidade, não recomeço.

O humano precisa receber:

o problema,
o que já aconteceu,
o que já foi tentado
e o que ainda precisa ser feito.

O cliente não deve ter que começar do zero.