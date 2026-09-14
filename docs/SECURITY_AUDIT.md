# Auditoria de segurança — flood de mensagens e arquivos maliciosos

Data: 2026-09-14. Branch: `feature/bot-agent-intelligence` (local, **nada aqui foi
deployado nem mergeado** — só commitado localmente para revisão).

Escopo pedido: qualquer meio de invadir ou derrubar o app/VPS por (1) envio em
excesso de mensagens, (2) arquivos maliciosos (executáveis, arquivos
disfarçados), (3) outros vetores de negação de serviço/comprometimento.

## Como cheguei nos pontos abaixo

Revisei `src/app.js` (todas as rotas públicas, uploads via multer),
`src/middleware/meta-signature.js` (validação do webhook), e todo o caminho de
armazenamento de mídia (`src/services/media-storage-service.js`,
`src/services/internal-chat-service.js`,
`src/services/channels/omnichannel-message-service.js`). A boa notícia: boa
parte do sistema já tinha defesas sólidas (ver seção "O que já estava
protegido"). Os achados abaixo são as lacunas reais que encontrei.

---

## 1. Arquivos maliciosos/disfarçados

### O que já estava protegido (não mexi)
Mídia recebida do **WhatsApp/Meta** (`storeImage`/`storeAudio`/`storeVideo`/
`storeDocument` em `media-storage-service.js`) já tem um allowlist estrito de
MIME **e** checagem de assinatura binária real (magic bytes) — um `.exe`
disfarçado de PDF já era rejeitado antes desta auditoria, porque o conteúdo
não bate com a assinatura `%PDF-` esperada. Isso cobre a maior parte do
volume real (clientes conversando pelo WhatsApp).

### A lacuna: o único caminho SEM allowlist de tipo
Dois caminhos aceitavam **qualquer** tipo de arquivo até 100 MB, com **zero**
inspeção de conteúdo (só tamanho):
- Upload de arquivo no chat interno entre atendentes (`POST
  /api/internal-chats/:id/files`).
- Mídia recebida de qualquer canal além do WhatsApp/Meta (Instagram,
  Facebook, e-mail, futuros canais — `omnichannel-message-service.js`),
  incluindo de **remetentes externos não autenticados**.

Um atacante externo (em qualquer canal conectado, ou um atendente com conta
comprometida) podia entregar um executável renomeado (`fatura.pdf` que na
verdade é um `.exe`) e ele ficava salvo no disco da VPS sem nenhum aviso,
pronto para um atendente baixar e abrir — o vetor clássico de entrega de
malware/ransomware via chat corporativo.

### O que implementei
Novo módulo **`src/services/file-risk-service.js`** (`assessFileRisk`),
puramente por CONTEÚDO — nunca confia no `Content-Type` ou na extensão que o
remetente declarou:

- **BLOQUEIA** (rejeita com HTTP 400, `code: "SUSPICIOUS_FILE"`, e loga
  `[SECURITY] upload bloqueado`):
  - Assinatura binária de executável nativo: PE/Windows (`MZ`), ELF/Linux,
    Mach-O/macOS.
  - Scripts com shebang (`#!/bin/sh`, `#!/usr/bin/env python`, etc.).
  - Extensão de executável/instalador/script conhecida (`.exe .dll .bat .cmd
    .scr .ps1 .vbs .js .jar .msi .apk .sh .app .dmg .iso .lnk ...` — lista
    completa no módulo), mesmo quando o conteúdo não bate nenhuma assinatura
    (scripts de texto puro não têm "magic bytes").
- **MARCA COMO SUSPEITO, mas NUNCA bloqueia** (são tipos de arquivo de negócio
  legítimos — bloquear seria destrutivo demais):
  - Arquivos `.json` (pedido explícito: "para arquivos suspeitos, tipo json
    ou executáveis, avise") — JSON pode carregar payloads que só viram
    perigosos se OUTRA ferramenta os interpretar de forma insegura depois; o
    aviso existe para quem for usar o conteúdo saber que merece atenção.
  - Documentos do Office com macro habilitada (`.docm .xlsm .pptm ...`).
  - Arquivo sem extensão e sem `Content-Type` reconhecível.

Isso é aplicado em `validateInternalFile` (`media-storage-service.js`), usado
tanto pelo chat interno quanto pela mídia de canais externos — os dois
caminhos sem allowlist ficaram cobertos com uma mudança central, sem duplicar
lógica.

O aviso ("suspeito") fica **persistido**, não só logado: adicionei
`Message.mediaSuspicious` (boolean) e `Message.mediaSuspiciousReason` (texto)
via migration aditiva (`20260914120000_message_media_suspicious`), e o mesmo
par de campos no `metadata.media` do chat interno. Isso deixa o dado pronto
para a UI mostrar um selo de aviso mais tarde (não fiz mudança de tela — fora
do pedido "não faça deploy", e mudança de UI exigiria decisão de design que
não me cabe tomar sozinho).

### Ataques que isso evita
- Entrega de malware/ransomware disfarçado de documento comum, via chat
  interno ou via canal externo, para um atendente humano baixar e executar.
- Bypass de filtro de tipo por meio de `Content-Type`/extensão forjados
  (MIME sniffing spoofing) — a checagem por assinatura binária não pode ser
  enganada só trocando o cabeçalho declarado.
- Uso do chat interno como ponto de distribuição lateral de um executável
  depois que uma conta de atendente já foi comprometida por outro meio.

### O que NÃO faz (limite consciente)
Não é um antivírus: não detecta malware em formatos que a assinatura não
denuncia (ex.: uma macro maliciosa dentro de um `.docx`/`.xlsx` sem extensão
de macro, ou um PDF com JavaScript embutido malicioso). Isso exigiria um
scanner de conteúdo de verdade (ex.: ClamAV) — deixei como recomendação de
próxima fase, não implementei por estar fora do que dá para fazer com
inspeção de assinatura sem novas dependências/infra.

---

## 2. Envio em excesso de mensagens (flood/DoS)

### O que já estava protegido
`express.json({ limit: "1mb" })` já limita o tamanho de qualquer corpo de
requisição — um payload gigante de uma vez já não passava. Login e o endpoint
de leads externos já tinham rate limit (`express-rate-limit`).

### As lacunas
1. **As rotas de webhook (`/webhook/whatsapp` GET+POST e
   `/webhooks/channels/:channel`) não tinham NENHUM rate limit.** São rotas
   públicas por natureza (recebem tráfego de fora sem sessão autenticada — só
   a assinatura HMAC valida o CONTEÚDO, nunca limitou o VOLUME). Um flood de
   requisições nelas gasta CPU real a cada requisição (parsing de JSON +
   HMAC + consultas ao banco) antes mesmo da assinatura ser checada —
   volume suficiente derruba o processo/consome toda a CPU da VPS.
2. **Um único evento malformado no webhook do WhatsApp derrubava o lote
   inteiro com HTTP 500.** O `try/catch` envolvia TODO o `for` de eventos:
   se `saveIncoming`/`storeDocument` lançasse uma exceção para UM evento
   (ex.: um documento deliberadamente malformado — mimetype declarado não
   bate com o conteúdo, o que agora é ainda mais comum de acontecer com a
   checagem de conteúdo mais rigorosa), a resposta virava 500 para o webhook
   inteiro. A Meta reentrega webhooks que respondem erro — um único evento
   malicioso conseguia gerar reentregas repetidas (retry automático da
   própria Meta agindo como amplificador de carga) e ainda derrubava o
   processamento dos OUTROS eventos legítimos do mesmo lote.
3. **Nenhum limite por remetente.** Um único número de WhatsApp (ou contato
   de outro canal) podia mandar milhares de mensagens seguidas; cada uma
   aciona processamento caro (Bot, possivelmente IA externa paga,
   observação, campanhas) sem nenhum teto — um vetor de exaustão de
   CPU/custo de IA a partir de UM ÚNICO contato externo, sem precisar de
   volume de rede nenhum (a rota HTTP em si recebe poucas requisições — é a
   Meta reencaminhando; o abuso está no CONTEÚDO, não no transporte). Um
   rate limit por IP sozinho não resolveria isso: o IP de origem do webhook é
   da Meta, compartilhado entre muitos clientes/empresas — limitar por IP
   ali arriscaria throttlar tráfego legítimo de outros números.

### O que implementei
- `webhookLimiter` (`express-rate-limit`, 300 requisições/minuto por IP)
  aplicado às três rotas de webhook — generoso o bastante para o tráfego real
  em lote da Meta, baixo o bastante para nunca deixar um flood de requisições
  brutas consumir a CPU até derrubar o processo.
- Todo o corpo do `for` de eventos do webhook do WhatsApp agora tem seu
  próprio `try/catch` — uma falha em UM evento é logada e o lote **continua**
  para os demais eventos, e a resposta ao final continua `200` (nunca mais
  provoca reentrega automática da Meta por causa de um único evento ruim).
  (A rota `/webhooks/channels/:channel` já tinha esse isolamento por evento —
  só faltava no WhatsApp.)
- Novo módulo **`src/services/inbound-flood-guard-service.js`**
  (`checkInboundFlood`): janela deslizante em memória, por CHAVE DE CONTATO
  (telefone/id externo, nunca por IP) — acima de 20 mensagens/minuto do MESMO
  contato, a mensagem continua sendo **salva normalmente** (nunca perde
  histórico), mas o processamento caro (Bot/IA/observação/campanhas) é
  **pulado** para aquele turno, com log `[SECURITY]`. Limpeza periódica
  (a cada 5 min) evita crescimento sem limite do mapa em memória ao longo da
  vida do processo.

### Ataques que isso evita
- Flood de requisições HTTP brutas nas rotas públicas de webhook até esgotar
  CPU/conexões da VPS (negação de serviço clássica).
- Amplificação de carga via retry automático da Meta, provocada por um único
  evento malicioso que antes derrubava o lote inteiro com 500.
- Exaustão de CPU/custo de IA externa a partir de um único número de
  WhatsApp/contato enviando volume alto de mensagens — sem depender de rate
  limit por IP (que não funcionaria aqui, dado o IP compartilhado da Meta).

### O que NÃO faz (limite consciente)
Não é proteção de camada de rede (não substitui um WAF/CDN na frente da VPS
para floods volumétricos — SYN flood, floods de banda). Isso é
infraestrutura fora do alcance do código da aplicação; a recomendação fica
registrada na seção "Próximos passos" abaixo.

---

## Arquivos alterados/criados

| Arquivo | O que mudou |
|---|---|
| `src/services/file-risk-service.js` | **novo** — detecção de arquivo suspeito/executável por conteúdo |
| `src/services/inbound-flood-guard-service.js` | **novo** — limite de mensagens por contato (janela deslizante em memória) |
| `src/services/media-storage-service.js` | `validateInternalFile` agora chama `assessFileRisk`, bloqueia executáveis, propaga `suspicious`/`suspiciousReason` |
| `src/services/internal-chat-service.js` | persiste `suspicious`/`suspiciousReason` no `metadata.media` da mensagem interna |
| `src/services/channels/omnichannel-message-service.js` | persiste `mediaSuspicious`/`mediaSuspiciousReason` na `Message` |
| `prisma/schema.prisma` + migration `20260914120000_message_media_suspicious` | novas colunas aditivas em `Message` (default seguro, nunca aplicado ao banco por mim — ver nota abaixo) |
| `src/app.js` | rate limit nas 3 rotas de webhook; isolamento por evento no webhook do WhatsApp; integração do flood guard por contato |
| `test/file-risk-service.test.js`, `test/inbound-flood-guard-service.test.js`, `test/media-storage-internal-file.test.js` | testes novos (17 casos, todos passando) |

**Nada foi deployado nem mergeado.** A migration nova precisa ser aplicada
(`prisma migrate deploy`) em qualquer ambiente que já tenha o schema anterior
antes destas colunas existirem — decisão de quando/onde fica para quem
revisar isto manualmente, igual combinado nas mudanças anteriores desta
sessão.

## Próximos passos (não implementados agora, por estarem fora do que dá para
fazer só em código de aplicação, ou por exigirem decisão de infraestrutura)

- Scanner de conteúdo real (ex.: ClamAV) para os tipos de arquivo que passam
  no allowlist mas podem conter macro/script malicioso embutido.
- Rate limit/WAF na camada de rede (Nginx/Cloudflare na frente da VPS) contra
  flood volumétrico que nunca chega a golpear a aplicação Node diretamente.
- Alertar um Master automaticamente (painel/e-mail) quando
  `mediaSuspicious=true` ou quando o flood guard throttla um contato
  repetidamente — hoje só fica registrado (banco + log), sem notificação
  ativa.
- Expor o selo "arquivo suspeito" na UI do inbox/chat interno (dado já
  persistido, falta só a tela).
