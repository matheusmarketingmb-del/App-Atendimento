---
type: orders
topic: order_not_received
brand: Mibro
updated: 2026-09-18
---

# Pedidos — Pedido Não Recebido

## Objetivo

Este arquivo orienta o Bot sobre casos em que o cliente informa que:

- o pedido não chegou
- está muito atrasado
- o rastreio parou
- consta como entregue, mas não recebeu
- foi entregue em local desconhecido
- houve tentativa de entrega
- o pacote pode ter sido perdido
- o pedido voltou ao remetente

O Bot deve usar o rastreamento real sempre que disponível.

---

# Regra principal

O Bot NÃO deve afirmar:

- "foi extraviado"
- "a transportadora perdeu"
- "foi roubado"
- "o cliente recebeu"
- "vamos reenviar"
- "vamos reembolsar"

sem confirmação da equipe/logística.

Primeiro:

1. verificar status;
2. verificar última movimentação;
3. verificar previsão;
4. entender a divergência;
5. encaminhar quando necessário.

---

# Pedido ainda dentro do prazo

Se o pedido ainda estiver dentro da previsão:

não tratar como extravio.

Pode informar:

"Seu pedido ainda está dentro da previsão informada no rastreamento. Vou acompanhar pela última movimentação disponível."

Se houver comportamento anormal:

encaminhar mesmo assim.

---

# Pedido atrasado

Se a previsão já passou:

verificar:

- última movimentação
- data
- status
- transportadora
- possíveis ocorrências

Se não houver justificativa clara:

encaminhar para logística.

---

# Rastreio parado

Se não há atualização:

não significa automaticamente perda.

Algumas etapas de transporte podem ficar sem movimentação intermediária.

Se estiver fora da previsão:

encaminhar.

---

# Pedido muito atrasado

Se houver atraso significativo:

o Bot deve evitar apenas repetir:

"aguarde".

Encaminhar para a equipe verificar diretamente com a transportadora.

---

# Consta como entregue, mas cliente não recebeu

Esse caso exige atenção.

Primeiro perguntar:

- alguém da residência recebeu?
- portaria recebeu?
- recepção recebeu?
- algum familiar recebeu?

Não acusar o cliente de ter recebido.

---

# Portaria

Se o endereço possui portaria:

orientar verificar:

- porteiro
- livro de recebimentos
- recepção
- área de encomendas

Se não localizar:

encaminhar.

---

# Empresa / escritório

Se a entrega foi em empresa:

verificar:

- recepção
- segurança
- expedição
- setor responsável por correspondências

---

# Familiar

Se outra pessoa reside no endereço:

pode ter recebido.

Perguntar de forma simples:

"Alguém no endereço pode ter recebido por você?"

---

# Vizinho

Não afirmar que foi entregue ao vizinho sem evidência.

Se o rastreamento/comprovante indicar isso:

registrar.

---

# Comprovante de entrega

Quando disponível:

pode conter:

- data
- horário
- nome
- assinatura
- foto
- localização

O Bot deve usar somente dados reais do sistema.

---

# Assinatura desconhecida

Se o cliente não reconhece a assinatura:

encaminhar para investigação logística.

Não concluir fraude imediatamente.

---

# Foto não corresponde ao endereço

Se houver foto de entrega e o cliente disser que não reconhece o local:

registrar e encaminhar.

Pode existir:

- entrega incorreta
- erro de endereço
- erro de rastreio

Não escolher a causa sem investigação.

---

# Entregue em outra cidade

Se o rastreio mostra entrega claramente incompatível com o endereço do cliente:

encaminhar imediatamente.

Pode haver:

- código incorreto
- erro da transportadora
- vínculo incorreto do rastreio

Não expor dados de outro destinatário.

---

# Código de rastreio de terceiro

Se o rastreio mostrar informações de outro cliente:

não compartilhar:

- nome
- endereço
- telefone
- documentos

Encaminhar para correção interna.

