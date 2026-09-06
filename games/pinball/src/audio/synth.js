// AUDIO-T11 (design doc §3.2): one AudioContext, unlocked on the first gesture, a bounded
// voice pool, and one noise buffer generated at init. DOM/Web-Audio-only — never imported by
// physics/table/rules, same boundary ui/input.js and ui/callouts.js already keep, and for the
// same reason: nothing here can be unit-tested under `node --test` (no AudioContext in a bare
// Node process), so it's kept small and browser-verified rather than pretending otherwise.
//
// VOICE POOL, and why 12: a pinball table produces many overlapping short sounds — up to 4
// balls in play at once (FIELD DAY), each capable of triggering a mechanism hit (a bumper, a
// sling) in the SAME physics tick, plus a named "moment" cue (a jackpot, a lock) layering on
// top of whatever mechanism sounds that same tick produced. Web Audio's OscillatorNode and
// AudioBufferSourceNode are both one-shot by spec — neither can be restarted after `stop()`,
// so a literal "reuse the same oscillator object" pool is impossible; what actually prevents
// the stutter the dispatch warns about is bounding how many sound-graphs can be ACTIVE at
// once, not reusing node objects (a stopped node's own garbage collection is cheap and not
// itself the risk — an unbounded pile of simultaneously-processing nodes overloading the
// audio thread's per-block budget is). 12 concurrent voices is a judgment call sized for a
// hectic 4-ball moment (4 balls, each machine-gunning a bumper, plus 2-3 named cues layered
// on top, with headroom to spare) — not a sourced figure, since no reference exists for how
// many simultaneous voices a browser's audio thread can carry before audible stress on the
// devices this actually needs to run on. A 13th trigger steals the SOONEST-to-finish voice
// (least perceptually disruptive) rather than being refused or silently piling up.
const VOICE_POOL_SIZE = 12;

