import {RATES, formatTime, validateBook, resolveProgress, readBundle, bookToc, tocAncestors, currentCueIndex, hasClips, makeClip, clipExport, clipFilename, clipPlace} from './core.mjs';
import {listBooks, readAudio, storeBook, storeAudio, removeBook, listClips, changeClips} from './storage.mjs';
import {SERVER_LIBRARY} from './config.mjs';

const $ = id => document.getElementById(id);
const audio = $('audio');
for (const rate of RATES) {
  const option = document.createElement('option');
  option.value = String(rate); option.textContent = `${rate}倍`;
  $('speed').append(option);
}
audio.preservesPitch = true;
if ('audioSession' in navigator) {
  try { navigator.audioSession.type = 'playback'; } catch { /* 未対応のSafariでも通常のaudio要素を使う */ }
}
let books = [], current = null, chapterIndex = 0, sourceURL = null, selection = 0, loading = false;
let dragging = false, saveAt = 0, noticeTimer, persistenceFailed = false, audioReady = false, importing = false;
const memoryProgress = new Map();
const savingBooks = new Set();
const tocStates = new Map();
let undoSelection = null, undoTimer;

let displayedCue = -1;
let clips = [], clipsBookId = null, clipsLoading = false, clipBusy = false, clipUndo = null, clipUndoTimer;

