// project-store.js — IndexedDB persistence for project snapshots.
// Saves EDL + trims + splits + overlays + settings per A-roll file (name + size).

const DB_NAME = 'nila-projects';
const STORE_NAME = 'edits';
const DB_VERSION = 1;

/** create a stable cache key from an A-roll file or name + size */
export function makeProjectKey(name, size = 0) {
  if (!name) return 'default';
  const clean = String(name).split('/').pop();
  return `${clean}:${size ?? 0}`;
}

export function openProjectDb(idb = globalThis.indexedDB) {
  if (!idb) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // self-heal (lesson 1 Nov): db bisa exist di DB_VERSION tanpa store (dibuat saat tab crash
      // di tengah upgrade, atau oleh open tanpa versi) — open(vSAMA) tidak melepas upgradeneeded,
      // jadi cek eksplisit; kalau store hilang, tutup + reopen dengan versi +1 utk paksa upgrade.
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const broken = db.version;
        db.close();
        const fix = idb.open(DB_NAME, broken + 1);
        fix.onupgradeneeded = () => { if (!fix.result.objectStoreNames.contains(STORE_NAME)) fix.result.createObjectStore(STORE_NAME); };
        fix.onsuccess = () => resolve(fix.result);
        fix.onerror = () => reject(fix.error);
        return;
      }
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

/** save a serialized project snapshot into IndexedDB */
export async function saveProject(key, snapshot, idb = globalThis.indexedDB) {
  try {
    const db = await openProjectDb(idb);
    if (!db) return false;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const data = { ...snapshot, key, savedAt: Date.now() };
      const req = store.put(data, key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('saveProject failed:', err?.message || err);
    return false;
  }
}

/** load a serialized project snapshot from IndexedDB */
export async function loadProject(key, idb = globalThis.indexedDB) {
  try {
    const db = await openProjectDb(idb);
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('loadProject failed:', err?.message || err);
    return null;
  }
}

/** remove a project snapshot from IndexedDB */
export async function deleteProject(key, idb = globalThis.indexedDB) {
  try {
    const db = await openProjectDb(idb);
    if (!db) return false;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    return false;
  }
}

/** extract clean JSON-serializable snapshot from project state */
export function serializeProjectState(p) {
  if (!p) return null;
  return {
    edl: p.edl ? JSON.parse(JSON.stringify(p.edl)) : null,
    words: p.words ? JSON.parse(JSON.stringify(p.words)) : null,
    baseKeeps: p.baseKeeps ? JSON.parse(JSON.stringify(p.baseKeeps)) : null,
    overrides: p.overrides ? JSON.parse(JSON.stringify(p.overrides)) : { cuts: [], keeps: [] },
    overlays: p.overlays ? JSON.parse(JSON.stringify(p.overlays)) : [],
    settings: p.settings ? JSON.parse(JSON.stringify(p.settings)) : {},
    variants: p.variants ? JSON.parse(JSON.stringify(p.variants)) : null,
    activeVariant: p.activeVariant ?? 0,
    glmResult: p.glmResult ? JSON.parse(JSON.stringify(p.glmResult)) : null,
    useGlm: !!p.useGlm,
    audioOverlays: p.edl?.audioOverlays ? JSON.parse(JSON.stringify(p.edl.audioOverlays)) : [],
    proposals: p.proposals ? JSON.parse(JSON.stringify(p.proposals)) : null,
    debateSummary: p.debateSummary ? JSON.parse(JSON.stringify(p.debateSummary)) : null,
    chatHistory: p.chatHistory ? JSON.parse(JSON.stringify(p.chatHistory)) : [],
  };
}

/** restore serialized snapshot into project state */
export function applyProjectSnapshot(p, snap) {
  if (!p || !snap) return false;
  if (snap.words) p.words = snap.words;
  if (snap.baseKeeps) p.baseKeeps = snap.baseKeeps;
  if (snap.overrides) p.overrides = snap.overrides;
  if (snap.overlays) p.overlays = snap.overlays;
  if (snap.settings) Object.assign(p.settings, snap.settings);
  if (snap.variants) p.variants = snap.variants;
  if (snap.activeVariant != null) p.activeVariant = snap.activeVariant;
  if (snap.glmResult) p.glmResult = snap.glmResult;
  p.useGlm = !!snap.useGlm;
  if (snap.proposals) p.proposals = snap.proposals;
  if (snap.debateSummary) p.debateSummary = snap.debateSummary;
  if (snap.chatHistory) p.chatHistory = snap.chatHistory;
  if (snap.edl) {
    p.edl = snap.edl;
    if (snap.audioOverlays?.length) p.edl.audioOverlays = snap.audioOverlays;
  }
  return true;
}
