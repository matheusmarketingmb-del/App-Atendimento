const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(process.cwd(), "public", "index.html"), "utf8");
const js = fs.readFileSync(path.join(process.cwd(), "public", "js", "app.js"), "utf8").replace(/\r\n/g, "\n");
const css = fs.readFileSync(path.join(process.cwd(), "public", "css", "app.css"), "utf8");
const fnBody = (name) => js.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];

test("composer tem microfone, painel de gravação (tempo/pausar/concluir/cancelar) e preview (player/regravar/excluir/salvar)", () => {
  assert.match(html, /id="record-audio"[^>]*aria-label="Gravar áudio"/);
  for (const id of ["audio-timer", "audio-pause", "audio-stop", "audio-cancel", "audio-preview-player", "audio-preview-duration", "audio-rerecord", "audio-discard", "audio-save-quick-reply"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /Salvar como resposta rápida/);
  // "Enviar áudio" pelo + aceita arquivos de áudio; fallback com gravador nativo do aparelho.
  assert.match(html, /id="attachment-input"[^>]*accept="[^"]*audio\/\*/);
  assert.match(html, /id="audio-capture-input" type="file" accept="audio\/\*" capture/);
});

test("nada é enviado automaticamente: concluir gravação, escolher arquivo ou resposta rápida só carregam o preview", () => {
  const stop = js.match(/recorder\.addEventListener\("stop", \(\) => \{[\s\S]*?\n  \}\);/)[0];
  assert.match(stop, /setPendingAudio\(/);
  assert.doesNotMatch(stop, /sendPendingAudio|\/audios/);
  assert.doesNotMatch(fnBody("loadQuickReplyAudioIntoComposer"), /sendPendingAudio|\/audios/);
  assert.doesNotMatch(fnBody("selectAudioFile"), /sendPendingAudio|\/audios/);
  // Enviar durante a gravação só conclui a gravação.
  assert.match(js, /if \(isAudioRecording\(\)\) \{\n    stopAudioRecording\(\);\n    return toast\(/);
  assert.match(js, /if \(pendingAudio\) return sendPendingAudio\(\);/);
  // O único POST para /audios é o envio explícito.
  assert.equal((js.match(/\/audios`/g) || []).length, 1);
  assert.match(fnBody("sendPendingAudio"), /\/api\/conversations\/\$\{conversationId\}\/audios/);
});

test("permissão de microfone negada mostra aviso e mantém o envio por arquivo", () => {
  assert.match(fnBody("startAudioRecording"), /Permissão de microfone necessária para gravar áudio\./);
  assert.match(fnBody("startAudioRecording"), /NotAllowedError/);
  // Sem MediaRecorder: abre o gravador nativo (input capture) em vez de quebrar.
  assert.match(fnBody("startAudioRecording"), /if \(!supportsAudioRecording\(\)\) return \$\("#audio-capture-input"\)\.click\(\);/);
});

test("cancelar descarta o blob, não persiste e libera o microfone", () => {
  const discard = fnBody("discardComposerAudio");
  assert.match(discard, /audioRecorder\.discard = true;/);
  assert.match(discard, /setPendingAudio\(null\);/);
  assert.match(fnBody("resetRecorderState"), /releaseMicrophone\(\);/);
  assert.match(fnBody("releaseMicrophone"), /getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
  assert.match(js, /if \(discard \|\| !blob\.size\) return syncAudioComposer\(\);/);
});

test("trocar de conversa ou fechar a página com áudio não enviado pede confirmação", () => {
  assert.match(js, /card\.dataset\.id !== state\.selectedId && !confirmDiscardComposerAudio\(\)/);
  assert.match(js, /window\.addEventListener\("beforeunload", \(event\) => \{\n  if \(!hasUnsentComposerAudio\(\)\) return;/);
});

test("gravação prefere OGG/WebM Opus e cai para MP4 (Safari/iOS)", () => {
  assert.match(fnBody("pickRecorderMimeType"), /"audio\/ogg;codecs=opus", "audio\/webm;codecs=opus", "audio\/mp4;codecs=mp4a\.40\.2", "audio\/mp4"/);
});

test("canal sem suporte desabilita o microfone com explicação", () => {
  assert.match(js, /const AUDIO_CHANNELS = new Set\(\["META"\]\);/);
  assert.match(fnBody("syncAudioAvailability"), /Este canal ainda não suporta envio de áudio/);
  assert.match(fnBody("syncAudioAvailability"), /button\.disabled = !allowed/);
});

test("comando /atalho de áudio mostra 🎤 nome + 'Áudio • Ns' e remove o comando digitado", () => {
  assert.match(js, /<span aria-hidden="true">🎤<\/span> \$\{escapeHtml\(item\.name\)\}[\s\S]{0,80}Áudio • \$\{escapeHtml\(shortAudioDuration/);
  assert.match(fnBody("applySlashSuggestion"), /if \(result\.audio\) \{[\s\S]*input\.value\.slice\(0, active\.start\) \+ input\.value\.slice\(active\.end\)[\s\S]*loadQuickReplyAudioIntoComposer/);
  // Texto continua no fluxo original.
  assert.match(fnBody("applySlashSuggestion"), /input\.value = input\.value\.slice\(0, active\.start\) \+ result\.text \+ input\.value\.slice\(active\.end\);/);
});

test("lista de respostas rápidas separa Texto/Áudio e busca também por tipo", () => {
  assert.match(html, /data-quick-reply-type="TEXT">Texto</);
  assert.match(html, /data-quick-reply-type="AUDIO">🎤 Áudio</);
  assert.match(fnBody("filteredQuickReplies"), /const typeLabel = isAudioQuickReply\(item\) \? "audio" : "texto";/);
  assert.match(js, /data-edit-audio=/);
  assert.match(js, /data-delete-audio=/);
});

test("player de áudio nas mensagens: play/pause, progresso, duração", () => {
  assert.match(js, /data-audio-play aria-label="Reproduzir áudio"/);
  assert.match(js, /data-audio-progress/);
  assert.match(js, /data-audio-time/);
  assert.match(js, /\["play", "pause", "ended", "timeupdate", "loadedmetadata"\]\.forEach/);
});

test("CSS: modo áudio não empurra o Enviar para fora e respeita prefers-reduced-motion", () => {
  assert.match(css, /\.composer\.audio-mode \{ flex-wrap:wrap; row-gap:8px; \}/);
  assert.match(css, /\.composer\.audio-mode #send-button \{ margin-left:auto; \}/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\) \{ \.audio-rec-dot \{ animation:none; \} \}/);
});
