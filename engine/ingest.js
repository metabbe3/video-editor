// Ingest — "just put all the files and B-roll in 1 folder".
// showDirectoryPicker (Chromium) when available, <input webkitdirectory> everywhere.

const VIDEO = new Set(['mp4', 'mov', 'webm', 'm4v', 'mkv']);
const IMAGE = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
const AUDIO = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac']);

export async function pickFolder() {
  if (typeof showDirectoryPicker === 'function') {
    try {
      const dir = await showDirectoryPicker({ mode: 'read' });
      const files = [];
      for await (const path of walk(dir, '')) files.push(path);
      return files;
    } catch (e) {
      if (e.name === 'AbortError') return null; // user cancelled
      // fall through to input on any picker failure
    }
  }
  return pickViaInput();
}

async function* walk(dirHandle, prefix) {
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'directory') yield* walk(handle, `${prefix}${name}/`);
    else {
      const file = await handle.getFile();
      yield { file, path: `${prefix}${name}` };
    }
  }
}

function pickViaInput() {
  return new Promise((resolve) => {
    const input = document.getElementById('dirInput') || document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    input.onchange = () => resolve(
      [...(input.files || [])].map((file) => ({ file, path: file.webkitRelativePath || file.name }))
    );
  });
}

/** files -> registry. A-roll = biggest video (proxy for "the main take"); user can change it. */
export function buildRegistry(entries) {
  const items = entries
    .filter((e) => e.file.size > 0)
    .map((e) => {
      const ext = e.path.split('.').pop().toLowerCase();
      const kind = VIDEO.has(ext) ? 'video' : IMAGE.has(ext) ? 'image' : AUDIO.has(ext) ? 'audio' : 'other';
      return { id: e.path, name: e.path.split('/').pop(), path: e.path, kind, size: e.file.size, file: e.file };
    })
    .filter((r) => r.kind !== 'other');
  const videos = items.filter((r) => r.kind === 'video');
  const aroll = videos.reduce((a, b) => (b.size > a.size ? b : a), videos[0]) || null;
  return {
    items,
    arollId: aroll?.id ?? null,
    brollPool: items.filter((r) => r.id !== aroll?.id && r.kind !== 'audio'), // videos + images
  };
}
