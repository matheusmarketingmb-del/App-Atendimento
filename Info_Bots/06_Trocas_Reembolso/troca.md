---
type: returns_refunds
topic: exchange
brand: Mibro
updated: 2026-09-18
---

# Trocas e Reembolso — Troca

## Objetivo

Este arquivo orienta o Bot sobre situações relacionadas a:

- troca por defeito
- troca por produto errado
- troca por avaria
- troca comercial
- troca por arrependimento
- troca de cor/modelo
- troca após análise de garantia
- diferença entre troca e garantia

O Bot deve identificar o motivo antes de orientar.

---

# Regra principal

Troca NÃO deve ser prometida antes da análise.

O Bot NÃO deve dizer:

- "vamos trocar"
- "sua troca foi aprovada"
- "você receberá outro produto"
- "vamos enviar um novo"

sem confirmação da equipe responsável.

---

# Troca por defeito

Quando o cliente relata possível defeito:

primeiro deve existir avaliação técnica.

Consultar:

04_Garantia/garantia-geral.md

Exemplos:

- não liga
- não carrega
- display falha
- sensor não funciona
- botão falha
- reinicia sozinho

O Bot não deve concluir automaticamente que a solução será troca.

---

# Garantia não é sinônimo de troca

Uma análise de garantia pode resultar em diferentes soluções.

A equipe responsável pode definir conforme o caso.

O Bot não escolhe antecipadamente entre:

- troca
- reparo
- reembolso
- outro procedimento

---

# Troca por produto errado

Se o cliente recebeu produto diferente do comprado:

registrar:

- número do pedido
- produto comprado
- produto recebido
- quantidade
- estado da embalagem
- fotos, se disponíveis

Encaminhar para logística/trocas.

---

# Não usar produto errado

Quando houver modelo claramente diferente:

orientar o cliente a manter o produto nas condições em que recebeu, quando possível.

Não incentivar uso prolongado antes da análise.

---

# Produto com cor errada

Primeiro confirmar:

- cor comprada
- cor recebida

Consultar o pedido real.

Se houver divergência:

encaminhar.

---

# Produto faltando

Não é necessariamente troca.

Pode ser:

- envio parcial
- erro de separação
- problema logístico

Consultar:

05_Pedidos/pedido-nao-recebido.md

---

# Produto avariado no transporte

Se chegou:

- quebrado
- amassado
- trincado
- com embalagem violada
- com dano visível

orientar:

- guardar embalagem
- guardar etiquetas
- registrar fotos, se possível

Encaminhar.

---

# Embalagem danificada

Embalagem amassada sozinha não confirma dano ao produto.

Se o produto também estiver danificado:

registrar ambos.

---

# Produto não funciona ao chegar

Se o produto chegou sem funcionar:

realizar apenas verificações básicas e seguras.

Exemplos:

- carregamento
- fonte
- contatos
- inicialização

Se continuar sem resposta:

encaminhar.

---

# Troca por arrependimento

Se o cliente apenas mudou de ideia:

o caso deve seguir a política aplicável de devolução/arrependimento.

Não tratar como defeito.

---

# Troca de cor

Se o cliente recebeu exatamente o que comprou, mas quer outra cor:

isso é uma troca comercial.

Não afirmar que será aceita.

Verificar:

- prazo
- condição do produto
- política
- disponibilidade

---

# Troca de modelo

Se o cliente quer trocar por outro modelo:

não prometer.

Pode envolver:

- devolução
- diferença de valor
- disponibilidade
- nova compra
- condição comercial

Encaminhar.

---

# Modelo mais caro

Não calcular ou prometer diferença de valor sem procedimento oficial.

---

# Modelo mais barato

Também não prometer:

- crédito
- estorno da diferença
- cupom

sem autorização.

---

# Produto aberto

A abertura da embalagem não deve gerar resposta automática de recusa.

A equipe deve analisar:

- motivo
- condição
- tipo de troca
- política

---

# Produto usado

Não dizer automaticamente:

"Não fazemos troca porque foi usado."

Depende do motivo.

Exemplo:

um possível defeito naturalmente pode ter sido identificado somente após uso.

---

# Produto com marcas

Registrar quando houver:

- riscos
- impacto
- desgaste
- dano

Isso pode ser relevante para a análise.

Não negar sozinho.

---

# Acessórios

Quando a troca exigir devolução do produto:

a equipe pode solicitar também os acessórios originais.

Exemplos:

- cabo/carregador
- pulseira
- manuais
- outros itens da embalagem

Não inventar lista obrigatória sem orientação do fluxo.

---

# Caixa original

Não afirmar que a ausência da caixa elimina automaticamente qualquer possibilidade de troca.

Registrar quando necessário e encaminhar.

---

# Nota Fiscal

A NF-e pode ser necessária para:

- comprovação da compra
- garantia
- logística reversa
- análise

Consultar:

04_Garantia/requisitos-garantia.md

---

# Troca de presente

Produto recebido como presente pode precisar da documentação original.

Não negar automaticamente.

---

# Compra em marketplace

Se a compra ocorreu em marketplace:

identificar:

- plataforma
- vendedor

A responsabilidade/processo pode depender do canal.

Não orientar pelo nome da plataforma apenas.

---

# Compra fora da loja oficial

Pode haver fluxo diferente dependendo do vendedor.

Se foi revendedor autorizado:

a equipe deve verificar o procedimento aplicável.

---

# Importação direta

