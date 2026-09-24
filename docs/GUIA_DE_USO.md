# Central de Atendimento — Guia de uso

Este conjunto de manuais explica como usar a Central de Atendimento conforme o perfil da conta.

- [Manual do Atendente](MANUAL_ATENDENTE.md)
- [Manual do Supervisor](MANUAL_SUPERVISOR.md)
- [Manual do Master](MANUAL_MASTER.md)

## Perfis

### Atendente

Opera as conversas liberadas para sua conta: assume atendimentos, responde clientes, registra notas, utiliza respostas rápidas e finaliza conversas. Outras ações dependem de permissões adicionais.

### Supervisor

Pode executar o atendimento normal e definir prioridades. Para acompanhar conversas de outros atendentes, precisa também da permissão **Acompanhar equipe** e dos acessos às categorias e aos números/canais envolvidos.

### Master

Possui acesso administrativo completo: equipe, permissões, categorias, canais, integrações, Bots, base de conhecimento, respostas rápidas, relatórios, configurações e auditoria.

## Matriz resumida

| Recurso | Atendente | Supervisor | Master |
|---|---:|---:|---:|
| Atender conversas liberadas | Sim | Sim | Sim |
| Assumir conversa | Sim | Sim | Sim |
| Responder e anexar arquivos | Sim | Sim | Sim |
| Usar respostas rápidas | Sim | Sim | Sim |
| Registrar notas e fixar conversa | Sim | Sim | Sim |
| Definir prioridade | Com permissão | Sim | Sim |
| Transferir responsável | Com permissão | Com permissão | Sim |
| Mudar categoria/setor | Conforme acesso; permissão de transferência amplia a ação | Conforme acesso; permissão de transferência amplia a ação | Sim |
| Ver conversas de outros atendentes | Com **Acompanhar equipe** | Com **Acompanhar equipe** | Sim |
| Ver histórico de ações | Com permissão | Com permissão | Sim |
| Ver mensagens anteriores após transferência | Com permissão | Com permissão | Sim |
| Ver “Sem categoria” | Com permissão | Com permissão | Sim |
| Iniciar conversa | Com permissão | Com permissão | Sim |
| Fundir contatos | Com permissão | Com permissão | Sim |
| Campanhas e templates | Com permissão | Com permissão | Sim |
| Configurações de Conversas | Não | Somente leitura | Edita |
| Criar e alterar contas | Não | Não | Sim |
| Integrações, Bots, base e relatórios | Não | Não | Sim |
| Auditoria geral | Não | Não | Sim |

## Como o acesso às conversas é calculado

Para uma conversa aparecer, não basta o perfil da conta. O usuário precisa estar no escopo correto:

1. A conversa está atribuída a ele, ou a categoria foi liberada para ele.
2. Se estiver sem categoria, a permissão **Ver “Sem categoria”** precisa estar ativa.
3. Para contas de WhatsApp/Meta e e-mail, o número ou a conta do canal também precisa estar liberado para o usuário.
4. Categorias exclusivas de Master nunca aparecem para Atendentes ou Supervisores.

## Permissões adicionais

- **Gerenciar categorias:** criar, editar e desativar categorias.
- **Transferir conversas:** mudar o atendente responsável e permitir transferências de categoria, respeitando as restrições de canal e de categorias Master.
- **Acompanhar equipe:** filtrar e consultar atendimentos de outros membros dentro do escopo liberado.
- **Visualizar histórico:** consultar ações registradas nas conversas permitidas.
- **Ver mensagens anteriores:** ao receber uma transferência, visualizar também mensagens anteriores ao encaminhamento.
- **Definir prioridade:** classificar a conversa como Normal, Alta ou Urgente. Supervisor e Master já possuem essa capacidade.
- **Iniciar conversas:** exibir a ação de nova conversa e permitir início pelos canais liberados.
- **Fundir contatos:** unir canais e cadastros que pertencem à mesma pessoa.
- **Campanhas e templates:** acessar campanhas e utilizar seus templates.

## Transferência: duas ações diferentes

### Transferir a conversa

Altera de fato a categoria/setor ou o atendente responsável. A mudança fica registrada no histórico e na auditoria.

### Sinalizar encaminhamento

Envia um aviso ao chat interno do setor escolhido. Essa ação, sozinha, não muda a categoria nem o responsável da conversa.

## Boas práticas gerais

- Confirme o número/canal antes de responder.
- Leia o histórico disponível e as notas do contato.
- Assuma a conversa antes de iniciar um atendimento que ainda não tenha responsável.
- Revise respostas rápidas antes do envio; elas apenas preenchem o campo de mensagem.
- Use notas para informações internas. Nunca envie dados internos no campo de resposta ao cliente.
- Escolha a categoria correta antes de transferir.
- Finalize somente quando o atendimento estiver concluído.
- Não compartilhe senha, token ou credenciais de integração.

## Quando solicitar ajuda ao Master

Solicite revisão administrativa quando uma conversa, categoria, número ou recurso necessário não aparecer; quando uma transferência for bloqueada; ou quando uma permissão adicional for necessária.
