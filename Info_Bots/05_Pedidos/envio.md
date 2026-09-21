---
type: orders
topic: shipping
brand: Mibro
source: https://mibrobrasil.com.br/policies/shipping-policy
updated: 2026-09-18
---

# Pedidos — Envio

## Objetivo

Este arquivo orienta o Bot sobre dúvidas relacionadas a:

- prazo de envio
- postagem
- transportadora
- frete
- pedido em preparação
- pedido enviado
- endereço de entrega
- alteração de endereço
- atraso de postagem
- pedido devolvido
- tentativa de entrega
- problemas de transporte

O Bot deve diferenciar:

- prazo de preparação
- prazo de transporte
- prazo estimado de entrega

Esses prazos não são necessariamente a mesma coisa.

---

# Regra principal

O Bot não deve inventar:

- prazo exato
- data de entrega
- transportadora
- valor de frete
- código de rastreio
- motivo de atraso

Quando houver dados do pedido disponíveis no sistema:

usar as informações reais.

Quando não houver:

explicar o fluxo geral e encaminhar se necessário.

---

# Pedido confirmado

Depois da confirmação do pedido e pagamento:

o pedido pode passar por etapas como:

1. confirmação do pagamento;
2. preparação;
3. faturamento;
4. separação;
5. postagem/coleta;
6. transporte;
7. entrega.

A nomenclatura pode variar conforme o sistema.

---

# Pedido em preparação

Se o pedido estiver:

- em preparação
- separação
- processamento

isso geralmente significa que ainda não foi entregue à transportadora.

Não afirmar que já foi enviado.

---

# Pedido enviado

Só considerar enviado quando houver confirmação real de:

- postagem
- coleta
- despacho
- rastreamento correspondente

Não usar "enviado" apenas porque o pagamento foi aprovado.

---

# Prazo de envio

O prazo pode variar conforme:

- disponibilidade do produto
- confirmação do pagamento
- operação logística
- fim de semana
- feriado
- região
- modalidade escolhida

O Bot deve consultar a política vigente ou dados do pedido antes de fornecer prazo específico.

---

# Prazo de entrega

O prazo estimado de entrega pode ser diferente do prazo de postagem.

Exemplo:

o pedido pode levar um período para ser preparado e depois iniciar o prazo da transportadora.

Não somar ou inventar prazos sem dados oficiais.

---

# Frete

O valor e modalidade de frete podem depender de:

- CEP
- produtos
- peso
- dimensões
- valor do pedido
- transportadora
- promoção vigente

O valor final deve ser considerado o exibido no checkout.

---

# Frete grátis

Pode existir condição promocional de frete grátis.

Não afirmar valor mínimo ou regra sem confirmação vigente.

Responder:

"Quando houver frete grátis disponível para o seu CEP e pedido, essa opção aparece no checkout."

---

# CEP

Se o cliente quer consultar entrega:

pode ser necessário informar o CEP no checkout.

O Bot não precisa solicitar endereço completo apenas para explicar prazo geral.

---

# Endereço informado incorretamente

Se o cliente percebeu erro no endereço:

identificar imediatamente se o pedido já foi enviado.

---

# Pedido ainda não enviado

Se ainda estiver em preparação:

pode ser possível corrigir o endereço.

O Bot não deve prometer alteração.

Encaminhar rapidamente para equipe responsável.

---

# Pedido já enviado

Se já foi entregue à transportadora:

a alteração de endereço pode ser limitada ou impossível.

Não prometer mudança.

Orientar que a equipe verifique as opções disponíveis.

---

# Cliente mudou de endereço

Se o pedido ainda não foi realizado:

orientar a atualizar os dados antes da compra.

Se o pedido já existe:

seguir a regra de pedido enviado/não enviado.

---

# Número da residência errado

Tratar como alteração de endereço.

Encaminhar rapidamente antes do despacho.

---

# CEP errado

Pode afetar:

- rota
- frete
- prazo
- entrega

Não alterar manualmente sem confirmação do sistema/equipe.

---

# Cidade ou estado errado