function hideClipUndo() {
  clearTimeout(clipUndoTimer); clipUndo = null;
  $('clip-undo').hidden = true; $('clip-sheet-undo').hidden = true;
}
function placeClipUndo() {
  $('clip-undo').hidden = !clipUndo || $('clip-sheet').open;
  $('clip-sheet-undo').hidden = !clipUndo || !$('clip-sheet').open;
}
function offerClipUndo(text, action) {
  hideClipUndo(); clipUndo = action;
  for (const id of ['clip-undo', 'clip-sheet-undo']) $(id).querySelector('span').textContent = text;
  placeClipUndo();
  clipUndoTimer = setTimeout(hideClipUndo, 6000);
}
async function refreshClips(book) {
  if (current?.book_id !== book.book_id) return;
  if (clipsBookId !== book.book_id) { clips = []; hideClipUndo(); }
  clipsBookId = book.book_id; clipsLoading = true; renderClips();
  try {
    const saved = await listClips(book.book_id);
    if (current?.book_id === book.book_id) clips = saved.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  } catch (error) { tell(describeError(error), true); }
  finally { if (current?.book_id === book.book_id) { clipsLoading = false; renderClips(); } }
}
function renderClips() {
  $('clip-controls').hidden = !hasClips(current);
  $('add-clip').disabled = loading || !audioReady || clipBusy || clipsLoading || currentCueIndex(current?.chapters[chapterIndex], audio.currentTime) < 0;
  $('open-clips').disabled = clipsLoading;
  $('clip-count').textContent = String(clips.length);
  $('export-clips').disabled = !current?.vault_book_id || !clips.length || clipBusy || clipsLoading;
  $('clip-export-reason').textContent = !current?.vault_book_id ? '本のID（vault_book_id）がないため、Macへ送れません。対応したZIPを追加してください。' : '';
  $('clips').replaceChildren();
  if (!clips.length) {
    const empty = document.createElement('li'); empty.className = 'empty';
    empty.textContent = clipsLoading ? 'クリップを読んでいます…' : 'まだクリップはありません。「＋クリップ」で、画面に出ている区間の原本の文を保存します。';
    $('clips').append(empty);
  }
  for (const clip of clips) {
    const li = document.createElement('li'); li.className = 'clip-item';
    const play = document.createElement('button'); play.className = 'clip-play'; play.disabled = clipBusy;
    for (const [name, text] of [['clip-place', clipPlace(current, clip.chapter_id)], ['clip-text', clip.text],
      ['clip-go', '▶ この区間から再生'], ['clip-sent', clip.export_status || '未送信']]) {
      const span = document.createElement('span'); span.className = name; span.textContent = text; play.append(span);
    }
    play.addEventListener('click', async () => {
      const index = current.chapters.findIndex(chapter => chapter.id === clip.chapter_id);
      if (index < 0) { tell('このクリップの音声項目がありません。', true); return; }
      $('clip-sheet').close();
      await selectChapter(current, index, {seconds: clip.start_seconds, autoplay: true});
    });
    const del = document.createElement('button'); del.className = 'clip-delete'; del.disabled = clipBusy;
    del.setAttribute('aria-label', `クリップを消す：${clip.text}`);
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';
    del.addEventListener('click', () => {
      const book = current;
      void editClips(book, {remove: [clip.id]}, () => offerClipUndo('クリップを消しました。', () => editClips(book, {put: [clip]})));
    });
    li.append(play, del); $('clips').append(li);
  }
}
async function editClips(book, change, after) {
  if (clipBusy) return;
  clipBusy = true; renderClips();
  try {
    await changeClips(book.book_id, change);
    if (current?.book_id === book.book_id) {
      await refreshClips(book);
      if (current?.book_id === book.book_id) after?.();
    }
  } catch (error) { tell(describeError(error), true); }
  finally { clipBusy = false; renderClips(); }
}
$('add-clip').addEventListener('click', () => {
  if ($('add-clip').disabled) return;
  const book = current, chapter = book.chapters[chapterIndex];
  const clip = makeClip(chapter, chapter.text_cues[displayedCue].start_seconds);
  void editClips(book, {put: [clip]}, () => offerClipUndo('クリップしました。', () => editClips(book, {remove: [clip.id]})));
});
for (const id of ['clip-undo', 'clip-sheet-undo']) $(id).querySelector('button').addEventListener('click', () => {
  if (clipBusy) return;
  const action = clipUndo; hideClipUndo(); void action?.();
});
$('open-clips').addEventListener('click', () => { renderClips(); $('clip-sheet').showModal(); placeClipUndo(); $('close-clips').focus(); });
$('close-clips').addEventListener('click', () => $('clip-sheet').close());
$('clip-sheet').addEventListener('click', event => { if (event.target === $('clip-sheet')) $('clip-sheet').close(); });
$('clip-sheet').addEventListener('close', () => { placeClipUndo(); $('open-clips').focus(); });
$('export-clips').addEventListener('click', async () => {
  if ($('export-clips').disabled) return;
  const book = current, sending = [...clips], data = clipExport(book, sending);
  const file = new File([JSON.stringify(data, null, 2) + '\n'], clipFilename(data), {type: 'application/json'});
  clipBusy = true; renderClips();
  try {
    let status;
    if (navigator.canShare?.({files: [file]}) && navigator.share) {
      // ユーザーの操作権を保つため、共有を開く前にはawaitしない。
      await navigator.share({files: [file], title: `${book.title}のクリップ`});
      status = '共有済み（保存先で確認してください）';
    } else {
      const url = URL.createObjectURL(file), link = document.createElement('a');
      link.href = url; link.download = file.name; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      status = 'ダウンロード済み（保存先で確認してください）';
    }
    await changeClips(book.book_id, {put: sending.map(clip => ({...clip, exported_at: data.exported_at, export_status: status}))});
    await refreshClips(book);
    tell('iCloud Drive/聴く本のクリップ/ に保存してください。');
  } catch (error) {
    if (error.name !== 'AbortError') tell(describeError(error), true);
  } finally { clipBusy = false; renderClips(); }
});

function tocState() {
  if (!tocStates.has(current.book_id)) {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(`listening:toc:${current.book_id}`)); } catch { /* メモリー内で保持する */ }
    tocStates.set(current.book_id, new Set(Array.isArray(saved) ? saved : tocAncestors(bookToc(current), current.chapters[chapterIndex].id) || []));
  }
  return tocStates.get(current.book_id);
}

function saveToc() {
  try { localStorage.setItem(`listening:toc:${current.book_id}`, JSON.stringify([...tocState()])); }
  catch { /* 再生位置の保存とは分け、開閉はメモリー内で保持する */ }
}

function hideUndo() {
  clearTimeout(undoTimer); undoSelection = null; $('toc-undo').hidden = true;
}

function closeToc() { $('toc-sheet').close(); }

async function chooseToc(index) {
  closeToc();
  if (index === chapterIndex) {
    if (audio.paused) await startPlaying(); else audio.pause();
    return;
  }
  const from = {book: current, index: chapterIndex, seconds: audio.currentTime, rate: audio.playbackRate, autoplay: !audio.paused};
  hideUndo();
  await selectChapter(current, index, {autoplay: true});
  if (current !== from.book || chapterIndex !== index) return;
  undoSelection = from; $('toc-undo').hidden = false;
  undoTimer = setTimeout(hideUndo, 6000);
}

