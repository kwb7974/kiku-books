import {RATES, formatTime, validateBook, resolveProgress, readBundle} from './core.mjs';
import {listBooks, readAudio, storeBook, storeAudio, removeBook} from './storage.mjs';
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
    detail.textContent = `${book.chapters.length}章 · ${formatTime(book.chapters.reduce((sum, chapter) => sum + chapter.audio.seconds, 0))}${book.saved ? ' · 端末に保存済み' : ''}`;
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
  $('book-details').textContent = `${current.chapters.length}章 · ${formatTime(current.chapters.reduce((sum, chapter) => sum + chapter.audio.seconds, 0))}`;
  $('chapter-total').textContent = `${current.chapters.length}章`;
  $('chapters').replaceChildren();
  for (const [index, chapter] of current.chapters.entries()) {
    const item = document.createElement('li'), button = document.createElement('button');
    button.className = 'chapter-button';
    button.setAttribute('aria-current', String(index === chapterIndex));
    const number = document.createElement('span'); number.className = 'chapter-number'; number.textContent = String(index + 1).padStart(2, '0');
    const name = document.createElement('span'); name.className = 'chapter-name'; name.textContent = chapter.title;
    const duration = document.createElement('span'); duration.className = 'chapter-duration'; duration.textContent = formatTime(chapter.audio.seconds);
    button.append(number, name, duration); item.append(button); $('chapters').append(item);
    button.addEventListener('click', () => selectChapter(current, index, {autoplay: true, seconds: 0}));
  }
  $('save-book').textContent = current.saved ? '音声は端末に保存済み' : 'この端末に音声を保存';
  mutationControls();
  renderShelf(); updatePosition();
}

function updatePosition() {
  if (!current) return;
  const chapter = current.chapters[chapterIndex];
  const duration = Number.isFinite(audio.duration) && !loading ? audio.duration : chapter.audio.seconds;
  const elapsed = loading ? 0 : audio.currentTime || 0;
  $('chapter-title').textContent = chapter.title;
  $('chapter-count').textContent = `第${chapterIndex + 1}章 / ${current.chapters.length}章`;
  $('elapsed').textContent = formatTime(elapsed); $('duration').textContent = formatTime(duration);
  $('seek').max = String(duration);
  if (!dragging) $('seek').value = String(elapsed);
  $('seek').setAttribute('aria-valuetext', `${formatTime(elapsed)} / ${formatTime(duration)}`);
  const total = current.chapters.reduce((sum, part) => sum + part.audio.seconds, 0);
  const done = current.chapters.slice(0, chapterIndex).reduce((sum, part) => sum + part.audio.seconds, 0) + elapsed;
  $('book-position').textContent = `${Math.min(100, Math.floor(done / total * 100))}% 読み進めました`;
  $('play-symbol').textContent = audio.paused ? '▶' : 'Ⅱ';
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
  persist();
  const version = ++selection;
  loading = true; audioReady = false; audio.pause(); controlsReady(false);
  current = book; chapterIndex = index; renderBook();
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
