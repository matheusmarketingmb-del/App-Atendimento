// Normalização de áudio enviado pela Central (gravação do navegador ou
// arquivo escolhido pelo atendente) para um formato que a WhatsApp Cloud API
// aceita. Formatos aceitos pela Meta para mensagens "audio" (máx. 16 MB):
// audio/aac, audio/amr, audio/mpeg, audio/mp4 e audio/ogg — este último
// SOMENTE com codec Opus. O tipo real é sempre decidido pelo CONTEÚDO
// (assinatura binária), nunca só pelo Content-Type/extensão declarados.
//
// O Chrome/Edge gravam via MediaRecorder em WebM/Opus, que a Meta não aceita.
// Como a imagem Docker não tem ffmpeg, fazemos um REMUX (sem recodificar):
// os pacotes Opus saem do contêiner WebM (Matroska) e vão para um contêiner
// Ogg — mesmo áudio, zero perda, sem dependência externa. Firefox já grava
// em Ogg/Opus e o Safari em MP4/AAC; ambos passam direto.
const MAX_AUDIO_DURATION_MS = 10 * 60 * 1000;
const OPUS_SAMPLE_RATE = 48000;
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_AUDIO_RECORDS = 60000;
const MAX_WEBM_ELEMENTS = 200000;

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// ---------- Detecção por assinatura ----------

function startsWith(buffer, bytes, offset = 0) {
  if (buffer.length < offset + bytes.length) return false;
  for (let index = 0; index < bytes.length; index += 1) {
    if (buffer[offset + index] !== bytes[index]) return false;
  }
  return true;
}

function ascii(text) { return [...text].map((char) => char.charCodeAt(0)); }

// Retorna o MIME real do contêiner/codec ou null quando não reconhecido.
function detectAudioFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (startsWith(buffer, ascii("OggS"))) return "audio/ogg";
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return "audio/webm";
  if (startsWith(buffer, ascii("ftyp"), 4)) return "audio/mp4";
  if (startsWith(buffer, ascii("#!AMR"))) return "audio/amr";
  if (startsWith(buffer, ascii("ID3"))) return "audio/mpeg";
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    // Frame sync: layer 00 = ADTS (AAC); demais layers = MPEG áudio (MP3).
    return (buffer[1] & 0x06) === 0 ? "audio/aac" : "audio/mpeg";
  }
  return null;
}

// ---------- Ogg ----------

const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 0x80000000) ? ((value << 1) ^ 0x04c11db7) : (value << 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

// CRC do Ogg (libogg): polinômio 0x04C11DB7, sem reflexão, init 0, sem XOR final.
function oggCrc(bytes) {
  let crc = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) & 0xff) ^ bytes[index]]) >>> 0;
  }
  return crc;
}

function lacingValues(length) {
  const values = new Array(Math.floor(length / 255)).fill(255);
  values.push(length % 255);
  return values;
}