function renderToc() {
  const nodes = bookToc(current), open = tocState();
  const active = tocAncestors(nodes, current.chapters[chapterIndex].id) || [];
  const parents = [];
  const descendants = node => [node.chapter_id, ...(node.children || []).flatMap(descendants)].filter(Boolean);
  $('chapters').replaceChildren();
  function leaf(node, depth, start = false) {
    const index = current.chapters.findIndex(c => c.id === node.chapter_id), chapter = current.chapters[index];
    const li = document.createElement('li'), button = document.createElement('button');
    button.className = 'chapter-button'; button.style.setProperty('--depth', depth);
    button.setAttribute('aria-current', String(index === chapterIndex));
    const icon = document.createElement('span'); icon.className = 'chapter-number'; icon.setAttribute('aria-hidden', 'true');
    icon.textContent = index === chapterIndex && !audio.paused ? 'Ⅱ' : '▶';
    const name = document.createElement('span'); name.className = 'chapter-name';
    name.textContent = start ? `（${node.title.split(/[　 :：]/)[0]}のはじめ）` : node.title;
    const duration = document.createElement('span'); duration.className = 'chapter-duration'; duration.textContent = formatTime(chapter.audio.seconds);
    button.append(icon, name, duration); button.addEventListener('click', () => chooseToc(index));
    li.append(button); return li;
  }
  function walk(list, ol, depth) {
    for (const node of list) {
      if (!node.children) { ol.append(leaf(node, depth)); continue; }
      parents.push(node.id);
      const li = document.createElement('li'), button = document.createElement('button');
      button.className = 'toc-parent'; button.style.setProperty('--depth', depth);
      button.setAttribute('aria-expanded', String(open.has(node.id)));
      const icon = document.createElement('span'); icon.className = 'chevron'; icon.textContent = '›'; icon.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span'); name.className = 'chapter-name'; name.textContent = node.title;
      if (!open.has(node.id) && active.includes(node.id)) {
        const mark = document.createElement('small'); mark.className = 'toc-current'; mark.textContent = '再生中'; name.append(mark);
      }
      const ids = descendants(node), summary = document.createElement('span'); summary.className = 'chapter-duration';
      summary.textContent = `${ids.length}項目 · ${formatTime(current.chapters.filter(c => ids.includes(c.id)).reduce((sum, c) => sum + c.audio.seconds, 0))}`;
      button.append(icon, name, summary); li.append(button); ol.append(li);
      button.addEventListener('click', () => {
        const focused = node.id;
        open.has(node.id) ? open.delete(node.id) : open.add(node.id); saveToc(); renderToc();
        [...$('chapters').querySelectorAll('.toc-parent')].find(b => b.dataset.id === focused)?.focus({preventScroll: true});
      });
      button.dataset.id = node.id;
      const children = document.createElement('ol'); children.hidden = !open.has(node.id); li.append(children);
      if (node.chapter_id) children.append(leaf(node, depth + 1, true));
      walk(node.children, children, depth + 1);
    }
  }
  walk(nodes, $('chapters'), 0);
  if ($('toc-sheet').open) sizeToc();
  const allOpen = parents.every(id => open.has(id));
  $('toggle-all').hidden = !parents.length;
  $('toggle-all').setAttribute('aria-label', allOpen ? '目次をすべて閉じる' : '目次をすべて開く');
  $('toggle-all').setAttribute('aria-expanded', String(allOpen));
  $('toggle-all').onclick = () => {
    tocStates.set(current.book_id, allOpen ? new Set() : new Set(parents)); saveToc(); renderToc();
  };
}

function sizeToc() {
  const body = $('toc-sheet').querySelector('.sheet-body');
  body.style.setProperty('--sticky-limit', `${Math.max(0, Math.min(132, body.clientHeight - 138))}px`);
}
window.addEventListener('resize', () => { if ($('toc-sheet').open) sizeToc(); });

$('open-toc').addEventListener('click', () => {
  renderToc(); $('toc-sheet').showModal();
  sizeToc();
  $('chapters').querySelector('[aria-current="true"]')?.scrollIntoView({block: 'end'});
  $('close-toc').focus();
});
$('close-toc').addEventListener('click', closeToc);
$('toc-sheet').addEventListener('click', event => { if (event.target === $('toc-sheet')) closeToc(); });
$('toc-sheet').addEventListener('close', () => $('open-toc').focus());
$('undo-toc').addEventListener('click', async () => {
  const from = undoSelection; hideUndo();
  if (from) await selectChapter(from.book, from.index, from);
});

