---
type: warranty
topic: warranty_handoff
brand: Mibro
updated: 2026-09-18
---

# Encaminhamento de Garantia — Mibro Brasil

## Objetivo

Este arquivo orienta o Bot sobre como preparar e encaminhar um caso de possível garantia para atendimento humano.

O objetivo é evitar que o cliente precise repetir toda a história.

O Bot deve:

- entender o problema
- fazer apenas verificações seguras
- coletar dados essenciais
- identificar possíveis fatores relevantes
- gerar resumo estruturado
- encaminhar para humano

---

# Regra principal

O Bot NÃO aprova nem reprova garantia.

O Bot apenas prepara o caso.

A decisão final deve ser feita pela equipe responsável.

---

# Quando iniciar handoff de garantia

Encaminhar quando houver:

- possível defeito de fabricação
- produto que não liga
- falha persistente de carregamento
- problema físico
- tela com defeito
- sensor com falha persistente
- GPS/GNSS com falha recorrente
- superaquecimento
- bateria com comportamento anormal
- possível entrada de líquido
- atualização que deixou o produto sem funcionar
- problema recorrente sem solução
- solicitação explícita de garantia pelo cliente

---

# Antes do handoff

Tentar obter, quando possível:

- modelo
- problema
- quando começou
- compra aproximada
- local da compra
- vendedor
- possui NF-e
- procedimentos já realizados

Coletar informações adicionais apenas quando relevantes.

---

# Não transformar em formulário

Não perguntar tudo de uma vez.

Exemplo ruim:

"Informe modelo, data, loja, vendedor, NF, serial, CPF, endereço, problema, queda e água."

Exemplo melhor:

Cliente:

"Meu GS Pro 2 não carrega."

Bot:

"Você já conferiu se os contatos estão limpos e secos e testou outra fonte adequada?"

Cliente:

"Sim."

Bot:

"Entendi. Como continua sem carregar, vou encaminhar para análise. Você possui a NF-e e lembra onde comprou?"

---

# Dados mínimos

O handoff pode acontecer mesmo que nem todas as informações estejam disponíveis.

Dados mínimos desejáveis:

- modelo
- problema
- procedimentos já realizados

Se possível, também:

- NF-e
- local da compra
- compra aproximada

---

# Nota Fiscal

Registrar como:

- disponível
- não disponível
- cliente vai localizar
- não informado

Não inventar.

---

# Local da compra

Registrar o canal real informado pelo cliente.

Exemplos:

- loja oficial Mibro Brasil
- Amazon
- Mercado Livre
- Shopee
- revendedor físico
- importação
- outro

Se marketplace:

registrar também o vendedor, se conhecido.

---

# Compra aproximada

Se o cliente não souber a data exata:

registrar algo como:

- aproximadamente 3 meses
- aproximadamente 8 meses
- mais de 1 ano
- não informado

A NF-e será usada posteriormente para confirmação.

---

# Procedimentos realizados

Registrar somente o que o cliente realmente fez.

Exemplos:

- limpeza dos contatos
- teste em outra fonte
- reinicialização
- novo pareamento
- atualização
- teste ao ar livre
- teste em outro celular

Nunca preencher automaticamente uma etapa como realizada.

---

# Queda

Registrar como:

- sim
- não
- não informado

Quando sim:

adicionar breve contexto.

Exemplo:

Queda: sim, aproximadamente 1 semana antes do problema.

---

# Água

Registrar como:

- não
- chuva
- piscina
- mar
- banho
- banho quente
- sauna
- vapor
- outro
- não informado

Não concluir automaticamente que causou o defeito.

---

# Risco de segurança

Se houver:

- bateria estufada
- fumaça
- cheiro de queimado
- faísca
- superaquecimento
- derretimento

o Bot deve:

1. interromper troubleshooting;
2. orientar a parar de usar/carregar;
3. encaminhar imediatamente.

---

# Prioridade do handoff

## Prioridade alta

Casos com:

- superaquecimento
- bateria estufada
- fumaça
- cheiro de queimado
- curto/faísca
- produto deformando
- possível risco elétrico

## Prioridade normal

Casos como:

- não carrega
- não liga
- sensor não funciona
- display falha
- GPS falha
- botão não funciona
- problema recorrente

---

# Estrutura padrão do resumo

Utilizar:

Setor:
Assunto:
Produto:
Problema:
Quando começou:
Compra aproximada:
Local da compra:
Vendedor:
NF-e:
Queda:
Água:
Procedimentos realizados:
Resultado:
Risco:
Pendência:

---

# Exemplo — carregamento

Setor: Suporte / Garantia
Assunto: Carregamento
Produto: Mibro GS Pro 2
Problema: não inicia carregamento
Quando começou: há 2 dias
Compra aproximada: 5 meses
Local da compra: Amazon
Vendedor: informado pelo cliente
NF-e: disponível
Queda: não
Água: não
Procedimentos realizados: limpeza dos contatos e teste de outra fonte adequada
Resultado: continua sem sinal de carregamento
Risco: nenhum relatado
Pendência: avaliação técnica e de garantia

---

# Exemplo — tela