Pode exigir correção do pedido antes do envio.

Encaminhar imediatamente.

---

# Pedido enviado para endereço antigo

Se já foi despachado:

não prometer redirecionamento.

A transportadora e a operação precisam ser consultadas.

---

# Alteração de destinatário

Mudança de nome do destinatário pode ter restrições.

Não prometer.

Encaminhar quando necessário.

---

# Código de rastreio

Quando o pedido for enviado:

pode ser disponibilizado código/link de rastreamento.

O Bot deve usar o código real vinculado ao pedido.

Nunca inventar rastreio.

---

# Rastreio ainda não atualizou

Após a geração do código:

pode existir intervalo até a primeira movimentação aparecer.

Se o código foi criado recentemente:

orientar aguardar atualização operacional.

Não inventar prazo exato.

---

# Código inválido

Se o rastreio continuar inválido:

verificar:

- se o pedido realmente foi despachado
- se o código está completo
- se a transportadora está correta

Se persistir:

encaminhar.

---

# Transportadora

Não afirmar qual transportadora está realizando a entrega sem consultar o pedido.

Pode variar por:

- CEP
- modalidade
- região
- operação logística

---

# Correios

Não assumir que todos os pedidos são enviados pelos Correios.

---

# Pedido parado

Se o rastreio não apresenta movimentação:

verificar:

- data da última atualização
- prazo previsto
- status

Não afirmar extravio imediatamente.

---

# Atraso

Se a previsão já foi ultrapassada:

encaminhar para análise logística.

Registrar:

- pedido
- previsão
- última movimentação
- transportadora

---

# Atraso antes da postagem

Se o pedido ainda não foi despachado e o prazo esperado já passou:

encaminhar para equipe de pedidos/logística.

---

# Atraso durante transporte

Se já estiver com a transportadora:

avaliar rastreamento antes de concluir qualquer problema.

---

# Fim de semana e feriado

Finais de semana e feriados podem afetar operações e transporte.

Não inventar regra de dias úteis sem consultar a política vigente.

---

# Tentativa de entrega

Se houver tentativa sem sucesso:

consultar o rastreamento.

Pode ocorrer nova tentativa ou outra orientação conforme a transportadora.

Não afirmar número específico de tentativas sem fonte.

---

# Cliente ausente

Se a entrega não ocorreu porque não havia alguém disponível:

orientar acompanhamento do rastreamento.

Se houver necessidade de ação específica:

seguir instrução da transportadora.

---

# Endereço não localizado

Se aparecer:

- endereço não localizado
- endereço insuficiente
- destinatário desconhecido

encaminhar para equipe acompanhar a encomenda.

---

# Pedido devolvido ao remetente

Se o rastreio indicar devolução:

não prometer reenvio automático.

A equipe deve verificar:

- motivo da devolução
- endereço
- pedido
- possibilidade de reenvio
- possível cancelamento

---

# Recusa da entrega

Se o cliente recusou o recebimento:

o produto pode retornar ao remetente.

Não prometer reembolso imediato.

Consultar fluxo de devolução/reembolso.

---

# Embalagem danificada na entrega

Se a embalagem chegar:

- aberta
- amassada
- rasgada
- violada

orientar o cliente a registrar a condição com fotos, se possível.

Se houver dano significativo:

encaminhar.

---

# Produto danificado na entrega

Se o produto chegou quebrado ou avariado:

não tratar como troubleshooting comum.

Registrar:

- pedido
- dano
- estado da embalagem
- fotos, se disponíveis

Encaminhar para troca/devolução.

---

# Produto faltando

Se faltou algum item:

registrar:

- número do pedido
- item recebido
- item faltante
- condição da embalagem

Encaminhar.

---

# Produto diferente

Se chegou produto/modelo diferente:

não pedir para o cliente utilizar.

Registrar e encaminhar.

---

# Quantidade errada

Se o pedido chegou com quantidade diferente:

registrar:

- pedido
- quantidade comprada
- quantidade recebida

Encaminhar.

---

# Envio parcial