function tell(text, error = false, persistent = false) {
  clearTimeout(noticeTimer);
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
  $('message').hidden = false;
  if (!persistent) noticeTimer = setTimeout(() => { $('message').hidden = true; }, error ? 10000 : 5000);
}

function describeError(error) {
  if (error?.name === 'QuotaExceededError') return '端末の空き容量が足りません。元のZIPを残したまま、不要な保存データを整理してください。';
  return error?.message || '処理できませんでした。もう一度お試しください。';
}

function savedProgress(book) {
  try { return JSON.parse(localStorage.getItem(`listening:${book.book_id}`) || '{}'); }
  catch { return memoryProgress.get(book.book_id) || {}; }
}

function persist() {
  if (!current || loading || !audioReady || !Number.isFinite(audio.currentTime)) return;
  const saved = {chapter_id: current.chapters[chapterIndex].id, seconds: audio.currentTime, rate: audio.playbackRate};
  memoryProgress.set(current.book_id, saved);
  try {
    localStorage.setItem(`listening:${current.book_id}`, JSON.stringify(saved));
    localStorage.setItem('listening:current-book', current.book_id);
  } catch {
    if (!persistenceFailed) tell('再生位置を端末に保存できません。ブラウザの保存設定を確認してください。', true);
    persistenceFailed = true;
    $('resume-note').textContent = '再生位置を保存できません';
  }
}

function renderShelf() {
  $('books').replaceChildren();
  $('book-count').textContent = `${books.length}冊`;
  $('empty').hidden = books.length > 0;
  for (const book of books) {
    const button = document.createElement('button');
    button.className = 'book-card';
    button.setAttribute('aria-pressed', String(book.book_id === current?.book_id));
    const title = document.createElement('strong'); title.textContent = book.title;
    const detail = document.createElement('small');
    detail.textContent = `${book.chapters.length}項目 · ${formatTime(book.chapters.reduce((sum, chapter) => sum + chapter.audio.seconds, 0))}${book.saved ? ' · 端末に保存済み' : ''}`;
    button.append(title, detail);
    button.addEventListener('click', () => openBook(book));
    $('books').append(button);
  }
}

function controlsReady(ready) {
  for (const id of ['play', 'seek', 'back', 'forward', 'speed']) $(id).disabled = !ready;
}

function mutationControls() {
  $('import-button').disabled = importing || savingBooks.size > 0;
  $('save-book').disabled = !current || importing || Boolean(current.saved) || savingBooks.has(current.book_id);
  $('remove-book').disabled = !current || importing || savingBooks.has(current.book_id);
}

function renderBook() {
  $('player').hidden = false; $('welcome').hidden = true;
  $('book-title').textContent = current.title;
  $('cover-letter').textContent = Array.from(current.title)[0];
  $('book-details').textContent = `${current.chapters.length}項目 · ${formatTime(current.chapters.reduce((sum, chapter) => sum + chapter.audio.seconds, 0))}`;
  $('chapter-total').textContent = `${current.chapters.length}項目`;
  renderToc();
  $('save-book').textContent = current.saved ? '音声は端末に保存済み' : 'この端末に音声を保存';
  mutationControls();
  renderShelf(); updatePosition();
}

