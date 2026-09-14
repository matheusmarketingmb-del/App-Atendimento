// Detecção de arquivo suspeito/executável por CONTEÚDO (assinatura binária),
// nunca só pela extensão ou pelo Content-Type declarado pelo remetente —
// ambos são triviais de falsificar (um executável pode chegar com
// Content-Type "application/pdf"). Usado hoje pelo caminho que aceita
// QUALQUER tipo de arquivo (chat interno + mídia recebida de canais que não
// são o WhatsApp/Meta — ver media-storage-service.js#validateInternalFile);
// o WhatsApp/Meta já tem um allowlist estrito por MIME + assinatura
// (validateDocument/validateImage/...), este módulo é a segunda camada para
// onde esse allowlist não existe.
//
// Dois níveis:
//   - BLOQUEADO: executável/script nativo (Windows/Linux/macOS) ou extensão
//     de instalador/script — nunca é aceito, em nenhum canal.
//   - SUSPEITO: não é bloqueado (arquivo de dados legítimo em outros
//     contextos: JSON, planilha com macro, arquivo sem extensão/tipo
//     reconhecível) mas fica marcado para quem for abrir saber que merece
//     atenção antes de confiar no conteúdo.
const EXECUTABLE_EXTENSIONS = new Set([
  "exe", "dll", "com", "bat", "cmd", "scr", "ps1", "ps1xml", "psc1", "psd1", "msh", "msh1", "msh2",
  "vbs", "vbe", "js", "jse", "wsf", "wsh", "jar", "msi", "msp", "mst", "cpl", "hta", "reg",
  "apk", "ipa", "app", "dmg", "pkg", "deb", "rpm", "sh", "bin", "run", "out", "iso", "lnk",
  "gadget", "appimage", "action", "command", "workflow",
]);

// Extensões de dados legítimos que, por conterem macro/script embutido, só
// entram como SUSPEITO (nunca bloqueadas — recusar de propósito é decisão de
// quem administra o Bot/chat, não deste serviço).
const MACRO_ENABLED_EXTENSIONS = new Set(["docm", "xlsm", "pptm", "dotm", "xltm", "potm", "xlsb"]);

// Assinaturas binárias de executáveis nativos — checadas mesmo se a extensão
// do arquivo tiver sido trocada/removida (ex.: "fatura.pdf" que na verdade é
// um .exe renomeado).
const SIGNATURES = [
  { name: "PE (Windows .exe/.dll)", match: (b) => b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a },
  { name: "ELF (binário Linux)", match: (b) => b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46 },
  {
    name: "Mach-O (binário macOS)",
    match: (b) => b.length >= 4 && [
      [0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe],
      [0xca, 0xfe, 0xba, 0xbe],
    ].some((sig) => sig.every((byte, i) => b[i] === byte)),
  },
  { name: "script com shebang (#!)", match: (b) => b.length >= 2 && b[0] === 0x23 && b[1] === 0x21 },
];

function extensionOf(fileName) {
  const match = /\.([a-z0-9]+)$/i.exec(String(fileName || "").trim());
  return match ? match[1].toLowerCase() : "";
}

// Retorna { blocked, blockedReason, suspicious, suspiciousReason } — nunca
// lança: quem chama decide o que fazer (validateInternalFile lança 400
// quando blocked; outros usos futuros podem só logar/marcar).
function assessFileRisk({ buffer, mimeType, fileName }) {
  const ext = extensionOf(fileName);
  const safeBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.alloc(0);

  if (ext && EXECUTABLE_EXTENSIONS.has(ext)) {
    return {
      blocked: true, blockedReason: `Extensão de arquivo executável/script não permitida (.${ext}).`,
      suspicious: true, suspiciousReason: null,
    };
  }
  for (const signature of SIGNATURES) {
    if (signature.match(safeBuffer)) {
      return {
        blocked: true, blockedReason: `Conteúdo do arquivo identificado como ${signature.name}, independente da extensão/tipo informado.`,
        suspicious: true, suspiciousReason: null,
      };
    }
  }

  if (ext === "json") {
    return {
      blocked: false, blockedReason: null,
      suspicious: true, suspiciousReason: "Arquivo JSON — confira o conteúdo antes de usá-lo em outra ferramenta.",
    };
  }
  if (ext && MACRO_ENABLED_EXTENSIONS.has(ext)) {
    return {
      blocked: false, blockedReason: null,
      suspicious: true, suspiciousReason: "Documento de escritório com suporte a macro — não habilite macros sem confirmar a origem.",
    };
  }
  const normalizedMime = String(mimeType || "").split(";", 1)[0].trim().toLowerCase();
  if (!ext && (!normalizedMime || normalizedMime === "application/octet-stream")) {
    return {
      blocked: false, blockedReason: null,
      suspicious: true, suspiciousReason: "Tipo de arquivo não identificado (sem extensão nem Content-Type reconhecível).",
    };
  }

  return { blocked: false, blockedReason: null, suspicious: false, suspiciousReason: null };
}

module.exports = { assessFileRisk, EXECUTABLE_EXTENSIONS, MACRO_ENABLED_EXTENSIONS };
