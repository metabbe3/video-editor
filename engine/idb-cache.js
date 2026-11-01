// tiny IndexedDB key/value cache (words per transcription window)

const DB = 'fyp-editor';
const STORE = 'transcripts';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function op(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function cachedWords(key) {
  try { return (await op('readonly', (s) => s.get(key))) || null; } catch { return null; }
}
export async function saveWords(key, words) {
  try { await op('readwrite', (s) => s.put(words, key)); } catch { /* cache is best-effort */ }
}
