---
type: returns_refunds
topic: return
brand: Mibro
updated: 2026-09-18
---

# Trocas e Reembolso — Devolução

## Objetivo

Este arquivo orienta o Bot sobre situações relacionadas a:

- devolução de produto
- logística reversa
- devolução por arrependimento
- devolução por defeito
- devolução após troca aprovada
- produto postado de volta
- produto em trânsito de retorno
- produto recebido pela Mibro
- conferência
- liberação de reembolso

O Bot deve diferenciar claramente:

- devolução solicitada
- devolução autorizada
- produto postado
- produto em trânsito
- produto recebido
- produto conferido
- reembolso aprovado
- reembolso concluído

Essas etapas NÃO são equivalentes.

---

# Regra principal

O Bot NÃO deve dizer:

- "seu produto já foi recebido"
- "seu reembolso foi liberado"
- "vamos enviar a troca"
- "já está tudo certo"

sem confirmação real do sistema ou da equipe.

---

# Quando pode existir devolução

Uma devolução pode ocorrer por motivos como:

- arrependimento
- troca
- produto incorreto
- avaria
- defeito
- cancelamento após envio
- solicitação comercial autorizada

O motivo define o fluxo.

---

# Devolução não é automaticamente reembolso

O produto pode ser devolvido e ainda precisar passar por:

- transporte de retorno
- recebimento
- conferência
- análise
- aprovação financeira

Só depois pode existir reembolso, quando aplicável.

---

# Devolução solicitada

Se o cliente pediu devolução:

isso não significa que o fluxo já foi aprovado.

Registrar:

- pedido
- motivo
- produto
- data aproximada
- situação atual

Encaminhar para validação quando necessário.

---

# Devolução autorizada

Somente considerar autorizada quando houver confirmação real.

Depois disso, o cliente pode receber orientações de logística reversa.

---

# Logística reversa

Pode envolver:

- código de postagem
- etiqueta
- transportadora
- coleta
- instruções específicas

O Bot NÃO deve inventar:

- código
- transportadora
- endereço
- etiqueta
- prazo

Essas informações devem vir do fluxo oficial.

---

# Código de postagem

Se houver código oficial:

informar exatamente o código vinculado ao caso.

Nunca inventar.

Nunca reutilizar código de outro atendimento.

---

# Etiqueta

Quando o processo utilizar etiqueta:

orientar conforme instrução oficial.

Não gerar manualmente dados que não existam no sistema.

---

# Coleta no endereço

Se a devolução for por coleta:

não prometer data ou horário sem confirmação.

---

# Postagem pelo cliente

Quando o cliente diz:

"Já postei."

registrar:

- data
- código de rastreio de retorno, se houver
- transportadora
- comprovante, se disponível

Mas:

"postado" NÃO significa "recebido".

---

# Produto em trânsito de retorno

Enquanto o rastreio estiver voltando:

informar isso.

Não considerar conferência concluída.

---

# Produto entregue no retorno

Mesmo quando a transportadora marcar como entregue:

pode ainda faltar:

- entrada interna
- conferência
- identificação do pedido
- análise

Não dizer que o reembolso está liberado automaticamente.

---

# Produto recebido pela operação

Somente considerar recebido quando houver confirmação adequada.

A partir disso:

pode seguir para conferência.

---

# Conferência

A conferência pode verificar:

- produto
- modelo
- acessórios
- estado
- quantidade
- motivo da devolução
- documentação
- possível dano

O Bot não deve inventar resultado.

---

# Produto incompleto

Se estiver faltando:

- acessório
- componente
- item do kit

registrar e encaminhar.

Não decidir sozinho se a devolução será recusada.

---

# Caixa original

A ausência da caixa pode ser relevante dependendo do fluxo.

Não dizer automaticamente:

"sem caixa não aceitamos."

A equipe deve analisar conforme o motivo e a política.

---

# Acessórios

Dependendo do caso, podem ser necessários:

- carregador
- cabo
- pulseira
- manuais
- itens que acompanharam o produto

Não inventar lista obrigatória sem orientação oficial.

---

# Produto usado

Produto usado não deve gerar recusa automática pelo Bot.

É necessário considerar:

- motivo
- tempo
- condição
- política
- tipo de solicitação

---

# Produto com marcas

Registrar quando houver:

- riscos
- trincas
- impacto
- desgaste
- deformação

A equipe decide como isso afeta o processo.

---

# Devolução por defeito

Se a devolução estiver ligada a defeito:

consultar também:

04_Garantia/garantia-geral.md
04_Garantia/encaminhamento-garantia.md

Não transformar automaticamente em reembolso.

---

# Devolução por troca

Quando a devolução faz parte de troca:

o novo envio pode depender de:

- recebimento
- conferência
- aprovação
- disponibilidade

Não prometer novo envio antes disso.

---

# Devolução por arrependimento

O fluxo deve seguir a política aplicável.

O Bot deve registrar:

- quando recebeu
- quando solicitou
- condição do produto
- status atual

Não inventar prazo legal/político se não estiver confirmado na base correspondente.

---

# Devolução após recusa de entrega

Se o cliente recusou a entrega:

o produto pode voltar automaticamente ao remetente.

Mesmo assim:

acompanhar retorno.

Não considerar devolvido até confirmação.

---

# Pedido retornando por endereço incorreto

Não tratar como devolução voluntária.

Pode ser ocorrência logística.

Consultar:

05_Pedidos/pedido-nao-recebido.md

Depois a equipe decide:

- reenvio
- correção
- cancelamento
- reembolso

---

# Produto errado

