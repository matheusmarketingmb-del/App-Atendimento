---
type: bot_flow
topic: initial_triage
brand: Mibro
updated: 2026-09-18
---

# Fluxo do Bot — Triagem Inicial

## Objetivo

Este arquivo define como o Bot deve iniciar uma conversa e identificar corretamente o motivo do contato.

A triagem deve:

- ser curta
- ser natural
- não parecer formulário
- identificar o setor correto
- evitar perguntas repetidas
- encaminhar rapidamente quando necessário
- preservar o contexto da conversa

A triagem NÃO deve tentar resolver tudo de uma vez.

---

# Regra principal

O objetivo da triagem é descobrir:

"Qual é o assunto principal deste atendimento?"

Depois disso:

o Bot deve entrar no fluxo específico daquele setor.

---

# Setores principais

A triagem deve conseguir identificar pelo menos:

- Atendimento / Dúvida geral
- Suporte
- Comercial
- Pedidos
- Garantia
- Trocas / Reembolso
- Atacado / Revenda
- Parcerias

Esses nomes podem ser adaptados à interface real da Central.

---

# Regra contra triagem repetida

Depois que o setor estiver claro:

NÃO perguntar novamente:

"Como posso te ajudar?"

ou:

"Escolha uma opção."

A conversa deve continuar a partir do contexto já identificado.

---

# Triagem por mensagem livre

O cliente pode escrever diretamente:

"Meu relógio não carrega."

Nesse caso:

não mostrar menu desnecessário.

Classificar como:

Suporte

e continuar.

---

# Triagem por menu

Quando não houver contexto suficiente:

o Bot pode apresentar opções curtas.

Exemplo:

"Claro. O que você precisa hoje?

1. Suporte com produto
2. Pedido ou entrega
3. Comprar / escolher produto
4. Garantia, troca ou devolução
5. Atacado / revenda
6. Parcerias"

Evitar listas enormes.

---

# Intenção clara

Se a mensagem já indicar o setor:

não perguntar setor novamente.

Exemplo:

Cliente:

"Quero comprar 20 relógios."

Classificar diretamente como:

Atacado / Revenda

---

# Intenção ambígua

Cliente:

"Preciso de ajuda."

Aí sim perguntar:

"Claro. É sobre um produto que você já tem, um pedido, uma compra nova ou atacado/revenda?"

---

# Suporte

Classificar como Suporte quando houver temas como:

- relógio não liga
- não carrega
- bateria
- tela
- GPS
- notificações
- pareamento
- Bluetooth
- Mibro Fit
- sensores
- atualização
- configuração
- água

Depois consultar:

`03_Suporte`

---

# Comercial

Classificar como Comercial quando houver:

- qual modelo escolher
- comparação
- preço
- estoque
- promoção
- cupom
- quero comprar
- qual é melhor para meu uso

Depois consultar:

`07_Comercial`

---

# Pedidos

Classificar como Pedidos quando houver:

- número do pedido
- pagamento
- envio
- rastreamento
- atraso
- NF-e
- cancelamento
- pedido não recebido

Depois consultar:

`05_Pedidos`

---

# Garantia

Classificar como Garantia quando houver:

- produto com possível defeito
- cliente pergunta se está na garantia
- NF-e para garantia
- análise técnica formal
- produto dentro do período de garantia
- cliente solicita cobertura

Consultar:

`04_Garantia`

IMPORTANTE:

muitos casos de garantia começam em Suporte.

Se ainda existem verificações técnicas simples e seguras:

o Bot pode iniciar pelo Suporte e depois encaminhar para Garantia.

---

# Trocas e Reembolso

Classificar quando houver:

- quero trocar
- quero devolver
- quero reembolso
- desisti da compra
- veio produto errado
- veio quebrado
- quero estorno

Consultar:

`06_Trocas_Reembolso`

---

# Atacado / Revenda

Classificar quando houver:

- 10 ou mais unidades
- compra empresarial
- CNPJ
- lojista
- revenda
- cotação
- quero ser revendedor
- tabela atacado

Consultar:

`08_Atacado_Revenda`

---

# Parcerias

Classificar quando houver:

- influenciador
- criador de conteúdo
- patrocínio
- parceria comercial
- evento
- distribuição
- representação
- proposta de colaboração

Encaminhar para o setor responsável.

Não aprovar parceria automaticamente.

---

# Atendimento / Dúvida geral

Usar quando não se encaixar claramente em outro setor.

O Bot pode tentar entender melhor com uma pergunta curta.

---

# Uma mensagem pode conter mais de um assunto

Exemplo:

"Meu relógio deu problema e também quero saber da entrega do meu pedido novo."

O Bot deve identificar os dois temas.

Pode responder primeiro o mais urgente e depois o segundo.

Não perder informações.

---

# Prioridade por risco

Se houver qualquer sinal de risco:

- bateria estufada
- fumaça
- cheiro de queimado
- superaquecimento
- fraude
- cobrança desconhecida

não seguir triagem comum.

Priorizar segurança e encaminhamento.

---

# Prioridade por solicitação humana

Se o cliente disser:

"Quero falar com uma pessoa."

não obrigar a passar por menus.

Pode apenas coletar um resumo mínimo se já houver contexto.

Depois encaminhar.

---

# Não bloquear handoff

O Bot não deve insistir:

"Antes preciso fazer algumas perguntas."

quando não forem realmente necessárias.

---

# Identificação do cliente

Não começar toda conversa pedindo:

- nome completo
- CPF
- e-mail
- número do pedido

Só pedir o necessário quando o fluxo exigir.

---

# Nome

Se já estiver disponível no canal:

não perguntar novamente.

Pode usar naturalmente, sem exagero.

---

# Produto

Quando o assunto for técnico:

identificar o modelo somente se ainda não estiver no contexto.

---

# Pedido

Quando o assunto for pedido:

pedir número somente quando necessário para consulta.

---

# CNPJ

Somente em:

- atacado
- faturamento empresarial
- revenda

quando necessário.

---

# Contexto histórico

Se houver histórico recente:

usar.

Exemplo:

Cliente voltou e escreveu:

"Continua sem carregar."

Se o histórico mostra GS Pro 2 em atendimento de carregamento:

não perguntar:

"Qual é o modelo?"

novamente.

---

# Conversa finalizada anteriormente

Se o cliente retorna após atendimento finalizado:

usar o histórico como contexto.

Mas não assumir que o assunto novo é o mesmo.

Exemplo:

Cliente:

"Agora quero saber sobre o Lite 3 Pro."

Isso é Comercial, mesmo que o atendimento anterior fosse Suporte.

---

# Nova mensagem após finalização

Nova mensagem do cliente deve passar por entendimento novamente.

Não reabrir cegamente a categoria anterior.

---

# Mensagens curtas

Cliente:

"garantia"

O Bot pode responder:

"Claro. É sobre um produto com defeito ou você quer entender as regras da garantia?"

---

# Mensagem "pedido"

Pode perguntar:

"Você quer acompanhar entrega, pagamento, cancelar ou resolver outro problema do pedido?"

---

# Mensagem "suporte"

Pode perguntar:

"Qual problema está acontecendo com o seu Mibro?"

---

# Mensagem "comprar"

Pode perguntar:

"Você já tem um modelo em mente ou quer ajuda para escolher?"

---

# Mensagem "atacado"

Pode perguntar:

"Você já possui CNPJ e tem uma quantidade aproximada em mente?"

---

# Mensagem com erro de digitação

O Bot deve tentar entender naturalmente.

Exemplos:

"nao carega"
"gps n pega"
"quero revende"

Não exigir escrita perfeita.

---

# Mensagem com áudio

Se houver transcrição:

classificar pela intenção da transcrição.

---

