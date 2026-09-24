# Manual do Master

## 1. Objetivo

O Master administra a Central de Atendimento e possui acesso completo à operação e às configurações. Esse perfil deve ser reservado a poucas pessoas responsáveis por segurança, acessos e continuidade do serviço.

## 2. Responsabilidades

- criar, editar, ativar e desativar contas;
- definir perfis e permissões;
- liberar categorias e números/canais;
- organizar categorias e subcategorias;
- configurar integrações;
- administrar Bots, base de conhecimento e respostas rápidas;
- acompanhar relatórios e auditoria;
- editar configurações gerais;
- revisar acessos periodicamente.

## 3. Criar uma conta

1. Abra **Equipe**.
2. Clique em **Nova conta**.
3. Informe nome e e-mail.
4. Escolha Atendente, Supervisor ou Master.
5. Defina uma senha inicial com pelo menos oito caracteres.
6. Marque somente as permissões necessárias.
7. Libere cada categoria e subcategoria necessária.
8. Salve.
9. Nas integrações/canais, libere também os números ou contas que o usuário poderá acessar.

Categoria e subcategoria são liberadas separadamente. Liberar uma categoria principal não significa necessariamente liberar todas as subcategorias.

## 4. Configuração recomendada por perfil

### Atendente

Libere apenas:

- categorias usadas no trabalho diário;
- números/contas atendidos;
- “Sem categoria”, se fizer parte da triagem;
- permissões adicionais estritamente necessárias.

### Supervisor

Além do escopo operacional, considere:

- **Acompanhar equipe**;
- **Visualizar histórico**;
- **Ver mensagens anteriores**;
- **Transferir conversas**;
- acesso a todas as categorias e canais da equipe supervisionada.

O Supervisor já pode definir prioridade e visualizar Configurações de Conversas em modo somente leitura.

### Master

O perfil possui acesso administrativo completo. Evite usar Master como conta comum de atendimento quando não houver necessidade.

## 5. Permissões adicionais

### Gerenciar categorias

Permite criar, editar e desativar categorias. Não concede administração de usuários.

### Transferir conversas

Permite alterar o atendente responsável e realizar mudanças de categoria/setor, respeitando as restrições do canal e categorias exclusivas de Master.

### Acompanhar equipe

Permite filtrar atendimentos de outros usuários dentro das categorias e canais liberados.

### Visualizar histórico

Exibe as ações registradas nas conversas permitidas.

### Ver mensagens anteriores

Permite consultar mensagens anteriores ao ponto de transferência, quando o histórico não estiver disponível pelo escopo normal.

### Definir prioridade

Permite ao Atendente marcar uma conversa como Normal, Alta ou Urgente. Supervisor e Master já podem fazer isso.

### Iniciar conversas

Exibe a ação de nova conversa e permite iniciar contatos pelos canais liberados.

### Fundir contatos

Permite unir registros de canais diferentes que pertençam à mesma pessoa.

### Campanhas e templates

Libera a área de campanhas e o uso de templates. Para usuários que não são Master, deve ser concedida explicitamente.

## 6. Categorias

Use categorias principais para setores e subcategorias para motivos ou filas específicas.

Boas práticas:

- nomes claros e curtos;
- evitar categorias duplicadas;
- desativar categorias obsoletas;
- usar categorias exclusivas de Master somente para conteúdo realmente restrito;
- revisar os acessos após criar ou reorganizar categorias.

Ao mudar uma conversa de setor, o sistema pode remover o responsável atual, registrar a mudança e limitar o histórico do destino, conforme a opção escolhida.

## 7. Números, canais e integrações

Além das categorias, cada usuário precisa de acesso à conta do canal correspondente.

Ao adicionar ou revisar um número:

1. confirme que a conexão está ativa;
2. teste a conexão;
3. libere os usuários corretos;
4. libere as categorias permitidas para aquela conta;
5. valide recebimento e envio;
6. confirme no cabeçalho da conversa qual número está sendo usado.

Nunca envie tokens ou chaves por mensagens comuns. Use somente os campos protegidos da integração.

## 8. Bots e conhecimento

O Master controla:

- ativação e configuração dos Bots;
- categorias e ações de encaminhamento;
- simulação segura;
- base de conhecimento;
- sugestões de aprendizado;
- versões e restauração;
- respostas rápidas.

Antes de ativar automação real, teste no simulador. Revise sugestões de aprendizado antes de aprová-las e descarte conteúdo que contenha dados pessoais, nomes de atendentes ou respostas específicas demais.

## 9. Configurações e relatórios

- **Configurações de Conversas:** regras operacionais, SLAs e comportamentos da caixa.
- **Relatório de Conversas:** visão consolidada e exportação dos atendimentos.
- **Auditoria geral:** registro de alterações administrativas e ações de maior impacto.
- **Campanhas:** gestão de disparos, templates, listas e métricas para usuários autorizados.

## 10. Auditoria

Use a auditoria para investigar alterações em:

- contas e acessos;
- conversas;
- categorias;
- notas;
- Bots;
- campanhas;
- configurações.

A auditoria não substitui o princípio do menor privilégio. Corrija acessos excessivos assim que forem identificados.

## 11. Checklist ao liberar um novo usuário

- [ ] Perfil correto.
- [ ] Conta ativa.
- [ ] Senha inicial entregue de forma segura.
- [ ] Categorias e subcategorias liberadas.
- [ ] “Sem categoria” revisado.
- [ ] Números/contas de canal liberados.
- [ ] Transferência revisada.
- [ ] Acompanhamento de equipe revisado.
- [ ] Histórico e mensagens anteriores revisados.
- [ ] Prioridade, novas conversas, contatos e campanhas revisados.
- [ ] Login testado.
- [ ] Uma conversa de teste aberta sem envio indevido ao cliente.

## 12. Revisão periódica

Recomenda-se revisar mensalmente:

- contas inativas;
- usuários com perfil Master;
- permissões adicionais;
- categorias e canais liberados;
- integrações desconectadas;
- Bots e automações ativos;
- registros de auditoria relevantes.
