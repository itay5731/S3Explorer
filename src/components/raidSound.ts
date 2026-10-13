/**
 * Sound for the hidden raid game, synthesised with the Web Audio API so the game ships no audio files.
 * Every method is a silent no-op before start() and after dispose(), and never throws: a broken audio
 * device must not break the game.
 */
export interface RaidSound {
  /** Call from a user gesture (the first click); creates or resumes the AudioContext. */
  start(): void;
  /** Stops everything and closes the AudioContext. */
  dispose(): void;
  setMuted(muted: boolean): void;
  shot(): void;
  /** A tick when your bullet hits a guard; a headshot is a brighter double tick. */
  hit(headshot: boolean): void;
  kill(): void;
  /** pan -1..1 (left..right of the player), distance in cells: quieter and duller far away. */
  guardShot(pan: number, distance: number): void;
  hurt(): void;
  /** One footstep; steps never overlap themselves. */
  step(running: boolean): void;
  spotted(): void;
  progressTick(): void;
  done(): void;
  ding(): void;
  pickup(): void;
  reload(): void;
  empty(): void;
  /** A looping building alarm; off stops it. */
  alarm(on: boolean): void;
  win(): void;
  lose(): void;
}

const MASTER = 0.4;
/** Beyond this many live one-shots new ones are dropped, so a firefight cannot pile up nodes. */
const MAX_VOICES = 32;
const MAX_GUARD_SHOTS = 6;

interface Voice {
  c: AudioContext;
  t: number;
  out: GainNode;
  add<T extends AudioNode>(n: T): T;
  play(s: AudioScheduledSourceNode, at: number, until: number, offset?: number): void;
}