function updatePosition() {
  if (!current) return;
  $('clip-controls').hidden = !hasClips(current);
  $('add-clip').disabled = loading || !audioReady || clipBusy || clipsLoading || currentCueIndex(current.chapters[chapterIndex], audio.currentTime) < 0;
  const chapter = current.chapters[chapterIndex];
  const duration = Number.isFinite(audio.duration) && !loading ? audio.duration : chapter.audio.seconds;
  const elapsed = loading ? 0 : audio.currentTime || 0;
  displayedCue = loading ? -1 : currentCueIndex(chapter, elapsed);
  const text = chapter.text_cues?.[displayedCue]?.text || '';
  $('current-text-panel').hidden = !text;
  if ($('current-text').textContent !== text) $('current-text').textContent = text;
  $('chapter-title').textContent = chapter.title;
  $('chapter-count').textContent = `第${chapterIndex + 1}項目 / ${current.chapters.length}項目`;
  $('elapsed').textContent = formatTime(elapsed); $('duration').textContent = formatTime(duration);
  $('seek').max = String(duration);
  if (!dragging) $('seek').value = String(elapsed);
  $('seek').setAttribute('aria-valuetext', `${formatTime(elapsed)} / ${formatTime(duration)}`);
  const total = current.chapters.reduce((sum, part) => sum + part.audio.seconds, 0);
  const done = current.chapters.slice(0, chapterIndex).reduce((sum, part) => sum + part.audio.seconds, 0) + elapsed;
  $('book-position').textContent = `${Math.min(100, Math.floor(done / total * 100))}% 読み進めました`;
  $('play-symbol').textContent = audio.paused ? '▶' : 'Ⅱ';
  for (const icon of $('chapters').querySelectorAll('.chapter-button[aria-current="true"] .chapter-number')) icon.textContent = audio.paused ? '▶' : 'Ⅱ';
  $('play').setAttribute('aria-label', audio.paused ? '再生' : '一時停止');
  if ('mediaSession' in navigator && Number.isFinite(duration) && duration > 0) {
    navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
    try { navigator.mediaSession.setPositionState({duration, playbackRate: audio.playbackRate, position: Math.min(duration, elapsed)}); } catch { /* ブラウザごとの差は再生を妨げない */ }
  }
}

async function audioFor(book, chapter) {
  const stored = await readAudio(book.book_id, chapter.id);
  if (stored?.sha256 === chapter.audio.sha256) return stored.blob;
  if (!book.serverBase) throw new Error('音声が端末にありません。「本を追加」から元のZIPを選んでください。');
  let response;
  try { response = await fetch(new URL(chapter.audio.file, new URL(book.serverBase, location.href)), {cache: 'no-store'}); }
  catch { throw new Error('Macに接続できません。同じWi-FiとMac側の起動を確認してください。'); }
  if (!response.ok) throw new Error('音声を読み込めません。接続用URLから開き直してください。');
  const blob = await response.blob();
  if (blob.size !== chapter.audio.bytes) throw new Error('音声の読み込みが途中で終わりました。もう一度お試しください。');
  // 現在の章をキャッシュする。保存に失敗しても、読めた音声の再生は続けられる。
  try { await storeAudio({book_id: book.book_id, chapter_id: chapter.id, sha256: chapter.audio.sha256, blob}); }
  catch (error) { tell(describeError(error), true); }
  return blob;
}

async function selectChapter(book, index, {autoplay = false, seconds = 0, rate = null} = {}) {
  hideUndo();
  persist();
  const version = ++selection;
  loading = true; audioReady = false; audio.pause(); controlsReady(false);
  current = book; chapterIndex = index; renderBook();
  if (clipsBookId !== book.book_id) void refreshClips(book);
  try {
    const blob = await audioFor(book, book.chapters[index]);
    if (version !== selection) return;
    const old = sourceURL; sourceURL = URL.createObjectURL(blob);
    const ready = new Promise((resolve, reject) => {
      const loaded = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('この音声を再生できません。元のZIPを確認してください。')); };
      const timer = setTimeout(failed, 15000);
      const cleanup = () => { clearTimeout(timer); audio.removeEventListener('loadedmetadata', loaded); audio.removeEventListener('error', failed); };
      audio.addEventListener('loadedmetadata', loaded); audio.addEventListener('error', failed);
    });
    audio.src = sourceURL; audio.load();
    if (old) URL.revokeObjectURL(old);
    await ready;
    if (version !== selection) return;
    audio.playbackRate = rate ?? Number($('speed').value);
    $('speed').value = String(audio.playbackRate);
    audio.currentTime = Math.max(0, Math.min(seconds, audio.duration || book.chapters[index].audio.seconds));
    loading = false; audioReady = true; controlsReady(true); updatePosition(); persist();
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({title: book.chapters[index].title, artist: book.title, album: '聴く本'});
    if (autoplay) await startPlaying();
  } catch (error) {
    if (version === selection) { loading = false; tell(describeError(error), true); }
  }
}

function openBook(book) {
  hideUndo();
  const progress = resolveProgress(book, savedProgress(book));
  return selectChapter(book, progress.index, progress);
}

