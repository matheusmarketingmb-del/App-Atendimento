# Manual do Supervisor

## 1. Objetivo

O Supervisor acompanha a operação, identifica filas e prioridades, apoia os Atendentes e verifica se as conversas estão distribuídas corretamente.

O perfil Supervisor não concede acesso irrestrito. Categorias, números/canais e permissões adicionais continuam controlando o que pode ser visualizado.

## 2. Preparação recomendada

Para exercer a supervisão, a conta normalmente deve receber:

- vínculo com seus atendentes, definido pelo Master em **Equipes**;
- acesso às categorias supervisionadas;
- acesso aos números/contas dos canais supervisionados;
- **Visualizar histórico**, quando precisar auditar ações da conversa;
- **Ver mensagens anteriores**, quando precisar analisar o atendimento antes de uma transferência;
- **Alterar responsável**, quando for responsável pela redistribuição entre Atendentes.

## 3. Visualizar conversas dos Atendentes

1. Abra **Minha equipe** na barra lateral.
2. Confira os membros vinculados pelo Master.
3. Selecione o Atendente.
4. Escolha **Atuais** para os responsáveis atuais ou **Histórico** para todas as conversas em que o atendente participou, inclusive transferidas e finalizadas. Remova filtros para uma consulta abrangente.
5. Abra a conversa para consultar o atendimento.

Você lê apenas os trechos em que alguém da sua equipe foi responsável. Categorias Somente Master continuam excluídas. A supervisão é somente leitura: não permite responder, transferir, finalizar ou marcar como lida pelo atendente. O campo antigo **Acompanhar equipe** não define esses vínculos.

## 4. Acompanhar a equipe

Na área **Minha equipe**, o Supervisor visualiza contagens e atendimentos dos membros vinculados. Não cria contas, altera permissões nem escolhe quem pertence à equipe; essas ações são exclusivas do Master.

Use a visão da equipe para:

- conferir distribuição de conversas;
- identificar usuários sobrecarregados;
- localizar conversas sem responsável;
- verificar filas paradas;
- orientar transferências.

## 5. Prioridades

O Supervisor pode classificar conversas em que possui acesso operacional como **Normal**, **Alta** ou **Urgente** sem uma permissão adicional. Uma conversa aberta apenas por supervisão permanece somente leitura.

Critérios recomendados:

- **Normal:** atendimento rotineiro, sem prazo crítico.
- **Alta:** impacto relevante, cliente aguardando ação importante ou prazo próximo.
- **Urgente:** risco imediato, indisponibilidade grave ou prazo crítico.

Evite marcar todos os casos como urgentes; isso elimina a utilidade da fila de prioridade.

## 6. Transferência e redistribuição

Nas conversas em que possui acesso operacional (próprio atendimento ou fila liberada), o Supervisor pode mover a conversa para uma categoria pública permitida pelo canal. Com **Alterar responsável**, também pode:

- trocar o atendente responsável;
- trocar o atendente mesmo quando ele próprio não é o destino;
- remover o responsável ao encaminhar para um novo setor;
- decidir se o histórico anterior deve ser ocultado do destino.

Antes de transferir, confirme se o novo atendente possui acesso à categoria e ao número/conta do canal.

A opção **Sinalizar encaminhamento** apenas publica um aviso no chat interno. Para concluir a transferência, altere a categoria ou o responsável.

## 7. Histórico e qualidade

Em **Histórico de atendimento**, o Supervisor consulta a linha do tempo dos trechos da equipe. O Master vê a linha do tempo completa.

**Visualizar histórico** e **Ver mensagens anteriores** continuam aplicáveis ao acesso operacional. Não ampliam a supervisão para trechos atendidos por pessoas fora da equipe.

Ao revisar um atendimento:

1. Leia a solicitação inicial.
2. Confirme se o Atendente entendeu o problema.
3. Verifique se a resposta seguiu a base de conhecimento.
4. Observe tempo, clareza e continuidade.
5. Registre orientação interna sem expor dados ao cliente.

## 8. Configurações de Conversas

O Supervisor pode abrir **Configurações de Conversas** em modo somente leitura para consultar regras operacionais, SLAs e comportamentos configurados. Apenas o Master pode alterar esses valores.

## 9. O que não é automático para o Supervisor

O perfil, sozinho, não libera:

- visualização de todos os Atendentes;
- todas as categorias;
- todos os números/canais;
- histórico de ações;
- mensagens anteriores a transferências;
- transferência de responsável;
- campanhas e templates;
- início de novas conversas;
- fusão de contatos.

Esses recursos exigem permissões e acessos específicos.

## 10. Escalonamento ao Master

Acione o Master quando for necessário:

- criar ou desativar usuário;
- alterar permissões e categorias liberadas;
- liberar um número ou conta de canal;
- configurar integrações;
- editar Bots, base de conhecimento ou respostas rápidas;
- alterar configurações gerais;
- consultar auditoria administrativa completa;
- corrigir um acesso que não corresponde à operação.

## 11. Rotina sugerida

### Início do turno

- Verifique filas Novas e sem responsável.
- Confira prioridades Alta e Urgente.
- Identifique canais ou categorias com acúmulo.

### Durante o turno

- Acompanhe conversas aguardando equipe.
- Redistribua casos quando necessário.
- Ajude a corrigir categoria e prioridade.

### Final do turno

- Confira pendências críticas.
- Garanta que transferências tenham responsável ou setor definido.
- Registre contexto relevante para a próxima equipe.
