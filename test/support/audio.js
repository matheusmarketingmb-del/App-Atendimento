// WebM/Opus mínimo no formato do Chrome (≈1 s), aceito pelo remux de áudio
// (mesma construção de test/audio-quick-replies.test.js).
function webmSample(packetCount = 50) {
  const vint = (n) => (n < 0x7f ? Buffer.from([0x80 | n]) : Buffer.from([0x40 | (n >> 8), n & 0xff]));
  const id = (value) => { const bytes = []; for (let v = value; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff); return Buffer.from(bytes); };
  const el = (i, data) => Buffer.concat([id(i), vint(data.length), data]);
  const unknown = (i) => Buffer.concat([id(i), Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])]);
  const head = Buffer.alloc(19); head.write("OpusHead"); head[8] = 1; head[9] = 1; head.writeUInt32LE(48000, 12);
  const track = el(0xae, Buffer.concat([el(0xd7, Buffer.from([1])), el(0x86, Buffer.from("A_OPUS")), el(0x63a2, head)]));
  const blocks = Array.from({ length: packetCount }, (_, i) => el(0xa3, Buffer.concat([Buffer.from([0x81, 0, i & 0xff, 0x80, 0xf8]), Buffer.alloc(30, i)])));
  return Buffer.concat([el(0x1a45dfa3, el(0x4282, Buffer.from("webm"))), unknown(0x18538067), el(0x1654ae6b, track), unknown(0x1f43b675), ...blocks]);
}

module.exports = { webmSample };