export function createRaidSound(): RaidSound {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let send: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  let muted = false;
  let disposed = false;
  let voices = 0;
  let guardShots = 0;
  let stepUntil = 0;
  let siren: { gain: GainNode; nodes: AudioNode[] } | null = null;

  const rnd = (a: number, b: number) => a + Math.random() * (b - a);

  function init() {
    const c = new AudioContext();
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    comp.connect(c.destination);
    master = c.createGain();
    master.gain.value = muted ? 0 : MASTER;
    master.connect(comp);

    // One shared short room: a decaying noise impulse, darkened so the tail does not hiss.
    const len = Math.floor(c.sampleRate * 0.9);
    const ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    const verb = c.createConvolver();
    verb.buffer = ir;
    const tone = c.createBiquadFilter();
    tone.frequency.value = 3500;
    const ret = c.createGain();
    ret.gain.value = 0.5;
    send = c.createGain();
    send.connect(verb).connect(tone).connect(ret).connect(master);

    noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const n = noise.getChannelData(0);
    for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1;
    ctx = c;
  }

  /** A one-shot's private chain; every node it creates is disconnected once its sources have ended. */
  function voice(level: number, rev: number, pan = 0): Voice | null {
    if (!ctx || !master || !send || muted || voices >= MAX_VOICES || ctx.state !== "running") return null;
    const c = ctx;
    const nodes: AudioNode[] = [];
    let pending = 0;
    let done = false;
    const add = <T extends AudioNode>(n: T) => (nodes.push(n), n);
    const out = add(c.createGain());
    out.gain.value = level;
    let tail: AudioNode = out;
    if (pan) {
      const p = add(c.createStereoPanner());
      p.pan.value = Math.max(-1, Math.min(1, pan));
      tail = out.connect(p);
    }
    tail.connect(master);
    if (rev) {
      const r = add(c.createGain());
      r.gain.value = rev;
      tail.connect(r).connect(send);
    }
    voices++;
    const finish = () => {
      if (done) return;
      done = true;
      voices--;
      for (const n of nodes) n.disconnect();
    };
    return {
      c,
      t: c.currentTime + 0.005,
      out,
      add,
      play(s, at, until, offset = 0) {
        pending++;
        add(s).addEventListener("ended", () => --pending === 0 && finish());
        if (s instanceof AudioBufferSourceNode) s.start(at, offset);
        else s.start(at);
        s.stop(until);
      },
    };
  }

  /** Attack then exponential decay; returns when the envelope is silent. */
  function env(g: GainNode, t: number, peak: number, a: number, d: number) {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    return t + a + d + 0.02;
  }

  function burst(v: Voice, t: number, type: BiquadFilterType, f: number, q: number, peak: number, a: number, d: number, dest: AudioNode = v.out) {
    const s = v.c.createBufferSource();
    s.buffer = noise;
    const fl = v.add(v.c.createBiquadFilter());
    fl.type = type;
    fl.frequency.value = f;
    fl.Q.value = q;
    const g = v.add(v.c.createGain());
    s.connect(fl).connect(g).connect(dest);
    // A random offset into the noise and a slight rate change, so repeats are never sample-identical.
    s.playbackRate.value = rnd(0.92, 1.08);
    v.play(s, t, env(g, t, peak, a, d), rnd(0, 0.4));
  }

  function tone(v: Voice, t: number, type: OscillatorType, f0: number, f1: number, peak: number, a: number, d: number, dest: AudioNode = v.out) {
    const o = v.c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + a + d);
    const g = v.add(v.c.createGain());
    o.connect(g).connect(dest);
    v.play(o, t, env(g, t, peak, a, d));
  }

  /** A struck bell: inharmonic partials that die faster the higher they are. */
  function bell(v: Voice, t: number, f: number, peak: number, d: number) {
    tone(v, t, "sine", f, f, peak, 0.002, d);
    tone(v, t, "sine", f * 2.76, f * 2.76, peak * 0.3, 0.002, d * 0.4);
    tone(v, t, "sine", f * 5.4, f * 5.4, peak * 0.12, 0.001, d * 0.15);
  }

  function notes(freqs: number[], gap: number, type: OscillatorType, peak: number, d: number, level: number) {
    const v = voice(level, 0.3);
    if (!v) return;
    freqs.forEach((f, i) => {
      tone(v, v.t + i * gap, type, f, f, peak, 0.005, d);
      tone(v, v.t + i * gap, "sine", f * 2, f * 2, peak * 0.2, 0.005, d * 0.5);
    });
  }

  function click(v: Voice, t: number, f: number, peak: number) {
    burst(v, t, "bandpass", f, 3, peak, 0.001, 0.02);
    tone(v, t, "square", f * 0.5, f * 0.4, peak * 0.15, 0.001, 0.012);
  }

  function gunshot(v: Voice, t: number, r: number, bright: number) {
    burst(v, t, "highpass", 2200 * r, 0.7, 0.9 * bright, 0.001, rnd(0.06, 0.09));
    burst(v, t, "lowpass", 1400 * r, 0.8, 1, 0.001, rnd(0.14, 0.2));
    tone(v, t, "sine", 160 * r, 42, 1, 0.002, 0.16);
  }

  const ops = {
    start() {
      if (disposed) return;
      if (!ctx) init();
      if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
    },
    dispose() {
      if (disposed) return;
      ops.alarm(false);
      disposed = true;
      if (ctx) void ctx.close().catch(() => {});
      ctx = master = send = null;
      noise = null;
    },
    setMuted(m: boolean) {
      muted = m;
      if (ctx && master) master.gain.setTargetAtTime(m ? 0 : MASTER, ctx.currentTime, 0.02);
    },
    shot() {
      const v = voice(0.9, 0.35);
      if (!v) return;
      gunshot(v, v.t, rnd(0.9, 1.1), 1);
      // The slide cycling, just after the bang.
      burst(v, v.t + rnd(0.05, 0.07), "bandpass", 4200, 4, 0.12, 0.001, 0.025);
    },
    guardShot(pan: number, distance: number) {
      if (guardShots >= MAX_GUARD_SHOTS) return;
      const d = Math.max(0, Math.min(40, distance || 0));
      const v = voice(0.75 / (1 + d * 0.22), Math.min(0.9, 0.3 + d * 0.04), pan);
      if (!v) return;
      guardShots++;
      const muffle = v.add(v.c.createBiquadFilter());
      muffle.frequency.value = Math.max(450, 7000 / (1 + d * 0.45));
      muffle.connect(v.out);
      // Roughly the sound's travel time across the cells.
      const t = v.t + d * 0.008;
      const r = rnd(0.85, 1.05);
      burst(v, t, "highpass", 2000 * r, 0.7, 0.7, 0.001, 0.07, muffle);
      burst(v, t, "lowpass", 1200 * r, 0.8, 1, 0.001, 0.17, muffle);
      tone(v, t, "sine", 140 * r, 40, 0.9, 0.002, 0.15, muffle);
      setTimeout(() => guardShots--, 250 + d * 8);
    },
    hit(headshot: boolean) {
      const v = voice(0.5, 0.1);
      if (!v) return;
      tone(v, v.t, "triangle", 1900, 1500, 0.4, 0.001, 0.045);
      burst(v, v.t, "highpass", 5000, 0.7, 0.3, 0.001, 0.02);
      if (headshot) {
        tone(v, v.t + 0.055, "triangle", 2700, 2300, 0.45, 0.001, 0.06);
        burst(v, v.t + 0.055, "highpass", 6000, 0.7, 0.3, 0.001, 0.025);
      }
    },
    kill() {
      const v = voice(0.7, 0.25);
      if (!v) return;
      // A body dropping on the floor, a beat after the shot.
      const t = v.t + 0.12;
      tone(v, t, "sine", 95, 38, 0.9, 0.004, 0.3);
      burst(v, t, "lowpass", 380, 0.8, 0.8, 0.004, 0.25);
      burst(v, t + 0.09, "lowpass", 600, 0.8, 0.35, 0.003, 0.12);
    },
    hurt() {
      const v = voice(0.7, 0.15);
      if (!v) return;
      tone(v, v.t, "sine", 120, 45, 1, 0.002, 0.22);
      burst(v, v.t, "bandpass", 700, 1.2, 0.8, 0.002, 0.14);
      tone(v, v.t, "sawtooth", 230, 160, 0.12, 0.01, 0.2);
    },
    step(running: boolean) {
      if (!ctx || ctx.currentTime < stepUntil) return;
      const v = voice(running ? 0.45 : 0.3, 0.12);
      if (!v) return;
      stepUntil = v.t + (running ? 0.08 : 0.12);
      const r = rnd(0.85, 1.15);
      burst(v, v.t, "lowpass", 260 * r, 1, 0.9, 0.002, running ? 0.05 : 0.07);
      burst(v, v.t + 0.012, "bandpass", 1500 * r, 1.5, 0.35, 0.001, running ? 0.025 : 0.035);
    },
    spotted() {
      const v = voice(0.35, 0.3);
      if (!v) return;
      const lp = v.add(v.c.createBiquadFilter());
      lp.frequency.value = 3200;
      lp.connect(v.out);
      tone(v, v.t, "sawtooth", 520, 1040, 0.5, 0.004, 0.09, lp);
      tone(v, v.t + 0.1, "square", 1040, 1040, 0.35, 0.003, 0.22, lp);
      tone(v, v.t + 0.1, "sawtooth", 1560, 1560, 0.25, 0.003, 0.22, lp);
    },
    progressTick() {
      const v = voice(0.18, 0.1);
      if (v) tone(v, v.t, "sine", 1320, 1320, 1, 0.003, 0.05);
    },
    done: () => notes([523, 659, 784, 1047], 0.07, "triangle", 0.5, 0.45, 0.4),
    ding() {
      const v = voice(0.35, 0.35);
      if (!v) return;
      bell(v, v.t, 1319, 0.8, 1.4);
      bell(v, v.t + 0.35, 1047, 0.8, 1.8);
    },
    pickup: () => notes([784, 1175], 0.06, "triangle", 0.45, 0.18, 0.35),
    reload() {
      const v = voice(0.6, 0.15);
      if (!v) return;
      click(v, v.t, 2600, 0.6);
      click(v, v.t + 0.2, 1900, 0.8);
      burst(v, v.t + 0.2, "lowpass", 500, 1, 0.4, 0.002, 0.05);
    },
    empty() {
      const v = voice(0.5, 0.1);
      if (v) click(v, v.t, 3400, 0.6);
    },
    alarm(on: boolean) {
      if (!on) {
        if (!siren) return;
        const s = siren;
        siren = null;
        if (ctx) s.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
        setTimeout(() => {
          for (const n of s.nodes) {
            if (n instanceof OscillatorNode) n.stop();
            n.disconnect();
          }
        }, 300);
        return;
      }
      if (siren || !ctx || !master || !send) return;
      const c = ctx;
      // A two-tone wail: a slow LFO sweeps two detuned square waves through a soft lowpass.
      const gain = c.createGain();
      gain.gain.value = 0;
      gain.gain.setTargetAtTime(0.13, c.currentTime, 0.1);
      const lp = c.createBiquadFilter();
      lp.frequency.value = 2200;
      const lfo = c.createOscillator();
      lfo.type = "triangle";
      lfo.frequency.value = 0.55;
      const depth = c.createGain();
      depth.gain.value = 180;
      lfo.connect(depth);
      const nodes: AudioNode[] = [gain, lp, lfo, depth];
      for (const f of [740, 744]) {
        const o = c.createOscillator();
        o.type = "square";
        o.frequency.value = f;
        depth.connect(o.frequency);
        o.connect(lp);
        o.start();
        nodes.push(o);
      }
      lfo.start();
      const r = c.createGain();
      r.gain.value = 0.3;
      nodes.push(r);
      lp.connect(gain).connect(master);
      gain.connect(r).connect(send);
      siren = { gain, nodes };
    },
    win: () => notes([392, 523, 659, 784, 1047], 0.12, "triangle", 0.5, 0.9, 0.45),
    lose: () => notes([392, 311, 262, 196], 0.22, "sawtooth", 0.25, 0.8, 0.35),
  };

  // Wrap every method: audio failures are swallowed so the game never sees them.
  const safe = {} as RaidSound;
  for (const [k, f] of Object.entries(ops) as [keyof RaidSound, (...a: unknown[]) => void][]) {
    (safe as unknown as Record<string, (...a: unknown[]) => void>)[k] = (...a) => {
      try {
        f(...a);
      } catch {
        /* audio is decoration */
      }
    };
  }
  return safe;
}
