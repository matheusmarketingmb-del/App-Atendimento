---
type: warranty
topic: warranty_requirements
brand: Mibro
source: https://mibrobrasil.com.br/pages/termos-de-garantia
updated: 2026-09-18
---

# Requisitos para Análise de Garantia — Mibro Brasil

## Objetivo

Este arquivo orienta o Bot sobre quais informações e documentos podem ser necessários para iniciar uma análise de garantia.

O Bot deve coletar apenas o necessário e evitar transformar o atendimento em um formulário longo.

A decisão final sobre cobertura é sempre da equipe responsável.

---

# Requisitos principais

Para análise de garantia, normalmente são necessários:

- modelo do produto
- descrição do defeito
- data aproximada da compra
- local da compra
- vendedor responsável
- Nota Fiscal eletrônica (NF-e)
- informações sobre quando o problema começou

Dependendo do caso, também podem ser necessários:

- fotos
- vídeos
- número de série
- evidências do defeito
- informações sobre contato com água
- informações sobre queda ou impacto

O Bot não deve exigir itens adicionais sem necessidade.

---

# Nota Fiscal eletrônica

A NF-e é um dos principais documentos para análise.

Ela deve permitir identificar:

- produto
- data da compra
- vendedor
- origem da compra

O Bot pode perguntar:

"Você possui a NF-e da compra?"

Não pedir imediatamente envio do documento se o fluxo humano fará isso depois.

---

# Compra em canal oficial ou revendedor autorizado

A garantia da Mibro Brasil é vinculada a produtos adquiridos em:

- canais oficiais
- revendedores autorizados

O Bot pode perguntar:

"Você lembra onde comprou e qual foi o vendedor?"

Isso é especialmente importante em marketplaces.

---

# Marketplace

Quando a compra foi feita em:

- Amazon
- Mercado Livre
- Shopee
- outro marketplace

não assumir elegibilidade apenas pelo nome da plataforma.

É necessário identificar:

- vendedor
- NF-e
- origem da compra

---

# Data da compra

A data ajuda a verificar o período de garantia.

Não exigir data exata se o cliente ainda não estiver com a nota em mãos.

Pode perguntar:

"Foi comprado há quanto tempo aproximadamente?"

Depois, a NF-e confirma a data oficial.

---

# Modelo do produto

Identificar corretamente o modelo.

Exemplos que não devem ser confundidos:

- GS Pro
- GS Pro 2
- GS Active
- GS Active2
- Lite 3
- Lite 3 Pro
- Explorer
- Explorer S

Se o cliente disser apenas:

"Meu GS"

perguntar qual modelo.

---

# Descrição do problema

O Bot deve registrar o problema de forma objetiva.

Exemplo:

Ruim:

"relógio não funciona"

Melhor:

"GS Pro 2 não inicia carregamento; nenhum sinal na tela mesmo após teste de outra fonte."

Isso ajuda o atendente humano a continuar sem repetir toda a conversa.

---

# Quando começou

Perguntar quando for relevante:

"Quando você percebeu esse problema pela primeira vez?"

Pode ajudar a identificar:

- falha repentina
- problema progressivo
- problema após atualização
- problema após queda
- problema após contato com água

---

# Procedimentos já realizados

Registrar apenas procedimentos realmente realizados.

Exemplos:

- reiniciou relógio
- testou outra fonte
- limpou contatos
- refez pareamento
- atualizou firmware
- testou em outro celular

Não marcar um procedimento como realizado se o cliente não confirmou.

---

# Queda ou impacto

Se o tipo de defeito justificar, perguntar:

"Houve alguma queda ou impacto antes do problema começar?"

Não usar tom acusatório.

Não dizer:

"Você derrubou?"

Preferir linguagem neutra.

---

# Contato com água

Quando relevante, perguntar:

"Teve contato com água, vapor ou banho antes do problema aparecer?"

Se sim, coletar apenas o necessário:

- tipo de contato
- água quente ou fria
- quando ocorreu

Consultar:

03_Suporte/resistencia-agua.md

---

# Fotos

Fotos podem ser úteis em casos de:

- tela quebrada
- trinca
- deformação
- oxidação
- carregador danificado
- produto fisicamente avariado

O Bot não deve pedir foto sem necessidade.

---

# Vídeos

Vídeos podem ser úteis quando o defeito é difícil de demonstrar em imagem.

Exemplos:

- reinicia sozinho
- tela piscando
- carregamento intermitente
- toque falhando
- botão com comportamento anormal

A solicitação de vídeo deve ocorrer apenas quando o fluxo permitir e fizer sentido.

---

# Número de série

O número de série pode ser necessário para identificação do produto.