function createNoiseBuffer(ctx, seconds = 1) {
  const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

export function createSynth() {
  let ctx = null;
  let masterGain = null;
  let noiseBuffer = null;
  let muted = false;
  // Each slot tracks the AudioContext time its current sound-graph is expected to finish —
  // 0 initially (immediately "free"). Triggering a sound claims the slot with the smallest
  // freeAt (the one soonest done, or already done) and fades/stops whatever was still
  // sounding there before starting the new graph, so a busy moment degrades by cutting the
  // least-noticeable tail rather than refusing the newest sound or growing unbounded.
  const voiceSlots = Array.from({ length: VOICE_POOL_SIZE }, () => ({ freeAt: 0, stopFns: [] }));

  function claimVoice(durationS) {
    let slot = voiceSlots[0];
    for (const s of voiceSlots) if (s.freeAt < slot.freeAt) slot = s;
    const now = ctx.currentTime;
    if (slot.freeAt > now) {
      // Steal: cut whatever's still ringing here, fast enough to avoid an audible click but
      // fast enough not to overlap the new graph for more than a few milliseconds.
      for (const stop of slot.stopFns) stop(now);
    }
    slot.freeAt = now + durationS;
    slot.stopFns = [];
    return slot;
  }

  /** Lazily creates the AudioContext and unlocks it — MUST be called synchronously inside a
   * real user-gesture handler (a touchstart/pointerdown/keydown listener), never on a delay
   * or inside a promise continuation, or iOS Safari refuses the unlock. Idempotent: safe to
   * call on every gesture (a real page wires this to several event types since it doesn't
   * know in advance which one the player's first touch will be — see main.js), only the
   * first call actually does anything. Never calls preventDefault/stopPropagation and is
   * always registered as a SEPARATE listener from the game's own input handling (never
   * inline in it) — the gesture that unlocks audio must still reach the flipper/plunger
   * logic main.js and ui/input.js own. */
  function unlock() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return; // no Web Audio support — silently do nothing, never throw over sound
    ctx = new AC();
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : 1;
    masterGain.connect(ctx.destination);
    noiseBuffer = createNoiseBuffer(ctx, 1);
    // The actual iOS unlock trick the design doc names: play one silent buffer synchronously
    // inside this same gesture — this is what actually flips the context from "requires a
    // gesture" to "will play" on Safari, resume() alone is not always sufficient there.
    const silent = ctx.createBuffer(1, 1, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = silent;
    src.connect(ctx.destination);
    src.start(0);
    if (ctx.state === 'suspended') ctx.resume();
  }

  function setMuted(next) {
    muted = next;
    if (masterGain) masterGain.gain.value = muted ? 0 : 1;
  }

  function isReady() {
    return ctx !== null;
  }

  /** A single oscillator voice with a linear/exponential gain envelope and an optional
   * lowpass filter — the shared building block every tonal cue (boing, chime, bell, blip)
   * composes from. `freq`/`endFreq` (Hz), `type` (oscillator waveform), `duration` (s),
   * `peakGain` (0..1), `filterHz` (optional lowpass cutoff), `detune` (cents). */
  function playTone({ freq, endFreq = freq, type = 'sine', duration = 0.15, peakGain = 0.3, filterHz = null, detune = 0, delay = 0 }) {
    if (!ctx) return;
    const slot = claimVoice(delay + duration);
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t0 + duration);
    osc.detune.value = detune;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peakGain, t0 + Math.min(0.01, duration / 4));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    let node = osc;
    if (filterHz) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = filterHz;
      node.connect(filter);
      node = filter;
    }
    node.connect(gain);
    gain.connect(masterGain);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
    slot.stopFns.push((atTime) => {
      try {
        gain.gain.cancelScheduledValues(atTime);
        gain.gain.setValueAtTime(gain.gain.value, atTime);
        gain.gain.linearRampToValueAtTime(0, atTime + 0.01);
        osc.stop(atTime + 0.015);
      } catch { /* already stopped — nothing to steal */ }
    });
  }

  /** Two-operator FM bell: a carrier modulated by a second oscillator at `ratio`x its own
   * frequency — the "recess bell" cue's own building block (§3.2: "FM bell, two operators"). */
  function playBell({ freq = 660, ratio = 2.4, modIndex = 220, duration = 0.9, peakGain = 0.35 }) {
    if (!ctx) return;
    const slot = claimVoice(duration);
    const t0 = ctx.currentTime;
    const carrier = ctx.createOscillator();
    carrier.frequency.value = freq;
    const modulator = ctx.createOscillator();
    modulator.frequency.value = freq * ratio;
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(modIndex, t0);
    modGain.gain.exponentialRampToValueAtTime(1, t0 + duration);
    modulator.connect(modGain);
    modGain.connect(carrier.frequency);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peakGain, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    carrier.connect(gain);
    gain.connect(masterGain);
    carrier.start(t0);
    modulator.start(t0);
    carrier.stop(t0 + duration + 0.02);
    modulator.stop(t0 + duration + 0.02);
    slot.stopFns.push((atTime) => {
      try {
        gain.gain.cancelScheduledValues(atTime);
        gain.gain.setValueAtTime(gain.gain.value, atTime);
        gain.gain.linearRampToValueAtTime(0, atTime + 0.01);
        carrier.stop(atTime + 0.015);
        modulator.stop(atTime + 0.015);
      } catch { /* already stopped */ }
    });
  }

  /** A filtered burst from the one shared noise buffer (§3.2: "filtered noise burst" for the
   * scoop thud, "short noise" for the knocker) — a fresh AudioBufferSourceNode per call (also
   * one-shot by spec) reading the SAME pre-generated PCM data, so the expensive part (filling
   * a second of random samples) happens once at unlock, never per trigger. */
  function playNoiseBurst({ duration = 0.12, filterHz = 1200, filterType = 'lowpass', peakGain = 0.3 }) {
    if (!ctx) return;
    const slot = claimVoice(duration);
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterHz;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peakGain, t0 + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);
    src.start(t0);
    src.stop(t0 + duration + 0.02);
    slot.stopFns.push((atTime) => {
      try {
        gain.gain.cancelScheduledValues(atTime);
        gain.gain.setValueAtTime(gain.gain.value, atTime);
        gain.gain.linearRampToValueAtTime(0, atTime + 0.01);
        src.stop(atTime + 0.015);
      } catch { /* already stopped */ }
    });
  }

  return { unlock, setMuted, isReady, playTone, playBell, playNoiseBurst };
}
