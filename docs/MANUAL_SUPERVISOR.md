# Manual do Supervisor

## 1. Objetivo

O Supervisor acompanha a operação, identifica filas e prioridades, apoia os Atendentes e verifica se as conversas estão distribuídas corretamente.

O perfil Supervisor não concede acesso irrestrito. Categorias, números/canais e permissões adicionais continuam controlando o que pode ser visualizado.

## 2. Preparação recomendada

Para exercer a supervisão, a conta normalmente deve receber:

- **Acompanhar equipe**;
- acesso às categorias supervisionadas;
- acesso aos números/contas dos canais supervisionados;
- **Visualizar histórico**, quando precisar auditar ações da conversa;
- **Ver mensagens anteriores**, quando precisar analisar o atendimento antes de uma transferência;
- **Transferir conversas**, quando for responsável pela redistribuição.

## 3. Visualizar conversas dos Atendentes

1. Abra a caixa de atendimento.
2. Use o filtro de responsável.
3. Selecione o Atendente.
4. Combine com filtros de categoria, situação, prioridade e canal.
5. Abra a conversa para consultar o atendimento.

A permissão **Acompanhar equipe** permite filtrar outros usuários, mas não ignora os demais controles. O Supervisor continuará vendo apenas conversas das categorias e contas de canal liberadas para ele.

## 4. Acompanhar a equipe

Na área **Equipe**, o Supervisor autorizado visualiza a atividade dentro de seu próprio escopo. Ele não cria contas nem altera permissões; essas ações são exclusivas do Master.

Use a visão da equipe para:

- conferir distribuição de conversas;
- identificar usuários sobrecarregados;
- localizar conversas sem responsável;
- verificar filas paradas;
- orientar transferências.

## 5. Prioridades

O Supervisor pode classificar conversas como **Normal**, **Alta** ou **Urgente** sem uma permissão adicional.

Critérios recomendados:

- **Normal:** atendimento rotineiro, sem prazo crítico.
- **Alta:** impacto relevante, cliente aguardando ação importante ou prazo próximo.
- **Urgente:** risco imediato, indisponibilidade grave ou prazo crítico.

Evite marcar todos os casos como urgentes; isso elimina a utilidade da fila de prioridade.

## 6. Transferência e redistribuição

Com **Transferir conversas**, o Supervisor pode:

- trocar o atendente responsável;
- mover a conversa para outra categoria/setor permitido;
- remover o responsável ao encaminhar para um novo setor;
- decidir se o histórico anterior deve ser ocultado do destino.

Antes de transferir, confirme se o novo atendente possui acesso à categoria e ao número/conta do canal.

A opção **Sinalizar encaminhamento** apenas publica um aviso no chat interno. Para concluir a transferência, altere a categoria ou o responsável.

## 7. Histórico e qualidade

Com **Visualizar histórico**, o Supervisor consulta as ações registradas na conversa, como mudança de responsável, categoria, prioridade e situação.

Com **Ver mensagens anteriores**, consegue analisar conteúdo anterior ao limite criado por um encaminhamento.

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
