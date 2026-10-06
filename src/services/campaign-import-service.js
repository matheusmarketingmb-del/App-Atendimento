// Importação de contatos para uma campanha (itens 6/7/8) — CSV apenas nesta
// fase (ver relatório final). Fluxo: parsear -> mapear colunas -> validar
// (preview, sem gravar nada) -> confirmar (grava, sempre revalidando no
// servidor, nunca confia só na validação do cliente).
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const audit = require("./audit-service");
const { parseCsv } = require("./campaign-csv-service");
const { normalizeCampaignPhone } = require("./campaign-phone-service");
const { bulkOptedOutSet } = require("./campaign-optout-service");
const {
  CAMPAIGN_IMPORT_FIELDS, CONTACT_SOURCES, CSV_MAX_ROWS,
} = require("./campaign-constants");
const { getCampaignSettings } = require("./campaign-settings-service");

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

async function assertCampaign(campaignId, client = prisma, actor = null) {
  const { findCampaignOr404 } = require("./campaign-service");
  const campaign = await findCampaignOr404(campaignId, client, actor);
  if (!["DRAFT", "SCHEDULED"].includes(campaign.status)) {
    throw fail("Só é possível importar contatos em campanhas em rascunho ou agendadas.");
  }
  return campaign;
}

// Item 6: primeira etapa do wizard de importação — devolve cabeçalhos +
// amostra para a UI montar o mapeamento de colunas, sem validar nada ainda.
function parseImportPreview(csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length) throw fail("O arquivo está vazio.");
  if (rows.length - 1 > CSV_MAX_ROWS) throw fail(`O arquivo tem mais de ${CSV_MAX_ROWS} linhas — divida em arquivos menores.`);
  const [header, ...dataRows] = rows;
  return { headers: header.map((cell) => String(cell || "").trim()), sampleRows: dataRows.slice(0, 5), totalRows: dataRows.length };
}

function applyMapping(row, headers, mapping) {
  const record = {};
  for (const [field, columnIndex] of Object.entries(mapping || {})) {
    if (!CAMPAIGN_IMPORT_FIELDS.includes(field)) continue;
    const index = Number(columnIndex);
    if (!Number.isInteger(index) || index < 0 || index >= headers.length) continue;
    record[field] = String(row[index] || "").trim();
  }
  return record;
}

// Núcleo de validação (item 7) — nunca grava nada; classifica cada linha em
// exatamente uma categoria e devolve os dados já normalizados para quem
// chamar decidir gravar (commitImport) ou só mostrar o resumo (validateImport).
async function classifyRows({ campaignId, csvText, mapping }, client = prisma) {
  const rows = parseCsv(csvText);
  const [header, ...dataRows] = rows;
  if (!header) throw fail("O arquivo está vazio.");
  if (dataRows.length > CSV_MAX_ROWS) throw fail(`O arquivo tem mais de ${CSV_MAX_ROWS} linhas — divida em arquivos menores.`);

  const existing = await client.campaignContact.findMany({ where: { campaignId }, select: { phone: true } });
  const existingPhones = new Set(existing.map((row) => row.phone));
  const { companyId } = await client.campaign.findUnique({ where: { id: campaignId }, select: { companyId: true } });

  const records = dataRows.map((row, index) => ({ index: index + 2, ...applyMapping(row, header, mapping) }));
  const candidatePhones = records.map((record) => normalizeCampaignPhone(record.phone)).filter(Boolean);
  const optedOutSet = await bulkOptedOutSet([...new Set(candidatePhones)], companyId, client);

  const seenInFile = new Set();
  const valid = [];
  const errors = [];
  let duplicateRows = 0; let optOutRows = 0; let alreadyInCampaignRows = 0; let noPhoneRows = 0; let invalidPhoneRows = 0;

  for (const record of records) {
    const rawPhone = record.phone;
    if (!rawPhone) { noPhoneRows += 1; errors.push({ row: record.index, reason: "SEM_TELEFONE" }); continue; }
    const phone = normalizeCampaignPhone(rawPhone);
    if (!phone) { invalidPhoneRows += 1; errors.push({ row: record.index, reason: "TELEFONE_INVALIDO", value: rawPhone }); continue; }
    if (seenInFile.has(phone)) { duplicateRows += 1; errors.push({ row: record.index, reason: "DUPLICADO_NO_ARQUIVO", value: phone }); continue; }
    seenInFile.add(phone);
    if (existingPhones.has(phone)) { alreadyInCampaignRows += 1; errors.push({ row: record.index, reason: "JA_NA_CAMPANHA", value: phone }); continue; }
    const optOut = optedOutSet.has(phone);
    if (optOut) optOutRows += 1;
    const source = CONTACT_SOURCES.includes((record.source || "").toUpperCase()) ? record.source.toUpperCase() : "MANUAL_IMPORT";
    valid.push({
      phone, firstName: record.firstName || null, fullName: record.fullName || null, email: record.email || null,
      companyName: record.companyName || null, document: record.document || null, city: record.city || null,
      state: record.state || null, source, tags: record.tags ? record.tags.split(/[;|]/).map((tag) => tag.trim()).filter(Boolean) : [],
      notes: record.notes || null, optOut, consentStatus: optOut ? "OPTED_OUT" : "UNKNOWN",
    });
  }

  return {
    totalRows: dataRows.length,
    validRows: valid.length,
    invalidRows: noPhoneRows + invalidPhoneRows,
    noPhoneRows, invalidPhoneRows, duplicateRows, optOutRows, alreadyInCampaignRows,
    valid, errors,
  };
}

