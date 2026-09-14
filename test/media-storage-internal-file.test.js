// Item de segurança (arquivos suspeitos/executáveis no chat interno + mídia
// de canais além do WhatsApp/Meta — único caminho de upload sem allowlist de
// MIME): storeInternalFile precisa recusar executáveis por CONTEÚDO e
// marcar arquivos ambíguos (JSON, tipo não identificado) como suspeitos sem
// bloqueá-los.
require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { storeInternalFile, resolveMedia, removeImage } = require("../src/services/media-storage-service");

const stored = [];
test.afterEach(async () => {
  while (stored.length) await removeImage(stored.pop());
});

test("storeInternalFile recusa um executável Windows (PE) disfarçado de documento", async () => {
  const buffer = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(50)]);
  await assert.rejects(
    () => storeInternalFile({ buffer, mimeType: "application/pdf", fileName: "fatura.pdf" }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "SUSPICIOUS_FILE");
      return true;
    },
  );
});

test("storeInternalFile recusa pela extensão (.exe) mesmo com conteúdo genérico", async () => {
  const buffer = Buffer.from("conteudo qualquer, sem assinatura reconhecivel");
  await assert.rejects(
    () => storeInternalFile({ buffer, mimeType: "application/octet-stream", fileName: "instalador.exe" }),
    { statusCode: 400, code: "SUSPICIOUS_FILE" },
  );
});

test("storeInternalFile aceita e MARCA um JSON como suspeito (nunca bloqueia arquivo de negócio legítimo)", async () => {
  const buffer = Buffer.from(JSON.stringify({ pedido: 123 }));
  const result = await storeInternalFile({ buffer, mimeType: "application/json", fileName: "pedido.json" });
  stored.push(result.storageKey);
  assert.equal(result.suspicious, true);
  assert.match(result.suspiciousReason, /JSON/);
  assert.deepEqual(await fs.readFile(resolveMedia(result.storageKey)), buffer);
});

test("storeInternalFile aceita um PDF real sem marcar como suspeito", async () => {
  const buffer = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(20)]);
  const result = await storeInternalFile({ buffer, mimeType: "application/pdf", fileName: "contrato.pdf" });
  stored.push(result.storageKey);
  assert.equal(result.suspicious, false);
  assert.equal(result.suspiciousReason, null);
});
