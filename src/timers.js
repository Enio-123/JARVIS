// Timers por voz ("Jarvis, me avisa em 10 minutos"). Funcionam enquanto a página estiver aberta.
export class Timers {
  constructor(onFire, onChange) {
    this.items = [];
    this.onFire = onFire;
    this.onChange = onChange;
    this.seq = 0;
    setInterval(() => this.tick(), 250);
  }

  add(seconds, label) {
    const s = Math.max(1, Math.min(24 * 3600, Math.round(+seconds || 0)));
    if (!s) return null;
    const t = { id: ++this.seq, label: String(label || 'Timer').slice(0, 40), end: Date.now() + s * 1000, total: s };
    this.items.push(t);
    this.onChange();
    return t;
  }

  cancel(label) {
    const q = String(label || '').toLowerCase().trim();
    const before = this.items.length;
    this.items = q ? this.items.filter((t) => !t.label.toLowerCase().includes(q)) : [];
    if (this.items.length !== before) this.onChange();
  }

  remove(id) {
    this.items = this.items.filter((t) => t.id !== id);
    this.onChange();
  }

  tick() {
    const now = Date.now();
    const done = this.items.filter((t) => t.end <= now);
    if (!done.length) { if (this.items.length) this.onChange(true); return; }
    this.items = this.items.filter((t) => t.end > now);
    this.onChange();
    for (const t of done) this.onFire(t);
  }

  describe() {
    if (!this.items.length) return 'nenhum';
    return this.items.map((t) => `${t.label} (faltam ${fmt(t.end - Date.now())})`).join('; ');
  }
}

export function fmt(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(r).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
