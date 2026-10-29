// Memória do JARVIS: fatos curtos que você pediu para ele lembrar (salvos só neste navegador)
const KEY = 'jarvisvoz.memoria';
const MAX = 40;

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]').filter((x) => typeof x === 'string'); } catch { return []; }
}

let facts = load();

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(facts)); } catch { /* sem armazenamento */ }
}

export const memory = {
  list: () => [...facts],
  add(fact) {
    const f = String(fact || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!f || facts.some((x) => x.toLowerCase() === f.toLowerCase())) return;
    facts.push(f);
    if (facts.length > MAX) facts = facts.slice(-MAX);
    persist();
  },
  forget(text) {
    const q = String(text || '').toLowerCase().trim();
    if (!q) return;
    facts = facts.filter((x) => !x.toLowerCase().includes(q));
    persist();
  },
  remove(i) {
    facts.splice(i, 1);
    persist();
  },
  clear() {
    facts = [];
    persist();
  },
  describe() {
    return facts.length ? facts.map((f) => `- ${f}`).join('\n') : '(nada salvo ainda)';
  },
};
