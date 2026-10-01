const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_AUDIO_DURATION_MS, detectAudioFormat, inspectOggOpus, normalizeOutgoingAudio, oggCrc,
  opusPacketSamples, readOggPages, webmToOggOpus,
} = require("../src/services/audio-normalization-service");

// ---- Construtor mínimo de WebM (EBML), igual ao que o MediaRecorder do
// Chrome produz: Segment e Cluster com tamanho DESCONHECIDO ("ao vivo"). ----
function vintSize(length) {
  if (length < 0x7f) return Buffer.from([0x80 | length]);
  if (length < 0x3fff) return Buffer.from([0x40 | (length >> 8), length & 0xff]);
  return Buffer.from([0x10 | ((length >> 24) & 0x0f), (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
}
function idBytes(id) {
  const bytes = [];
  for (let value = id; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
  return Buffer.from(bytes);
}
const element = (id, data) => Buffer.concat([idBytes(id), vintSize(data.length), data]);
const unknownSize = (id) => Buffer.concat([idBytes(id), Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])]);
const uint = (value) => Buffer.from([value]);

function opusHead({ channels = 1, preSkip = 312 } = {}) {
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "ascii"); head[8] = 1; head[9] = channels;
  head.writeUInt16LE(preSkip, 10); head.writeUInt32LE(48000, 12);
  return head;
}

// Pacote Opus CELT 20 ms (config 31, code 0) = 960 amostras.
const opusPacket = (index) => Buffer.concat([Buffer.from([0xf8]), Buffer.alloc(40, index & 0xff)]);

function buildWebm({ packetCount = 50, codecId = "A_OPUS", withCodecPrivate = true } = {}) {
  const trackEntry = element(0xae, Buffer.concat([
    element(0xd7, uint(1)), element(0x83, uint(2)), element(0x86, Buffer.from(codecId, "ascii")),
    ...(withCodecPrivate ? [element(0x63a2, opusHead())] : []),
    element(0xe1, element(0x9f, uint(1))),
  ]));
  const blocks = Array.from({ length: packetCount }, (_, index) => element(0xa3, Buffer.concat([
    Buffer.from([0x81]), Buffer.from([0x00, index & 0xff]), Buffer.from([0x80]), opusPacket(index),
  ])));
  return Buffer.concat([
    element(0x1a45dfa3, element(0x4282, Buffer.from("webm", "ascii"))),
    unknownSize(0x18538067),
    element(0x1654ae6b, trackEntry),
    unknownSize(0x1f43b675),
    element(0xe7, uint(0)),
    ...blocks,
  ]);
}

test("detecta o formato real pelo conteúdo, não pelo nome/tipo declarado", () => {
  assert.equal(detectAudioFormat(Buffer.from("OggS\0\0\0\0")), "audio/ogg");
  assert.equal(detectAudioFormat(buildWebm()), "audio/webm");
  assert.equal(detectAudioFormat(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A ")])), "audio/mp4");
  assert.equal(detectAudioFormat(Buffer.from("#!AMR\n....")), "audio/amr");
  assert.equal(detectAudioFormat(Buffer.from("ID3\x04\0\0\0\0")), "audio/mpeg");
  assert.equal(detectAudioFormat(Buffer.from([0xff, 0xfb, 0x90, 0x00])), "audio/mpeg");
  assert.equal(detectAudioFormat(Buffer.from([0xff, 0xf1, 0x50, 0x80])), "audio/aac");
  assert.equal(detectAudioFormat(Buffer.from("%PDF-1.7")), null);
  assert.equal(detectAudioFormat(Buffer.from([0x4d, 0x5a, 0x90, 0x00])), null);
});

test("CRC do Ogg segue a libogg (polinômio 0x04C11DB7, sem reflexão)", () => {
  assert.equal(oggCrc(Buffer.alloc(0)), 0);
  assert.equal(oggCrc(Buffer.from([0x01])), 0x04c11db7);
});

test("amostras por pacote Opus vêm do byte TOC", () => {
  assert.equal(opusPacketSamples(Buffer.from([0xf8])), 960);        // CELT 20 ms
  assert.equal(opusPacketSamples(Buffer.from([0x08])), 960);        // SILK 20 ms (config 1)
  assert.equal(opusPacketSamples(Buffer.from([0xf9])), 1920);       // 2 frames de 20 ms
  assert.equal(opusPacketSamples(Buffer.from([0xfb, 0x03])), 2880); // code 3, 3 frames
});

test("WebM/Opus do Chrome vira Ogg/Opus válido sem recodificar (remux)", () => {
  const { buffer, durationMs } = webmToOggOpus(buildWebm({ packetCount: 50 }));
  const pages = readOggPages(buffer);
  assert.equal(pages[0].headerType, 0x02, "primeira página é BOS");
  assert.ok(pages[0].body.subarray(0, 8).equals(Buffer.from("OpusHead")));
  assert.ok(pages[1].body.subarray(0, 8).equals(Buffer.from("OpusTags")));
  assert.equal(pages.at(-1).headerType & 0x04, 0x04, "última página é EOS");
  for (const page of pages) {
    const copy = Buffer.from(page.raw); copy.writeUInt32LE(0, 22);
    assert.equal(oggCrc(copy), page.crc, "CRC de cada página confere");
  }
  // 50 pacotes × 960 amostras = 48000; menos pre-skip 312 → 993 ms.
  assert.equal(pages.at(-1).granule, 48000n);
  assert.equal(durationMs, Math.round(((48000 - 312) / 48000) * 1000));
  // Os pacotes chegam intactos e na ordem.
  const audioBody = Buffer.concat(pages.slice(2).map((page) => page.body));
  assert.ok(audioBody.equals(Buffer.concat(Array.from({ length: 50 }, (_, index) => opusPacket(index)))));
  assert.deepEqual(inspectOggOpus(buffer), { durationMs });
});

test("muitos pacotes são distribuídos em várias páginas (máx. 255 segmentos)", () => {
  const { buffer } = webmToOggOpus(buildWebm({ packetCount: 600 }));
  const pages = readOggPages(buffer);
  assert.ok(pages.length > 4);
  assert.ok(pages.every((page) => page.segments.length <= 255));
  assert.equal(pages.at(-1).granule, BigInt(600 * 960));
  pages.slice(1).forEach((page, index) => assert.equal(page.raw.readUInt32LE(18), index + 1, "sequência contínua"));
});

test("WebM sem CodecPrivate ainda gera OpusHead válido", () => {
  const { buffer } = webmToOggOpus(buildWebm({ withCodecPrivate: false }));
  assert.ok(readOggPages(buffer)[0].body.subarray(0, 8).equals(Buffer.from("OpusHead")));
});

test("normalizeOutgoingAudio: webm → audio/ogg com nome .ogg; formato inválido é recusado", () => {
  const result = normalizeOutgoingAudio({ buffer: buildWebm(), fileName: "gravacao.webm", declaredDurationMs: 999999 });
  assert.equal(result.mimeType, "audio/ogg");
  assert.equal(result.fileName, "gravacao.ogg");
  assert.ok(result.durationMs < 2000, "duração calculada do conteúdo, não a declarada");

  assert.throws(() => normalizeOutgoingAudio({ buffer: Buffer.from("%PDF-1.7 não é áudio"), fileName: "x.mp3" }), /Formato de áudio não suportado/);
  assert.throws(() => normalizeOutgoingAudio({ buffer: Buffer.alloc(0), fileName: "x.ogg" }), /vazio/);
  assert.throws(() => webmToOggOpus(buildWebm({ codecId: "A_VORBIS" })), /codec Opus/);
});

test("Ogg/Vorbis é recusado (a Meta só aceita OGG com Opus)", () => {
  const vorbisHead = Buffer.concat([Buffer.from([0x01]), Buffer.from("vorbis"), Buffer.alloc(23)]);
  const header = Buffer.alloc(28);
  header.write("OggS", 0, "ascii"); header[5] = 0x02; header[26] = 1; header[27] = vorbisHead.length;
  assert.throws(() => normalizeOutgoingAudio({ buffer: Buffer.concat([header, vorbisHead]), fileName: "a.ogg" }), /Opus/);
});

test("MP3/M4A passam direto com a duração medida pelo navegador; duração excessiva é recusada", () => {
  const mp3 = Buffer.concat([Buffer.from("ID3\x04\0\0\0\0\0\0"), Buffer.alloc(64)]);
  const ok = normalizeOutgoingAudio({ buffer: mp3, fileName: "aviso.mp3", declaredDurationMs: "12000" });
  assert.equal(ok.mimeType, "audio/mpeg");
  assert.equal(ok.durationMs, 12000);
  assert.throws(
    () => normalizeOutgoingAudio({ buffer: mp3, fileName: "longo.mp3", declaredDurationMs: MAX_AUDIO_DURATION_MS + 1 }),
    /no máximo 10 minutos/,
  );
});