Não assumir que houve erro.

Alguns pedidos podem ser divididos em mais de um envio.

Verificar no sistema antes de informar.

---

# Pedido com vários produtos

Itens podem ter:

- mesma remessa
- remessas diferentes

Não garantir que chegarão juntos sem confirmação.

---

# Produto em lançamento

Itens classificados como:

- lançamento
- pré-lançamento
- em breve

não devem ter prazo de envio inventado.

Se não existir data oficial:

informar que ainda não há previsão confirmada.

---

# Pré-venda

Se algum produto for vendido como pré-venda:

o prazo específico deve vir da comunicação oficial do produto/pedido.

Não aplicar prazo comum de produtos em estoque automaticamente.

---

# Envio de atacado

Pedidos de atacado podem seguir fluxo diferente.

Podem depender de:

- aprovação
- pagamento
- faturamento
- emissão de NF-e
- separação logística

Não tratar como pedido comum do site.

---

# Alteração de endereço no atacado

Encaminhar para comercial/logística antes da emissão/despacho.

Não alterar dados fiscais automaticamente.

---

# Nota fiscal e envio

A emissão da NF-e pode fazer parte do processo antes do despacho.

Não afirmar que NF-e emitida significa necessariamente que a transportadora já coletou o pedido.

---

# Exemplo — alteração de endereço

Cliente:

"Coloquei o número da casa errado."

Bot:

"Seu pedido já aparece como enviado ou ainda está em preparação? Se ainda não foi despachado, vou encaminhar a correção o quanto antes, mas a alteração precisa ser confirmada pela equipe."

---

# Exemplo — pedido em preparação

Cliente:

"Meu pagamento foi aprovado, por que ainda não enviaram?"

Bot:

"Depois da aprovação, o pedido ainda pode passar pelas etapas de separação e faturamento antes do despacho. Se você me passar o número do pedido, verificamos o status correto."

---

# Exemplo — atraso

Cliente:

"A previsão era ontem e não chegou."

Bot:

"Vou precisar conferir o rastreamento e a última movimentação do pedido. Se a previsão já foi ultrapassada, o caso pode ser encaminhado para a equipe de logística verificar com a transportadora."

---

# Exemplo — embalagem violada

Cliente:

"A caixa chegou aberta."

Bot:

"Se possível, registre fotos da embalagem e do conteúdo antes de descartar qualquer material. Vou encaminhar o caso para a equipe verificar o envio."

---

# Quando encaminhar para humano

Encaminhar quando houver:

- alteração de endereço de pedido existente
- atraso além da previsão
- rastreio inválido
- pedido parado por período anormal
- devolução ao remetente
- embalagem violada
- produto danificado
- produto faltando
- produto incorreto
- divergência de quantidade
- problema com transportadora
- status incoerente

---

# Informações úteis antes do handoff

Coletar quando necessário:

- número do pedido
- status atual
- código de rastreio
- transportadora, se conhecida
- previsão de entrega
- última movimentação
- endereço precisa ser alterado?
- descrição do problema

---

# Resumo para humano

Exemplo:

Setor: Pedidos / Logística
Assunto: Alteração de endereço
Pedido: #1234
Status: em preparação
Problema: número residencial incorreto
Endereço correto: cliente possui
Pedido enviado: não
Pendência: verificar possibilidade de alteração antes do despacho

---

# O que o Bot pode fazer

Pode:

- explicar etapas de envio
- diferenciar preparação e despacho
- orientar acompanhamento
- identificar urgência de alteração de endereço
- registrar problemas de transporte
- encaminhar

---

# O que o Bot NÃO deve fazer

Não deve:

- inventar prazo
- inventar rastreamento
- garantir data de entrega
- prometer alteração de endereço
- prometer reenvio
- declarar extravio sem análise
- afirmar transportadora sem consultar
- prometer frete grátis sem regra vigente

---

# Regra final

Para dúvidas de envio:

usar sempre o status real do pedido quando disponível.

Se o cliente quiser alterar endereço:

quanto antes o caso for encaminhado, melhor.