Não exigir em todo atendimento.

Se necessário:

orientar o cliente a localizar conforme instrução oficial ou encaminhar para humano.

Não inventar onde o número fica em cada modelo sem confirmação.

---

# IMEI

Smartwatches desta Knowledge não devem ser tratados automaticamente como produtos com IMEI.

Não pedir IMEI se o modelo não utilizar esse identificador.

---

# CPF / CNPJ

Não solicitar CPF/CNPJ para análise técnica se não houver necessidade operacional.

Se o sistema exigir posteriormente para localizar pedido ou nota:

seguir o fluxo autorizado da Central.

---

# Dados pessoais

Coletar somente o necessário.

Evitar pedir:

- senha
- código de autenticação
- dados bancários
- token
- informações sensíveis sem necessidade

---

# Compra de presente

Se o produto foi presente:

a NF-e continua sendo importante para comprovação de compra.

O cliente pode precisar obter a nota com quem realizou a compra.

Não afirmar que presente perde garantia.

---

# Segunda via da NF-e

Se o cliente perdeu a nota:

não afirmar imediatamente que o atendimento é impossível.

Pode orientar:

- verificar e-mail da compra
- consultar o vendedor
- solicitar segunda via

Se ainda assim não conseguir:

encaminhar para análise humana.

---

# Produto usado

Se o cliente comprou de outra pessoa:

a elegibilidade pode depender da documentação e origem original do produto.

Não aprovar ou negar automaticamente.

Encaminhar para análise.

---

# Importação direta

Se o cliente comprou fora dos canais oficiais brasileiros:

registrar:

- país/origem
- vendedor
- existência ou não de NF-e brasileira

A garantia oficial da Mibro Brasil pode não se aplicar.

Consultar:

04_Garantia/garantia-geral.md

---

# Revendedor autorizado

Se o cliente não sabe se o vendedor é autorizado:

não inventar.

Registrar o nome do vendedor e encaminhar para verificação.

---

# Ordem ideal de coleta

Não pedir tudo em uma única mensagem.

Fluxo recomendado:

1. entender o defeito;
2. identificar modelo;
3. fazer verificações básicas seguras, quando aplicável;
4. confirmar aproximadamente quando comprou;
5. perguntar se possui NF-e;
6. identificar onde comprou;
7. coletar detalhe extra somente se necessário.

---

# Exemplo natural

Cliente:

"Meu relógio parou de carregar."

Bot:

"Qual é o modelo?"

Cliente:

"GS Pro 2."

Bot:

"Você já testou outra fonte e conferiu se os contatos estão limpos e secos?"

Cliente:

"Sim, não mudou."

Bot:

"Entendi. Como continua sem carregar, vale encaminhar para análise. Você possui a NF-e e lembra onde comprou?"

Isso é melhor que pedir 10 informações de uma vez.

---

# Handoff mínimo recomendado

Antes de encaminhar um possível caso de garantia, tentar ter:

- modelo
- problema
- compra aproximada
- local da compra
- NF-e: sim/não
- verificações realizadas

Se algum item não estiver disponível:

não impedir o handoff.

---

# Resumo para humano

Exemplo:

Setor: Suporte / Garantia
Modelo: GS Active2
Problema: não liga
Compra: aproximadamente 7 meses
Local: Mercado Livre
Vendedor: informado
NF-e: disponível
Queda: não
Água: não
Procedimentos: carregamento e reinicialização tentados
Resultado: sem resposta
Pendência: análise de garantia

---

# Casos em que o Bot deve encaminhar mesmo com dados incompletos

Encaminhar quando houver:

- risco de segurança
- superaquecimento
- bateria estufada
- fumaça
- cheiro de queimado
- dano físico relevante
- possível entrada de líquido
- produto completamente sem resposta
- cliente sem conseguir localizar documentação

Não prender o cliente em coleta de informações se o caso precisa de avaliação.

---

# O que o Bot pode solicitar

Pode solicitar, quando necessário:

- modelo
- descrição do problema
- compra aproximada
- loja/vendedor
- confirmação de NF-e
- fotos/vídeos
- histórico do problema

---

# O que o Bot NÃO deve solicitar

Não pedir:

- senha
- token
- código 2FA
- cartão bancário
- senha de e-mail
- informações médicas
- dados pessoais não relacionados ao atendimento

---

# Regra sobre documentos

A documentação ajuda na análise, mas o Bot não é responsável por validar autenticidade de NF-e.

Essa validação deve ocorrer no fluxo humano/sistema autorizado.

---

# Regra final

O objetivo é entregar o caso para o atendente já organizado.

Não é obrigar o cliente a preencher um formulário inteiro antes de falar com uma pessoa.