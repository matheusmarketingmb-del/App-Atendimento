(() => {
  const APP_VERSION = "0.38.6";



  const CHANGELOG = [
    {"version":"0.38.6","date":"09/11/2026","title":"Desempenho de campanhas Meta","changes":["Mibro e Sincrofit acompanham alcance, frequência, CPM, CTR e CPC total e de link.","Conversas atribuídas pela Meta e contatos vinculados no WhatsApp têm indicadores separados.","Compare campanhas, conjuntos de anúncios ou anúncios individuais."]},
    {"version":"0.38.5","date":"09/11/2026","title":"Restaurar categorias ocultas","changes":["Ao limpar os filtros pelo botão ↻, as categorias ocultadas da empresa aberta voltam a aparecer conforme as permissões da conta."]},
    {"version":"0.38.4","date":"09/11/2026","title":"Novo toque e limpeza de filtros","changes":["Novo toque para mensagens e entradas na categoria, com volume mais alto e controle pelo sino.","O botão ↻ limpa os filtros da empresa aberta e volta para Todos.","A mensagem da Mibro Black mostra os oito modelos por linha, com preços no Pix e link para todos os produtos."]},
    {"version":"0.38.3","date":"09/11/2026","title":"Alertas e organização da Central","changes":["Alerta sonoro mais alto para novas mensagens e atendimentos que chegam à categoria, com controle pelo sino de cada empresa.","Avisos identificam Mibro ou Sincrofit, inclusive quando outra empresa está aberta. A barra lateral exibe as categorias liberadas.","A Agenda destaca compromissos do dia. O menu Mibro Black apresenta os modelos, descontos e preços no Pix."]},
    {"version":"0.38.2","date":"06/11/2026","title":"Assistentes, triagem e ficha interna","changes":["Assistentes normais da Mibro e da Sincrofit se apresentam após a triagem e oferecem opções conforme o setor.","A triagem informa se a conversa segue com o assistente ou com a equipe. O aviso de fora do expediente continua valendo.","Os assistentes respeitam o atendente fixo e param quando a equipe assume ou responde.","Marketing e Parcerias coletam redes sociais, formato da proposta, média de visualizações e valores.","A Ficha do bot organiza as respostas dentro da conversa, com as mesmas permissões do histórico.","O menu continua aceitando números após respostas fora das opções, enquanto a lista atual estiver aberta.","Assistentes de fora do expediente têm opções de Varejo e Atacado, com descrições de produtos e catálogo conforme o fluxo."]},
    { version: "0.38.1", date: "05/11/2026", title: "Configurações e permissões organizadas", changes: ["Recursos do chat ativados pelo Master em Configurações, com proteção contra alterações simultâneas.", "Métricas reunidas em um único botão, com abas conforme o acesso de cada pessoa.", "Equipe organizada por Conta, Acessos, Permissões e Equipe e CRM, com escolha dos números de WhatsApp.", "Proteção contra repetição de reações e envios pela biblioteca."] },
    { version: "0.38.0", date: "04/11/2026", title: "Conversas mais próximas do WhatsApp", changes: ["Responder citando uma mensagem, com a citação visível no WhatsApp do cliente quando a Meta permitir.", "Reações com emoji, enviadas e recebidas, sem criar mensagens falsas na conversa.", "Biblioteca de figurinhas e GIFs por pessoa, setor e empresa. GIFs são enviados como vídeo MP4.", "Favoritos pessoais, mensagens fixadas, pesquisa na conversa e encaminhamento com confirmação do destinatário.", "Menu de ações por mensagem, seletor de emojis, links clicáveis, zoom em imagens e velocidade de áudio.", "Reações locais no chat interno."] },
    { version: "0.37.21", date: "03/11/2026", title: "Campanhas Meta e painel comercial", changes: ["Campanhas Meta: investimento, cliques, impressões e contatos identificados pelo anúncio, separados por empresa e conta de anúncios.", "Dashboard comercial Master/Supervisor com filtros, indicadores, gráficos e exportação respeitando a equipe atual.", "Custos WhatsApp com Todo o período e Últimos 3 meses. Conversas, vendedores, permissões e regras do WhatsApp preservados."] },
    {"version":"0.37.20","date":"03/11/2026","title":"Templates e propostas comerciais","changes":["Contato e template podem ser selecionados em qualquer ordem; campos editados manualmente são preservados.","Botão de envio atualizado automaticamente e com indicação dos campos pendentes.","Novo fluxo de propostas comerciais do CRM, conferência de estoque, fila de pendências e aprovação de pedido exclusiva do Master.","Consultas de parcelas, nota e rastreamento; documentos preparados no Atendimento para revisão antes de enviar.","Sem alteração retroativa de mensagens, responsáveis ou categorias."]},{"version":"0.37.19","date":"30/10/2026","title":"Propostas em PDF e expediente respeitado","changes":["Baixar propostas em PDF no CRM, respeitando a carteira de cada usuário.","Clientes com vendedor fixo recebem aviso de fora do expediente e previsão de retorno.","SLA pausado fora do expediente; apenas minutos de atendimento são contabilizados, incluindo fins de semana e feriados.","Responsável, categoria e histórico preservados."]},{"version":"0.37.18","date":"29/10/2026","title":"Perfil do cliente mais prático","changes":["Ações de arquivamento com visual mais limpo e compacto nos detalhes do cliente.","Copiar nome e número diretamente no perfil, com identificação do telefone.","Mantida a recuperação manual de conversas arquivadas."]},{"version":"0.37.17","date":"29/10/2026","title":"Arquivar e recuperar conversas","changes":["Arquivar nos detalhes retira a conversa de Todos e das listas normais sem apagar o histórico.","Nova aba Arquivados nas Configurações para buscar e abrir conversas e detalhes.","Novas mensagens ficam salvas e a conversa permanece arquivada até a recuperação manual.","Preservados responsáveis, atendentes fixos, carteiras CRM e separação entre empresas."]},{"version":"0.37.16","date":"28/10/2026","title":"Sincrofit: entrada direta no Atacado","changes":["Bot independente identifica a mensagem Quero comprar no atacado e encaminha para Comercial → Atacado.","Confirmação ao cliente com respeito ao expediente da Sincrofit.","Preservados responsáveis, categorias manuais e demais fluxos."]},{"version":"0.37.15","date":"28/10/2026","title":"Assistência técnica e propostas pelo Atendimento","changes":["Assistência técnica coleta modelo, problema e tentativas antes de encaminhar à equipe.","Anexos durante a coleta não consomem tentativas nem repetem perguntas.","Criar proposta pela ficha CRM e voltar à conversa e ao número de origem para revisar o envio.","Marca da proposta independente da empresa do WhatsApp."]},{"version":"0.37.14","date":"28/10/2026","title":"Proteção de envios e categoria do cliente fixo","changes":["Proteção contra Enter repetido, clique duplo e repetição da mesma tentativa de envio de texto.","Cliente com vendedor fixo mantém a categoria ao voltar a falar, respeitando alterações manuais.","Rascunho preservado ao trocar de conversa durante um envio."]},{"version":"0.37.13","date":"28/10/2026","title":"Correção da sincronização de e-mails","changes":["Anexos do Gmail deixam de se repetir a cada sincronização.","Histórico e arquivos preservados; recuperação de falhas temporárias na importação."]},{"version":"0.37.12","date":"27/10/2026","title":"Assistente organizado e expediente integrado","changes":["Assistente reorganizado em nove fluxos por assunto, preservando as respostas e o atendimento humano.","Calendário do assistente integrado à triagem Mibro, incluindo fins de semana e feriados.","Recepção fora do expediente encaminha para a equipe e evita repetir o aviso no mesmo período fechado.","Editor diferencia bot pausado de fluxo publicado. Assistente e lembrete de 10 horas permanecem desligados."]},
{"version":"0.37.11","date":"26/10/2026","title":"Segurança e atendimento mais leve","changes":["Sessões de contas exclusivas do CRM são encerradas após troca ou redefinição de senha. A senha permanece a mesma na atualização, mas pode ser necessário entrar novamente uma vez.","Mais proteção na separação entre empresas dos canais sociais e no cadastro de notificações.","Conversas abrem pelas mensagens recentes; as antigas carregam ao rolar, preservando a posição de leitura e o acesso aos arquivos compartilhados.","Fila carregada em partes, contadores preservados e atualização em tempo real sem descartar avisos recebidos durante outra atualização.","HEIC e TIFF podem ser convertidos em PDF com as páginas preservadas; WebP animado pode ser convertido em MP4, com limites de processamento.","Novidades carregam somente quando abertas. Contatos sem nome não interrompem a lista."]},
    
    {"version":"0.37.10","date":"26/10/2026","title":"Senha geral e compatibilidade de anexos","changes":["Contas vinculadas podem alterar a senha geral pelo perfil CRM; redefinições do Master continuam prevalecendo e sessões antigas são revogadas.","Mensagens não disponibilizadas pelo WhatsApp agora explicam a necessidade de reenvio, inclusive no histórico existente.","Anexos BMP/WebP estático, GIF/MOV/AVI e WAV/FLAC podem ser convertidos antes do envio pela equipe, com limites de processamento e sem envio automático.","Conversões não recuperam conteúdo omitido pela Meta. HEIC, TIFF e WebP animado continuam sem conversão nesta versão."]},
    {version:"0.37.9",date:"23/10/2026",title:"Acesso ao CRM pela equipe",changes:["Novas contas CRM identificam uma conta ativa do Atendimento com o mesmo e-mail e vinculam o login automaticamente, preservando os cargos de cada sistema.","Master pode conferir, permitir e desativar o vínculo em Equipe → Editar membro → Acesso ao CRM. Contas existentes precisam dessa confirmação.","Representantes continuam somente no CRM. Falhas de comunicação são mostradas como pendência, sem recriar usuários ou substituir senhas."]},
    {"version":"0.37.8","date":"23/10/2026","title":"CRM integrado e atendimento por empresa","changes":["Número Comercial classifica entradas sem categoria em Comercial → Atacado, preservando responsáveis e a recepção do bot.","Assistente Mibro não inicia após a triagem em Atacado. Em Assistência Técnica, solicita SN, local de compra e NF/DANFE com o link de consulta. A ativação do Assistente continua manual.","Sincrofit responde à entrada de mais informações com o site de produtos; a entrada de atacado mantém o fluxo atual.","Produtividade ganha contagem de contatos por mensagem-padrão Sincrofit, com filtros e sem atribuir automaticamente a origem a anúncios.","CRM e Atendimento mantêm suas entradas de login, com navegação entre módulos e credencial do Atendimento para contas vinculadas. Representantes continuam somente no CRM.","Seleção de contatos da carteira para revisar envios na Central, importação de contatos, avisos de abordagem em outra empresa e busca por nome.","Central de Atividades, agenda, busca integrada e avisos, preservando os registros e permissões de cada sistema.","CRM com visual neutro e carregamento sob demanda dentro da Central."]},
    {"version":"0.37.7","date":"21/10/2026","title":"Atendimento mais ágil e histórico incremental","changes":["Lista de conversas aparece sem aguardar os contadores laterais. Reduzidas consultas repetidas e operações de supervisão, preservando permissões e atualização de novas mensagens.","Filtro Minhas mostra as conversas em que você é o responsável, dentro da empresa selecionada.","Chat interno carrega as mensagens recentes primeiro e busca as antigas ao rolar para cima, sem apagar mensagens ou limitar o histórico a 300 registros.","No número Comercial, o envio de template por um vendedor pode fixar o responsável automaticamente. Transferências manuais de atendente ou categoria removem esse vínculo automático, sem alterar vínculos manuais."]},
    { version: "0.37.6", date: "19/10/2026", title: "Chat por empresa e ranking de templates", changes: ["Chat interno com canais da empresa ativa, conversas diretas e grupos da equipe. O Geral antigo permanece como histórico somente leitura, sem apagar mensagens ou anexos.", "Contadores por empresa sem troca automática de área; grupos com descrição e seleção de participantes por empresa.", "Corrigido o ciclo de avisos de leitura que fazia a lista piscar e repetir consultas. A seleção do chat muda imediatamente e respostas atrasadas não substituem a conversa escolhida.", "Custos Meta ganha ranking de templates por empresa, com envios, entregas, leituras, respostas e taxa de resposta, filtros de período e detalhamento por número.", "Indicadores comerciais não coletados são identificados como indisponíveis, sem tratar resposta como venda. Status da Meta não regridem com eventos fora de ordem.", "Mantido o limite atual de 300 mensagens na visualização do chat interno, sem excluir qualquer registro."] },
    { version: "0.37.5", date: "19/10/2026", title: "Webhooks independentes e respostas aos templates", changes: ["Contas de outro aplicativo Meta podem configurar App Secret, token de verificação e callback próprios, sem substituir o webhook da Mibro.", "Custos Meta mostram templates respondidos e taxa de resposta, com detalhamento por atendente e número de envio e regra de associação indicada na tela.", "O layout em avaliação continua somente na prévia local; não foi incluído nesta publicação."] },
    { version: "0.37.4", date: "16/10/2026", title: "Otimização de consultas e e-mail sem SLA", changes: ["Reduzidas consultas repetidas na contagem de mensagens não lidas do Master e nos indicadores da caixa de entrada.", "E-mail deixa de receber contagem regressiva, alertas e avaliação de SLA; WhatsApp e demais canais mantêm suas regras.", "Medições de chegada de mensagens, cliques e transferência verificadas antes da publicação, preservando conversas, permissões e funcionamento dos atendentes."] },
    { version: "0.37.3", date: "14/10/2026", title: "Gastos por pessoa e telefone", changes: ["Custos Meta organizados por atendente: total em destaque e detalhamento de valor por telefone e conta de WhatsApp.", "Registros sem número, atendentes sem custo e automações ficam em grupos recolhíveis, sem apagar informações ou alterar cálculos.", "Gráficos gerais continuam disponíveis e os preços mantêm a precisão de cadastro."] },
    { version: "0.37.2", date: "14/10/2026", title: "Biblioteca central de templates", changes: ["Templates agora tem menu próprio no ícone de livros, logo abaixo de Campanhas, com empresa, número, catálogo completo, prévia e destinos automáticos.", "Campanhas mantém a seleção do template para o envio; a configuração dos destinos fica centralizada em Templates.", "A tela antiga de Conhecimento foi retirada da navegação e seus endereços redirecionam para Templates, sem apagar dados nem alterar os bots."] },
    { version: "0.37.1", date: "14/10/2026", title: "Campanhas e atendimento mais estáveis", changes: ["Biblioteca de templates com busca, filtros, prévia WhatsApp e edição clara do destino automático, preservando o vínculo com o número selecionado.", "Respostas rápidas com estados de carregamento, erro e nova tentativa; proteção contra inserção duplicada.", "Reduzidas atualizações repetidas das conversas e reconstruções do cabeçalho que interrompiam cliques e escolhas de transferência.", "Melhorias de legibilidade, navegação móvel e atualização do app instalado, sem alterar permissões, bots ou mensagens."] },
    { version: "0.37.0", date: "14/10/2026", title: "Destinos por template e custos por atendente", changes: ["Configure categoria e subcategoria de destino para cada template em Campanhas → Templates da WABA → Editar destino, preservando atendimentos em andamento e as permissões existentes.", "Custos da Meta: gráficos por atendente/origem e número de envio, com tabela detalhada e os mesmos filtros do relatório. Autoria baseada no envio registrado, não no responsável atual da conversa.", "Melhoradas a proteção de mensagens do Financeiro, a troca de contas no editor de destinos e a reutilização do catálogo durante o mesmo envio.", "Recepção do número Comercial com mensagem curta e encaminhamento automático para Comercial → Atacado; bot do número principal preservado."] },
    { version: "0.36.0", date: "09/10/2026", title: "Agenda, Perfil 360° e monitoramento", changes: ["Agenda e follow-ups: agendar retorno dentro da conversa, com lista, dia, semana e mês, filtros por empresa e lembretes internos (próximo, vencido, reagendado e cliente que voltou a escrever). Nada é enviado ao cliente automaticamente.", "Atendente fixo sugerido como responsável; Supervisor acompanha a equipe e o Master todas as empresas; Financeiro protegido também na agenda.", "Flow Builder: novo bloco Agendar retorno e perguntas de Data e Horário; o simulador mostra o retorno sem gravar nada.", "Perfil 360° do cliente com visão geral, agenda, observações, origem e linha do tempo paginada, respeitando histórico e setores protegidos.", "Central de Operação com follow-ups vencidos, falhas de envio, atendente fixo ausente, saúde dos canais por evidência e diagnóstico técnico para o Master.", "Revisados os lembretes após reagendamento, a paginação da linha do tempo e os acessos das notificações e indicadores por empresa."] },
    { version: "0.35.3", date: "09/10/2026", title: "Produtividade e início pelo Comercial", changes: ["Novo painel de Produtividade e Qualidade por ciclo de atendimento, com atribuição, transferências, reaberturas, SLA e visão própria autorizada.", "Tempos do painel respeitam o expediente configurado, sem contar noites, dias fechados ou feriados habilitados.", "Conversas iniciadas por template no número Comercial entram em Comercial → Atacado, sem mover atendimentos em andamento.", "Preservadas as funções atuais da VPS, Financeiro protegido, acesso Master, custos da Meta e navegação móvel."] },
    { version: "0.35.2", date: "08/10/2026", title: "Contagem de templates da Meta", changes: ["Corrigido o registro de custos dos envios por números adicionais do WhatsApp.", "Recuperação de templates com entrega/leitura confirmada, sem reenvio e sem inventar preços; valores sem tabela cadastrada permanecem pendentes."] },
    { version: "0.35.1", date: "08/10/2026", title: "Identidade neutra do app", changes: ["App instalado passa a se chamar Central de Atendimento, com ícone de conversas sem a marca Mibro.", "Manifesto, ícone do celular e cache atualizados, sem alterar contas, bots, mensagens ou permissões."] },
    { version: "0.35.0", date: "08/10/2026", title: "Empresas, Financeiro e operação", changes: ["Multiempresa com contas, categorias e permissões por empresa; segunda empresa oculta até sua ativação pelo Master.", "Financeiro protegido com histórico privado por setor e atendente fixo por cliente.", "Central de Operação e estimativas de custos da Meta, sem iniciar envios automaticamente.", "Interface com controles e categorias organizados por empresa, preservando a navegação móvel atual.", "Preservados os bots atuais, conversa WhatsApp unificada, número de envio por setor, envio individual/em massa e supervisão por períodos.", "Proteções de busca, histórico, anexos, supervisão e resumos privados aplicadas à integração."] },
    { version: "0.34.14", date: "07/10/2026", title: "Atendimento e navegação móvel", changes: ["Celular: menu e filtros com fechamento visível, seta real para sair da conversa, botão Voltar e gesto de retorno para a direita.", "Conversa ocupa a largura da tela; funções ficam em Opções e a altura acompanha a área visível do navegador.", "Busca do topo pesquisa palavras no histórico das mensagens, mostra o trecho encontrado e abre a conversa, respeitando permissões.", "Permissões independentes para iniciar conversas por e-mail e WhatsApp, preservando os acessos existentes.", "Bot exclusivo do número Comercial com aviso de horários, indicação do atendimento principal e encaminhamento direto ao Atacado; bot principal preservado.", "Troca de número de envio tem aviso próprio, distinto de janela expirada e espera pela resposta a template.", "Rolagem da Central de Integrações corrigida; controles de recolher menus/lista restaurados e notas contidas nos cards.", "Esta publicação não inclui multiempresa, Financeiro protegido nem atendente fixo, que permanecem na versão local."] },
    { version: "0.34.13", date: "05/10/2026", title: "Bots de perguntas e respostas", changes: ["Triagem e Assistente atendem por perguntas e respostas; outros bots são arquivados sem apagar dados.", "Assistente inicia após a escolha do setor, com orientações da base cadastrada e links da loja.", "Opções para vendedor ou atendente, finalizar, outro assunto e voltar.", "Configuração centraliza mensagens, horários, feriados, avaliação, simulador e métricas.", "Blocos Webhook/API retirados; conversas, números, áudio, permissões e backups preservados."] },
    { version: "0.34.12", date: "01/10/2026", title: "Áudios no atendimento e alerta de categoria", changes: ["Grave pelo microfone ou selecione um arquivo de áudio, ouça a prévia e confirme em Enviar. Selecionar ou concluir uma gravação nunca envia automaticamente.", "Crie respostas rápidas pessoais de áudio com nome e atalho. Outros atendentes não têm acesso; o Master mantém a administração.", "Áudios respeitam o número definido pela categoria, a janela de 24 horas de cada número e as permissões de atendimento. A supervisão somente leitura não permite enviar.", "Conversas abertas sem categoria recebem um aviso visual discreto. O aviso não bloqueia ações e respeita a preferência por reduzir animações.", "Proteções de tamanho e estrutura de áudio foram reforçadas, mantendo categorias múltiplas, histórico, anexos e backups existentes."] },
    { version: "0.34.11", date: "01/10/2026", title: "Conversa única e número de envio por setor", changes: ["Um único atendimento por cliente no WhatsApp, preservando as mensagens anteriores dos diferentes números.", "Em Integrações > WhatsApp > Acessos, configure os setores que utilizam cada número para responder. Subcategorias herdam o setor principal, salvo configuração específica.", "O número muda automaticamente ao trocar a categoria. O seletor manual foi removido; apenas o Master vê uma indicação discreta do remetente.", "Ao transferir entre números, o aviso distingue iniciar conversa, aguardar resposta ao template e janela expirada. Somente a mensagem recebida do cliente no número de destino abre as 24 horas.", "Templates aprovados podem ser fixados nos avisos por usuário e número neste navegador, disponíveis em todos os setores que utilizam esse remetente. Selecionar um favorito não envia automaticamente.", "Textos, documentos, templates e Bot respeitam o remetente e a janela de 24 horas de cada número, sem fallback silencioso para o principal. Configurações ausentes ou ambíguas devem ser ajustadas pelo Master nos Acessos.", "Históricos restritos, permissões, conversas, anexos e backups são preservados."] },
    { version: "0.34.10", date: "30/09/2026", title: "Envio de WhatsApp individual e em massa", changes: ["Novo assistente para selecionar destinatários manualmente, por CSV ou pelos contatos da Central, com templates e variáveis por grupo.", "Revisão antes do envio identifica duplicados, dados ausentes, opt-out e templates não aprovados, com estimativa de custo.", "Envios em massa entram na fila com controle de permissões, número remetente, idempotência e acompanhamento por destinatário.", "Corrigidos o isolamento entre números, a privacidade dos lotes e a validação do contato pelo telefone no servidor.", "A atualização não inicia campanhas automaticamente e preserva conversas, mensagens e backups."] },
    { version: "0.34.9", date: "29/09/2026", title: "Controle completo de e-mails", changes: ["A sincronizacao do Gmail importa somente mensagens com o marcador Shopify (site Mibro).", "O marcador e confirmado pelo ID real da API do Gmail, evitando falhas por maiusculas, espacos ou parenteses.", "Qualquer atendente com acesso a conversa pode marcar ou remover spam; o item sai das caixas normais e permanece na pasta Spam.", "O envio de um novo e-mail aceita ate 10 documentos PDF, TXT, Word, Excel ou PowerPoint, limitados a 20 MB no total.", "Nenhuma configuracao do WhatsApp ou dos Bots foi alterada."] },
    { version: "0.34.8", date: "29/09/2026", title: "Editor Visual de fluxos para Bots", changes: ["Novo editor em blocos para montar mensagens, perguntas, menus, condicoes, IA, consulta ao conhecimento, intervalos e encaminhamentos.", "Rascunhos podem ser validados e simulados sem enviar mensagens aos clientes.", "Publicacoes criam versoes imutaveis, com historico e opcao de rollback.", "Bots existentes continuam no motor atual; o Editor Visual so entra em uso quando um Master publica um fluxo e ativa explicitamente o novo modo.", "Execucoes respeitam automacao global, auto-resposta, atendimento humano, multiplos numeros e entrega segura para a equipe em caso de falha."] },
    { version: "0.34.7", date: "25/09/2026", title: "Privacidade no atendimento e grupos internos", changes: ["Conversas assumidas ficam visiveis somente para o atendente responsavel e para contas Master.", "A transferencia para outra pessoa permite compartilhar ou limitar o historico, com motivo e resumo de passagem opcionais.", "Ao devolver uma conversa, cada atendente recupera o historico ao qual ja teve acesso e transferir para um setor devolve a conversa a fila.", "O chat interno agora permite grupos com participantes, administradores, renomeacao e encerramento sem apagar mensagens.", "Auditoria, anexos, alertas, busca e atualizacoes em tempo real seguem as mesmas regras de privacidade.", "Respostas Rapidas agora aceitam varias categorias; ao selecionar uma categoria principal, a resposta tambem fica disponivel automaticamente em suas subcategorias."] },
    { version: "0.34.6", date: "25/09/2026", title: "FAQ contextual e transferências por setor", changes: ["Novo FAQ no cabeçalho adapta as orientações ao perfil e às permissões da conta.", "Atendentes e Supervisores podem transferir conversas para qualquer categoria pública ativa permitida pelo canal.", "Categorias não liberadas continuam ocultas na barra lateral e a conversa sai da tela após ser transferida para uma fila sem acesso.", "Categorias Somente Master permanecem invisíveis e bloqueadas para os demais perfis.", "A permissão Transferir conversas foi renomeada para Alterar responsável, separando a troca de Atendente da mudança de categoria.", "Os manuais de Atendente, Supervisor e Master foram atualizados com as novas regras."] },
    { version: "0.34.5", date: "24/09/2026", title: "Aprendizado corrigido e regenerado", changes: ["O Qwen local agora analisa e reescreve as respostas de treinamento antes da revisão humana.", "Nomes e cargos dos atendentes não são assumidos pelo Bot; apresentações usam somente {{botName}}.", "Sugestões antigas foram preservadas, mas retiradas da fila atual.", "A fila atual contém somente sugestões geradas pelo pareamento corrigido.", "Novas intenções só são agrupadas quando o texto coincide.", "Saudações compostas e confirmações são ignoradas."] },
    { version: "0.34.4", date: "24/09/2026", title: "Sugestões de aprendizado claras", changes: ["Saudações e confirmações isoladas não viram novas intenções.", "Cartões diferenciam claramente nova intenção de resposta sugerida.", "Sugestões pendentes foram regeneradas sem nomes pessoais."] },
    { version: "0.34.3", date: "24/09/2026", title: "Aprendizado por conversa", changes: ["Cada sugestão mostra a pergunta específica do cliente e a resposta humana correspondente.", "Toda a conversa finalizada é analisada em pares pergunta–resposta.", "Nomes de clientes e atendentes não são aprendidos; apresentações usam {{botName}}."] },
    { version: "0.34.2", date: "21/09/2026", title: "Respostas completas da IA", changes: ["Ações ASK e HANDOFF agora exigem texto ao cliente.", "A IA tenta orientar com a base antes de encaminhar."] },
    { version: "0.34.1", date: "21/09/2026", title: "Resposta no chat simulado", changes: ["A resposta da IA local agora aparece como mensagem do Bot na conversa simulada.", "Nenhuma mensagem é enviada ao cliente real."] },
    { version: "0.34.0", date: "21/09/2026", title: "IA segura em DRY RUN", changes: ["Gate de envio validado em modo seguro.", "Prévia da IA local mantida no simulador.", "Envio real permanece bloqueado."] },
    {
      version: "0.33.0",
      date: "18/09/2026",
      title: "IA local em modo de observa‡Æo",
      changes: [
        "Adicionada integra‡Æo global com Qwen via Ollama para an lise local.",
        "O Assistente Mibro pode avaliar mensagens em modo shadow sem responder ao cliente.",
        "Status, fila, valida‡Æo estruturada e bloqueios seguros evitam respostas sem conhecimento ou com a IA offline."
      ]
    },
    {
      version: "0.32.7",
      date: "16/09/2026",
      title: "Atendimento comercial mais guiado",
      changes: [
        "Parcerias agora coleta redes sociais, seguidores e links antes de encaminhar para a equipe.",
        "Atacado coleta dados da loja e interesse de compra, encaminhando pedidos de preços e condições ao atendente.",
        "Varejo consulta a base cadastrada para responder dúvidas sobre modelos e orienta a compra pelo site oficial com o cupom de primeira compra.",
        "Atendimento pode reclassificar o setor pela descrição do cliente sem repetir a mensagem inicial, e os encaminhamentos usam uma mensagem mais neutra."
      ]
    },
    {
      version: "0.32.6",
      date: "16/09/2026",
      title: "Assistente mais natural por setor",
      changes: [
        "Mensagens genéricas agora recebem a abertura neutra Olá! Como posso ajudar?, independentemente do setor.",
        "O Assistente consulta primeiro a Knowledge e responde diretamente quando encontra uma orientação segura.",
        "Perguntas de coleta e encaminhamento ficam reservados para casos sem resposta confiável ou que realmente precisam de atendimento humano."
      ]
    },
    {
      version: "0.32.5",
      date: "16/09/2026",
      title: "Nova triagem após inatividade",
      changes: [
        "Conversas passam a ser finalizadas após 1 minuto de inatividade.",
        "A finalização automática mantém a categoria enquanto a conversa estiver em Finalizados.",
        "Quando o cliente envia uma nova mensagem, a categoria e o responsável são removidos para iniciar novamente pelo Bot de triagem."
      ]
    },
    {
      version: "0.32.4",
      date: "15/09/2026",
      title: "Central sem cortes e controle visível",
      changes: [
        "A Central agora compacta as colunas também em janelas de até 1700 px, evitando cortes na conversa e nas mensagens.",
        "O controle da conversa passa a exibir claramente Recolher conversas ou Mostrar conversas."
      ]
    },
    {
      version: "0.32.3",
      date: "15/09/2026",
      title: "Interface adaptada para notebooks",
      changes: [
        "As principais telas agora se ajustam melhor a notebooks de 1366x768, 1280x720 e resoluções menores.",
        "Menus, formulários, painéis, tabelas e modais foram compactados ou ganharam rolagem para evitar conteúdo cortado."
      ]
    },
    {
      version: "0.32.2",
      date: "15/09/2026",
      title: "Preparação do teste social",
      changes: [
        "A validação inicial do webhook da Meta agora funciona para os canais de Instagram e Facebook.",
        "Contas sociais podem ser adicionadas com ID e token de teste pelo formulário avançado, sem depender do OAuth público."
      ]
    },
    {
      version: "0.32.1",
      date: "15/09/2026",
      title: "Finalização completa por inatividade",
      changes: [
        "Conversas inativas agora são finalizadas após o prazo configurado mesmo quando a última mensagem foi enviada pelo cliente.",
        "Quando o cliente retorna, a conversa reabre sem o setor e o atendente anteriores para reiniciar a triagem automática."
      ]
    },
    {
      version: "0.32.0",
      date: "15/09/2026",
      title: "Instagram e Facebook integrados à Central",
      changes: [
        "A Central agora permite responder mensagens do Instagram Direct e Facebook Messenger pelos canais conectados.",
        "Respostas públicas a comentários do Instagram e Facebook passam a usar o comentário original como destino.",
        "Mídias recebidas em Direct e Messenger podem ser visualizadas com acesso protegido dentro da conversa.",
        "Publicações e reels podem ser associados a produtos para contextualizar comentários recebidos.",
        "Ações compatíveis de moderação permitem ocultar, reexibir, curtir ou excluir comentários, respeitando as permissões e capacidades reais do canal.",
        "As respostas automáticas sociais permanecem desativadas por padrão e podem ser liberadas separadamente pela conta Master."
      ]
    },
    {
      version: "0.31.0",
      date: "15/09/2026",
      title: "Novo dashboard de relatórios",
      changes: [
        "A conta Master ganhou uma área dedicada de Relatórios, acessível pela aba superior das Configurações.",
        "O dashboard permite consultar hoje, períodos recentes, todo o histórico ou datas personalizadas.",
        "Novos indicadores mostram volume, tempos de resposta, SLA, canais, categorias e desempenho dos vendedores.",
        "Filtros globais, comparação de períodos, detalhes das conversas e exportações CSV facilitam a análise operacional."
      ]
    },
    {
      version: "0.30.3",
      date: "14/09/2026",
      title: "Assistente por setor, segurança e relatório semanal",
      changes: [
        "O Assistente Mibro agora começa somente após a triagem e adapta perguntas, contexto e encaminhamento ao setor escolhido.",
        "Uploads executáveis são bloqueados, arquivos suspeitos são sinalizados e os webhooks ganharam proteção contra flood sem ignorar pedidos de opt-out.",
        "A conta Master ganhou o relatório Conversas por semana, com indicadores, produtividade por atendente e detalhamento das conversas.",
        "O relatório semanal usa explicitamente o horário de Brasília, inclusive quando a VPS opera em UTC."
      ]
    },
    {
      version: "0.30.2",
      date: "14/09/2026",
      title: "Assistente com contexto e fallback inteligente",
      changes: [
        "O menu guiado consulta o Gemini somente quando o reconhecimento local não encontra uma opção segura.",
        "O Assistente preserva contexto do caso e evita repetir somente soluções que o cliente confirmou como falhas.",
        "Dados já informados, como produto, aplicativo, sistema e número do pedido, são reaproveitados nas próximas etapas.",
        "Chamadas externas e consumo ficam identificados corretamente no simulador e nas métricas."
      ]
    },
    {
      version: "0.30.1",
      date: "11/09/2026",
      title: "Assistente híbrido e guiado",
      changes: [
        "O Assistente Mibro ganhou menus e submenus configuráveis, preservando contexto entre as etapas.",
        "Blocos de resposta e grupos de sinônimos agora podem ser gerenciados no painel de Bots.",
        "Normalização local, fuzzy matching e Knowledge resolvem casos simples sem consumir IA externa.",
        "A IA externa permanece apenas como fallback estruturado e o Assistente continua em observação, sem enviar mensagens reais."
      ]
    },
    {
      version: "0.30.0",
      date: "11/09/2026",
      title: "Múltiplos números WhatsApp",
      changes: [
        "Permite cadastrar números WhatsApp adicionais com Phone Number ID, WABA e token próprios, sempre criptografados.",
        "O Master define os atendentes e as áreas autorizadas para cada número; categorias principais incluem suas subcategorias.",
        "Conversas e respostas permanecem vinculadas ao número que recebeu o contato, inclusive mídia, triagem e templates.",
        "Ao iniciar uma conversa, o usuário escolhe somente entre os números liberados para sua conta."
      ]
    },
    {
      version: "0.29.7",
      date: "11/09/2026",
      title: "Permissão de templates e tarifa por mensagem",
      changes: [
        "Usuários sem a permissão Campanhas e templates não veem nem acessam templates ou o aviso da janela de 24 horas.",
        "As rotas de campanhas, listagem e envio de templates agora também validam a permissão no backend.",
        "Templates exibem a tarifa base estimada por mensagem entregue no Brasil."
      ]
    },
    {
      version: "0.29.6",
      date: "11/09/2026",
      title: "Nova conversa pelo WhatsApp",
      changes: [
        "Libera o WhatsApp no botão Nova quando a WABA e os templates estão configurados.",
        "A nova conversa exige nome, telefone e um template aprovado pela Meta.",
        "Mensagens livres continuam protegidas pelas regras da janela de atendimento da Meta."
      ]
    },
    {
      version: "0.29.5",
      date: "10/09/2026",
      title: "Templates da WABA e acesso controlado",
      changes: [
        "Campanhas agora sincroniza e exibe templates aprovados, pendentes e rejeitados, com conteúdo, componentes e variáveis.",
        "A sincronização mostra horário, quantidade e o erro específico retornado pela Meta sem expor credenciais.",
        "Somente o Master acessa Campanhas por padrão; o Master pode liberar a permissão individualmente na área de Equipes.",
        "O envio de mensagens não foi alterado e continua aceitando somente templates aprovados."
      ]
    },
    {
      version: "0.29.4",
      date: "09/09/2026",
      title: "Assistente Mibro em observacao",
      changes: [
        "Novo Assistente Mibro Brasil atua apos a triagem inicial em modo seguro de observacao.",
        "O Bot analisa as conversas e gera sugestoes, sem enviar mensagens reais aos clientes.",
        "Foram adicionadas 9 intencoes de atendimento e 18 fontes oficiais da Mibro Brasil.",
        "A memoria registra produto, celular, objetivo, tentativas, resultado, pedido e canal de compra para evitar repeticoes.",
        "O card identifica claramente o modo Observacao; a resposta real continuara bloqueada ate aprovacao."
      ]
    },
    {
      version: "0.29.3",
      date: "04/09/2026",
      title: "Configuracao de Bots reorganizada",
      changes: [
        "A configuracao foi dividida em sete secoes objetivas, mostrando somente o grupo em uso.",
        "Identidade, triagem e recursos avancados agora podem ser recolhidos.",
        "Configuracoes globais da lateral ficam compactas e expansivas sob demanda.",
        "Ao abrir, o primeiro Bot e selecionado automaticamente; os menus ficam no topo e a mensagem de feriado pode ser personalizada."
      ]
    },
    {
      version: "0.29.2",
      date: "04/09/2026",
      title: "Triagem hierarquica por subcategorias",
      changes: [
        "O Bot mostra primeiro a categoria e depois somente as subcategorias selecionadas.",
        "A tela de Bots ganhou uma selecao simples das subcategorias liberadas ao cliente."
      ]
    },
    {
      version: "0.29.1",
      date: "03/09/2026",
      title: "Categorias restritas e subcategorias na triagem",
      changes: [
        "Categorias marcadas como Somente Master ficam ocultas do Bot e dos demais usuarios.",
        "Transferencias para categorias restritas sao bloqueadas no backend para nao-Master.",
        "A Triagem Inicial permite escolher categorias e subcategorias individualmente."
      ]
    },
    {
      version: "0.29.0",
      date: "03/09/2026",
      title: "Bots inteligentes e configur\u00e1veis",
      changes: [
        "Adiciona cadastro de feriados por data na configuração da Triagem Inicial.",
        "Em feriados ativos, o bot usa a mensagem de fora do horário durante todo o dia.",
        "Datas podem ser editadas, desativadas ou removidas, com auditoria e acesso Master.",
        "Personalidade configur\u00e1vel define identidade, tom, estilo, limites e tamanho das respostas de cada Bot.",
        "Entendimento sem\u00e2ntico melhora a leitura de mensagens informais sem alterar o texto original do cliente.",
        "Agent Planner e estado do caso foram adicionados atr\u00e1s de flag, preservando o comportamento atual quando desligados.",
        "Nova se\u00e7\u00e3o visual permite configurar presets, tom, estilo, regras e tamanho das respostas na tela de Bots."
      ]
    },
    {
      version: "0.28.5",
      date: "03/09/2026",
      title: "Ajustes visuais da Central",
      changes: [
        "Menu de a\u00e7\u00f5es da conversa permanece leg\u00edvel acima das mensagens.",
        "Bot\u00f5es de anexo e respostas r\u00e1pidas ficam alinhados, com o raio laranja no tema escuro."
      ]
    },
    {
      version: "0.28.4",
      date: "02/09/2026",
      title: "Triagem configurável na área de Bots",
      changes: [
        "O Bot de Triagem Inicial agora aparece na área de Bots como Bot do sistema.",
        "Mensagens, horário, ativação e quatro opções de encaminhamento podem ser configurados pelo Admin.",
        "O executor real, os textos padrão e o comportamento atual da triagem foram preservados."
      ]
    },
    {
      version: "0.28.3",
      date: "02/09/2026",
      title: "Ajustes rápidos da Central",
      changes: [
        "Menu recolhido volta a exibir somente os ícones.",
        "Aviso de atendimento pisca apenas enquanto houver conversa não lida.",
        "Botões de anexo e respostas rápidas ficam alinhados no campo de mensagem.",
        "Contadores de atendimento e categorias permanecem globais ao trocar filtros."
      ]
    },
    {
      version: "0.28.2",
      date: "02/09/2026",
      title: "Marketplaces temporariamente ocultos",
      changes: [
        "Oculta plataformas de venda da Central, Integrações, Bots e Respostas Rápidas.",
        "Conversas e contadores de marketplace deixam de aparecer na operação diária.",
        "Toda a implementação permanece preservada e pode ser reativada por uma única flag."
      ]
    },
    {
      version: "0.28.1",
      date: "02/09/2026",
      title: "E-mail premium e filtros organizados",
      changes: [
        "Painel de e-mail refinado com caixas Geral, Promoções e Spam baseadas nos marcadores do Gmail.",
        "Filtros rápidos agora podem ser recolhidos e mantêm a preferência do usuário.",
        "Sidebar compacta corrigida para não cortar os textos dos atalhos."
      ]
    },
    {
      version: "0.28.0",
      date: "02/09/2026",
      title: "Central multicanal premium",
      changes: [
        "Nova sidebar sofisticada, superfícies em camadas e painel de contexto em formato de workspace.",
        "WhatsApp, E-mail, Instagram + Facebook e plataformas de venda agora abrem em áreas dedicadas.",
        "Layout responsivo otimizado para 1080p e notebooks, com densidade ajustável e microinterações."
      ]
    },
    {
      version: "0.27.4",
      date: "01/09/2026",
      title: "Contato único em vários canais",
      changes: [
        "Permite fundir telefone, e-mail e outros canais da mesma pessoa sem apagar históricos.",
        "A conversa fundida oferece um seletor para responder pelo canal correto.",
        "O Master escolhe individualmente, na Equipe, quem pode fundir contatos."
      ]
    },
    {
      version: "0.27.3",
      date: "01/09/2026",
      title: "Envio e respostas pelo Gmail",
      changes: [
        "Respostas de conversas de e-mail agora saem pela conta Gmail e permanecem na mesma thread.",
        "O botão Nova permite enviar e-mail apenas por contas conectadas; Meta e demais canais ficam indisponíveis.",
        "O Master pode liberar individualmente, na Equipe, quem pode iniciar conversas."
      ]
    },
    {
      version: "0.27.2",
      date: "01/09/2026",
      title: "Anexos e acesso restrito no Gmail",
      changes: [
        "Exibe imagens e arquivos recebidos pelo Gmail diretamente na conversa.",
        "Mostra o endereço de e-mail real do remetente nos cards e no cabeçalho.",
        "Permite ao Master escolher quais usuários podem acessar cada conta de e-mail."
      ]
    },
    {
      version: "0.27.1",
      date: "01/09/2026",
      title: "Recebimento de e-mails pelo Gmail",
      changes: [
        "Sincroniza automaticamente novos e-mails da caixa de entrada a cada 30 segundos.",
        "Importa remetente, assunto, conteúdo e thread sem duplicar mensagens.",
        "Renova o acesso OAuth automaticamente e solicita reconexão quando necessário."
      ]
    },
    {
      version: "0.27.0",
      date: "01/09/2026",
      title: "Conexão simplificada dos canais",
      changes: [
        "Substitui credenciais técnicas por botões OAuth para Google, Microsoft, Meta, Mercado Livre e Amazon.",
        "Descobre automaticamente e-mail, conta, página e perfil, com seleção quando a Meta retorna mais de uma opção.",
        "Renova tokens compatíveis automaticamente e sinaliza quando uma reconexão é necessária.",
        "Mantém credenciais manuais somente na configuração avançada dos canais ainda sem OAuth habilitado."
      ]
    },

    {
      version: "0.26.3",
      date: "01/09/2026",
      title: "OAuth correto para Gmail e Google Reviews",
      changes: [
        "Separa as permissões do Gmail e do Google Reviews no fluxo OAuth compartilhado.",
        "Solicita no Gmail somente leitura de mensagens e envio de respostas, mantendo acesso offline.",
        "Mantém a permissão de gestão de avaliações exclusivamente no canal Google Reviews."
      ]
    },
    {
      version: "0.26.2",
      date: "01/09/2026",
      title: "Refinamento visual da Central de Atendimento",
      changes: [
        "Move a nota para uma linha pr\u00f3pria do card, sem depender do tamanho do nome e sem ultrapassar seus limites.",
        "Adiciona a op\u00e7\u00e3o de recolher filtros e a lista, deixando somente a conversa atual aberta.",
        "Faz o seletor de Respostas R\u00e1pidas acompanhar corretamente os temas claro e escuro, com contraste leg\u00edvel.",
        "Troca o bot\u00e3o de Respostas R\u00e1pidas para o laranja Mibro, com raio em degrad\u00ea cinza e contorno preto."
      ]
    },
    {
      version: "0.26.1",
      date: "01/09/2026",
      title: "Fila cronol\u00f3gica e mais espa\u00e7o no atendimento",
      changes: [
        "Ordena as conversas pela \u00faltima mensagem, mostrando no topo quem falou mais recentemente; conversas fixadas continuam respeitando a escolha do usu\u00e1rio.",
        "Permite recolher filtros e categorias para ampliar a lista de conversas e a \u00e1rea do atendimento, mantendo a prefer\u00eancia salva.",
        "Aumenta os cards e mant\u00e9m as notas dentro de seus limites, com leitura em at\u00e9 duas linhas.",
        "Centraliza os bot\u00f5es de anexo e respostas r\u00e1pidas e melhora o destaque do raio no tema escuro sem aumentar a altura do composer."
      ]
    },
    {
      version: "0.26.0",
      date: "01/09/2026",
      title: "Atendimento omnichannel e prioridade de conversas",
      changes: [
        "Adiciona mensageria real para Instagram Direct, Facebook Messenger e respostas a comentários do Instagram e Facebook usando a Graph API da Meta.",
        "Adiciona integração funcional de e-mail para Gmail e Microsoft 365, com OAuth e encadeamento por conversa, além de perguntas e respostas do Mercado Livre.",
        "Permite múltiplas contas por canal, valida assinatura dos webhooks Meta e mantém credenciais protegidas no cofre de integrações.",
        "Exibe canal, status de conexão e filtros na Central, com reconexão por OAuth ou token manual conforme o provedor.",
        "Adiciona prioridade manual, estados operacionais mais claros e indicadores de SLA para organizar a fila de atendimento.",
        "Remove da triagem o aviso de finalização automática que não corresponde mais ao prazo configurado.",
        "Mantém TikTok Shop, Amazon, Shopee, Google Reviews e Reclame Aqui com status limitado e transparente enquanto dependem de aprovação, contrato ou endpoints externos."
      ]
    },
    {
      version: "0.25.2",
      date: "31/08/2026",
      title: "Navegação organizada e layout das configurações",
      changes: [
        "Agrupa os atalhos da Central nos menus Atendimento, Automação, Canais e Administração, preservando permissões e ações existentes.",
        "Corrige a rolagem vertical da tela de Configurações quando as seções são abertas.",
        "Evita sobreposição dos textos de ajuda com campos e linhas divisórias e deixa as seções recolhidas mais compactas."
      ]
    },
    {
      version: "0.25.1",
      date: "31/08/2026",
      title: "Inicialização segura das configurações",
      changes: [
        "Evita conflito ao criar as Configurações de Conversas quando os monitores de SLA e inatividade iniciam simultaneamente.",
        "Mantém um único registro global de configurações e elimina o erro transitório P2002 dos logs de inicialização."
      ]
    },
    {
      version: "0.25.0",
      date: "31/08/2026",
      title: "Configurações de conversas e SLAs",
      changes: [
        "Adiciona uma tela central de Configurações para controlar reabertura, finalização automática, contexto do Bot, SLAs e alertas de atendimento.",
        "Permite que uma conta Master edite as regras e que Supervisores consultem os valores em modo somente leitura.",
        "Inclui SLA de primeira resposta e de resposta durante o atendimento, com indicadores internos e avaliação opcional no horário comercial.",
        "Adiciona alertas internos para conversas aguardando resposta ou paradas, sem enviar mensagens automáticas ao cliente.",
        "Torna configuráveis a janela de reabertura, o tempo de finalização por inatividade e o TTL global do contexto dos Bots.",
        "Mantém a retomada automática do Bot após atendimento humano desativada e identificada como recurso futuro.",
        "Preserva a integração Meta, o atendimento humano, o bot de triagem e os comportamentos atuais por meio de defaults seguros."
      ]
    },
    {
      version: "0.24.4",
      date: "28/08/2026",
      title: "Estabilidade do Gemini",
      changes: [
        "Reduz o raciocínio interno do Gemini ao mínimo necessário para classificação de intenção, evitando respostas vazias por consumo do limite de tokens.",
        "Amplia o timeout padrão do Gemini de 8 para 15 segundos para acomodar a latência real observada sem abandonar prematuramente a chamada.",
        "Preserva o schema de intenções e o fallback local seguro da versão anterior."
      ]
    },
    {
      version: "0.24.3",
      date: "28/08/2026",
      title: "Fallback de IA com Gemini",
      changes: [
        "Corrige a classificação do Gemini com saída JSON estruturada e restrita aos IDs reais das intenções do Bot.",
        "Passa a processar respostas divididas em múltiplas partes e aceita o nome exato de uma intenção somente quando ele corresponde de forma única.",
        "Registra corretamente qual provider externo foi chamado e se a classificação foi aceita, sem mascarar a tentativa como motor local.",
        "Mantém o fallback local seguro quando a IA externa falhar ou não confirmar uma intenção válida."
      ]
    },
    {
      version: "0.24.2",
      date: "28/08/2026",
      title: "Controle de sugestões por Bot",
      changes: [
        "Adiciona em cada Bot a opção Sugestões de resposta ao atendente.",
        "Ao desativar, a Central deixa de exibir sugestões novas e antigas daquele Bot imediatamente.",
        "Observação e aprendizado supervisionado continuam funcionando normalmente, sem envio automático de mensagens.",
        "Mantém o recurso habilitado por padrão nos Bots existentes para preservar o comportamento atual; uma conta Master pode desligá-lo individualmente."
      ]
    },
    {
      version: "0.24.1",
      date: "27/08/2026",
      title: "Acesso às Campanhas e templates da Meta",
      changes: [
        "Corrige os overlays de Configurações e Opt-out que apareciam sobre a tela e impediam qualquer clique ao abrir Campanhas.",
        "Mantém campanhas, métricas, configurações e opt-outs acessíveis mesmo quando a API de templates da Meta ainda não estiver configurada.",
        "Exibe um modo limitado claro e desabilita somente criação, edição e preview que realmente dependem de um template aprovado.",
        "Adiciona tentativa manual de recarregar templates e evita que uma falha da Meta interrompa o restante do carregamento da página.",
        "Torna a seleção de template estável pelo ID e impede chamadas duplicadas à Meta durante o preview.",
        "Melhora as mensagens de credencial, permissão, WABA inválido, limite de requisições e indisponibilidade sem expor dados sensíveis.",
        "Preserva o envio em massa desligado por padrão, a integração Meta existente, o atendimento humano e o bot de triagem."
      ]
    },
    {
      version: "0.24.0",
      date: "27/08/2026",
      title: "Providers e cofre de chaves de IA",
      changes: [
        "Adiciona Google Gemini e OpenAI ao motor de interpretação, mantendo Anthropic e o processamento local já existentes.",
        "Permite escolher, em cada Bot, o provider e o modelo usados quando o fallback externo estiver habilitado.",
        "Inclui a aba Chaves de IA para uma conta Master cadastrar, substituir, remover e testar credenciais globais sem editar a VPS.",
        "Protege as credenciais no banco com AES-256-GCM e uma chave mestra exclusiva; o painel e a auditoria nunca recebem a chave completa.",
        "Aplica imediatamente uma troca de credencial, sem cache e sem reiniciar o servidor; variáveis de ambiente continuam disponíveis como compatibilidade.",
        "Mantém a IA externa desligada por padrão em cada Bot e usa o motor local quando não houver credencial ou ocorrer falha no provider.",
        "Atualiza o modelo padrão do Gemini para gemini-3.6-flash e preserva campanhas, Meta, atendimento humano e bot de triagem."
      ]
    },
    {
      version: "0.23.0",
      date: "27/08/2026",
      title: "Campanhas e prospecção pelo WhatsApp",
      changes: [
        "Adiciona uma área de Campanhas para criar rascunhos, selecionar templates aprovados da Meta, mapear variáveis, importar contatos por CSV e acompanhar o envio.",
        "Inclui segmentação, estimativa de público, preview, agendamento, pausa, retomada, cancelamento, envio de teste e exportação de resultados.",
        "Processa os destinatários em lotes com reivindicação atômica, intervalo configurável, retentativa gradual e proteção contra duplicidade entre workers.",
        "Registra enviados, entregues, lidos, respostas, falhas e opt-outs sem regredir status quando eventos atrasados chegam da Meta.",
        "Respostas podem vincular a conversa à campanha, categoria, responsável e Bot configurados sem sobrescrever atendimento já atribuído.",
        "O envio em massa permanece desligado por padrão e só uma conta Master pode ativar o master switch; criar ou agendar uma campanha não dispara mensagens enquanto ele estiver desligado.",
        "Reaproveita a integração Meta e os templates já existentes, preservando a Central, o atendimento humano e o bot de triagem."
      ]
    },
    {
      version: "0.22.0",
      date: "27/08/2026",
      title: "Supervisão, handoff e qualidade dos Bots",
      changes: [
        "Mantém o contexto de produto entre intenções e permite retomar automaticamente um fluxo pausado após uma troca de assunto.",
        "Estrutura o encaminhamento humano com produto, etapa terminal, motivo, tentativas e resumo correto para apoiar o atendente.",
        "Adiciona na Central uma sugestão supervisionada com Usar, Editar, Ignorar e feedback; o texto sempre passa pelo atendente e nunca é enviado sozinho.",
        "Remove sugestões antigas depois de uma resposta ou nova mensagem e preserva o texto final ao atualizar o feedback.",
        "Amplia o aprendizado supervisionado com sugestões pendentes de Resposta Rápida e revisão de fluxo, sempre sujeitas à aprovação humana.",
        "Prepara avaliação, ranking, métricas e alertas de qualidade; no webhook passivo, nenhuma avaliação é solicitada nem registrada como se o Bot tivesse respondido.",
        "Mantém Tools em modo de observação no webhook atual e preserva o WhatsApp/Meta, o atendimento humano e o bot de triagem existentes."
      ]
    },
    {
      version: "0.21.0",
      date: "27/08/2026",
      title: "Contexto, conhecimento e fallback inteligente dos Bots",
      changes: [
        "Aprimora o contexto do Flow Engine, registra a pergunta pendente e impede que uma sessão expirada retome etapas antigas.",
        "Prioriza conhecimentos específicos por produto e intenção e sinaliza conflitos entre fontes equivalentes, sem escolher uma resposta no escuro.",
        "Amplia o simulador e as observações com rastros de etapa, Tool, conhecimento e provider utilizados, sem enviar mensagens reais.",
        "O aprendizado supervisionado passa a sugerir conhecimento recorrente ou revisão do fluxo, sempre pendente de aprovação humana.",
        "Adiciona fallback opcional de IA externa para baixa confiança e métricas de uso; fica desligado por padrão e o teste de conexão exige confirmação por poder gerar custo.",
        "A finalização automática fica apenas sinalizada para ocorrer após um futuro envio confirmado; esta versão não finaliza conversas nem ativa respostas automáticas pelo modo de observação.",
        "Preserva integralmente o WhatsApp/Meta, o atendimento humano e o bot de triagem existentes."
      ]
    },
    {
      version: "0.20.0",
      date: "27/08/2026",
      title: "Fluxos de atendimento em múltiplas etapas",
      changes: [
        "Adiciona um editor de fluxo dentro de cada intenção do Bot, com perguntas, coleta de dados, consulta à Base de conhecimento, Tools, respostas e encaminhamento humano.",
        "Permite configurar próximas etapas e caminhos de sucesso ou falha, além de reorganizar, ativar e desativar etapas sem alterar intenções já existentes.",
        "Mantém o contexto entre mensagens, evita repetir perguntas já respondidas e limita tentativas e encadeamentos para impedir loops.",
        "O simulador exibe o andamento do fluxo sem enviar mensagens reais; intenções sem etapas continuam funcionando no modelo anterior.",
        "Reforça o isolamento da Base de conhecimento: um fluxo nunca usa conteúdo reservado a outro Bot, mesmo diante de configuração antiga ou inválida.",
        "A atualização não ativa respostas automáticas, preserva o WhatsApp/Meta e mantém o bot de triagem existente."
      ]
    },
    {
      version: "0.19.0",
      date: "26/08/2026",
      title: "Tela geral da Base de conhecimento",
      changes: [
        "Adiciona uma tela exclusiva para contas Master cadastrarem informações de produtos, relógios, manuais, garantias, políticas e procedimentos.",
        "Permite organizar cada informação por tipo, produto, categoria, tags, origem, validade e status.",
        "Cada conteúdo pode ficar disponível para todos os Bots ou somente para um ou vários Bots selecionados.",
        "A consulta do Bot respeita os acessos configurados; fontes inativas, vencidas ou destinadas a outros Bots nunca são utilizadas.",
        "Conceder acesso não ativa respostas automáticas nem a Base de conhecimento do Bot, preservando a ativação controlada, o WhatsApp/Meta e a triagem existentes."
      ]
    },
    {
      version: "0.18.1",
      date: "26/08/2026",
      title: "Campo de mensagem expansível",
      changes: [
        "O campo de mensagem agora cresce automaticamente conforme o texto, até três vezes a altura inicial.",
        "Textos maiores passam a usar rolagem interna, sem alterar a largura do composer ou encobrir os botões.",
        "Após o envio, o campo retorna à altura inicial; Enter, Shift+Enter, anexos e Respostas Rápidas continuam funcionando normalmente."
      ]
    },
    {
      version: "0.18.0",
      date: "26/08/2026",
      title: "Conhecimento dos Bots e notificações no dispositivo",
      changes: [
        "Adiciona biblioteca global de intenções e fontes de conhecimento reutilizáveis entre Bots, com gerenciamento exclusivo por contas Master.",
        "Prepara ferramentas seguras e contexto estruturado para transferência humana, mantendo respostas automáticas, ferramentas e conhecimento desligados por padrão.",
        "Adiciona notificações Web Push opcionais por dispositivo para o atendente responsável, com listagem e remoção dos dispositivos autorizados.",
        "Melhora o indicador de conexão, a recuperação após reconexão, os estados de carregamento e o uso do painel em tablets.",
        "Mantém o app funcional quando as chaves VAPID não estão configuradas e preserva o WhatsApp/Meta e o bot de triagem existentes."
      ]
    },
    {
      version: "0.17.0",
      date: "26/08/2026",
      title: "Respostas Rápidas no atendimento",
      changes: [
        "Adiciona uma biblioteca de Respostas Rápidas gerenciada exclusivamente por contas Master.",
        "Permite ao atendente localizar respostas pelo seletor ou por atalhos com / e inserir o texto no campo de mensagem para revisão antes do envio.",
        "Inclui filtros por setor e canal, favoritos individuais, variáveis seguras e métricas de uso.",
        "Restringe cada resposta à conversa autorizada e impede acesso cruzado entre setores ou canais.",
        "Prepara sugestões passivas para Bots e Observações, sem envio automático e sem alterar o WhatsApp/Meta ou o bot de triagem."
      ]
    },
    {
      version: "0.16.0",
      date: "26/08/2026",
      title: "Base segura de integrações omnichannel",
      changes: [
        "Adiciona o painel de Integrações, exclusivo para contas Master, com cadastro multi-conta, status e teste de conexão por canal.",
        "Prepara a arquitetura para e-mail, Mercado Livre, TikTok Shop, Amazon Marketplace, Shopee, Google Reviews e Reclame Aqui, sem anunciar como ativas operações ainda não verificadas.",
        "Protege credenciais com armazenamento cifrado e reforça o OAuth contra replay, troca de conta, canal ou provider.",
        "Mantém novos canais desligados por padrão e bloqueia ingresso, envio e leitura enquanto a ativação global ou a conta estiverem desabilitadas.",
        "Isola contatos, conversas, mensagens e eventos por conta do canal, evitando mistura de histórico entre lojas.",
        "Mantém webhooks sem autenticação verificável fechados e preserva integralmente o WhatsApp/Meta e o bot de triagem existentes."
      ]
    },
    {
      version: "0.15.0",
      date: "25/08/2026",
      title: "Governança, versões e qualidade dos Bots",
      changes: [
        "Adiciona controles globais de governança e kill switch auditado, sem interromper atendimento humano, triagem ou recebimento de mensagens.",
        "Inclui identidade por Bot, versões com prévia de restauração e rollback que preserva todo o histórico.",
        "Adiciona proteções contra loops, ping-pong entre Bots e pausa automática quando um atendente assume a conversa.",
        "Disponibiliza métricas separadas de interpretação e atendimento, avaliações opcionais e ranking com amostra mínima.",
        "Mantém respostas automáticas, ferramentas, avaliações e ranking desativados por padrão para uma ativação controlada."
      ]
    },
    {
      version: "0.14.3",
      date: "25/08/2026",
      title: "Contraste dos botões na área de Bots",
      changes: [
        "Corrige os botões Cancelar e Limpar conversa que ficavam sem contraste no tema escuro.",
        "Restaura o estilo dos botões Executar simulação e Limpar conversa após a evolução do simulador multi-turno.",
        "Padroniza as ações primárias e secundárias das telas de Configuração, Simulador e Aprendizado nos temas claro e escuro."
      ]
    },
    {
      version: "0.14.2",
      date: "25/08/2026",
      title: "Correção do perfil da conversa",
      changes: [
        "Corrige o tamanho e a quebra dos botões Copiar ID e Analisar para aprendizado no painel de conteúdo compartilhado.",
        "Evita que os controles do ID se sobreponham às abas de imagens, documentos e links.",
        "Ajusta o cabeçalho para crescer dinamicamente em computadores e celulares."
      ]
    },
    {
      version: "0.14.1",
      date: "25/08/2026",
      title: "ID da conversa e atalho para Aprendizado",
      changes: [
        "Exibe o ID interno real da conversa no painel de conteúdo compartilhado, sem usar telefone ou ID do contato.",
        "Permite copiar o ID da conversa com confirmação, sem fazer chamadas de rede ou alterar o atendimento.",
        "Adiciona, somente para contas Master, um atalho para analisar a conversa finalizada no Aprendizado supervisionado.",
        "Mantém a análise passiva: não finaliza conversas automaticamente, não envia mensagens e não altera o histórico."
      ]
    },
    {
      version: "0.14.0",
      date: "25/08/2026",
      title: "Comportamento conversacional, Observação e Aprendizado supervisionado",
      changes: [
        "Reconhece saudação, agradecimento, despedida, small talk, confirmação e negação ao lado da intenção de negócio, sem virar intenção cadastrada.",
        "Modo Observação evoluído: shadow mode completo, sem nunca enviar mensagem, mudar categoria/responsável ou finalizar a conversa real.",
        "Adiciona feedback humano (correto/incorreto) nas Observações, com métricas de confiança e precisão.",
        "Nova aba Aprendizado: analisa conversas finalizadas e sugere novos exemplos, intenções e respostas — sempre aguardando aprovação humana antes de virar conhecimento ativo.",
        "Sanitiza automaticamente dados pessoais (CPF, CNPJ, e-mail, telefone, pedido) antes de qualquer sugestão de aprendizado.",
        "Detecta conflitos entre soluções diferentes para o mesmo problema e evita reprocessar a mesma conversa.",
        "Ajusta o contraste das bolhas de conversa do simulador."
      ]
    },
    {
      version: "0.13.0",
      date: "25/08/2026",
      title: "Motor de interpretação inteligente de Bots",
      changes: [
        "Adiciona interpretação de intenções com faixas configuráveis de confiança alta, média e baixa.",
        "Inclui fallback local tolerante a variações de texto e suporte opcional ao provider Anthropic.",
        "Extrai e sanitiza entidades como pedido, CPF, CNPJ, série, e-mail e código de rastreio.",
        "Evolui o simulador para conversas com múltiplas mensagens, contexto temporário e resultado detalhado.",
        "Adiciona a aba Observações para comparar interpretações do Bot com a triagem real.",
        "Persiste estado e observações enriquecidas sem responder pela Meta nem alterar categoria, responsável ou status da conversa real.",
        "Mantém tools e base de conhecimento como estruturas inativas para evolução futura."
      ]
    },
    {
      version: "0.12.1",
      date: "25/08/2026",
      title: "Observação de Bots e novos canais",
      changes: [
        "Executa o Bot ativo em modo de observação, em paralelo à triagem atual, sem responder ao cliente nem alterar a conversa.",
        "Persiste o resultado das observações para permitir comparações futuras com a triagem real.",
        "Atualiza para 24 horas o prazo informado ao cliente antes da finalização automática da conversa.",
        "Amplia a configuração de Bots com Instagram, Facebook, e-mail, marketplaces, Google Reviews e Reclame Aqui.",
        "Remove a opção Zenvia da configuração de novos Bots.",
        "Mantém os novos canais apenas como opções de configuração; suas integrações externas ainda não são ativadas por esta versão."
      ]
    },
    {
      version: "0.12.0",
      date: "21/08/2026",
      title: "Gerenciamento e simulação de Bots",
      changes: [
        "Adiciona uma área interna de Bots, protegida e disponível somente para contas Master.",
        "Permite criar, editar, ativar, pausar e arquivar configurações de Bots.",
        "Inclui mensagens iniciais, respostas fora do horário, fallback, timezone e categoria padrão.",
        "Permite configurar horários semanais, intenções, prioridades, exemplos, respostas e ações de transferência.",
        "Adiciona um simulador determinístico e local que não envia mensagens nem acessa a API da Meta.",
        "Registra as alterações administrativas de Bots na auditoria geral.",
        "Mantém o bot de triagem, o webhook e a integração WhatsApp Cloud API existentes sem alterações de comportamento."
      ]
    },
    {
      version: "0.11.4",
      date: "21/08/2026",
      title: "Ocultação em cascata de categorias e contatos",
      changes: [
        "Ao ocultar uma categoria principal, as subcategorias associadas são ocultadas automaticamente junto com ela.",
        "Ocultar uma categoria agora também oculta os contatos vinculados a ela na lista geral de atendimento.",
        "Um contato oculto volta a aparecer automaticamente ao receber uma nova mensagem do cliente.",
        "Um contato oculto também reaparece assim que a categoria é reabilitada para a conta.",
        "Abrir diretamente a categoria oculta no atendimento continua exibindo todos os seus contatos normalmente.",
        "A ocultação continua sendo apenas uma preferência visual por conta: acesso, permissões e alertas não são afetados."
      ]
    },
    {
      version: "0.11.3",
      date: "21/08/2026",
      title: "Categorias pessoais e arquivos no chat interno",
      changes: [
        "Permite que cada conta oculte ou restaure individualmente as categorias às quais possui acesso.",
        "Inclui Sem categoria nas preferências individuais de visibilidade.",
        "Mantém os alertas de novas mensagens ativos mesmo quando a categoria está oculta.",
        "Permite enviar qualquer tipo de arquivo no chat interno da equipe, com limite de 100 MB por anexo.",
        "Exibe imagens com prévia e disponibiliza os demais arquivos para download seguro."
      ]
    },
    {
      version: "0.11.2",
      date: "21/08/2026",
      title: "Alertas por leitura e acesso sem categoria",
      changes: [
        "Mantém as conversas em Aguardando resposta mesmo depois que a mensagem do cliente é visualizada.",
        "Interrompe o alerta vermelho, o título piscando e as notificações assim que a mensagem é visualizada.",
        "Marca como visualizadas as novas mensagens que chegam enquanto a conversa está aberta.",
        "Preserva o controle de leitura individual para cada conta Master.",
        "Adiciona Sem categoria ao quadro de categorias liberadas de cada membro da equipe.",
        "Permite definir exatamente quais usuários podem visualizar conversas ainda não classificadas.",
        "Fortalece o controle de leitura para mensagens recebidas com atraso pelo webhook."
      ]
    },
    {
      version: "0.11.1",
      date: "20/08/2026",
      title: "Nova conversa pelo painel",
      changes: [
        "Adiciona o fluxo para iniciar uma conversa informando nome e telefone do contato.",
        "Cria automaticamente o contato e a conversa quando o número ainda não existe.",
        "Reaproveita a conversa existente sem duplicar o contato ou o atendimento.",
        "Exige um template aprovado da Meta para realizar o primeiro envio.",
        "Permite visualizar o template, preencher suas variáveis e revisar o aviso de possível cobrança.",
        "Atribui automaticamente ao atendente a conversa iniciada por ele.",
        "Mantém o recurso desativado com uma explicação enquanto a configuração de templates da Meta não estiver concluída."
      ]
    },
    {
      version: "0.11.0",
      date: "20/08/2026",
      title: "Base para templates da Meta",
      changes: [
        "Prepara a integração com templates aprovados da Meta para ativação futura.",
        "Inclui consulta por nome, idioma, categoria e prévia da mensagem.",
        "Prepara o preenchimento de variáveis e o registro do atendente responsável.",
        "Inclui o aviso de possível cobrança da Meta no fluxo futuro de templates.",
        "Mantém o envio atual funcionando normalmente enquanto a integração não estiver configurada.",
        "O botão de templates e o bloqueio da janela de 24 horas permanecem inativos até a configuração do WABA ID."
      ]
    },

    {
      version: "0.10.5",
      date: "20/08/2026",
      title: "Estabilidade do chat interno",
      changes: [
        "Corrige a atualização em tempo real do chat interno e evita recarregamentos repetidos.",
        "Mantém o cabeçalho e o campo de envio fixos, com rolagem somente no histórico das mensagens.",
        "Melhora o tamanho e a adaptação do chat interno em computadores e telas menores.",
        "Permite que atendentes iniciem conversas diretas com outros membros ativos da equipe.",
        "Atualiza automaticamente o acesso aos chats de setor conforme as permissões de cada usuário.",
        "Inclui o nome personalizado do contato na busca e nos registros internos.",
        "Mantém a sinalização manual de encaminhamento compacta e sem exibir dados do cliente."
      ]
    },

    {
      version: "0.10.4",
      date: "20/08/2026",
      title: "Chat interno e notificações",
      changes: [
        "Simplifica as notificações de clientes para mostrar apenas quem enviou uma mensagem.",
        "Adiciona notificações simplificadas para mensagens do chat interno.",
        "Atualiza o chat interno em tempo real sem precisar fechar e abrir a janela.",
        "Aumenta e padroniza o tamanho do chat interno.",
        "Mantém a barra de envio fixa e deixa apenas o histórico das mensagens rolável.",
        "Remove avisos automáticos de transferência entre setores.",
        "Adiciona sinalização manual de encaminhamento no chat interno.",
        "Simplifica o aviso de encaminhamento para uma linha discreta."
      ]
    },

    {
      version: "0.10.3",
      date: "19/08/2026",
      title: "Nome personalizado e atribuição automática",
      changes: [
        "Adiciona nome personalizado para contatos sem sobrescrever o nome recebido pelo WhatsApp.",
        "Exibe o nome personalizado com prioridade sobre o nome do WhatsApp.",
        "Adiciona edição manual do nome do contato diretamente no atendimento.",
        "Altera a finalização automática por inatividade para 24 horas.",
        "Quem envia uma mensagem passa a assumir automaticamente a conversa."
      ]
    },

    {
      version: "0.10.2",
      date: "19/08/2026",
      title: "Correções e melhorias do chat interno",
      changes: [
        "Corrigido problema em que o histórico do chat interno podia desaparecer após uma atualização.",
        "Corrigida a sincronização das notificações de mensagens não lidas.",
        "Chat interno agora permite enviar mensagens pressionando Enter.",
        "Shift + Enter adiciona uma nova linha sem enviar a mensagem.",
        "Imagens podem ser coladas diretamente da área de transferência nas conversas do WhatsApp.",
        "Imagens podem ser coladas diretamente da área de transferência no chat interno.",
        "Corrigido o envio de imagens no chat interno.",
        "Melhorias no sistema de atualização e cache do aplicativo."
      ]
    },

   {
  version: "0.10.1",
  date: "19/08/2026",
  title: "Envio rápido de mensagens e imagens",
  changes: [
    "Chat interno agora envia mensagens com Enter.",
    "Shift + Enter mantém a quebra de linha.",
    "Imagens podem ser coladas diretamente da área de transferência nas conversas do WhatsApp.",
    "Imagens podem ser coladas diretamente da área de transferência no chat interno.",
    "Novo preview de imagem antes do envio no chat interno."
  ]
},
{
  version: "0.10.0",
  date: "19/08/2026",
  title: "Chat interno e melhorias de atendimento",
  changes: [
    "Novo chat interno entre usuários do aplicativo.",
    "Chat geral, chats por setor e conversas diretas entre membros da equipe.",
    "Contador individual de mensagens não lidas no chat interno.",
    "Avisos automáticos de transferência de atendimento no chat do setor de destino.",
    "Leitura individual de novas mensagens para contas Master.",
    "Leitura compartilhada das notificações entre Supervisores e Atendentes.",
    "Nome do contato do WhatsApp atualizado automaticamente quando disponível.",
    "Novo painel com versão atual e histórico de atualizações do aplicativo.",
    "Novo controle compacto para verificar atualizações disponíveis."
  ]
},
    {
      version: "0.9.2",
      date: "13/08/2026",
      title: "Auditoria e controle de acesso",
      changes: [
        "Auditoria geral para contas Master.",
        "Novas permissões individuais para membros da equipe.",
        "Permissão para visualizar histórico das conversas.",
        "Permissão para visualizar mensagens anteriores após transferências."
      ]
    },
    {
      version: "0.9.1",
      date: "12/08/2026",
      title: "Organização do atendimento",
      changes: [
        "Categorias e subcategorias de atendimento.",
        "Fixação individual de conversas.",
        "Melhorias no acompanhamento e transferência entre atendentes.",
        "Ajustes no fluxo de conversas aguardando resposta."
      ]
    },
    {
      version: "0.9.0",
      date: "10/08/2026",
      title: "Base funcional da Central de Atendimento",
      changes: [
        "Painel central de conversas do WhatsApp.",
        "Recebimento e envio de mensagens.",
        "Controle de responsável por conversa.",
        "Estados Novo, Em atendimento, Aguardando resposta, Bot e Finalizado."
      ]
    }
  ];

  const $ = (selector) => document.querySelector(selector);

  function escapeHtml(value = "") {
    return String(value).replace(/[&<>'"]/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;"
    })[char]);
  }

  function storageKey() {
    const userId =
      window.state?.currentUser?.id ||
      document.querySelector("#current-user")?.textContent ||
      "anonymous";

    return `mibro-changelog-seen:${userId}`;
  }

  function renderChangelog() {
    const list = $("#changelog-list");
    if (!list) return;

    const current = CHANGELOG[0];

    $("#app-version-label").textContent = `v${APP_VERSION}`;
    $("#changelog-current-version").textContent = `v${APP_VERSION}`;
    $("#changelog-current-date").textContent = current.date;

    list.innerHTML = CHANGELOG.map((release, index) => `
      <article class="changelog-release ${index === 0 ? "current" : ""}">
        <div class="changelog-release-heading">
          <div>
            <span>v${escapeHtml(release.version)}</span>
            ${index === 0 ? '<b>Atual</b>' : ""}
          </div>
          <time>${escapeHtml(release.date)}</time>
        </div>

        <h3>${escapeHtml(release.title)}</h3>

        <ul>
          ${release.changes
            .map((change) => `<li>${escapeHtml(change)}</li>`)
            .join("")}
        </ul>
      </article>
    `).join("");
  }

  function syncUnreadDot() {
    const dot = $("#changelog-unread-dot");
    if (!dot) return;

    let seenVersion = null;

    try {
      seenVersion = localStorage.getItem(storageKey());
    } catch {}

    dot.hidden = seenVersion === APP_VERSION;
  }

  function markCurrentVersionSeen() {
    try {
      localStorage.setItem(storageKey(), APP_VERSION);
    } catch {}

    syncUnreadDot();
  }

  function openChangelog() {
    renderChangelog();
    markCurrentVersionSeen();

    const dialog = $("#changelog-dialog");

    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }

  function initializeChangelog() {
    const label = $("#app-version-label");
    if (label) label.textContent = `v${APP_VERSION}`;
    syncUnreadDot();

    $("#changelog-button")?.addEventListener("click", openChangelog);

    $("#close-changelog")?.addEventListener("click", () => {
      $("#changelog-dialog")?.close();
    });

    $("#changelog-dialog")?.addEventListener("click", (event) => {
      if (event.target === $("#changelog-dialog")) {
        $("#changelog-dialog").close();
      }
    });
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initializeChangelog,{once:true});else initializeChangelog();

  window.MibroChangelog = {
    open:openChangelog,
    version: APP_VERSION,
    releases: CHANGELOG,
    render: renderChangelog
  };
})();
