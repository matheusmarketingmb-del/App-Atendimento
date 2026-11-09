# Central de Atendimento + CRM + ponte Olist

Os fontes de execução do Atendimento nesta cópia correspondem à versão **0.38.6**, publicada em 09/11/2026. O CRM e a ponte Olist seguem a cópia integrada de 03/11/2026, que inclui trabalho local em revisão.

- attendance/: Central, canais, bots, banco/schema e interface.
- crm/: CRM, integração de identidade, propostas e acompanhamento Olist.
- olist-bridge/: base versionada do aplicativo de integração Shopify/Olist, com os complementos CRM desta entrega. Alterações independentes e não commitadas das seções da loja foram preservadas apenas no checkout original.
- docs/: escopo e limites das mudanças locais.

Para reproduzir o alerta sonoro do Atendimento, baixe [New Notification 056, de Universfield](https://pixabay.com/sound-effects/technology-new-notification-056-494256/) e coloque o MP3 em `attendance/public/assets/inbox-notification.mp3` antes de montar a imagem. O arquivo original fica separado da cópia pública do código.

Dependências, builds, ambientes, segredos, bancos, conversas, anexos e relatórios de dados reais não fazem parte desta cópia. Configure as credenciais no ambiente de execução. Não execute seeds, migrations ou scripts de publicação contra produção como verificação.

Consulte [integração](docs/INTEGRACAO.md), [fluxo Olist](docs/FLUXO_OLIST_LOCAL_20261030.md) e [templates](docs/TEMPLATES_SELECAO_LOCAL_20261103.md).