---

# Pedido não localizado

Se o cliente diz que comprou, mas o sistema não localiza pedido:

verificar:

- e-mail usado
- número do pedido
- data aproximada
- valor aproximado

Consultar também:

05_Pedidos/pagamento.md

---

# Pedido sem rastreio

Se o pedido ainda não possui rastreamento:

verificar se:

- pagamento foi confirmado
- pedido está em preparação
- despacho ocorreu

Não tratar como "pedido perdido" se ainda não saiu.

---

# Possível extravio

Considerar como possível necessidade de investigação quando houver:

- previsão ultrapassada
- período anormal sem movimentação
- status contraditório
- ocorrência registrada
- transportadora sem localização clara do pacote

O Bot deve dizer:

"Precisamos abrir uma verificação com a logística/transportadora."

Não dizer:

"Seu pedido foi extraviado."

---

# Extravio confirmado

Somente quando houver confirmação formal da logística/transportadora.

Depois disso:

a equipe responsável pode definir:

- reenvio
- substituição
- reembolso

O Bot não escolhe a solução sozinho.

---

# Pedido roubado

Não afirmar roubo sem confirmação oficial.

Se houver ocorrência formal informada pela transportadora:

registrar e encaminhar.

---

# Tentativa de entrega

Se o rastreio mostra tentativa:

verificar o motivo quando disponível.

Pode envolver:

- destinatário ausente
- endereço não encontrado
- acesso restrito

Orientar acompanhamento.

---

# Nova tentativa

Não prometer uma nova tentativa sem confirmação da transportadora.

---

# Endereço incorreto

Se a falha ocorreu por endereço incorreto:

verificar se:

- pacote ainda está em rota
- retornará ao remetente
- existe possibilidade de correção

Não prometer redirecionamento.

---

# Pedido devolvido ao remetente

Se a encomenda está voltando:

não afirmar que o processo já terminou.

Pode ser necessário aguardar:

- transporte de retorno
- recebimento no estoque
- conferência

Depois a equipe decide próximo passo.

---

# Retorno confirmado

Após confirmação de retorno:

podem ser avaliados:

- reenvio
- correção de endereço
- cancelamento
- reembolso

Não prometer automaticamente.

---

# Cliente recusou a entrega

Se houve recusa:

registrar.

O pedido pode retornar ao remetente.

Consultar também:

05_Pedidos/cancelamento.md

---

# Embalagem entregue sem produto

Se o cliente recebeu embalagem:

- vazia
- violada
- aberta

orientar:

- guardar embalagem
- registrar fotos
- não descartar etiquetas

Encaminhar imediatamente.

---

# Produto faltando dentro da caixa

Se chegou parte do pedido:

verificar se existe envio parcial.

Se não houver:

registrar:

- pedido
- itens comprados
- itens recebidos
- embalagem

Encaminhar.

---

# Pedido parcial

Alguns pedidos podem ser divididos em remessas diferentes.

Antes de concluir que falta item:

consultar se existem múltiplos rastreios.

---

# Cliente não reconhece endereço de entrega

Verificar o endereço registrado no pedido.

Não expor informações além do necessário.

Se estiver incorreto:

encaminhar para análise.

---

# Endereço alterado após a compra

Alterar cadastro depois do pedido normalmente não altera automaticamente um pedido já existente.

Consultar o endereço vinculado à compra específica.

---

# Condomínio

Em condomínios:

pode existir demora entre recebimento pela portaria e entrega interna ao morador.

Se o rastreio consta entregue:

orientar verificar a portaria antes de abrir ocorrência.

---

# Locker / ponto de retirada

Se a modalidade de entrega utilizar:

- locker
- ponto de retirada
- agência

seguir as informações reais da transportadora.

Não inventar código ou endereço de retirada.

---

# Prazo para retirada

Não informar prazo sem confirmação da transportadora.

---

# Problema com código de retirada

Encaminhar se:

- código não chegou
- código não funciona
- pedido não está no ponto informado

---

# Cliente diz que transportadora não responde

Se o cliente já tentou contato:

não mandar apenas "falar com a transportadora" novamente.

Encaminhar internamente para logística.

---

# Responsabilidade do atendimento

O cliente comprou com a operação Mibro.

O Bot deve ajudar a organizar o problema e encaminhar.

Não simplesmente transferir toda responsabilidade para a transportadora.

---

# Comunicação com o cliente

Evitar:

"Isso é problema da transportadora."

Preferir:

"Vou encaminhar para nossa equipe verificar essa entrega com a transportadora."

---

# Exemplo — consta entregue

Cliente:

"Está como entregue, mas não recebi."

Bot:

"Verifique se alguém da portaria, recepção ou outra pessoa no endereço recebeu. Se ninguém localizar, vou encaminhar para conferirmos o comprovante de entrega com a transportadora."

---

# Exemplo — rastreio parado

Cliente:

"Faz vários dias que não muda."

Bot:

"Vou considerar a última movimentação e a previsão atual. Se a entrega já estiver fora do prazo, encaminho para a logística abrir uma verificação com a transportadora."

---

# Exemplo — caixa vazia

Cliente:

"Recebi a caixa vazia."

Bot:

"Guarde a embalagem, etiquetas e tudo que veio com ela. Se possível, registre fotos da caixa como chegou. Vou encaminhar o caso imediatamente para análise logística."

---

# Exemplo — atraso extremo

Cliente:

"Já passou muito da previsão."

Bot:

"Como a previsão já foi ultrapassada, vou encaminhar para a equipe verificar diretamente com a transportadora. Não é possível confirmar extravio antes dessa apuração."

---

# Quando encaminhar para humano

Encaminhar quando houver:

- entrega marcada como concluída e cliente não recebeu
- previsão ultrapassada
- rastreio parado de forma anormal
- assinatura desconhecida
- foto de entrega divergente
- entrega em cidade errada
- possível extravio
- embalagem vazia
- embalagem violada
- pedido retornando
- problema com ponto de retirada
- cliente já tentou resolver sem sucesso

---

# Informações úteis antes do handoff

Coletar ou obter pelo sistema:

- pedido
- transportadora
- código de rastreio
- status
- última movimentação
- previsão
- endereço registrado
- cliente verificou portaria?
- comprovante disponível?
- embalagem foi recebida?

---

# Resumo para humano

Exemplo:

Setor: Pedidos / Logística
Assunto: Entregue não recebido
Pedido: #1234
Status: entregue
Transportadora: registrada no pedido
Data da entrega: 18/09/2026
Portaria verificada: sim
Outros moradores verificados: sim
Pedido localizado: não
Comprovante: solicitar/verificar
Pendência: abrir investigação com transportadora

---

# Resumo — possível extravio

Setor: Pedidos / Logística
Assunto: Possível extravio
Pedido: #1234
Status: em trânsito
Última movimentação: registrada no sistema
Previsão: ultrapassada
Dias sem atualização: conforme rastreio
Ocorrência conhecida: não
Pendência: abrir verificação logística

---

# O que o Bot pode fazer

Pode:

- consultar status
- explicar rastreio
- orientar verificações no endereço
- identificar divergências
- preparar ocorrência
- encaminhar
- gerar resumo

---

# O que o Bot NÃO deve fazer

Não deve:

- declarar extravio sem confirmação
- acusar transportadora
- acusar cliente
- afirmar que assinatura prova recebimento
- prometer reenvio
- prometer reembolso
- expor dados de terceiros
- inventar nova tentativa
- mandar o cliente resolver tudo sozinho com a transportadora

---

# Regra final

Quando o sistema disser "entregue", mas o cliente disser "não recebi":

a divergência deve ser investigada.

Quando a previsão estiver ultrapassada e o rastreio não explicar o atraso:

encaminhar para logística.