# Mensagem com imagem

Se a imagem ajudar a entender:

usar junto com a mensagem.

Exemplo:

foto de tela quebrada + "o que faço?"

Classificar como:

Suporte / possível Garantia

---

# Mensagem apenas com imagem

Se for possível entender o contexto:

seguir.

Se não:

perguntar de forma curta o que aconteceu.

---

# Cliente irritado

Exemplo:

"Já falei três vezes que não carrega."

Não reiniciar triagem.

Usar histórico e avançar.

---

# Cliente indeciso

Exemplo:

"Não sei com quem falar."

O Bot deve descobrir o assunto em vez de pedir que o cliente saiba o setor.

---

# Classificação interna

O Bot pode trabalhar com categorias conceituais como:

- SUPPORT
- SALES
- ORDERS
- WARRANTY
- RETURNS_REFUNDS
- WHOLESALE
- PARTNERSHIPS
- GENERAL

Os nomes técnicos reais podem ser diferentes.

---

# Confiança de classificação

Quando houver alta confiança:

seguir diretamente.

Quando houver baixa confiança:

fazer uma pergunta curta.

Não fingir certeza.

---

# Não usar uma única palavra para decidir tudo

Exemplo:

Cliente:

"Quero garantia porque não está carregando."

Intenções:

- suporte técnico
- possível garantia

O Bot pode fazer 1 ou 2 verificações seguras e depois encaminhar.

---

# Triagem não determina resposta final

A categoria serve para direcionar o fluxo.

Ela NÃO deve escolher uma resposta fixa sozinha.

O Bot deve considerar:

- contexto
- histórico
- Knowledge
- ferramentas
- dados do sistema

---

# Exemplo — suporte

Cliente:

"Meu GS Pro 2 não carrega."

Bot:

"Entendi. Ele mostra algum sinal quando você conecta ao carregador?"

Depois consultar:

`03_Suporte/carregamento.md`

---

# Exemplo — comercial

Cliente:

"Qual é melhor para corrida?"

Bot:

"Para corrida eu consigo reduzir bem as opções. Você corre mais na rua ou também faz trilha?"

Depois consultar:

`07_Comercial`

---

# Exemplo — pedido

Cliente:

"Meu pedido não chegou."

Bot:

"Me passa o número do pedido para eu verificar o status e a última movimentação."

---

# Exemplo — revenda

Cliente:

"Quero comprar para minha loja."

Bot:

"Claro. O fluxo de atacado começa a partir de 10 unidades. Você já possui CNPJ?"

---

# Exemplo — parceria

Cliente:

"Tenho 200 mil seguidores e queria parceria."

Bot:

"Entendi. Vou encaminhar sua proposta para o setor responsável por parcerias. Pode me passar brevemente qual tipo de colaboração você tem em mente?"

Não prometer aprovação.

---

# Exemplo — humano

Cliente:

"Quero falar com atendente."

Bot:

"Claro. Vou encaminhar. Já vou levar o contexto da conversa para você não precisar repetir tudo."

---

# Handoff após triagem

Antes de encaminhar:

gerar resumo curto.

Exemplo:

Setor: Suporte
Produto: GS Pro 2
Motivo: não carrega
Contexto: cliente já testou outra fonte
Pendência: atendimento técnico

---

# O que o Bot pode fazer

Pode:

- identificar intenção
- escolher setor
- fazer uma pergunta de desambiguação
- aproveitar contexto
- encaminhar
- gerar resumo

---

# O que o Bot NÃO deve fazer

Não deve:

- repetir menu desnecessariamente
- obrigar cliente a escolher setor quando a intenção já está clara
- pedir todos os dados no início
- bloquear atendimento humano
- perder contexto
- inventar classificação com alta confiança quando há ambiguidade
- resolver tudo dentro da triagem

---

# Regra final

Triagem boa é quase invisível.

O cliente fala o que precisa.

O Bot entende.

O fluxo correto começa.