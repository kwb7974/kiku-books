import {MAX_CHUNK_CHARS} from './text-limits.mjs';

export const RATES = Array.from({length: 11}, (_, index) => 1 + index / 4);
export const MAX_BOOK_BYTES = 512 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

export function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function validateBook(value) {
  const fail = () => { throw new Error('このアプリ用の再生ファイルではありません。'); };
  if (!value || ![2, 3].includes(value.schema_version) || !/^[a-f0-9]{64}$/.test(value.book_id)
      || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 500
      || !Array.isArray(value.chapters) || !value.chapters.length || value.chapters.length > 1000) fail();
  if ('vault_book_id' in value && (typeof value.vault_book_id !== 'string' || !value.vault_book_id.trim())) fail();
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
    if ('text_cues' in chapter) {
      if (!Array.isArray(chapter.text_cues) || !chapter.text_cues.length) fail();
      let previous = 0;
      for (const cue of chapter.text_cues) {
        if (!cue || !Number.isFinite(cue.start_seconds) || !Number.isFinite(cue.end_seconds)
            || cue.start_seconds !== previous || cue.end_seconds <= previous || cue.end_seconds > audio.seconds + .2
            || typeof cue.text !== 'string' || !cue.text.trim() || Array.from(cue.text).length > MAX_CHUNK_CHARS) fail();
        previous = cue.end_seconds;
      }
      if (Math.abs(previous - audio.seconds) > .2) fail();
    }
  }
  if (bytes > MAX_BOOK_BYTES) throw new Error('1冊の容量は512MBまでです。章ごとに分けてください。');
  if (value.schema_version === 3) validateToc(value.toc, value.chapters.map(c => c.id));
  return value;
}

export function validateToc(toc, chapterIds) {
  const seen = new Set(), audio = [];
  const fail = () => { throw new Error('目次の階層と音声項目が一致しません。'); };
  function walk(nodes, depth) {
    if (!Array.isArray(nodes) || !nodes.length || depth > 32) fail();
    for (const node of nodes) {
      if (!node || typeof node.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(node.id) || seen.has(node.id)
          || seen.size >= 2000 || typeof node.title !== 'string' || !node.title.trim() || node.title.length > 500) fail();
      seen.add(node.id);
      if ('chapter_id' in node) {
        if (!chapterIds.includes(node.chapter_id)) fail();
        audio.push(node.chapter_id);
      }
      if ('children' in node) walk(node.children, depth + 1);
      else if (!('chapter_id' in node)) fail();
    }
  }
  walk(toc, 1);
  if (audio.length !== chapterIds.length || audio.some((id, i) => id !== chapterIds[i])) fail();
}

export function bookToc(book) {
  return book.schema_version === 3 ? book.toc : book.chapters.map(c => ({id: c.id, title: c.title, chapter_id: c.id}));
}

export function currentCueIndex(chapter, seconds) {
  const cues = chapter?.text_cues;
  if (!cues?.length || !Number.isFinite(seconds) || seconds < 0 || seconds > chapter.audio.seconds + .2) return -1;
  let low = 0, high = cues.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (cues[middle].start_seconds <= seconds) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

export function tocAncestors(nodes, chapterId, path = []) {
  for (const node of nodes) {
    if (node.chapter_id === chapterId) return node.children ? [...path, node.id] : path;
    if (node.children) {
      const found = tocAncestors(node.children, chapterId, [...path, node.id]);
      if (found) return found;
    }
  }
  return null;
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
  if (file.size > MAX_BOOK_BYTES + MAX_MANIFEST_BYTES + 2 * 1024 * 1024 || file.size < 22) throw new Error('再生用ZIPの容量を確認してください。');
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
    if (localName !== name || dataStart + length > offset || (name === 'manifest.json' && length > MAX_MANIFEST_BYTES)) throw new Error('ZIP内の範囲が不正です。');
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

export function currentText(chapter, seconds) {
  return chapter?.text_cues?.[currentCueIndex(chapter, seconds)]?.text || '';
}

export function hasClips(book) {
  return Boolean(book?.chapters.some(chapter => chapter.text_cues?.length));
}

export function makeClip(chapter, seconds, id = clipId(), created_at = new Date().toISOString()) {
  const cue_index = currentCueIndex(chapter, seconds);
  if (cue_index < 0) throw new Error('保存する区間がありません。');
  return {id, created_at, chapter_id: chapter.id, cue_index, ...chapter.text_cues[cue_index]};
}

export function clipExport(book, clips, exported_at = new Date().toISOString()) {
  if (!book.vault_book_id) throw new Error('本のIDがないため、Macへ送れません。');
  return {schema_version: 1, vault_book_id: book.vault_book_id, book_id: book.book_id,
    title: book.title, exported_at, clips: clips.map(({id, created_at, chapter_id, cue_index, start_seconds, end_seconds, text}) =>
      ({id, created_at, chapter_id, cue_index, start_seconds, end_seconds, text}))};
}

export function clipFilename(data) {
  return `clips-${encodeURIComponent(data.vault_book_id)}-${data.exported_at.replace(/[:.]/g, '-')}.json`;
}

export function clipPlace(book, chapterId) {
  function walk(nodes, titles = []) {
    for (const node of nodes) {
      const path = [...titles, node.title];
      if (node.chapter_id === chapterId) return path.join(' › ');
      const found = node.children && walk(node.children, path);
      if (found) return found;
    }
  }
  return walk(bookToc(book)) || chapterId;
}

function clipId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