// Item 7: preview de validação — nunca grava nada, só mostra os números e a
// lista de erros para download.
async function validateImport({ campaignId, csvText, mapping }, viewer) {
  const settings = await getCampaignSettings();
  if (!settings.allowImports) throw fail("Importação de contatos está desativada nas configurações globais.");
  await assertCampaign(campaignId, prisma, viewer);
  const result = await classifyRows({ campaignId, csvText, mapping });
  return { ...result, valid: undefined }; // preview nunca expõe os dados completos, só os números + erros
}

// Item 6/8: confirma a importação — revalida no servidor (nunca confia só na
// validação anterior do cliente) e grava só as linhas válidas, dentro do
// limite de destinatários da campanha (item 31).
async function commitImport({ campaignId, csvText, mapping, fileName }, actor) {
  const settings = await getCampaignSettings();
  if (!settings.allowImports) throw fail("Importação de contatos está desativada nas configurações globais.");
  const campaign = await assertCampaign(campaignId, prisma, actor);

  const result = await classifyRows({ campaignId, csvText, mapping });
  const currentCount = await prisma.campaignContact.count({ where: { campaignId: campaign.id } });
  if (currentCount + result.valid.length > settings.maxCampaignRecipients) {
    throw fail(`Esta importação ultrapassaria o limite de ${settings.maxCampaignRecipients} destinatários por campanha.`);
  }

  const created = await prisma.$transaction(async (transaction) => {
    if (result.valid.length) {
      await transaction.campaignContact.createMany({
        data: result.valid.map((contact) => ({ ...contact, campaignId: campaign.id })),
        skipDuplicates: true,
      });
    }
    return transaction.campaignImport.create({
      data: {
        campaignId: campaign.id, fileName: fileName || null,
        totalRows: result.totalRows, validRows: result.validRows, invalidRows: result.invalidRows,
        duplicateRows: result.duplicateRows + result.alreadyInCampaignRows, optOutRows: result.optOutRows,
        importedByUserId: actor.id,
      },
    });
  });

  await audit.recordAudit({
    actor, action: "CAMPAIGN_CONTACTS_IMPORTED", entityType: "CAMPAIGN", entityId: campaign.id,
    summary: `Importou ${result.validRows} contato(s) para a campanha "${campaign.name}"`,
    details: { fileName, totalRows: result.totalRows, validRows: result.validRows, invalidRows: result.invalidRows },
  });

  return { import: created, ...result, valid: undefined };
}

module.exports = { classifyRows, commitImport, parseImportPreview, validateImport };
