// Parser/serializador de CSV mínimo e dependência-zero (o projeto não tinha
// nenhuma lib de CSV/XLSX instalada — ver relatório final sobre o corte de
// escopo do XLSX). Suporta campos entre aspas com vírgula/quebra de linha/
// aspas escapadas ("") — RFC 4180 o suficiente para import/export de contatos.
// Excel em pt-BR exporta CSV com ";" — detecta pelo cabeçalho (fora de aspas).
function detectCsvDelimiter(text) {
  const firstLine = String(text || "").split(/\r?\n/, 1)[0].replace(/"[^"]*"/g, "");
  const count = (char) => firstLine.split(char).length - 1;
  return count(";") > count(",") ? ";" : count("\t") > count(",") ? "\t" : ",";
}

function parseCsv(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const source = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') { inQuotes = true; continue; }
    if (char === delimiter) { row.push(field); field = ""; continue; }
    if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += char;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((line) => line.some((cell) => String(cell || "").trim().length));
}

// Item 28: previne CSV formula injection — qualquer campo que comece com
// =, +, -, @ (ou tab/CR) ganha um apóstrofo na frente antes de ser escrito,
// exatamente como recomendado pelo OWASP, para o Excel nunca interpretar
// como fórmula.
function sanitizeCsvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  const dangerous = /^[=+\-@\t\r]/.test(text);
  const safe = dangerous ? `'${text}` : text;
  if (/[",\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

function toCsv(headers, rows) {
  const lines = [headers.map(sanitizeCsvCell).join(",")];
  for (const row of rows) lines.push(headers.map((header) => sanitizeCsvCell(row[header])).join(","));
  return lines.join("\r\n");
}

module.exports = { detectCsvDelimiter, parseCsv, sanitizeCsvCell, toCsv };
