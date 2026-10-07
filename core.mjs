export const RATES = Array.from({length: 11}, (_, index) => 1 + index / 4);
export const MAX_BOOK_BYTES = 512 * 1024 * 1024;

export function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function validateBook(value) {
  const fail = () => { throw new Error('このアプリ用の再生ファイルではありません。'); };
  if (!value || value.schema_version !== 2 || !/^[a-f0-9]{64}$/.test(value.book_id)
      || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 500
      || !Array.isArray(value.chapters) || !value.chapters.length || value.chapters.length > 1000) fail();
  const ids = new Set(), paths = new Set();
  let bytes = 0;
  for (const [index, chapter] of value.chapters.entries()) {
    const audio = chapter?.audio;
    if (!chapter || !/^[A-Za-z0-9_-]+$/.test(chapter.id) || ids.has(chapter.id) || chapter.order !== index + 1
        || typeof chapter.title !== 'string' || !chapter.title.trim() || chapter.title.length > 500
        || !audio || !/^chapters\/[0-9]+\.(mp3|m4a)$/.test(audio.file) || paths.has(audio.file)
        || !Number.isFinite(audio.seconds) || audio.seconds <= 0
        || !Number.isSafeInteger(audio.bytes) || audio.bytes <= 0 || !/^[a-f0-9]{64}$/.test(audio.sha256)) fail();
    ids.add(chapter.id); paths.add(audio.file); bytes += audio.bytes;
  }
  if (bytes > MAX_BOOK_BYTES) throw new Error('1冊の容量は512MBまでです。章ごとに分けてください。');
  return value;
}

export function resolveProgress(book, saved = {}) {
  if (!saved || typeof saved !== 'object') saved = {};
  let index = book.chapters.findIndex(chapter => chapter.id === saved.chapter_id);
  const found = index >= 0;
  if (!found) index = 0;
  return {index, seconds: Math.max(0, Math.min(found && Number.isFinite(saved.seconds) ? saved.seconds : 0,
          book.chapters[index].audio.seconds)), rate: RATES.includes(saved.rate) ? saved.rate : 1};
}

const CRC_TABLE = Uint32Array.from({length: 256}, (_, number) => {
  let crc = number;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

export async function crc32(blob) {
  let crc = 0xffffffff;
  for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
    const data = new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer());
    for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function readBundle(file) {
  if (file.size > MAX_BOOK_BYTES + 2 * 1024 * 1024 || file.size < 22) throw new Error('再生用ZIPの容量を確認してください。');
  const tailStart = Math.max(0, file.size - 65557);
  const tail = new DataView(await file.slice(tailStart).arrayBuffer());
  let end = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50 && i + 22 + tail.getUint16(i + 20, true) === tail.byteLength) { end = i; break; }
  }
  if (end < 0) throw new Error('ZIPの末尾を読み取れません。');
  const count = tail.getUint16(end + 10, true), size = tail.getUint32(end + 12, true), offset = tail.getUint32(end + 16, true);
  if (tail.getUint16(end + 4, true) || tail.getUint16(end + 6, true) || tail.getUint16(end + 8, true) !== count
      || !count || count > 1001 || size > 1024 * 1024 || offset + size !== tailStart + end) throw new Error('対応していないZIP形式です。');
  const directory = new DataView(await file.slice(offset, offset + size).arrayBuffer());
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const entries = new Map(), spans = [];
  let cursor = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > size || directory.getUint32(cursor, true) !== 0x02014b50) throw new Error('ZIPの一覧が壊れています。');
    const flags = directory.getUint16(cursor + 8, true), method = directory.getUint16(cursor + 10, true);
    const crc = directory.getUint32(cursor + 16, true), length = directory.getUint32(cursor + 24, true);
    const nameSize = directory.getUint16(cursor + 28, true), extraSize = directory.getUint16(cursor + 30, true), commentSize = directory.getUint16(cursor + 32, true);
    const local = directory.getUint32(cursor + 42, true);
    if (cursor + 46 + nameSize + extraSize + commentSize > size) throw new Error('ZIPの名前が壊れています。');
    const name = decoder.decode(new Uint8Array(directory.buffer, cursor + 46, nameSize));
    if ((flags & 1) || method !== 0 || directory.getUint32(cursor + 20, true) !== length
        || entries.has(name) || (name !== 'manifest.json' && !/^chapters\/[0-9]+\.(mp3|m4a)$/.test(name))
        || directory.getUint16(cursor + 34, true) !== 0 || local + 30 > offset
        || ((directory.getUint32(cursor + 38, true) >>> 16) & 0xf000) === 0xa000) throw new Error('このアプリのpackで作ったZIPを選んでください。');
    const header = new DataView(await file.slice(local, local + 30).arrayBuffer());
    if (header.getUint32(0, true) !== 0x04034b50 || header.getUint16(8, true) !== method || header.getUint16(6, true) !== flags) throw new Error('ZIPの内容が一覧と一致しません。');
    const localNameSize = header.getUint16(26, true), dataStart = local + 30 + localNameSize + header.getUint16(28, true);
    const localName = decoder.decode(await file.slice(local + 30, local + 30 + localNameSize).arrayBuffer());
    if (localName !== name || dataStart + length > offset || (name === 'manifest.json' && length > 1024 * 1024)) throw new Error('ZIP内の範囲が不正です。');
    const blob = file.slice(dataStart, dataStart + length, name.endsWith('.mp3') ? 'audio/mpeg' : name.endsWith('.m4a') ? 'audio/mp4' : 'application/json');
    if (await crc32(blob) !== crc) throw new Error('ファイルが破損しています。もう一度コピーしてください。');
    entries.set(name, blob); spans.push([local, dataStart + length]);
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  spans.sort((a, b) => a[0] - b[0]);
  if (cursor !== size || spans.some((span, index) => index && spans[index - 1][1] > span[0])) throw new Error('ZIP内の範囲が重複しています。');
  if (!entries.has('manifest.json')) throw new Error('章の一覧が入っていません。');
  const book = validateBook(JSON.parse(await entries.get('manifest.json').text()));
  if (entries.size !== book.chapters.length + 1) throw new Error('章数と音声の数が一致しません。');
  const audios = [];
  for (const chapter of book.chapters) {
    const blob = entries.get(chapter.audio.file);
    if (!blob || blob.size !== chapter.audio.bytes) throw new Error('章の音声が足りません。');
    if (globalThis.crypto?.subtle) {
      const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (actual !== chapter.audio.sha256) throw new Error('章の音声と記録が一致しません。');
    }
    audios.push({book_id: book.book_id, chapter_id: chapter.id, sha256: chapter.audio.sha256, blob});
  }
  return {book, audios};
}