A Mibro Brasil pode não ser responsável pela troca de produto adquirido por importação direta.

Consultar:

04_Garantia/exclusoes-garantia.md

Não negar de forma definitiva pelo Bot.

---

# Troca após garantia aprovada

Se a equipe aprovou formalmente uma troca:

o Bot pode informar o status real.

Exemplos:

- aguardando devolução
- produto recebido
- troca em preparação
- novo envio realizado

Não adiantar etapas que ainda não aconteceram.

---

# Logística reversa

Uma troca pode exigir devolução do produto anterior.

O Bot não deve inventar:

- código de postagem
- transportadora
- endereço
- etiqueta

Essas informações devem vir do fluxo oficial.

---

# Produto ainda não devolvido

Se a troca depende da devolução:

não informar que o novo produto já será enviado sem confirmação.

---

# Produto devolvido

"Postado pelo cliente" não significa necessariamente:

"recebido pela Mibro."

Separar:

- postagem
- trânsito de retorno
- recebimento
- conferência

---

# Produto recebido para análise

Após o retorno:

pode haver conferência antes da conclusão da troca.

Não prometer envio imediato do novo produto.

---

# Produto substituto

Não afirmar que será enviado:

- produto novo
- mesmo lote
- modelo superior
- cor específica

sem confirmação.

---

# Produto indisponível

Se o mesmo modelo estiver indisponível:

a equipe deve definir a solução aplicável.

O Bot não deve escolher automaticamente outro produto.

---

# Troca parcial

Em pedidos com múltiplos itens:

pode ser necessário trocar apenas um.

Registrar exatamente qual item está afetado.

---

# Pedido de atacado

Trocas B2B podem seguir processo comercial diferente.

Encaminhar para:

- comercial
- logística
- financeiro

conforme o caso.

---

# Frete de troca

Não afirmar automaticamente quem paga o frete.

Isso depende:

- motivo
- política
- análise

---

# Prazo de troca

Não inventar prazo.

O prazo pode depender de:

- retorno do produto
- análise
- estoque
- transporte

---

# Troca aprovada mas ainda não enviada

Informar exatamente o status real.

Exemplo:

"A troca foi aprovada e está aguardando preparação."

Não dizer:

"Já está a caminho."

---

# Novo rastreamento

Somente fornecer quando existir.

Nunca reutilizar rastreamento antigo como se fosse o novo envio.

---

# Exemplo — produto errado

Cliente:

"Comprei o GS Pro 2 e chegou um Lite 3."

Bot:

"Entendi. Não precisa realizar novos testes no produto. Vou encaminhar como divergência de item. Se possível, mantenha a embalagem e me passe o número do pedido para registrarmos corretamente."

---

# Exemplo — defeito

Cliente:

"Meu relógio parou de funcionar. Quero trocar."

Bot:

"Primeiro precisamos registrar e avaliar o defeito. Depois da análise, a equipe define a solução aplicável. Vou organizar as informações para você não precisar repetir tudo."

---

# Exemplo — cor

Cliente:

"Comprei preto mas quero trocar pelo dourado."

Bot:

"Se o produto recebido corresponde ao pedido, isso entra como troca comercial. A equipe precisa verificar a condição do produto, prazo e disponibilidade da outra cor antes de confirmar a troca."

---

# Exemplo — avaria

Cliente:

"A caixa chegou amassada e a tela veio quebrada."

Bot:

"Guarde a embalagem e as etiquetas e, se possível, registre fotos de como o pedido chegou. Vou encaminhar como avaria de transporte para análise."

---

# Quando encaminhar para humano

Encaminhar quando houver:

- solicitação de troca
- produto errado
- cor divergente
- produto avariado
- possível defeito
- troca comercial
- produto devolvido
- troca já aprovada
- item substituto indisponível
- atacado
- dúvida não documentada

---

# Informações úteis antes do handoff

Coletar ou obter:

- número do pedido
- produto
- motivo da troca
- produto recebido
- condição
- embalagem
- NF-e
- data da compra
- houve uso?
- houve queda?
- houve contato com água?
- fotos disponíveis?

Não perguntar o que não for relevante.

---

# Resumo para humano

Exemplo:

Setor: Trocas / Logística
Assunto: Produto incorreto
Pedido: #1234
Comprado: Mibro GS Pro 2 Preto
Recebido: Mibro Lite 3
Embalagem: preservada
Produto utilizado: não
Fotos: disponíveis
NF-e: disponível
Pendência: validar divergência e iniciar troca

---

# Resumo — possível defeito

Setor: Suporte / Garantia
Assunto: Solicitação de troca por defeito
Produto: Mibro GS Active2
Problema: não liga
Compra: 4 meses
NF-e: disponível
Procedimentos: carregamento e reinicialização
Resultado: sem resposta
Pendência: avaliação técnica antes de definir solução

---

# O que o Bot pode fazer

Pode:

- identificar tipo de troca
- diferenciar troca comercial e garantia
- organizar evidências
- orientar preservação do produto/embalagem
- informar status real
- encaminhar

---

# O que o Bot NÃO deve fazer

Não deve:

- aprovar troca
- prometer produto substituto
- prometer modelo superior
- inventar prazo
- inventar logística reversa
- afirmar quem paga frete sem regra
- negar troca automaticamente porque produto foi aberto
- escolher solução de garantia

---

# Regra final

Troca por defeito:

primeiro análise.

Produto errado ou avariado:

priorizar logística.

Troca por preferência:

seguir política comercial.