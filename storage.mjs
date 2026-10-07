let connection;
export function openLibrary() {
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open('reading-books-player', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('books', {keyPath: 'book_id'});
      request.result.createObjectStore('audios', {keyPath: ['book_id', 'chapter_id']});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('別のタブを閉じて、もう一度開いてください。'));
  });
  return connection;
}

async function read(store, key) {
  const db = await openLibrary();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store);
    const request = key === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(key);
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error);
    request.onerror = () => reject(request.error);
  });
}

export const listBooks = () => read('books');
export async function readAudio(book, chapter) {
  const record = await read('audios', [book, chapter]);
  if (!record) return record;
  return {...record, blob: record.blob || new Blob([record.buffer], {type: record.mime})};
}

async function audioRecord(audio) {
  // Safari系のBlobをIndexedDBへ直接保存する際の失敗を避ける。
  // 変換はトランザクションの外で終え、書き込み途中にawaitしない。
  const {blob, ...metadata} = audio;
  return {...metadata, buffer: await blob.arrayBuffer(), mime: blob.type};
}

export async function storeBook(book, audios = []) {
  const records = [];
  for (const audio of audios) records.push(await audioRecord(audio));
  const db = await openLibrary();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['books', 'audios'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('保存できませんでした。'));
    tx.onerror = () => {};
    tx.objectStore('books').put(book);
    for (const audio of records) tx.objectStore('audios').put(audio);
  });
}

export async function storeAudio(audio) {
  const record = await audioRecord(audio);
  const db = await openLibrary();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('audios', 'readwrite');
    tx.objectStore('audios').put(record);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}

export async function removeBook(book) {
  const db = await openLibrary();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['books', 'audios'], 'readwrite');
    tx.objectStore('books').delete(book.book_id);
    const cursor = tx.objectStore('audios').openCursor(IDBKeyRange.bound([book.book_id, ''], [book.book_id, '\uffff']));
    cursor.onsuccess = () => { const item = cursor.result; if (item) { item.delete(); item.continue(); } };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}