Se o cliente recebeu item diferente:

pode ser necessário devolver o item incorreto antes do envio correto.

Consultar:

06_Trocas_Reembolso/troca.md

---

# Avaria

Se o produto chegou avariado:

orientar preservação de:

- embalagem
- etiquetas
- fotos
- conteúdo

Não pedir que o cliente descarte o produto.

---

# Comprovante de postagem

Quando existir:

pode ser útil para confirmar início da devolução.

O Bot pode registrar:

- data
- código
- agência/transportadora

Não pedir informações desnecessárias.

---

# Rastreio da devolução

Quando houver:

usar o código real.

Separar sempre:

Rastreio de ida
Rastreio de retorno

Não confundir os dois.

---

# Devolução parada

Se o retorno estiver sem movimentação:

verificar:

- última atualização
- previsão
- transportadora

Se houver atraso relevante:

encaminhar para logística.

---

# Devolução extraviada

Não declarar extravio sozinho.

Se houver possível perda no retorno:

encaminhar para investigação.

---

# Produto recebido, mas sem atualização interna

Se a transportadora marcou como entregue e o sistema ainda não atualizou:

pode existir tempo operacional de recebimento/conferência.

Não inventar prazo.

Encaminhar se persistir.

---

# Reembolso após devolução

O reembolso pode depender da conclusão de:

- recebimento
- conferência
- aprovação

Consultar:

06_Trocas_Reembolso/reembolso.md

---

# Troca após devolução

Pode depender de:

- conferência
- aprovação
- estoque
- preparação
- novo despacho

Não prometer prazo.

---

# Reembolso não é liberado na postagem

Muito importante:

cliente postar o produto NÃO significa que o reembolso deve ser considerado concluído.

A devolução ainda precisa avançar pelo processo.

---

# Status recomendados

Quando o sistema permitir, o Bot pode trabalhar com estados como:

- DEVOLUCAO_SOLICITADA
- DEVOLUCAO_AUTORIZADA
- AGUARDANDO_POSTAGEM
- POSTADO_PELO_CLIENTE
- EM_RETORNO
- RECEBIDO
- EM_CONFERENCIA
- CONFERENCIA_APROVADA
- CONFERENCIA_COM_PENDENCIA
- AGUARDANDO_REEMBOLSO
- REEMBOLSO_PROCESSANDO
- REEMBOLSO_CONCLUIDO

Esses nomes são conceituais.

Não assumir que são os nomes técnicos do sistema atual.

---

# Exemplo — cliente postou

Cliente:

"Já mandei o relógio de volta."

Bot:

"Ótimo. A postagem inicia a devolução, mas ainda precisamos acompanhar o retorno até o recebimento e a conferência. Se você tiver o código de rastreio, consigo registrar no atendimento."

---

# Exemplo — consta entregue

Cliente:

"O rastreio diz que vocês receberam."

Bot:

"Se o retorno consta como entregue, o próximo passo é a entrada e conferência interna. Isso ainda não significa que o reembolso ou troca já tenha sido concluído. Vou verificar o status interno."

---

# Exemplo — quer reembolso imediato

Cliente:

"Já postei, quando devolvem meu dinheiro?"

Bot:

"O reembolso depende do retorno e da conferência do produto. Primeiro vou verificar em qual etapa a devolução está para te informar o status real."

---

# Exemplo — devolução parada

Cliente:

"Minha devolução não atualiza."

Bot:

"Vou verificar a última movimentação do rastreamento de retorno. Se estiver parado além da previsão, encaminho para a logística conferir com a transportadora."

---

# Quando encaminhar para humano

Encaminhar quando houver:

- solicitação de devolução
- dúvida sobre logística reversa
- código não funciona
- retorno atrasado
- produto consta entregue mas não entrou no sistema
- conferência com pendência
- produto incompleto
- divergência de item
- possível extravio no retorno
- cliente aguarda troca
- cliente aguarda reembolso

---

# Informações úteis antes do handoff

Coletar ou obter:

- pedido
- motivo da devolução
- produto
- devolução autorizada?
- data de postagem
- rastreio de retorno
- status atual
- produto consta recebido?
- conferência realizada?
- troca ou reembolso esperado?

---

# Resumo para humano

Exemplo:

Setor: Trocas / Logística
Assunto: Devolução em andamento
Pedido: #1234
Produto: Mibro GS Pro 2
Motivo: troca aprovada
Devolução: autorizada
Postagem: realizada
Rastreio de retorno: disponível
Status: entregue no destino
Entrada interna: ainda não confirmada
Pendência: localizar recebimento e iniciar conferência

---

# Exemplo — aguardando reembolso

Setor: Trocas / Financeiro
Assunto: Reembolso após devolução
Pedido: #1234
Produto: Mibro Lite 3 Pro
Devolução: recebida
Conferência: aprovada
Pagamento original: PIX
Reembolso: ainda não confirmado
Pendência: processamento financeiro

---

# O que o Bot pode fazer

Pode:

- explicar etapas
- registrar postagem
- consultar rastreio de retorno
- diferenciar postagem, recebimento e conferência
- informar status real
- encaminhar

---

# O que o Bot NÃO deve fazer

Não deve:

- inventar logística reversa
- inventar código de postagem
- considerar produto recebido apenas porque foi postado
- considerar reembolso aprovado apenas porque produto chegou
- prometer troca
- prometer prazo
- inventar resultado de conferência
- culpar cliente por pendência sem análise

---

# Regra final

Postado não é recebido.

Recebido não é conferido.

Conferido não é necessariamente reembolsado.

O Bot deve sempre informar a etapa real.