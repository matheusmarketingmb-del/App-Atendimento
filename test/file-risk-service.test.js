// Item de segurança (arquivos suspeitos/executáveis): detecção por CONTEÚDO
// (assinatura binária), nunca só pela extensão/Content-Type declarado —
// ver src/services/file-risk-service.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const { assessFileRisk } = require("../src/services/file-risk-service");

test("bloqueia um executável Windows (PE/MZ) mesmo disfarçado de PDF", () => {
  const buffer = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(100)]);
  const risk = assessFileRisk({ buffer, mimeType: "application/pdf", fileName: "fatura.pdf" });
  assert.equal(risk.blocked, true);
  assert.match(risk.blockedReason, /PE \(Windows/);
});

test("bloqueia um binário ELF (Linux) mesmo sem extensão", () => {
  const buffer = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(100)]);
  const risk = assessFileRisk({ buffer, mimeType: "application/octet-stream", fileName: "relatorio" });
  assert.equal(risk.blocked, true);
  assert.match(risk.blockedReason, /ELF/);
});

test("bloqueia um script com shebang (#!/bin/sh) mesmo declarado como texto", () => {
  const buffer = Buffer.from("#!/bin/sh\nrm -rf /\n");
  const risk = assessFileRisk({ buffer, mimeType: "text/plain", fileName: "notas.txt" });
  assert.equal(risk.blocked, true);
  assert.match(risk.blockedReason, /shebang/);
});

test("bloqueia pela extensão executável mesmo quando o conteúdo não bate nenhuma assinatura conhecida", () => {
  const buffer = Buffer.from("qualquer coisa");
  const risk = assessFileRisk({ buffer, mimeType: "application/octet-stream", fileName: "instalar.bat" });
  assert.equal(risk.blocked, true);
  assert.match(risk.blockedReason, /\.bat/);
});

test("marca JSON como suspeito, mas NUNCA bloqueia (arquivo de negócio legítimo)", () => {
  const buffer = Buffer.from(JSON.stringify({ ok: true }));
  const risk = assessFileRisk({ buffer, mimeType: "application/json", fileName: "dados.json" });
  assert.equal(risk.blocked, false);
  assert.equal(risk.suspicious, true);
  assert.match(risk.suspiciousReason, /JSON/);
});

test("marca documento com macro (.xlsm) como suspeito, mas não bloqueia", () => {
  const buffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0]);
  const risk = assessFileRisk({ buffer, mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12", fileName: "planilha.xlsm" });
  assert.equal(risk.blocked, false);
  assert.equal(risk.suspicious, true);
  assert.match(risk.suspiciousReason, /macro/);
});

test("um PDF real (assinatura %PDF-) não é bloqueado nem marcado como suspeito", () => {
  const buffer = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(50)]);
  const risk = assessFileRisk({ buffer, mimeType: "application/pdf", fileName: "contrato.pdf" });
  assert.equal(risk.blocked, false);
  assert.equal(risk.suspicious, false);
});

test("arquivo sem extensão e sem Content-Type reconhecível fica marcado como suspeito", () => {
  const buffer = Buffer.from("conteudo qualquer");
  const risk = assessFileRisk({ buffer, mimeType: "", fileName: "arquivo" });
  assert.equal(risk.blocked, false);
  assert.equal(risk.suspicious, true);
});
