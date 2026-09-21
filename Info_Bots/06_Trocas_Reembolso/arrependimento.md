---
type: returns_refunds
topic: withdrawal
brand: Mibro
source: https://mibrobrasil.com.br/policies/refund-policy
updated: 2026-09-18
---

# Trocas e Reembolso — Arrependimento

## Objetivo

Este arquivo orienta o Bot sobre solicitações em que o cliente deseja desistir da compra por arrependimento.

Exemplos:

- "Não quero mais."
- "Mudei de ideia."
- "Quero devolver."
- "Comprei errado."
- "Quero cancelar depois que chegou."
- "Não gostei do produto."

Esse fluxo deve ser separado de:

- defeito
- garantia
- produto errado enviado pela loja
- avaria de transporte
- cobrança duplicada

---

# Regra principal

O Bot NÃO deve tratar arrependimento como defeito.

Também não deve:

- aprovar devolução sozinho
- garantir reembolso
- inventar prazo
- afirmar que produto aberto perde automaticamente o direito
- afirmar que produto usado sempre pode ser devolvido
- prometer logística reversa sem autorização

Primeiro identificar a situação real.

---

# Compra online

Compras realizadas fora de estabelecimento físico podem estar sujeitas ao direito de arrependimento conforme legislação aplicável e a política da loja.

O Bot deve seguir a política oficial vigente.

Não inventar condições diferentes da política publicada.

---

# Prazo

Quando necessário, consultar a política vigente para confirmar o prazo aplicável.

O Bot não deve criar prazo próprio.

Se o prazo já estiver disponível de forma confiável na Knowledge:

pode informar exatamente o que estiver documentado.

Caso contrário:

encaminhar para confirmação.

---

# Data importante

Para análise de arrependimento, pode ser importante saber:

- data da compra
- data do recebimento
- data da solicitação

Em compras já entregues, a data de recebimento costuma ser especialmente relevante.

---

# Pedido ainda não enviado

Se o cliente mudou de ideia antes do despacho:

consultar:

05_Pedidos/cancelamento.md

Esse caso pode ser tratado como cancelamento antes do envio, e não necessariamente como devolução física.

---

# Pedido em preparação

Se ainda estiver em preparação:

encaminhar rapidamente para verificar possibilidade de interromper o despacho.

Não prometer.

---

# Pedido já enviado

Se o cliente desistiu depois do despacho:

pode ser necessário:

- aguardar entrega
- seguir orientação de recusa
- iniciar devolução

dependendo do status e da orientação da equipe.

Não prometer bloqueio da transportadora.

---

# Pedido em trânsito

O Bot deve explicar:

"Como o pedido já está em transporte, precisamos verificar o procedimento aplicável. Dependendo do caso, pode ser necessário aguardar ou seguir uma orientação de devolução."

---

# Pedido entregue

Se o cliente já recebeu:

identificar:

- quando recebeu
- se abriu a embalagem
- se utilizou
- condição atual
- motivo da devolução

Perguntar apenas o necessário.

---

# Produto fechado

Se o produto permanece fechado:

registrar essa informação.

Não significa aprovação automática, mas é relevante para análise.

---

# Produto aberto

O Bot NÃO deve responder automaticamente:

"Produto aberto não pode ser devolvido."

A análise depende da política e da condição real.

Registrar:

Produto aberto: sim.

E encaminhar quando necessário.

---

# Produto testado

Se o cliente abriu apenas para testar:

registrar.

Não classificar automaticamente como:

- usado em excesso
- fora da política
- inválido para devolução

A equipe deve avaliar.

---

# Produto utilizado

Se houve uso:

perguntar somente quando relevante.

Exemplo:

"Você chegou apenas a testar ou usou o produto por algum período?"

Não usar tom acusatório.

---

# Sinais de uso

Se houver:

- riscos
- marcas
- danos
- sujeira
- peças faltando

registrar se informado.

Não negar sozinho.

---

# Cliente não gostou

"Não gostei" pode ser uma solicitação de arrependimento.

Não tentar convencer o cliente a manter a compra.

Pode perguntar:

"Você já recebeu o pedido? Se sim, quando ele foi entregue?"

---

# Comprou modelo errado

Se o cliente escolheu o modelo errado:

pode ser:

- cancelamento, se não enviado
- arrependimento/devolução, se recebido
- troca comercial, dependendo do pedido

Não confundir com erro da loja.

---

# Comprou cor errada

Se o cliente escolheu a cor errada:

mesma lógica.

Se a loja enviou cor diferente da comprada:

isso é divergência de item, não simples arrependimento.

Consultar:

06_Trocas_Reembolso/troca.md

---

# Cliente quer modelo melhor

Se deseja trocar porque prefere outro modelo:

tratar como troca comercial/arrependimento.

Não prometer apenas pagamento da diferença.

---

# Motivo não precisa ser defeito

No arrependimento, o cliente pode simplesmente não querer mais a compra.

Não obrigar o cliente a inventar problema técnico.

---

# Defeito durante solicitação de arrependimento

Se o cliente também relata defeito:

entender qual fluxo ele deseja seguir.

Pode existir:

- arrependimento
- garantia
- troca por defeito

Não misturar automaticamente.

---

# Produto chegou errado

Isso NÃO é arrependimento.

Consultar:

06_Trocas_Reembolso/troca.md

---

# Produto chegou quebrado

Isso NÃO deve ser tratado apenas como arrependimento.

Registrar como:

- avaria
- possível problema logístico

Consultar:

06_Trocas_Reembolso/troca.md

---

# Logística reversa

Se a devolução for aprovada:

o cliente deve seguir o processo oficial.

Pode envolver:

- etiqueta
- código de postagem
- transportadora
- coleta

O Bot não deve inventar essas informações.

Consultar:

06_Trocas_Reembolso/devolucao.md

---

# Embalagem

Orientar o cliente a preservar:

- produto
- acessórios
- itens recebidos
- embalagem, quando disponível

Não afirmar automaticamente que ausência da embalagem cancela qualquer possibilidade de devolução.

---

# Acessórios

É importante não descartar:

- cabo
- carregador
- pulseira
- manuais
- itens do kit

quando fizerem parte do produto recebido.

---

# Nota Fiscal

A NF-e pode ser necessária no processo.

Se o cliente não localizar:

consultar:

05_Pedidos/nota-fiscal.md

---

# Frete

Não afirmar automaticamente:

- cliente paga
- loja paga
- frete será reembolsado

Isso depende da política e do motivo da devolução.

---

# Reembolso

Arrependimento aprovado pode resultar em reembolso conforme processo aplicável.

Mas:

devolução solicitada != reembolso aprovado.

Consultar:

06_Trocas_Reembolso/reembolso.md

---

# Produto postado de volta

Se o cliente já devolveu:

consultar:

06_Trocas_Reembolso/devolucao.md

Lembrar:

postado não significa recebido.

---

# Produto recebido de volta

Ainda pode existir:

- conferência
- validação
- processamento financeiro

Não prometer crédito imediato.

---

# Compra com PIX

Se o reembolso for aprovado:

seguir processo financeiro oficial.

Não pedir senha, token ou código bancário.

---

# Compra com cartão

Se aprovado:

o estorno segue o meio de pagamento/processador.

Não inventar prazo.

---

# Cupom

Se a compra usou cupom:

não prometer que o cupom será reativado.

---

# Frete promocional

Também não afirmar automaticamente como será tratado no reembolso.

---

# Pedido com múltiplos produtos

O cliente pode querer devolver:

- pedido inteiro
- apenas um item

Registrar claramente.

Não assumir cancelamento total.

---

# Devolução parcial

Pode exigir análise específica.

Registrar:

- qual item
- quantidade
- motivo

---

# Brinde

Se o pedido continha brinde/promocional:

não decidir sozinho se ele deve ser devolvido.

A equipe deve seguir a condição comercial.

---

# Compra de atacado

O fluxo de arrependimento B2B pode ser diferente do varejo.

Não aplicar automaticamente as mesmas regras de consumidor final.

Encaminhar para comercial/financeiro.

---

# Produto personalizado

Se futuramente existir produto personalizado:

consultar política específica.

Não inventar regra.

---

# Exemplo — não quer mais

Cliente:

"Recebi ontem, mas não quero mais."

Bot:

"Entendi. Como você já recebeu o pedido, preciso verificar o fluxo de devolução por arrependimento. O produto foi apenas aberto para conferência ou chegou a ser utilizado?"

---

# Exemplo — pedido ainda não enviado

Cliente:

"Comprei agora, mas desisti."

Bot:

"Vou verificar se o pedido ainda está em preparação. Se ainda não tiver sido despachado, o ideal é tentar interromper o envio antes de iniciar uma devolução."

---

# Exemplo — comprou modelo errado

Cliente:

"Comprei o Lite 3, mas queria o Lite 3 Pro."

Bot:

"Se o pedido ainda não foi enviado, podemos verificar a possibilidade de cancelamento. Se você já recebeu, a situação entra como troca comercial ou devolução, dependendo da política e da condição do produto."

---

# Exemplo — produto aberto

Cliente:

"Abri a caixa, então perdi o direito de devolver?"

Bot:

"A abertura da embalagem por si só não deve ser tratada automaticamente como recusa. Precisamos considerar quando você recebeu, a condição do produto e a política aplicável ao caso."

---

# Quando encaminhar para humano

Encaminhar quando houver:

- solicitação de arrependimento
- pedido já enviado
- produto já recebido
- dúvida sobre prazo
- produto aberto/usado
- devolução parcial
- troca por preferência
- dúvida sobre frete
- reembolso
- caso de atacado
- situação não documentada

---

# Informações úteis antes do handoff

Coletar ou obter:

- número do pedido
- data de recebimento
- motivo
- pedido completo ou item específico
- produto aberto?
- produto utilizado?
- condição aparente
- acessórios disponíveis?
- status logístico
- forma de pagamento

---

# Resumo para humano

Exemplo:

Setor: Trocas / Devoluções
Assunto: Arrependimento
Pedido: #1234
Produto: Mibro Lite 3
Recebimento: 17/09/2026
Solicitação: 18/09/2026
Motivo: cliente mudou de ideia
Produto aberto: sim, apenas conferência
Uso informado: não
Acessórios: completos
Pendência: validar elegibilidade e orientar logística reversa

---

# O que o Bot pode fazer

Pode:

- identificar arrependimento
- diferenciar de defeito
- verificar status do pedido
- coletar dados essenciais
- orientar preservação do produto
- encaminhar para devolução
- acompanhar status real

---

# O que o Bot NÃO deve fazer

Não deve:

- forçar justificativa técnica
- aprovar devolução sozinho
- negar porque abriu a caixa
- garantir reembolso
- inventar prazo
- inventar logística reversa
- escolher outro produto sem autorização
- prometer devolução de frete/cupom

---

# Regra final

Arrependimento é diferente de defeito.

Primeiro identificar:

- pedido ainda não enviado
- pedido em trânsito
- produto já recebido

Depois encaminhar para o fluxo correto.