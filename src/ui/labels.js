// shared label maps
export const LANG_NAMES = {
  id: 'Indonesian', en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
  es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', ru: 'Russian',
  ar: 'Arabic', hi: 'Hindi', ms: 'Malay', tl: 'Tagalog', th: 'Thai', vi: 'Vietnamese',
  it: 'Italian', nl: 'Dutch', tr: 'Turkish',
};
export const langName = (l) => LANG_NAMES[String(l ?? '').replace(/[<>|]/g, '')] ?? l;

export const CAPTION_LABELS = {
  hormozi: 'Hormozi / Impact', karaoke: 'Sliding Pill', glass: 'Frosted Glass',
  pop: 'Kinetic Pop & Tilt', clean: 'YouTube Clean',
};