async function startPlaying() {
  if (loading || !current || !audioReady) return;
  if (audio.ended || audio.currentTime >= audio.duration - 0.03) audio.currentTime = 0;
  try { await audio.play(); }
  catch { tell('再生ボタンを押すと、音声が始まります。'); }
}

function seekBy(seconds) {
  if (!current || loading || !audioReady) return;
  audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + seconds));
  persist(); updatePosition();
}

$('play').addEventListener('click', () => { if (audio.paused) startPlaying(); else audio.pause(); });
$('back').addEventListener('click', () => seekBy(-15));
$('forward').addEventListener('click', () => seekBy(15));
$('seek').addEventListener('pointerdown', () => { dragging = true; });
$('seek').addEventListener('input', () => { $('elapsed').textContent = formatTime(Number($('seek').value)); });
$('seek').addEventListener('change', () => { audio.currentTime = Number($('seek').value); dragging = false; persist(); updatePosition(); });
$('seek').addEventListener('pointerup', () => { dragging = false; });
$('seek').addEventListener('pointercancel', () => { dragging = false; });
$('speed').addEventListener('change', () => { audio.playbackRate = Number($('speed').value); persist(); updatePosition(); });
audio.addEventListener('timeupdate', () => { updatePosition(); if (performance.now() - saveAt > 2000) { persist(); saveAt = performance.now(); } });
for (const event of ['pause', 'play', 'seeked', 'ratechange']) audio.addEventListener(event, () => { updatePosition(); persist(); });
audio.addEventListener('ended', () => {
  persist();
  if (current && chapterIndex + 1 < current.chapters.length) selectChapter(current, chapterIndex + 1, {autoplay: true});
  else tell('最後まで聴き終わりました。');
});
window.addEventListener('pagehide', persist);
document.addEventListener('visibilitychange', () => { if (document.hidden) persist(); });

if ('mediaSession' in navigator) {
  for (const [name, handler] of Object.entries({play: startPlaying, pause: () => audio.pause(),
    previoustrack: () => { if (current && chapterIndex > 0) selectChapter(current, chapterIndex - 1, {autoplay: true}); },
    nexttrack: () => { if (current && chapterIndex + 1 < current.chapters.length) selectChapter(current, chapterIndex + 1, {autoplay: true}); },
    seekbackward: detail => seekBy(-(detail.seekOffset || 15)), seekforward: detail => seekBy(detail.seekOffset || 15), seekto: detail => {
    if (Number.isFinite(detail.seekTime)) { audio.currentTime = Math.max(0, Math.min(audio.duration, detail.seekTime)); persist(); }
  }})) { try { navigator.mediaSession.setActionHandler(name, handler); } catch { /* 非対応の操作は通常ボタンから使う */ } }
}

$('import-button').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async () => {
  const file = $('import-file').files[0]; if (!file) return;
  if (importing || savingBooks.size) { $('import-file').value = ''; tell('保存が終わってから本を追加してください。'); return; }
  importing = true; mutationControls(); tell('本を読み込んでいます…', false, true);
  try {
    const {book, audios} = await readBundle(file);
    const stored = {...book, saved: true, imported: true};
    await storeBook(stored, audios);
    books = [...books.filter(item => item.book_id !== stored.book_id), stored];
    await openBook(stored);
    tell('本をこの端末に保存しました。');
    void protectStorage();
  } catch (error) { tell(describeError(error), true); }
  finally { importing = false; mutationControls(); $('import-file').value = ''; }
});

$('save-book').addEventListener('click', async () => {
  const book = current; if (!book || importing || savingBooks.has(book.book_id)) return;
  savingBooks.add(book.book_id); renderBook();
  try {
    for (const [index, chapter] of book.chapters.entries()) {
      tell(`音声を保存しています ${index + 1}/${book.chapters.length}`, false, true);
      const blob = await audioFor(book, chapter);
      // audioForの再生用キャッシュ失敗を、全冊保存の成功と誤認しない。
      await storeAudio({book_id: book.book_id, chapter_id: chapter.id, sha256: chapter.audio.sha256, blob});
    }
    await storeBook({...book, saved: true}); book.saved = true;
    void protectStorage();
    tell('音声をこの端末に保存しました。');
  } catch (error) { tell(describeError(error), true); }
  finally { savingBooks.delete(book.book_id); mutationControls(); renderShelf(); if (current?.book_id === book.book_id) renderBook(); }
});

