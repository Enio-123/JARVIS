// O que o JARVIS sabe do mundo real: data, hora e o clima onde você está.
// Clima: Open-Meteo (grátis, sem chave). Cidade: BigDataCloud (grátis, uso direto pelo navegador).
// A localização vem do navegador (pede permissão); se você negar, usa uma estimativa pela internet.
const WMO = {
  0: 'céu limpo', 1: 'poucas nuvens', 2: 'parcialmente nublado', 3: 'nublado',
  45: 'neblina', 48: 'neblina com geada', 51: 'garoa fraca', 53: 'garoa', 55: 'garoa forte',
  56: 'garoa congelante', 57: 'garoa congelante forte', 61: 'chuva fraca', 63: 'chuva', 65: 'chuva forte',
  66: 'chuva congelante', 67: 'chuva congelante forte', 71: 'neve fraca', 73: 'neve', 75: 'neve forte',
  77: 'granizo fino', 80: 'pancadas de chuva fracas', 81: 'pancadas de chuva', 82: 'pancadas de chuva fortes',
  85: 'pancadas de neve', 86: 'pancadas de neve fortes', 95: 'trovoadas', 96: 'trovoadas com granizo', 99: 'trovoadas fortes com granizo',
};

const UNITS = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const TENS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta'];

// Número por extenso (0 a 59), para a voz ler hora e temperatura sem tropeçar
export function words(n, fem = false) {
  n = Math.round(n);
  if (n < 0) return 'menos ' + words(-n, fem);
  if (n >= 60) return String(n);
  const u = (k) => (fem && k === 1 ? 'uma' : fem && k === 2 ? 'duas' : UNITS[k]);
  if (n < 20) return u(n);
  const t = TENS[Math.floor(n / 10)], r = n % 10;
  return r ? `${t} e ${u(r)}` : t;
}

export function spokenTime(d = new Date()) {
  const h = d.getHours(), m = d.getMinutes();
  const period = h < 5 ? 'da madrugada' : h < 12 ? 'da manhã' : h < 18 ? 'da tarde' : 'da noite';
  let hour;
  if (h === 0) hour = 'meia-noite';
  else if (h === 12) hour = 'meio-dia';
  else hour = words(h % 12 || 12, true);
  const special = h === 0 || h === 12;
  const plural = !special && (h % 12 || 12) !== 1;
  const verb = special || !plural ? 'É' : 'São';
  if (m === 0) return special ? `${verb} ${hour}` : `${verb} ${hour} ${plural ? 'horas' : 'hora'} ${period}`;
  return special ? `${verb} ${hour} e ${words(m)}` : `${verb} ${hour} e ${words(m)} ${period}`;
}

export function greetingWord(d = new Date()) {
  const h = d.getHours();
  return h >= 5 && h < 12 ? 'Bom dia' : h >= 12 && h < 18 ? 'Boa tarde' : 'Boa noite';
}

export function nowText(d = new Date()) {
  return d.toLocaleString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function position() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, precise: true }),
      () => resolve(null),
      { timeout: 8000, maximumAge: 3600000 },
    );
  });
}

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export class World {
  constructor() {
    this.weather = null; // { city, region, temp, feels, desc, humidity, wind, today, tomorrow, at }
    this.loading = null;
  }

  async refresh(useLocation = true) {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const pos = useLocation ? await position() : null;
        const geoUrl = 'https://api.bigdatacloud.net/data/reverse-geocode-client?localityLanguage=pt'
          + (pos ? `&latitude=${pos.lat}&longitude=${pos.lon}` : '');
        const geo = await json(geoUrl);
        const lat = pos?.lat ?? geo.latitude, lon = pos?.lon ?? geo.longitude;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('sem localização');
        const w = await json(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}`
          + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m'
          + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=2');
        const day = (i) => ({
          min: Math.round(w.daily.temperature_2m_min[i]),
          max: Math.round(w.daily.temperature_2m_max[i]),
          rain: w.daily.precipitation_probability_max?.[i] ?? null,
          desc: WMO[w.daily.weather_code[i]] || '',
        });
        this.weather = {
          city: geo.city || geo.locality || '',
          region: geo.principalSubdivisionCode?.split('-')[1] || geo.principalSubdivision || '',
          temp: Math.round(w.current.temperature_2m),
          feels: Math.round(w.current.apparent_temperature),
          desc: WMO[w.current.weather_code] || '',
          humidity: Math.round(w.current.relative_humidity_2m),
          wind: Math.round(w.current.wind_speed_10m),
          today: day(0),
          tomorrow: day(1),
          at: Date.now(),
        };
      } catch {
        // sem clima: o JARVIS simplesmente não fala do tempo
      } finally {
        this.loading = null;
      }
      return this.weather;
    })();
    return this.loading;
  }

  // Texto para o prompt da IA (só dados reais)
  describe() {
    const w = this.weather;
    if (!w) return 'Sem dados de clima no momento.';
    const place = [w.city, w.region].filter(Boolean).join(' - ') || 'local do usuário';
    const rain = (d) => (d.rain != null ? `, chance de chuva ${d.rain}%` : '');
    return `Clima agora em ${place}: ${w.temp} °C (sensação ${w.feels} °C), ${w.desc}, umidade ${w.humidity}%, vento ${w.wind} km/h. `
      + `Hoje: mínima ${w.today.min} °C, máxima ${w.today.max} °C${rain(w.today)}. `
      + `Amanhã: ${w.tomorrow.desc}, mínima ${w.tomorrow.min} °C, máxima ${w.tomorrow.max} °C${rain(w.tomorrow)}.`;
  }

  short() {
    const w = this.weather;
    return w ? `${w.city ? w.city + ' ' : ''}${w.temp} °C` : '';
  }

  // Saudação de abertura, no estilo do JARVIS do filme
  greeting(name) {
    const d = new Date();
    let text = `${greetingWord(d)}, ${name}. ${spokenTime(d)}.`;
    const w = this.weather;
    if (w) {
      text += ` ${w.city ? `Em ${w.city}, ` : 'Aqui, '}${words(w.temp)} graus${w.desc ? `, ${w.desc}` : ''}.`;
      if (w.today.rain != null && w.today.rain >= 60) text += ' Há boa chance de chuva hoje.';
    }
    return text + ' Em que posso ajudar?';
  }
}
