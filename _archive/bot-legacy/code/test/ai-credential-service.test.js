const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const prisma = require("../src/database/prisma");
const credentials = require("../src/services/ai/ai-credential-service");
const { getPrimaryProvider, getProviderStatus } = require("../src/services/ai/get-ai-provider");

const adminEmail = "admin-ai-credential-test@teste.local";
const attendantEmail = "atendente-ai-credential-test@teste.local";
let admin;
let attendant;

async function withEncryptionKey(fn) {
  const previous = process.env.AI_SECRETS_ENCRYPTION_KEY;
  process.env.AI_SECRETS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    return await fn();
  } finally {
    if (previous !== undefined) process.env.AI_SECRETS_ENCRYPTION_KEY = previous;
    else delete process.env.AI_SECRETS_ENCRYPTION_KEY;
  }
}

async function cleanup() {
  await prisma.aiProviderCredential.deleteMany({ where: { provider: { in: ["GEMINI", "ANTHROPIC", "OPENAI"] } } });
  await prisma.auditLog.deleteMany({ where: { entityType: "AI_PROVIDER_CREDENTIAL" } });
}

test.before(async () => {
  admin = await prisma.user.upsert({
    where: { email: adminEmail }, update: {}, create: { name: "Admin Credencial IA", email: adminEmail, role: "ADMIN" },
  });
  attendant = await prisma.user.upsert({
    where: { email: attendantEmail }, update: {}, create: { name: "Atendente Credencial IA", email: attendantEmail, role: "ATENDENTE" },
  });
});

test.after(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { email: { in: [adminEmail, attendantEmail] } } });
  await prisma.$disconnect();
});

test("RBAC: somente Admin pode salvar/remover/listar credenciais de IA", async () => {
  await assert.rejects(
    () => credentials.saveCredential("GEMINI", { apiKey: "AIzaTeste1234567890" }, attendant),
    (error) => error.statusCode === 403,
  );
  await assert.rejects(() => credentials.listCredentialStatus(attendant), (error) => error.statusCode === 403);
  await assert.rejects(() => credentials.removeCredential("GEMINI", attendant), (error) => error.statusCode === 403);
});

test("salvar chave: nunca em texto puro no banco, só os últimos 4 caracteres em claro", async () => {
  await cleanup();
  await withEncryptionKey(async () => {
    const key = "AIzaSySECRETVALUE7890abcd";
    const saved = await credentials.saveCredential("GEMINI", { apiKey: key, defaultModel: "gemini-3.6-flash" }, admin);
    assert.equal(saved.lastFour, "abcd");
    assert.equal(saved.configured, true);

    const row = await prisma.aiProviderCredential.findUnique({ where: { provider: "GEMINI" } });
    assert.ok(row.encryptedKey instanceof Uint8Array && row.encryptedKey.length > 0);
    assert.doesNotMatch(Buffer.from(row.encryptedKey).toString("utf8"), /AIzaSySECRETVALUE/, "a chave nunca deveria ficar legível no valor bruto salvo");
    assert.equal(row.lastFour, "abcd");
    assert.equal(row.defaultModel, "gemini-3.6-flash");
  });
});

test("substituir chave: upsert troca a credencial inteira, nunca mistura IV antigo com chave nova", async () => {
  await cleanup();
  await withEncryptionKey(async () => {
    await credentials.saveCredential("GEMINI", { apiKey: "chave-antiga-0001" }, admin);
    const first = await prisma.aiProviderCredential.findUnique({ where: { provider: "GEMINI" } });

    await credentials.saveCredential("GEMINI", { apiKey: "chave-nova-9999" }, admin);
    const second = await prisma.aiProviderCredential.findUnique({ where: { provider: "GEMINI" } });

    assert.notEqual(first.encryptionIv.toString("hex"), second.encryptionIv.toString("hex"));
    assert.equal(second.lastFour, "9999");

    const { apiKey } = require("../src/services/crypto/secret-vault-service").decryptSecrets(
      { encryptedSecrets: second.encryptedKey, encryptionIv: second.encryptionIv, encryptionAuthTag: second.encryptionAuthTag },
      "AI_SECRETS_ENCRYPTION_KEY",
    );
    assert.equal(apiKey, "chave-nova-9999");
  });
});

test("remover chave: some da lista de status e getPrimaryProvider volta a usar o motor local", async () => {
  await cleanup();
  await withEncryptionKey(async () => {
    const previousEnv = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY; // garante que não há fallback de env nesta checagem
    try {
      await credentials.saveCredential("GEMINI", { apiKey: "chave-para-remover-1234" }, admin);
      const statusBefore = await getProviderStatus("GEMINI");
      assert.equal(statusBefore.configured, true);

      await credentials.removeCredential("GEMINI", admin);
      const statusAfter = await getProviderStatus("GEMINI");
      assert.equal(statusAfter.configured, false);

      const { name } = await getPrimaryProvider("GEMINI");
      assert.equal(name, "LOCAL_FALLBACK");
    } finally {
      if (previousEnv !== undefined) process.env.GEMINI_API_KEY = previousEnv;
    }
  });
});

test("auditoria: registra a ação sem NUNCA gravar a chave (nem os últimos 4 caracteres)", async () => {
  await cleanup();
  await withEncryptionKey(async () => {
    await credentials.saveCredential("ANTHROPIC", { apiKey: "sk-ant-secretissimo-0007" }, admin);
    const log = await prisma.auditLog.findFirst({
      where: { entityType: "AI_PROVIDER_CREDENTIAL", action: "AI_PROVIDER_CREDENTIAL_SAVED" },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(log);
    const serialized = JSON.stringify(log.details || {});
    assert.doesNotMatch(serialized, /secretissimo/);
    assert.doesNotMatch(serialized, /sk-ant-/);
    assert.doesNotMatch(serialized, /0007/, "nem os últimos 4 caracteres deveriam ir para a auditoria");
  });
});

test("listCredentialStatus nunca inclui a chave, só metadados (lastFour, modelo, quem alterou)", async () => {
  await cleanup();
  await withEncryptionKey(async () => {
    await credentials.saveCredential("OPENAI", { apiKey: "sk-openai-testevalor9999" }, admin);
    const list = await credentials.listCredentialStatus(admin);
    const openai = list.find((item) => item.provider === "OPENAI");
    assert.equal(openai.configured, true);
    assert.equal(openai.lastFour, "9999");
    assert.ok(!("apiKey" in openai));
    assert.ok(!JSON.stringify(list).includes("sk-openai-testevalor9999"));
  });
});

test("sem AI_SECRETS_ENCRYPTION_KEY configurada: salvar falha com erro claro, app não derruba", async () => {
  await cleanup();
  const previous = process.env.AI_SECRETS_ENCRYPTION_KEY;
  delete process.env.AI_SECRETS_ENCRYPTION_KEY;
  try {
    await assert.rejects(
      () => credentials.saveCredential("GEMINI", { apiKey: "qualquer-coisa-1234" }, admin),
      /AI_SECRETS_ENCRYPTION_KEY/,
    );
  } finally {
    if (previous !== undefined) process.env.AI_SECRETS_ENCRYPTION_KEY = previous;
  }
});