$('remove-book').addEventListener('click', async () => {
  const book = current;
  if (!book || importing || savingBooks.has(book.book_id) || !confirm(`「${book.title}」の保存した音声と再生位置を削除しますか？\n元のZIPやMacの音声は残ります。`)) return;
  try {
    ++selection; loading = true; audioReady = false; audio.pause();
    await removeBook(book); books = books.filter(item => item.book_id !== book.book_id);
    try { localStorage.removeItem(`listening:${book.book_id}`); localStorage.removeItem('listening:current-book'); } catch { /* 保存不可時 */ }
    hideClipUndo(); clips = []; clipsBookId = null;
    current = null; audio.removeAttribute('src'); audio.load();
    if (sourceURL) URL.revokeObjectURL(sourceURL); sourceURL = null;
    $('player').hidden = true; $('welcome').hidden = false; loading = false; renderShelf();
    if (books.length) await openBook(books[0]);
    tell('この端末の保存を削除しました。元のZIPからもう一度追加できます。');
  } catch (error) { loading = false; tell(describeError(error), true); }
});

async function initialise() {
  try {
    books = (await listBooks()).map(validateBook);
    renderShelf();
    const response = SERVER_LIBRARY ? await fetch('./api/library', {signal: AbortSignal.timeout(5000)}).catch(() => null) : null;
    if (response?.ok) {
      const library = await response.json();
      let failed = false;
      for (const item of library) {
        if (books.some(book => book.book_id === item.id && book.imported)) continue;
        try {
          const result = await fetch(item.manifest_url, {signal: AbortSignal.timeout(5000)});
          if (!result.ok) { failed = true; continue; }
          const manifest = validateBook(await result.json());
          // 操作中の本はこの起動中に差し替えない。
          if (current?.book_id === manifest.book_id) continue;
          const old = books.find(book => book.book_id === manifest.book_id);
          const unchanged = old && old.chapters.length === manifest.chapters.length && old.chapters.every((chapter, index) => chapter.id === manifest.chapters[index].id && chapter.audio.sha256 === manifest.chapters[index].audio.sha256);
          const book = {...manifest, serverBase: `/books/${manifest.book_id}/`, saved: Boolean(unchanged && old.saved)};
          await storeBook(book); books = [...books.filter(previous => previous.book_id !== book.book_id), book];
        } catch { failed = true; }
      }
      $('connection').textContent = failed ? '接続が途切れました。保存済みの本は開けます' : 'Macの本棚に接続しています';
    } else $('connection').textContent = 'この端末に保存した本を表示しています';
    renderShelf();
    let last;
    try { last = localStorage.getItem('listening:current-book'); } catch { /* 既定の本から開く */ }
    const initial = books.find(book => book.book_id === last) || books[0];
    if (initial && !current) await openBook(initial);
  } catch (error) { tell(describeError(error), true, true); $('connection').textContent = '本棚を開けませんでした'; }
  if (window.isSecureContext && 'serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
      await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))]);
      const worker = (await navigator.serviceWorker.ready).active;
      const ready = await new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => { channel.port1.close(); reject(new Error('timeout')); }, 5000);
        channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data?.ready === true); };
        worker.postMessage({type: 'CHECK_OFFLINE'}, [channel.port2]);
      });
      if (!ready) throw new Error('cache incomplete');
      $('offline-note').textContent = '画面を保存しました。取り込んだ本はオフラインでも聴けます。';
    }
    catch { $('offline-note').textContent = '画面のオフライン保存は利用できません。'; }
  } else $('offline-note').textContent = '現在の接続では、アプリを開き直すときにMacへの接続が必要です。';
}

async function protectStorage() {
  if (!navigator.storage?.persist) return;
  try {
    // 保存保護の判定を返さないブラウザでも、取り込み完了を止めない。
    const protectedStorage = await Promise.race([
      navigator.storage.persist(), new Promise(resolve => setTimeout(() => resolve(false), 5000))
    ]);
    $('storage-note').textContent = protectedStorage
      ? '端末内の保存を保護しています。元のZIPもiCloud Driveに残してください。'
      : '元のZIPはiCloud Driveに残してください。端末の空き容量が不足すると、ブラウザの保存が整理される場合があります。';
  } catch { /* 保存が完了した本は、永続化の許可がなくても利用できる */ }
}

initialise();