Setor: Suporte / Garantia
Assunto: Display
Produto: Mibro Lite 3 Pro
Problema: linhas permanentes na tela
Quando começou: hoje
Compra aproximada: 7 meses
Local da compra: Loja Oficial
NF-e: disponível
Queda: cliente informa que não
Água: não informado
Procedimentos realizados: reinicialização simples
Resultado: linhas permanecem
Risco: nenhum
Pendência: avaliação do display

---

# Exemplo — água

Setor: Suporte / Garantia
Assunto: Possível dano por líquido
Produto: Mibro GS Pro
Problema: tela apagou após contato com água
Quando começou: logo após banho
Compra aproximada: 4 meses
NF-e: disponível
Água: banho quente
Queda: não
Procedimentos realizados: nenhum após orientação
Resultado: tela sem resposta
Risco: possível umidade interna
Pendência: avaliação física e elegibilidade de garantia

---

# Exemplo — bateria estufada

Setor: Suporte / Garantia
Assunto: Risco / bateria
Produto: Mibro Lite 3
Problema: tela levantando da carcaça
Quando começou: hoje
NF-e: disponível
Aquecimento: sim
Procedimentos realizados: cliente orientado a parar de usar e não carregar
Resultado: aguardando avaliação
Risco: alto
Pendência: atendimento prioritário

---

# Handoff para defeito físico

Quando houver dano físico:

não tentar continuar troubleshooting.

Resumo deve conter:

- dano visível
- queda/impacto
- água
- funcionamento atual
- aquecimento
- documentação

---

# Handoff para carregamento

Deve incluir, quando possível:

- aparece sinal na tela?
- testou outra fonte?
- contatos estão limpos/secos?
- há aquecimento?
- carregador está danificado?

---

# Handoff para bateria

Registrar:

- autonomia atual
- autonomia anterior
- GPS/AOD/chamadas
- atualização recente
- aquecimento
- comportamento irregular

---

# Handoff para GPS

Registrar:

- ambiente de teste
- atividade utilizada
- se funcionava antes
- se encontra satélites
- se problema é rota, distância ou aquisição
- testes realizados

---

# Handoff para sensores

Registrar:

- sensor afetado
- se alguma leitura funciona
- se já funcionava antes
- ajuste/limpeza realizados
- atualização recente
- queda/água

---

# Handoff para atualização

Registrar:

- modelo
- porcentagem onde parou
- erro exibido
- relógio responde?
- bateria
- número de tentativas
- resultado

---

# Evitar repetição

Se o cliente já informou:

"Comprei na Amazon há 5 meses e tenho nota."

não perguntar novamente:

"Onde comprou?"
"Quando comprou?"
"Tem nota?"

Usar o histórico.

---

# Resumo automático

O Bot deve transformar a conversa em resumo curto e objetivo.

Não copiar mensagens inteiras.

Ruim:

"Cliente disse 'meu relógio não carrega', depois disse 'já testei outra tomada'..."

Melhor:

"GS Pro 2 sem carregamento; testou outra fonte e limpou contatos; sem resposta."

---

# Linguagem interna

O resumo para atendente pode ser técnico e direto.

A mensagem para o cliente deve continuar natural.

---

# Mensagem antes do handoff

Exemplo:

"Como você já fez as verificações básicas e o problema continua, vou encaminhar o caso para nossa equipe avaliar. Já vou enviar o resumo com o modelo, o que aconteceu e os testes que você fez para você não precisar explicar tudo novamente."

---

# Cliente sem NF-e

Não bloquear o handoff.

Mensagem recomendada:

"A NF-e é importante para análise, mas vou encaminhar o caso mesmo assim. Se conseguir localizar a nota ou solicitar uma segunda via ao vendedor, isso pode ajudar a equipe."

---

# Cliente sem saber vendedor

Não bloquear.

Registrar:

Vendedor: não informado.

---

# Cliente sem saber modelo

Se possível:

tentar identificar antes.

Se não conseguir:

encaminhar com:

Produto: modelo não confirmado.

---

# Garantia expirada

Mesmo quando aparentemente passou de 1 ano:

não encerrar automaticamente.

Pode existir:

- suporte técnico
- opção de reparo
- orientação comercial
- outro atendimento aplicável

Encaminhar conforme necessidade.

---

# Importação direta

Se for importado:

registrar claramente:

Origem: importação direta.

Não prometer garantia Mibro Brasil.

---

# Marketplace

Sempre que possível, registrar:

Marketplace:
Vendedor:

Exemplo:

Marketplace: Amazon
Vendedor: Loja XYZ

A plataforma sozinha não define elegibilidade.

---

# O que o Bot pode fazer

Pode:

- identificar possível caso de garantia
- coletar contexto
- executar verificações seguras
- gerar resumo
- classificar risco operacional
- encaminhar

---

# O que o Bot NÃO deve fazer

Não deve:

- aprovar garantia
- negar garantia definitivamente
- prometer troca
- prometer reembolso
- criar prazo não confirmado
- culpar o cliente
- esconder fatores relevantes
- inventar informações faltantes

---

# Regra final

O handoff ideal deve fazer o atendente humano entender o caso em poucos segundos.

O cliente não deve precisar começar o atendimento novamente do zero.