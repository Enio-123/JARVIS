// Trilha do Tony Stark: músicas do AC/DC tocadas pelo player oficial do YouTube (vídeos do canal
// oficial da banda). Nada de áudio copiado para o site: o YouTube é quem transmite.
// O volume abaixa sozinho quando você ou o JARVIS falam.
import { normalize } from './projector.js';

export const TRACKS = [
  { id: 'pAgnJDJN4VA', title: 'Back In Black', artist: 'AC/DC', bpm: 94, note: 'a abertura de Homem de Ferro (2008)', alias: ['back in black', 'back black'] },
  { id: 'xRQnJyP77tY', title: 'Shoot To Thrill', artist: 'AC/DC', bpm: 141, note: 'a entrada do Tony na Stark Expo em Homem de Ferro 2', alias: ['shoot to thrill', 'shoot thrill', 'shoot'] },
  { id: 'l482T0yNkeo', title: 'Highway to Hell', artist: 'AC/DC', bpm: 116, note: 'trilha de Homem de Ferro 2', alias: ['highway to hell', 'highway'] },
  { id: 'v2AC41dglnM', title: 'Thunderstruck', artist: 'AC/DC', bpm: 134, note: 'trilha de Homem de Ferro 2', alias: ['thunderstruck', 'thunder'] },
  { id: 'Lo2qQmj0_h4', title: 'You Shook Me All Night Long', artist: 'AC/DC', bpm: 127, note: 'clássico do AC/DC', alias: ['you shook me all night long', 'you shook me', 'shook me'] },
  { id: 'etAIpkdhU9Q', title: 'Hells Bells', artist: 'AC/DC', bpm: 107, note: 'clássico do AC/DC', alias: ['hells bells', 'hell s bells', 'bells'] },
];

let apiPromise = null;
function loadApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ||= new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiPromise = null; reject(new Error('Não consegui carregar o player do YouTube.')); };
    document.head.append(s);
  });
  return apiPromise;
}

export class Music {
  constructor() {
    this.player = null;
    this.ready = null;
    this.track = null;
    this.state = 'off'; // off | loading | playing | paused
    this.volume = 70;
    this.duckers = new Set();
    this.currentVol = 70;
    this.onChange = () => {};
    this.onError = () => {};
    this.el = document.getElementById('music');
  }

  get playing() {
    return this.state === 'playing' || this.state === 'loading';
  }

  find(query) {
    const q = normalize(query);
    if (!q) return null;
    return TRACKS.find((t) => t.alias.some((a) => q.includes(a)) || normalize(t.title) === q) || null;
  }

  async ensure() {
    if (this.player) return this.ready;
    const YT = await loadApi();
    this.ready = new Promise((resolve) => {
      this.player = new YT.Player('ytPlayer', {
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 1, controls: 1, rel: 0, playsinline: 1, fs: 0, iv_load_policy: 3, disablekb: 1 },
        events: {
          onReady: () => resolve(),
          onStateChange: (e) => this._state(e.data),
          onError: (e) => this._error(e.data),
        },
      });
    });
    return this.ready;
  }

  _state(s) {
    const YT = window.YT;
    if (s === YT.PlayerState.PLAYING) this.state = 'playing';
    else if (s === YT.PlayerState.PAUSED) this.state = 'paused';
    else if (s === YT.PlayerState.ENDED) { this.next(); return; }
    this._apply(true);
    this.onChange();
  }

  _error(code) {
    const t = this.track;
    const blocked = code === 101 || code === 150 || code === 100;
    this.state = 'paused';
    this.onChange();
    this.onError(t, blocked ? 'O YouTube não liberou essa música para tocar aqui.' : 'O player do YouTube deu erro.');
  }

  async play(track) {
    this.track = track || TRACKS[0];
    this.state = 'loading';
    this.el.hidden = false;
    this.onChange();
    try {
      await this.ensure();
    } catch (e) {
      this.state = 'off';
      this.track = null;
      this.el.hidden = true;
      this.onChange();
      throw e;
    }
    this.startedAt = performance.now();
    this.player.loadVideoById(this.track.id);
    this._apply(true);
  }

  pause() {
    if (!this.player || this.state === 'off') return;
    this.player.pauseVideo();
  }

  resume() {
    if (!this.player || this.state === 'off') return;
    this.player.playVideo();
  }

  toggle() {
    if (this.state === 'playing' || this.state === 'loading') this.pause(); else this.resume();
  }

  next(step = 1) {
    const i = TRACKS.indexOf(this.track);
    return this.play(TRACKS[(i + step + TRACKS.length) % TRACKS.length]);
  }

  stop() {
    this.player?.stopVideo();
    this.state = 'off';
    this.track = null;
    this.el.hidden = true;
    this.onChange();
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(100, Math.round(v)));
    this._apply();
  }

  // Abaixa o volume enquanto alguém fala; cada "motivo" é guardado separado
  duck(reason, on) {
    if (on) this.duckers.add(reason); else this.duckers.delete(reason);
    this._apply();
  }

  _apply(now = false) {
    if (!this.player?.setVolume) return;
    const target = this.duckers.size ? Math.min(14, this.volume) : this.volume;
    if (now) this.currentVol = target;
    clearInterval(this.fade);
    // rampa curta para não dar "degrau" no volume
    this.fade = setInterval(() => {
      this.currentVol += Math.sign(target - this.currentVol) * Math.min(6, Math.abs(target - this.currentVol));
      try { this.player.setVolume(this.currentVol); } catch { /* player saindo */ }
      if (this.currentVol === target) clearInterval(this.fade);
    }, 30);
  }

  // Para a dancinha do JARVIS: andamento e tempo atual da música
  beat() {
    if (this.state !== 'playing' || !this.player?.getCurrentTime) return null;
    return { bpm: this.track.bpm, time: this.player.getCurrentTime() };
  }

  progress() {
    if (!this.player?.getDuration) return 0;
    const d = this.player.getDuration();
    return d ? this.player.getCurrentTime() / d : 0;
  }

  // Comando vindo da IA: { acao, faixa, valor }
  async handle(cmd) {
    if (!cmd || typeof cmd !== 'object') return;
    const a = normalize(cmd.acao);
    if (a === 'tocar') {
      const t = this.find(cmd.faixa) || (cmd.faixa ? null : TRACKS[Math.floor(Math.random() * 4)]);
      if (t) await this.play(t);
    } else if (a === 'parar') this.stop();
    else if (a === 'pausar') this.pause();
    else if (a === 'continuar') this.resume();
    else if (a === 'proxima') this.next(1);
    else if (a === 'anterior') this.next(-1);
    else if (a === 'volume' && Number.isFinite(+cmd.valor)) this.setVolume(+cmd.valor);
  }
}

// Lista para o JARVIS saber o que pode tocar
export function trackList() {
  return TRACKS.map((t) => `${t.title} (${t.note})`).join('; ');
}
