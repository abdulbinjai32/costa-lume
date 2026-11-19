// Costa Lume — the game's own sound, synthesised with WebAudio and nothing else.
//
// No audio file is loaded and no network is touched: every voice here is an oscillator or a burst of
// generated noise. The context is only built on the first real gesture (main.js calls unlock() from
// the New game / Continue click), so a page that is merely open stays silent and Chrome never
// complains about a suspended context.
//
// Voices: a continuous engine drone whose pitch follows the car's speed, a two-tone siren that only
// runs while a chase is on, two quiet station pads for the radio (one per station, started and
// stopped with the car) and short one-shots for gunfire, hits, pickups, the horn, a reload, a
// mission chime and a failure sting. Nothing loops at menu volume: the menu is silent by design.

const MASTER = 0.55;
const ENGINE_OFF = 0.0;
const RADIO_LEVEL = 0.05;

// Two fictional stations, each a small chord the pad cycles through. Frequencies only.
const STATIONS = [
  {
    name: 'Radio Sol',
    wave: 'sine',
    notes: [174.61, 220.0, 261.63, 329.63],
    beat: 1.15,
    cutoff: 900,
  },
  {
    name: 'Lume Bass',
    wave: 'triangle',
    notes: [98.0, 116.54, 146.83, 130.81],
    beat: 0.72,
    cutoff: 520,
  },
];

function noiseBuffer(ctx, seconds = 0.4) {
  const frames = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let seed = 0x9e3779b9;
  for (let i = 0; i < frames; i += 1) {
    // xorshift keeps the noise identical run to run and never touches Math.random
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    data[i] = ((seed >>> 0) / 0xffffffff) * 2 - 1;
  }
  return buf;
}

