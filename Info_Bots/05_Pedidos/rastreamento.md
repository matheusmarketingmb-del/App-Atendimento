---
type: orders
topic: tracking
brand: Mibro
updated: 2026-09-18
---

# Pedidos — Rastreamento

## Objetivo

Este arquivo orienta o Bot sobre dúvidas relacionadas a:

- código de rastreio
- rastreio sem atualização
- pedido parado
- pedido em trânsito
- tentativa de entrega
- destinatário ausente
- endereço não localizado
- devolução ao remetente
- possível extravio
- entrega marcada como concluída
- pedido não recebido

O Bot deve usar o status real do pedido sempre que estiver disponível.

---

# Regra principal

O Bot NÃO deve:

- inventar código de rastreio
- inventar transportadora
- inventar movimentação
- afirmar extravio sem confirmação
- prometer data exata de entrega
- dizer que pedido foi perdido apenas porque está parado

Quando houver integração com pedidos/logística:

consultar primeiro os dados reais.

---

# Código de rastreio

O código deve vir do pedido real.

Pode estar disponível após:

- postagem
- coleta
- despacho

A geração de código não significa necessariamente que a encomenda já teve a primeira movimentação física.

---

# Código ainda não aparece

Se o pedido acabou de ser despachado:

pode existir um intervalo até a transportadora registrar a primeira movimentação.

Não inventar prazo exato.

Se continuar sem atualização por período anormal:

encaminhar.

---

# Código inválido

Se o código retornar inválido:

verificar:

- código completo
- transportadora correta
- se o pedido realmente foi despachado
- se o cadastro ainda está sendo atualizado

Se persistir:

encaminhar para logística.

---

# Transportadora

Consultar sempre no pedido.

Não assumir:

- Correios
- transportadora privada
- logística própria

A transportadora pode variar conforme:

- região
- CEP
- modalidade de frete
- operação logística

---

# Pedido em trânsito

Status como:

- em trânsito
- encaminhado
- transferido
- em rota logística

normalmente indicam movimentação entre unidades.

Não afirmar que está "saindo para entrega" sem o status específico.

---

# Saiu para entrega

Quando o rastreamento indicar claramente:

- saiu para entrega
- em rota de entrega
- saiu para destinatário

o Bot pode informar que está na etapa final da entrega.

Mesmo assim:

não garantir horário.

---

# Pedido parado

Se o rastreio não muda:

verificar:

- última movimentação
- data da movimentação
- previsão de entrega
- se há ocorrência registrada

Não considerar automaticamente extravio.

---

# Pedido parado antes do prazo

Se ainda estiver dentro da previsão:

explicar que algumas etapas podem ficar sem atualização intermediária.

Evitar gerar preocupação desnecessária.

---

# Pedido parado após a previsão

Se a previsão já passou:

encaminhar para logística verificar com a transportadora.

Registrar:

- número do pedido
- código
- última movimentação
- data
- previsão

---

# Tentativa de entrega

Se aparecer:

"Tentativa de entrega"

consultar os detalhes disponíveis.

Pode ocorrer por:

- destinatário ausente
- endereço não localizado
- acesso restrito
- ocorrência da transportadora

Não inventar o motivo se o rastreio não informar.

---

# Destinatário ausente

Se a transportadora registrou ausência:

orientar o cliente a acompanhar o rastreamento.

Pode haver:

- nova tentativa
- retirada
- devolução

dependendo da transportadora.

Não informar quantidade fixa de tentativas sem confirmação.

---

# Endereço não localizado

Se aparecer:

- endereço não localizado
- endereço insuficiente
- número inexistente
- dados incompletos

encaminhar para logística.

Não prometer alteração do endereço se o pacote já estiver em trânsito.

---

# Área de difícil acesso

Algumas transportadoras podem registrar restrição operacional em determinadas regiões.

Não afirmar motivo de segurança ou impossibilidade sem informação oficial.

Seguir o status exibido.

---

# Entrega recusada

Se houver recusa:

