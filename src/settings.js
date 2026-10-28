// Configurações salvas só neste navegador (localStorage).
// As chaves de API nunca saem daqui, a não ser para o próprio serviço (Groq / ElevenLabs).
const KEY = 'jarvisvoz.settings';

const DEFAULTS = {
  groqKey: '',
  voice: 'piper', // auto | eleven | microsoft | piper | sistema
  elevenKey: '',
  elevenVoice: 'onwK4e9ZLuTAKqWW03F9', // "Daniel", voz britânica pronta da ElevenLabs
  name: '',
  wake: false,
  camera: true,
};

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}

export const settings = load();

export function save(patch = {}) {
  Object.assign(settings, patch);
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* sem armazenamento */ }
}

export function wipe() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('jarvisvoz.')) localStorage.removeItem(k);
  } catch { /* sem armazenamento */ }
  Object.assign(settings, DEFAULTS);
}