export function createAudio() {
  let ctx = null;
  let master = null;
  let noise = null;
  let muted = false;
  let failed = false;

  // continuous voices, created with the context
  let engine = null;
  let siren = null;
  let radio = null;

  let stationIndex = 0;

  const now = () => (ctx ? ctx.currentTime : 0);

  function buildEngine() {
    const osc = ctx.createOscillator();
    const sub = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    sub.type = 'square';
    osc.frequency.value = 52;
    sub.frequency.value = 26;
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    filter.Q.value = 0.8;
    gain.gain.value = ENGINE_OFF;
    osc.connect(filter);
    sub.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    osc.start();
    sub.start();
    engine = { osc, sub, filter, gain };
  }

  function buildSiren() {
    const hi = ctx.createOscillator();
    const lo = ctx.createOscillator();
    const gain = ctx.createGain();
    const trem = ctx.createOscillator();
    const tremGain = ctx.createGain();
    hi.type = 'sine';
    lo.type = 'sine';
    hi.frequency.value = 660;
    lo.frequency.value = 470;
    gain.gain.value = 0;
    // the two-tone wobble: a slow square LFO chopping the pair back and forth
    trem.type = 'square';
    trem.frequency.value = 1.6;
    tremGain.gain.value = 0.5;
    trem.connect(tremGain);
    tremGain.connect(gain.gain);
    hi.connect(gain);
    lo.connect(gain);
    gain.connect(master);
    hi.start();
    lo.start();
    trem.start();
    siren = { hi, lo, gain, trem };
  }

  function buildRadio() {
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = STATIONS[stationIndex].cutoff;
    gain.gain.value = 0;
    filter.connect(gain);
    gain.connect(master);
    radio = { gain, filter, voices: [], timer: 0, step: 0, playing: false };
  }

  function stopRadioVoices() {
    if (!radio) return;
    for (const v of radio.voices) {
      try { v.stop(); } catch (err) { /* already stopped */ }
      v.disconnect();
    }
    radio.voices = [];
  }

  // A pad voice that fades in on the station's next note and dies after it: no long-lived loop, so
  // pausing the game and muting both leave nothing ringing.
  function radioNote(freq) {
    if (!radio || !radio.playing) return;
    const spec = STATIONS[stationIndex];
    const t = now();
    for (const detune of [-4, 4]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = spec.wave;
      osc.frequency.value = freq;
      osc.detune.value = detune;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(RADIO_LEVEL, t + 0.35);
      g.gain.exponentialRampToValueAtTime(0.0001, t + spec.beat * 1.9);
      osc.connect(g);
      g.connect(radio.filter);
      osc.start(t);
      osc.stop(t + spec.beat * 2.0);
      radio.voices.push(osc);
      if (radio.voices.length > 8) {
        const old = radio.voices.shift();
        try { old.stop(); } catch (err) { /* gone */ }
        old.disconnect();
      }
    }
  }

  function tickRadio() {
    if (!radio || !radio.playing || !ctx) return;
    const spec = STATIONS[stationIndex];
    radioNote(spec.notes[radio.step % spec.notes.length]);
    radio.step += 1;
    radio.timer = setTimeout(tickRadio, spec.beat * 1000);
  }

  function ensure() {
    if (ctx || failed) return !!ctx;
    const Ctor = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
    if (!Ctor) { failed = true; return false; }
    try {
      ctx = new Ctor();
    } catch (err) {
      failed = true;
      return false;
    }
    master = ctx.createGain();
    master.gain.value = muted ? 0 : MASTER;
    master.connect(ctx.destination);
    noise = noiseBuffer(ctx);
    buildEngine();
    buildSiren();
    buildRadio();
    return true;
  }

  // ---- one-shots ----------------------------------------------------------------------------
  function blip(freq, when = 0, len = 0.16, type = 'sine', level = 0.3, slide = 0) {
    if (!ctx) return;
    const t = now() + when;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + len);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    osc.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + len + 0.02);
  }

  function burst(level = 0.5, seconds = 0.16, cutoff = 1600) {
    if (!ctx || !noise) return;
    const t = now();
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const g = ctx.createGain();
    src.buffer = noise;
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoff, t);
    filter.frequency.exponentialRampToValueAtTime(240, t + seconds);
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    src.connect(filter);
    filter.connect(g);
    g.connect(master);
    src.start(t);
    src.stop(t + seconds + 0.02);
  }

  const api = {
    // Called from a click. Safe to call again: it only resumes a context Chrome suspended.
    unlock() {
      if (!ensure()) return false;
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      return true;
    },

    get ready() { return !!ctx; },
    get muted() { return muted; },

    setMuted(next) {
      muted = !!next;
      if (master && ctx) {
        master.gain.cancelScheduledValues(now());
        master.gain.setTargetAtTime(muted ? 0 : MASTER, now(), 0.02);
      }
      return muted;
    },

    toggleMute() {
      return api.setMuted(!muted);
    },

    // speed01 0..1, on toggles the drone; the pitch rises with the car and falls back at a stop
    engine(speed01, on) {
      if (!engine || !ctx) return;
      const t = now();
      const load = Math.max(0, Math.min(1, Number(speed01) || 0));
      const target = on ? 0.055 + load * 0.075 : 0;
      engine.gain.gain.setTargetAtTime(target, t, 0.08);
      engine.osc.frequency.setTargetAtTime(48 + load * 96, t, 0.10);
      engine.sub.frequency.setTargetAtTime(24 + load * 40, t, 0.10);
      engine.filter.frequency.setTargetAtTime(360 + load * 980, t, 0.12);
    },

    siren(on) {
      if (!siren || !ctx) return;
      siren.gain.gain.setTargetAtTime(on ? 0.055 : 0, now(), 0.25);
      if (on) siren.trem.frequency.setTargetAtTime(2.4, now(), 0.2);
    },

    horn() {
      blip(330, 0, 0.34, 'square', 0.22);
      blip(415, 0.02, 0.32, 'square', 0.16);
    },

    gunshot(power = 1) {
      burst(0.42 * Math.max(0.2, Math.min(1, power)), 0.18, 2600);
      blip(120, 0, 0.09, 'square', 0.14, -60);
    },

    hit(gain = 0.4) {
      burst(0.18 * Math.max(0.1, Math.min(1, gain)), 0.09, 900);
    },

    dry() {
      blip(900, 0, 0.05, 'square', 0.09);
    },

    reload() {
      blip(680, 0, 0.05, 'square', 0.10);
      blip(420, 0.12, 0.07, 'square', 0.09);
    },

    pickup(kind) {
      const base = kind === 'cash' ? 880 : kind === 'health' ? 660 : 740;
      blip(base, 0, 0.10, 'sine', 0.16);
      blip(base * 1.5, 0.09, 0.14, 'sine', 0.13);
    },

    // mission feedback: a three-note rise for a win, a two-note fall for a failure
    missionComplete() {
      blip(523.25, 0.0, 0.20, 'triangle', 0.20);
      blip(659.25, 0.17, 0.20, 'triangle', 0.20);
      blip(783.99, 0.34, 0.34, 'triangle', 0.22);
    },

    missionFail() {
      blip(220, 0.0, 0.24, 'sawtooth', 0.16, -40);
      blip(164.81, 0.20, 0.36, 'sawtooth', 0.14, -30);
    },

    ui() {
      blip(740, 0, 0.05, 'sine', 0.10);
    },

    // radio: stations are named in the HUD; the pad only runs while a car is being driven
    get station() { return STATIONS[stationIndex].name; },

    stationNext() {
      stationIndex = (stationIndex + 1) % STATIONS.length;
      if (radio && radio.playing) {
        stopRadioVoices();
        radio.filter.frequency.setTargetAtTime(STATIONS[stationIndex].cutoff, now(), 0.05);
        radio.step = 0;
      }
      return STATIONS[stationIndex].name;
    },

    radioOn(on) {
      if (!radio || !ctx) return;
      const playing = !!on;
      if (playing === radio.playing) return;
      radio.playing = playing;
      if (playing) {
        radio.filter.frequency.setTargetAtTime(STATIONS[stationIndex].cutoff, now(), 0.05);
        radio.gain.gain.setTargetAtTime(1, now(), 0.2);
        radio.step = 0;
        tickRadio();
      } else {
        radio.gain.gain.setTargetAtTime(0, now(), 0.15);
        if (radio.timer) clearTimeout(radio.timer);
        radio.timer = 0;
        stopRadioVoices();
      }
    },

    dispose() {
      if (radio && radio.timer) clearTimeout(radio.timer);
      stopRadioVoices();
      if (ctx && ctx.close) { try { ctx.close(); } catch (err) { /* closed */ } }
      ctx = null;
    },
  };

  return api;
}