a encomenda pode entrar em processo de retorno.

Não prometer:

- reenvio imediato
- cancelamento imediato
- reembolso imediato

Encaminhar para análise.

---

# Devolução ao remetente

Status de devolução pode ocorrer por:

- tentativas sem sucesso
- endereço incorreto
- recusa
- ocorrência logística

Quando aparecer devolução:

encaminhar.

A equipe deve verificar:

- motivo
- retorno físico
- reenvio
- correção de endereço
- possível cancelamento/reembolso

---

# Pedido retornando

Se o produto ainda está em transporte de volta:

não afirmar que já chegou ao estoque.

Aguardar confirmação logística.

---

# Pedido devolvido ao estoque

Somente considerar recebido de volta quando houver confirmação real.

A partir disso:

a equipe pode avaliar próximo passo.

---

# Possível extravio

Extravio deve ser tratado com cautela.

Indícios podem incluir:

- longo período sem movimentação
- previsão ultrapassada
- ocorrência da transportadora
- confirmação formal de perda

Mas o Bot NÃO deve declarar extravio sozinho.

Usar:

"Pode ser necessária uma verificação com a transportadora."

---

# Extravio confirmado

Se a transportadora/equipe confirmar formalmente extravio:

encaminhar para fluxo responsável por:

- reenvio
- reposição
- reembolso

conforme decisão humana/política aplicável.

---

# Marcado como entregue

Se o rastreio mostrar:

"Entregue"

mas o cliente disser que não recebeu:

não afirmar que o cliente recebeu.

Perguntar de forma natural:

- alguém no endereço recebeu?
- portaria recebeu?
- familiar/vizinho recebeu?
- existe comprovante de entrega disponível?

Se continuar sem localizar:

encaminhar.

---

# Porteiro / recepção

Em condomínios ou empresas:

a entrega pode ter sido recebida por:

- portaria
- recepção
- segurança
- responsável interno

Orientar o cliente a verificar antes de abrir ocorrência.

---

# Vizinho

Não afirmar que foi entregue a vizinho sem evidência.

Se o comprovante indicar:

registrar a informação.

---

# Comprovante de entrega

Quando disponível, pode conter:

- data
- horário
- nome
- assinatura
- foto
- localização

O Bot pode usar somente as informações reais disponíveis.

---

# Foto da entrega

Se houver foto vinculada:

ela pode ajudar na identificação.

Não concluir sozinho que a entrega está correta apenas pela foto.

---

# Assinatura desconhecida

Se o cliente não reconhece:

encaminhar para investigação logística.

Não acusar:

- transportadora
- terceiro
- cliente

---

# Pedido consta entregue em outra cidade

Se houver divergência clara:

encaminhar imediatamente para logística.

Pode indicar:

- erro de rastreio
- código incorreto
- problema na remessa

Não tentar justificar sem dados.

---

# Código pertence a outro pedido

Se os dados do rastreio não correspondem ao cliente:

não expor informações de terceiros.

Encaminhar para correção.

---

# Privacidade

Nunca informar ao cliente:

- nome
- endereço
- telefone
- dados de outro destinatário

mesmo que apareçam em rastreio incorreto.

---

# Rastreio no site da transportadora

Quando houver link oficial do pedido:

o Bot pode orientar o cliente a acompanhar por ele.

Não criar links não confirmados.

---

# Atualização automática

Se a Central estiver integrada ao sistema de pedidos:

o Bot deve priorizar o status recebido pela integração.

Evitar pedir ao cliente informações que o sistema já possui.

---

# Última movimentação

Ao responder:

usar linguagem clara.

Exemplo:

"Seu pedido teve a última atualização em 16/09, quando foi encaminhado para a unidade de distribuição."

Melhor que:

"Está em trânsito."

quando houver detalhe disponível.

---

# Previsão

Se houver uma previsão registrada:

pode informar:

"A previsão atual é..."

Não transformar previsão em garantia.

Preferir:

"previsão"

e não:

"vai chegar".

---

# Previsão alterada

Se a transportadora atualizar a previsão:

usar a mais recente.

Se houver atraso significativo:

encaminhar.

---

# Pedido sem previsão

Não inventar data.

Informar que ainda não existe previsão disponível no rastreamento.

---

# Finais de semana e feriados

Podem afetar movimentação e entrega.

Não aplicar regra específica de dias úteis sem confirmação da transportadora/política.

---

# Pedido parado em unidade de distribuição

Isso não significa necessariamente problema.

Verificar:

- há quanto tempo
- previsão
- ocorrência

Se dentro do prazo:

acompanhar.

Se fora:

encaminhar.

---

# Pedido em fiscalização

Se houver status específico de fiscalização, retenção ou processo externo:

não inventar motivo.

Encaminhar se necessário.

---

# Pedido internacional

Quando aplicável, rastreamento pode ter etapas adicionais.

Não misturar automaticamente com pedidos nacionais da Mibro Brasil.

---

# Produto em lançamento / pré-venda

Não fornecer rastreio antes de existir despacho real.

Status de lançamento não significa pedido enviado.

---

# Exemplo — rastreio parado

Cliente:

"Meu pedido não atualiza há 3 dias."

Bot:

"Vou conferir a última movimentação e a previsão. Se ainda estiver dentro do prazo, pode ser apenas uma etapa sem atualização intermediária. Se a previsão já tiver passado, encaminho para a logística verificar."

---

# Exemplo — entregue, mas não recebido

Cliente:

"Aparece entregue, mas não chegou."

Bot:

"Verifique primeiro se alguém da portaria, recepção ou outra pessoa no endereço recebeu. Se ninguém localizar o pedido, vou encaminhar para conferirmos o comprovante de entrega com a transportadora."

---

# Exemplo — devolução

Cliente:

"Apareceu devolução ao remetente."

Bot:

"Isso significa que a encomenda está retornando. Vou encaminhar o pedido para a equipe verificar o motivo da devolução e quais opções estarão disponíveis depois da confirmação do retorno."

---

# Exemplo — possível extravio

Cliente:

"Meu pedido sumiu."

Bot:

"Como o rastreio está sem movimentação e a previsão já passou, precisamos abrir uma verificação com a logística/transportadora. Ainda não é possível afirmar que houve extravio sem essa confirmação."

---

# Quando encaminhar para humano

Encaminhar quando houver:

- previsão ultrapassada
- rastreio sem atualização por período anormal
- código inválido persistente
- devolução ao remetente
- entrega marcada como concluída e cliente não recebeu
- assinatura desconhecida
- entrega em local divergente
- suspeita de extravio
- código incorreto
- ocorrência logística não documentada

---

# Informações úteis antes do handoff

Coletar ou obter pelo sistema:

- número do pedido
- código de rastreio
- transportadora
- status
- última movimentação
- data da última movimentação
- previsão
- problema relatado

---

# Resumo para humano

Exemplo:

Setor: Pedidos / Logística
Assunto: Entregue não recebido
Pedido: #1234
Transportadora: registrada no pedido
Rastreio: disponível
Status: entregue
Data: 17/09/2026
Cliente verificou portaria: sim
Pedido localizado: não
Pendência: consultar comprovante de entrega e abrir ocorrência logística

---

# O que o Bot pode fazer

Pode:

- informar rastreio real
- explicar status
- informar última movimentação
- informar previsão existente
- orientar verificações simples
- identificar necessidade de ocorrência
- encaminhar

---

# O que o Bot NÃO deve fazer

Não deve:

- inventar status
- declarar extravio sem confirmação
- garantir data
- culpar transportadora
- culpar cliente
- expor dados de terceiros
- prometer reenvio
- prometer reembolso
- prometer nova tentativa sem confirmação

---

# Regra final

O rastreamento mostra o que aconteceu até o momento.

Quando houver divergência entre o rastreio e a realidade relatada pelo cliente:

encaminhar para investigação logística.