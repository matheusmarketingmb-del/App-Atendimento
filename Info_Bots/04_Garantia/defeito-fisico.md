---
type: warranty
topic: physical_defect
brand: Mibro
updated: 2026-09-18
---

# Defeito Físico — Mibro Brasil

## Objetivo

Este arquivo orienta o Bot sobre casos em que pode existir:

- dano físico
- defeito estrutural
- quebra
- trinca
- botão quebrado
- carcaça danificada
- tela descolando
- bateria estufada
- carregador danificado
- deformação
- peça solta
- possível dano interno

O Bot deve identificar rapidamente quando deve:

- parar de sugerir testes
- priorizar segurança
- encaminhar para avaliação humana

---

# Regra principal

Quando houver sinal físico visível, o Bot não deve tentar resolver com muitos testes.

Problemas físicos exigem avaliação.

O Bot NÃO deve:

- mandar abrir o produto
- mandar desmontar
- recomendar cola
- recomendar solda
- recomendar pressão na tela
- recomendar reparo caseiro
- garantir que está ou não coberto pela garantia

---

# Tela quebrada

Se houver:

- trinca
- vidro quebrado
- lasca
- tela estilhaçada

encaminhar para avaliação humana.

Não orientar:

- pressionar a tela
- colar
- aquecer
- desmontar

Resposta recomendada:

"Como existe dano físico na tela, o ideal é encaminhar para avaliação. Não recomendo pressionar, abrir ou tentar reparar em casa."

---

# Tela descolando

Se a tela estiver:

- levantando
- descolando
- separando da carcaça

tratar com atenção.

Pode existir:

- falha de adesão
- deformação
- pressão interna
- possível problema de bateria

Não orientar pressionar a tela para fechar.

Encaminhar.

---

# Bateria estufada

Sinais possíveis:

- tela levantando
- tampa traseira abrindo
- carcaça deformada
- pressão interna aparente

Se houver suspeita de bateria estufada:

orientar imediatamente:

- parar de usar
- não carregar
- não perfurar
- não pressionar
- não abrir

Encaminhar para avaliação humana.

---

# Superaquecimento

Se o cliente relatar:

- calor excessivo
- aquecimento anormal
- cheiro estranho
- fumaça

orientar:

- interromper o uso
- desconectar do carregador, se estiver carregando
- não continuar testando

Encaminhar imediatamente.

---

# Cheiro de queimado

Se houver cheiro de queimado:

não realizar mais testes.

Orientar:

- desligar/desconectar quando seguro
- não carregar novamente
- não abrir o produto

Encaminhar imediatamente.

---

# Fumaça

Se houver fumaça:

priorizar segurança.

Não orientar novos testes.

Encaminhar imediatamente.

---

# Botão quebrado

Se botão estiver:

- quebrado
- solto
- preso
- afundado
- sem resposta após impacto

não orientar desmontagem.

Se o problema parecer apenas travamento de software, pode haver verificação simples.

Se houver dano físico:

encaminhar.

---

# Coroa/botão giratório

Se o modelo possuir coroa/botão giratório e houver:

- folga excessiva
- quebra
- travamento físico
- peça soltando

encaminhar.

Não aplicar força.

---

# Carcaça danificada

Danos como:

- amassado
- rachadura
- deformação
- abertura da caixa

podem afetar:

- estrutura
- vedação
- resistência à água

Encaminhar para avaliação.

---

# Pulseira

Problemas podem incluir:

- rasgo
- rompimento
- ressecamento
- pino quebrado
- encaixe danificado

Não confundir pulseira danificada com defeito eletrônico.

Se houver risco de queda do relógio:

orientar não usar até corrigir.

---

# Pino da pulseira

Se o pino estiver:

- quebrado
- torto
- solto

não recomendar improvisos que possam causar queda do relógio.

Encaminhar para acessório/substituição adequada.

---

# Carregador danificado

Sinais:

- fio rompido
- conector quebrado
- contato queimado
- cabo exposto
- derretimento

Orientar:

- parar de usar
- não improvisar
- não emendar
- não continuar carregando

Encaminhar.

---

# Contatos de carregamento danificados

Se os contatos estiverem:

- quebrados
- soltos
- afundados
- queimados

não recomendar raspagem ou ajuste manual.

Encaminhar.

---

# Oxidação

Se houver:

- ferrugem
- corrosão
- oxidação nos contatos

não orientar:

- raspar
- lixar
- usar produto químico

Encaminhar para avaliação.

---

# Peça solta

Se o cliente disser:

"Tem uma peça solta dentro."

ou:

"Faz barulho quando mexo."

Não orientar abrir.

Encaminhar.

---

# Barulho interno

Se o barulho não for esperado:

registrar:

- modelo
- quando começou
- houve queda?
- funcionamento atual

Encaminhar se persistir.

---

# Dano após queda

Se o problema começou após:

- queda
- impacto
- pancada

registrar.

Não afirmar:

"foi mau uso"

ou:

"perdeu garantia".

A análise humana decide.

---

# Dano após água

Se houver dano após:

- piscina
- mar
- banho
- sauna
- vapor
- água quente

consultar também:

03_Suporte/resistencia-agua.md

Encaminhar.

---

# Tela com linhas/manchas

Pode indicar:

- falha do display
- dano interno
- impacto

Não tentar reparar.

Consultar também:

03_Suporte/tela-display.md

---

# Vidro intacto, mas display falha

Mesmo sem trinca externa, pode existir falha interna.

Exemplos:

- tela preta
- manchas
- linhas
- touch sem resposta

Pode ser possível defeito de hardware.

Encaminhar após verificações básicas.

---

# Produto não liga após queda

Não insistir em:

- reset
- atualização
- múltiplos carregamentos

Se houve impacto e não liga:

encaminhar.

---

# Produto não liga sem queda

Pode ser:

- bateria
- carregamento
- software
- hardware

Consultar:

03_Suporte/carregamento.md

Se não houver resposta:

encaminhar.

---

# Risco de segurança

Casos prioritários:

- bateria estufada
- fumaça
- cheiro de queimado
- superaquecimento
- faísca
- derretimento
- deformação significativa

Nesses casos:

não continuar troubleshooting.

---

# Exemplo — tela descolando

Cliente:

"A tela está levantando."

Bot:

"Não pressione a tela de volta e não continue carregando se houver deformação ou aquecimento. Como pode existir um problema físico interno, vou encaminhar para avaliação."

---

# Exemplo — botão quebrado

Cliente:

"O botão lateral caiu."

Bot:

"Como existe dano físico no botão, não é indicado tentar abrir ou recolocar em casa. Vou encaminhar para avaliação técnica."

---

# Exemplo — bateria estufada

Cliente:

"A tela está sendo empurrada para fora."

Bot:

"Pare de usar e não coloque para carregar. Não pressione nem abra o relógio. Esse caso precisa de avaliação técnica."

---

# Exemplo — carregador derretido

Cliente:

"Meu cabo derreteu."

Bot:

"Pare de usar esse carregador imediatamente e não faça novos testes com ele. Vou encaminhar o caso para avaliação."

---

# Garantia

Defeito físico pode ou não estar coberto.

A cobertura depende de:

- causa
- origem
- documentação
- condições de uso
- análise técnica

O Bot não decide.

Consultar:

04_Garantia/garantia-geral.md
04_Garantia/exclusoes-garantia.md

---

# Informações úteis antes do handoff

Coletar quando necessário:

- modelo
- dano observado
- quando começou
- houve queda
- houve água
- houve aquecimento
- produto ainda liga
- NF-e
- local da compra
- data aproximada

---

# Resumo para humano

Exemplo:

Setor: Suporte / Garantia
Assunto: Defeito físico
Modelo: Lite 3 Pro
Problema: tela descolando
Aquecimento: não informado
Queda: não
Água: não
Produto liga: sim
NF-e: disponível
Pendência: avaliação física

---

# Quando encaminhar imediatamente

Encaminhar imediatamente em caso de:

- bateria estufada
- fumaça
- cheiro de queimado
- faísca
- derretimento
- superaquecimento
- tela descolando com deformação
- possível curto

---

# Quando encaminhar após poucas verificações

Encaminhar quando houver:

- botão quebrado
- tela quebrada
- carcaça rachada
- contato danificado
- oxidação
- peça solta
- display com falha física
- dano após queda
- dano após água

---

# O que o Bot pode fazer

Pode:

- reconhecer sinal físico
- priorizar segurança
- interromper troubleshooting
- coletar contexto
- encaminhar

---

# O que o Bot NÃO deve fazer

Não deve:

- abrir o produto
- orientar desmontagem
- recomendar solda
- recomendar cola
- recomendar pressão
- recomendar calor
- mandar perfurar bateria
- garantir cobertura
- negar cobertura
- culpar o cliente

---

# Regra final

Quando houver dano físico:

menos testes, mais segurança.

Quando houver risco:

parar imediatamente e encaminhar.