function oggPage({ packets, granule, serial, sequence, headerType }) {
  const segments = packets.flatMap((packet) => lacingValues(packet.length));
  const header = Buffer.alloc(27 + segments.length);
  header.write("OggS", 0, "ascii");
  header[4] = 0;
  header[5] = headerType;
  header.writeBigUInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(sequence, 18);
  header.writeUInt32LE(0, 22);
  header[26] = segments.length;
  segments.forEach((value, index) => { header[27 + index] = value; });
  const page = Buffer.concat([header, ...packets]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

// Lê as páginas de um Ogg e devolve os pacotes do primeiro stream lógico.
function readOggPages(buffer) {
  const pages = [];
  let offset = 0;
  while (offset + 27 <= buffer.length) {
    if (pages.length >= MAX_AUDIO_RECORDS) throw fail("Arquivo Ogg com estrutura excessiva.");
    if (!startsWith(buffer, ascii("OggS"), offset)) throw fail("Arquivo Ogg corrompido.");
    const segmentCount = buffer[offset + 26];
    const tableEnd = offset + 27 + segmentCount;
    if (tableEnd > buffer.length) throw fail("Arquivo Ogg corrompido.");
    const segments = [...buffer.subarray(offset + 27, tableEnd)];
    const bodyLength = segments.reduce((sum, value) => sum + value, 0);
    if (tableEnd + bodyLength > buffer.length) throw fail("Arquivo Ogg corrompido.");
    pages.push({
      headerType: buffer[offset + 5],
      granule: buffer.readBigUInt64LE(offset + 6),
      crc: buffer.readUInt32LE(offset + 22),
      segments,
      body: buffer.subarray(tableEnd, tableEnd + bodyLength),
      raw: buffer.subarray(offset, tableEnd + bodyLength),
    });
    offset = tableEnd + bodyLength;
  }
  if (!pages.length) throw fail("Arquivo Ogg vazio.");
  return pages;
}

function opusPreSkip(opusHead) {
  return opusHead.length >= 12 ? opusHead.readUInt16LE(10) : 0;
}

// Valida que o Ogg é Opus (a Meta recusa Ogg/Vorbis) e calcula a duração
// pela granule position da última página (amostras a 48 kHz − pre-skip).
function inspectOggOpus(buffer) {
  const pages = readOggPages(buffer);
  const first = pages[0];
  if (!startsWith(first.body, ascii("OpusHead"))) {
    throw fail("Áudio OGG precisa usar o codec Opus (o WhatsApp não aceita OGG/Vorbis).");
  }
  const preSkip = opusPreSkip(first.body);
  const lastGranule = pages.reduce((max, page) => (
    page.granule !== 0xffffffffffffffffn && page.granule > max ? page.granule : max
  ), 0n);
  const samples = Number(lastGranule) - preSkip;
  return { durationMs: samples > 0 ? Math.round((samples / OPUS_SAMPLE_RATE) * 1000) : null };
}

// ---------- WebM (Matroska) → Ogg/Opus ----------

const EBML_IDS = Object.freeze({
  SEGMENT: 0x18538067, CLUSTER: 0x1f43b675, TRACKS: 0x1654ae6b, TRACK_ENTRY: 0xae,
  BLOCK_GROUP: 0xa0, AUDIO: 0xe1, TRACK_NUMBER: 0xd7, TRACK_TYPE: 0x83, CODEC_ID: 0x86,
  CODEC_PRIVATE: 0x63a2, CHANNELS: 0x9f, SIMPLE_BLOCK: 0xa3, BLOCK: 0xa1,
});
// Elementos-contêiner: o parser "desce" neles em vez de pular — é o que
// permite ler o WebM "ao vivo" do MediaRecorder, que grava Segment e
// Cluster com tamanho desconhecido.
const EBML_MASTERS = new Set([
  EBML_IDS.SEGMENT, EBML_IDS.CLUSTER, EBML_IDS.TRACKS, EBML_IDS.TRACK_ENTRY,
  EBML_IDS.BLOCK_GROUP, EBML_IDS.AUDIO,
]);

function readVint(buffer, offset, { keepMarker }) {
  const first = buffer[offset];
  if (first === undefined || first === 0) throw fail("Arquivo WebM corrompido.");
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1;
  if (offset + length > buffer.length) throw fail("Arquivo WebM corrompido.");
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + buffer[offset + index];
    if (buffer[offset + index] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function readUnsigned(bytes) {
  if (bytes.length > 8) throw fail("Campo numérico WebM inválido.");
  return [...bytes].reduce((value, byte) => value * 256 + byte, 0);
}

// Número de amostras (48 kHz) de um pacote Opus, a partir do byte TOC (RFC 6716 §3.1).
function opusPacketSamples(packet) {
  if (!packet.length) return 0;
  const toc = packet[0];
  const config = toc >> 3;
  let frameSamples;
  if (config < 12) frameSamples = [480, 960, 1920, 2880][config % 4];
  else if (config < 16) frameSamples = [480, 960][config % 2];
  else frameSamples = [120, 240, 480, 960][config % 4];
  const code = toc & 0x03;
  const frames = code === 0 ? 1 : (code === 3 ? (packet[1] || 0) & 0x3f : 2);
  return frameSamples * frames;
}

function parseWebmOpus(buffer) {
  const tracks = new Map();
  let currentTrack = null;
  const blocks = [];
  let offset = 0;
  let elementCount = 0;
  while (offset < buffer.length) {
    if (++elementCount > MAX_WEBM_ELEMENTS) throw fail("Arquivo WebM com estrutura excessiva.");
    const id = readVint(buffer, offset, { keepMarker: true });
    const size = readVint(buffer, offset + id.length, { keepMarker: false });
    const dataStart = offset + id.length + size.length;
    if (EBML_MASTERS.has(id.value)) {
      if (id.value === EBML_IDS.TRACK_ENTRY) {
        if (tracks.size >= 16) throw fail("Arquivo WebM com faixas excessivas.");
        currentTrack = { number: null, type: null, codecId: null, codecPrivate: null, channels: 1 };
        tracks.set(currentTrack, currentTrack);
      }
      offset = dataStart;
      continue;
    }
    if (size.unknown) throw fail("Arquivo WebM com estrutura não suportada.");
    const dataEnd = dataStart + size.value;
    // Gravação interrompida pode deixar o último elemento truncado: o que
    // veio antes continua válido.
    if (dataEnd > buffer.length) break;
    const data = buffer.subarray(dataStart, dataEnd);
    if (currentTrack && id.value === EBML_IDS.TRACK_NUMBER) currentTrack.number = readUnsigned(data);
    else if (currentTrack && id.value === EBML_IDS.TRACK_TYPE) currentTrack.type = readUnsigned(data);
    else if (currentTrack && id.value === EBML_IDS.CODEC_ID) currentTrack.codecId = data.toString("ascii");
    else if (currentTrack && id.value === EBML_IDS.CODEC_PRIVATE) currentTrack.codecPrivate = Buffer.from(data);
    else if (currentTrack && id.value === EBML_IDS.CHANNELS) currentTrack.channels = readUnsigned(data) || 1;
    else if (id.value === EBML_IDS.SIMPLE_BLOCK || id.value === EBML_IDS.BLOCK) {
      if (blocks.length >= MAX_AUDIO_RECORDS) throw fail("Arquivo WebM com blocos excessivos.");
      const track = readVint(data, 0, { keepMarker: false });
      const flags = data[track.length + 2];
      if ((flags >> 1) & 0x03) throw fail("Arquivo WebM com lacing não suportado.");
      blocks.push({ track: track.value, payload: Buffer.from(data.subarray(track.length + 3)) });
    }
    offset = dataEnd;
  }
  const opusTrack = [...tracks.values()].find((track) => track.codecId === "A_OPUS");
  if (!opusTrack) throw fail("O áudio WebM precisa usar o codec Opus.");
  const packets = blocks.filter((block) => block.track === opusTrack.number && block.payload.length).map((block) => block.payload);
  if (!packets.length) throw fail("A gravação não contém áudio.");
  return { track: opusTrack, packets };
}

function defaultOpusHead(channels) {
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "ascii");
  head[8] = 1;
  head[9] = Math.min(Math.max(channels, 1), 2);
  head.writeUInt16LE(0, 10);
  head.writeUInt32LE(OPUS_SAMPLE_RATE, 12);
  head.writeInt16LE(0, 16);
  head[18] = 0;
  return head;
}

function opusTags() {
  const vendor = Buffer.from("Mibro Central", "utf8");
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write("OpusTags", 0, "ascii");
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length);
  return tags;
}

function webmToOggOpus(buffer, { serial = 0x4d696272 } = {}) {
  const { track, packets } = parseWebmOpus(buffer);
  const head = track.codecPrivate && startsWith(track.codecPrivate, ascii("OpusHead"))
    ? track.codecPrivate : defaultOpusHead(track.channels);
  const pages = [];
  let sequence = 0;
  pages.push(oggPage({ packets: [head], granule: 0, serial, sequence: sequence++, headerType: 0x02 }));
  pages.push(oggPage({ packets: [opusTags()], granule: 0, serial, sequence: sequence++, headerType: 0x00 }));
  let granule = 0;
  let pending = [];
  let pendingSegments = 0;
  const flush = (last) => {
    pages.push(oggPage({ packets: pending, granule, serial, sequence: sequence++, headerType: last ? 0x04 : 0x00 }));
    pending = [];
    pendingSegments = 0;
  };
  packets.forEach((packet, index) => {
    const segments = Math.floor(packet.length / 255) + 1;
    if (pending.length && pendingSegments + segments > 255) flush(false);
    pending.push(packet);
    pendingSegments += segments;
    granule += opusPacketSamples(packet);
    if (index === packets.length - 1) flush(true);
  });
  const output = Buffer.concat(pages);
  const samples = granule - opusPreSkip(head);
  return { buffer: output, durationMs: samples > 0 ? Math.round((samples / OPUS_SAMPLE_RATE) * 1000) : null };
}

// ---------- Ponto de entrada ----------

const EXTENSION_BY_MIME = Object.freeze({
  "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/mpeg": ".mp3", "audio/aac": ".aac", "audio/amr": ".amr",
});

function normalizedFileName(fileName, mimeType) {
  const base = String(fileName || "audio").replace(/\.[a-z0-9]{1,5}$/i, "").trim() || "audio";
  return `${base}${EXTENSION_BY_MIME[mimeType]}`;
}

function clampDuration(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

// Recebe o buffer enviado e devolve { buffer, mimeType, fileName, durationMs }
// prontos para o storage e para a Meta. `declaredDurationMs` (medido pelo
// navegador) só é usado quando o contêiner não permite calcular a duração.
function normalizeOutgoingAudio({ buffer, fileName, declaredDurationMs }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw fail("O áudio está vazio.");
  if (buffer.length > MAX_AUDIO_BYTES) throw fail("O áudio deve ter no máximo 16 MB.", 413);
  const detected = detectAudioFormat(buffer);
  if (!detected) {
    throw fail("Formato de áudio não suportado. Use OGG (Opus), MP3, M4A/MP4, AAC ou AMR.");
  }
  let result;
  if (detected === "audio/webm") {
    const converted = webmToOggOpus(buffer);
    result = { buffer: converted.buffer, mimeType: "audio/ogg", durationMs: converted.durationMs };
  } else if (detected === "audio/ogg") {
    result = { buffer, mimeType: "audio/ogg", durationMs: inspectOggOpus(buffer).durationMs };
  } else {
    result = { buffer, mimeType: detected, durationMs: null };
  }
  result.durationMs = result.durationMs ?? clampDuration(declaredDurationMs);
  if (result.durationMs && result.durationMs > MAX_AUDIO_DURATION_MS) {
    throw fail("O áudio deve ter no máximo 10 minutos.");
  }
  result.fileName = normalizedFileName(fileName, result.mimeType);
  return result;
}

module.exports = {
  MAX_AUDIO_DURATION_MS, detectAudioFormat, inspectOggOpus, normalizeOutgoingAudio, oggCrc,
  opusPacketSamples, readOggPages, webmToOggOpus,
};
