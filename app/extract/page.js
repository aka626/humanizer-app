"use client";
import { useState, useRef, useEffect } from "react";
import { createClient } from "../../utils/supabase/client";

const MODEL_URL = "/basic-pitch/model.json";
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const midiToName = (m) => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);

export default function Extract() {
  const [user, setUser] = useState(undefined);
  const [isOwner, setIsOwner] = useState(false);
  const [credits, setCredits] = useState(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [notes, setNotes] = useState(null);
  const [anchors, setAnchors] = useState(null);
  const [waveType, setWaveType] = useState(null);
  const [playing, setPlaying] = useState(null); // null | "original" | "midi" | "voice"
  const [buyNeeded, setBuyNeeded] = useState(false);
  const [fileName, setFileName] = useState("");

  const acRef = useRef(null);
  const authRef = useRef(null);
  const bufferRef = useRef(null);
  const paidMidRef = useRef(false);
  const paidPackRef = useRef(false);
  const toneRef = useRef(null);
  const synthRef = useRef(null);
  const samplerRef = useRef(null);
  const anchorUrlsRef = useRef(null);
  const srcRef = useRef(null);
  const stopTimerRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const auth = createClient();
    authRef.current = auth;
    auth.auth.getUser().then(({ data }) => {
      const u = data && data.user ? data.user : null;
      setUser(u);
      if (u) {
        fetch("/api/credits").then((r) => r.json()).then((j) => {
          if (j && j.ok) { setIsOwner(!!j.isOwner); setCredits(j.balance); }
        }).catch(() => {});
      }
    });
  }, []);

  async function signOut() {
    if (authRef.current) await authRef.current.auth.signOut();
    setUser(null);
    stopAll();
  }

  const ctx = () => {
    if (!acRef.current) acRef.current = new (window.AudioContext || window.webkitAudioContext)();
    return acRef.current;
  };

  /* ---------------- timbre analysis (ported from the Python rebuilder) --------------- */
  function fft(re, im) {
    const n = re.length;
    if (n <= 1) return;
    const half = n / 2;
    const er = new Float64Array(half), ei = new Float64Array(half);
    const or_ = new Float64Array(half), oi = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      er[i] = re[2 * i]; ei[i] = im[2 * i];
      or_[i] = re[2 * i + 1]; oi[i] = im[2 * i + 1];
    }
    fft(er, ei); fft(or_, oi);
    for (let k = 0; k < half; k++) {
      const ang = (-2 * Math.PI * k) / n;
      const cr = Math.cos(ang), ci = Math.sin(ang);
      const tr = cr * or_[k] - ci * oi[k];
      const ti = cr * oi[k] + ci * or_[k];
      re[k] = er[k] + tr; im[k] = ei[k] + ti;
      re[k + half] = er[k] - tr; im[k + half] = ei[k] - ti;
    }
  }

  function analyzeTimbre(buf) {
    const data = buf.getChannelData(0);
    const sr = buf.sampleRate;
    const win = 2048;
    const hops = 24;
    let centroidSum = 0, flatnessSum = 0, frames = 0;
    for (let h = 0; h < hops; h++) {
      const start = Math.floor((data.length - win) * (h / hops));
      if (start < 0) break;
      const re = new Float64Array(win), im = new Float64Array(win);
      for (let i = 0; i < win; i++) {
        re[i] = data[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1)));
      }
      fft(re, im);
      let sum = 0, weighted = 0, logSum = 0, nonzero = 0;
      for (let k = 1; k < win / 2; k++) {
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        const freq = (k * sr) / win;
        sum += mag;
        weighted += mag * freq;
        if (mag > 0) { logSum += Math.log(mag); nonzero++; }
      }
      if (sum > 0 && nonzero > 0) {
        centroidSum += weighted / sum;
        const geoMean = Math.exp(logSum / nonzero);
        const ariMean = sum / nonzero;
        flatnessSum += ariMean > 0 ? geoMean / ariMean : 0;
        frames++;
      }
    }
    const meanCentroid = frames ? centroidSum / frames : 1000;
    const meanFlatness = frames ? flatnessSum / frames : 0;
    if (meanFlatness > 0.04) return "sawtooth";
    if (meanCentroid > 2200) return "square";
    return "triangle";
  }

  /* ---------------- anchor detection: cleanly isolated notes --------------- */
  function findAnchors(list, buf) {
    const margin = 0.03;
    const candidates = list.filter((n) => {
      if (n.duration < 0.15 || n.velocity < 0.2) return false;
      const s = n.time - margin;
      const e = n.time + Math.min(n.duration, 1.2) + margin;
      return !list.some((m) => m !== n && m.time < e && m.time + m.duration > s);
    });
    if (candidates.length === 0) return [];
    const byPitch = [...candidates].sort((a, b) => a.midi - b.midi);
    const picks = [];
    const wants = [0, 0.25, 0.5, 0.75, 1];
    for (const q of wants) {
      const cand = byPitch[Math.min(byPitch.length - 1, Math.round(q * (byPitch.length - 1)))];
      if (!picks.some((p) => Math.abs(p.midi - cand.midi) < 3)) picks.push(cand);
    }
    return picks
      .sort((a, b) => a.midi - b.midi)
      .map((n) => ({
        midi: n.midi,
        name: midiToName(n.midi),
        time: n.time,
        duration: Math.min(n.duration, 1.5, buf.duration - n.time),
      }));
  }

  /* ---------------- WAV slicing --------------- */
  function sliceToWav(buf, startSec, durSec) {
    const sr = buf.sampleRate;
    const ch = buf.numberOfChannels;
    const start = Math.max(0, Math.floor(startSec * sr));
    const len = Math.min(Math.floor(durSec * sr), buf.length - start);
    const fadeIn = Math.min(Math.floor(0.005 * sr), len);
    const fadeOut = Math.min(Math.floor(0.06 * sr), len);
    const chans = [];
    for (let c = 0; c < ch; c++) {
      const src = buf.getChannelData(c);
      const out = new Float32Array(len);
      out.set(src.subarray(start, start + len));
      for (let i = 0; i < fadeIn; i++) out[i] *= i / fadeIn;
      for (let i = 0; i < fadeOut; i++) out[len - 1 - i] *= i / fadeOut;
      chans.push(out);
    }
    const blockAlign = ch * 2;
    const dataSize = len * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize);
    const dv = new DataView(ab);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); dv.setUint32(4, 36 + dataSize, true); w(8, "WAVE"); w(12, "fmt ");
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * blockAlign, true);
    dv.setUint16(32, blockAlign, true); dv.setUint16(34, 16, true);
    w(36, "data"); dv.setUint32(40, dataSize, true);
    let off = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < ch; c++) {
        let x = chans[c][i];
        if (x > 1) x = 1; if (x < -1) x = -1;
        dv.setInt16(off, (x < 0 ? x * 0x8000 : x * 0x7fff) | 0, true);
        off += 2;
      }
    }
    return new Blob([ab], { type: "audio/wav" });
  }

  function anchorBlobs() {
    if (anchorUrlsRef.current) return anchorUrlsRef.current;
    const out = anchors.map((a) => {
      const blob = sliceToWav(bufferRef.current, a.time, a.duration);
      return { ...a, blob, url: URL.createObjectURL(blob) };
    });
    anchorUrlsRef.current = out;
    return out;
  }

  function buildSfz(list) {
    let out = "// First Take Audio - voice of your track\n// Load in Sforzando (free) or any SFZ player.\n\n<control>\ndefault_path=samples/\n\n<group>\nampeg_release=0.25\n\n";
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const lo = i === 0 ? 0 : Math.ceil((list[i - 1].midi + a.midi) / 2);
      const hi = i === list.length - 1 ? 127 : Math.floor((a.midi + list[i + 1].midi) / 2);
      out += `<region>\nsample=${a.name}.wav\npitch_keycenter=${a.midi}\nlokey=${lo}\nhikey=${hi}\n\n`;
    }
    return out;
  }

  /* ---------------- transcription --------------- */
  async function resampleTo22050Mono(buf) {
    const len = Math.ceil(buf.duration * 22050);
    const oc = new OfflineAudioContext(1, len, 22050);
    const src = oc.createBufferSource();
    src.buffer = buf;
    src.connect(oc.destination);
    src.start();
    return await oc.startRendering();
  }

  async function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    stopAll();
    setBusy(true); setNotes(null); setAnchors(null); setBuyNeeded(false); setProgress(0);
    paidMidRef.current = false;
    paidPackRef.current = false;
    if (anchorUrlsRef.current) {
      anchorUrlsRef.current.forEach((a) => URL.revokeObjectURL(a.url));
      anchorUrlsRef.current = null;
    }
    if (samplerRef.current) { try { samplerRef.current.dispose(); } catch {} samplerRef.current = null; }
    setFileName(file.name);
    try {
      setStatus("Reading your track...");
      const arr = await file.arrayBuffer();
      const buf = await ctx().decodeAudioData(arr);
      bufferRef.current = buf;
      if (buf.duration > 360) {
        throw new Error("Tracks over 6 minutes are too heavy for in-browser transcription. Try a shorter piece or a single stem.");
      }

      setStatus("Listening for the track's character...");
      const wt = analyzeTimbre(buf);
      setWaveType(wt);

      setStatus("Loading the transcription engine (first time takes a moment)...");
      const bp = await import("@spotify/basic-pitch");

      setStatus("Preparing audio...");
      const mono = await resampleTo22050Mono(buf);

      setStatus("Transcribing notes... 0%");
      const frames = [], onsets = [], contours = [];
      const model = new bp.BasicPitch(MODEL_URL);
      await model.evaluateModel(
        mono,
        (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); },
        (pct) => {
          const p = Math.round(pct * 100);
          setProgress(p);
          setStatus(`Transcribing notes... ${p}%`);
        }
      );

      setStatus("Building the note list...");
      const rawNotes = bp.noteFramesToTime(
        bp.addPitchBendsToNoteEvents(
          contours,
          bp.outputToNotesPoly(frames, onsets, 0.25, 0.25, 11)
        )
      );
      const cleaned = rawNotes
        .filter((n) => n.durationSeconds > 0.03)
        .map((n) => ({
          midi: n.pitchMidi,
          time: n.startTimeSeconds,
          duration: n.durationSeconds,
          velocity: Math.min(1, Math.max(0.1, n.amplitude)),
        }))
        .sort((a, b) => a.time - b.time);

      if (cleaned.length === 0) throw new Error("No clear notes found. This works best on melodies, basslines, and leads.");

      const found = findAnchors(cleaned, buf);
      setNotes(cleaned);
      setAnchors(found);
      setStatus(
        `Done. ${cleaned.length} notes found. ` +
        (found.length > 0
          ? `Voice pack ready: ${found.length} samples pulled from your track.`
          : `No cleanly isolated notes for a voice pack — dense mixes blend together. A single stem works best.`)
      );
      setTimeout(() => drawRoll(cleaned), 50);
    } catch (err) {
      setStatus("Error: " + err.message);
    }
    setBusy(false);
  }

  /* ---------------- piano roll --------------- */
  function drawRoll(list) {
    const canvas = canvasRef.current;
    if (!canvas || !list) return;
    const W = canvas.width, H = canvas.height;
    const g = canvas.getContext("2d");
    g.fillStyle = "#080b16";
    g.fillRect(0, 0, W, H);
    const tMax = Math.max(...list.map((n) => n.time + n.duration));
    let lo = 127, hi = 0;
    list.forEach((n) => { if (n.midi < lo) lo = n.midi; if (n.midi > hi) hi = n.midi; });
    lo = Math.max(0, lo - 2); hi = Math.min(127, hi + 2);
    const rows = hi - lo + 1;
    const rowH = H / rows;
    for (let m = lo; m <= hi; m++) {
      const isBlack = [1, 3, 6, 8, 10].includes(m % 12);
      g.fillStyle = isBlack ? "#0a0e1c" : "#0c1122";
      g.fillRect(0, H - (m - lo + 1) * rowH, W, rowH);
    }
    list.forEach((n) => {
      const x = (n.time / tMax) * W;
      const w = Math.max(2, (n.duration / tMax) * W);
      const y = H - (n.midi - lo + 1) * rowH;
      g.fillStyle = `rgba(61, 240, 255, ${0.35 + n.velocity * 0.65})`;
      g.fillRect(x, y + 1, w, Math.max(2, rowH - 2));
    });
  }

  /* ---------------- playback --------------- */
  function stopAll() {
    if (stopTimerRef.current) { clearTimeout(stopTimerRef.current); stopTimerRef.current = null; }
    if (srcRef.current) { try { srcRef.current.stop(); } catch {} srcRef.current = null; }
    if (synthRef.current) { try { synthRef.current.releaseAll(); } catch {} }
    if (samplerRef.current) { try { samplerRef.current.releaseAll(); } catch {} }
    setPlaying(null);
  }

  async function playOriginal() {
    if (playing) { stopAll(); return; }
    const oc = ctx(); await oc.resume();
    const s = oc.createBufferSource();
    s.buffer = bufferRef.current;
    s.connect(oc.destination);
    s.start();
    srcRef.current = s;
    setPlaying("original");
    stopTimerRef.current = setTimeout(() => stopAll(), bufferRef.current.duration * 1000 + 200);
  }

  function scheduleNotes(Tone, instrument) {
    const now = Tone.now() + 0.1;
    notes.forEach((n) => {
      instrument.triggerAttackRelease(
        Tone.Frequency(n.midi, "midi").toFrequency(),
        Math.max(0.05, n.duration),
        now + n.time,
        n.velocity
      );
    });
    const total = Math.max(...notes.map((n) => n.time + n.duration));
    stopTimerRef.current = setTimeout(() => stopAll(), total * 1000 + 400);
  }

  async function playMidi() {
    if (playing) { stopAll(); return; }
    const Tone = await import("tone");
    toneRef.current = Tone;
    await Tone.start();
    if (!synthRef.current) {
      synthRef.current = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: waveType || "triangle" },
        envelope: { attack: 0.01, decay: 0.05, sustain: 0.8, release: 0.04 },
        volume: -8,
      }).toDestination();
    } else {
      synthRef.current.set({ oscillator: { type: waveType || "triangle" } });
    }
    setPlaying("midi");
    scheduleNotes(Tone, synthRef.current);
  }

  async function playVoice() {
    if (playing) { stopAll(); return; }
    if (!anchors || anchors.length === 0) return;
    const Tone = await import("tone");
    toneRef.current = Tone;
    await Tone.start();
    if (!samplerRef.current) {
      setStatus("Building the voice from your track...");
      const urls = {};
      anchorBlobs().forEach((a) => { urls[a.name] = a.url; });
      samplerRef.current = new Tone.Sampler(urls, { release: 0.25, volume: -4 }).toDestination();
      await Tone.loaded();
      setStatus("Voice ready.");
    }
    setPlaying("voice");
    scheduleNotes(Tone, samplerRef.current);
  }

  /* ---------------- payment gates --------------- */
  async function spendOne(paidRef) {
    if (isOwner || paidRef.current) return true;
    try {
      const res = await fetch("/api/spend-download", { method: "POST" });
      const json = await res.json();
      if (json && json.ok) { paidRef.current = true; return true; }
      if (json && json.needCredits) {
        setBuyNeeded(true);
        setStatus(json.error || "You're out of credits.");
        return false;
      }
      setStatus("Error: " + ((json && json.error) || "Could not unlock download."));
      return false;
    } catch (err) {
      setStatus("Error: " + err.message);
      return false;
    }
  }

  async function makeMidiBlob() {
    const { Midi } = await import("@tonejs/midi");
    const midi = new Midi();
    const track = midi.addTrack();
    notes.forEach((n) => {
      track.addNote({ midi: n.midi, time: n.time, duration: n.duration, velocity: n.velocity });
    });
    return new Blob([midi.toArray()], { type: "audio/midi" });
  }

  async function downloadMidi() {
    if (!notes) return;
    if (!(await spendOne(paidMidRef))) return;
    setStatus("Writing your MIDI file...");
    try {
      const blob = await makeMidiBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const base = (fileName || "track").replace(/\.[^.]+$/, "");
      a.href = url; a.download = `${base}.mid`; a.click();
      setStatus(`Downloaded ${base}.mid`);
    } catch (err) {
      setStatus("MIDI error: " + err.message);
    }
  }

  async function downloadPack() {
    if (!notes || !anchors || anchors.length === 0) return;
    if (!(await spendOne(paidPackRef))) return;
    setStatus("Building your voice pack...");
    try {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      const base = (fileName || "track").replace(/\.[^.]+$/, "");
      zip.file(`${base}.mid`, await makeMidiBlob());
      zip.file("instrument.sfz", buildSfz(anchors));
      const folder = zip.folder("samples");
      anchorBlobs().forEach((a) => { folder.file(`${a.name}.wav`, a.blob); });
      zip.file(
        "README.txt",
        `FIRST TAKE AUDIO - VOICE PACK\n` +
        `Track: ${fileName}\n\n` +
        `WHAT'S INSIDE\n` +
        `${base}.mid - the notes we heard in your track\n` +
        `samples/ - ${anchors.length} clean note slices cut from your original audio\n` +
        `instrument.sfz - an instrument that plays those slices at any pitch\n\n` +
        `HOW TO USE\n` +
        `Option 1 (any DAW): install the free Sforzando plugin, load instrument.sfz,\n` +
        `put the .mid on the same track. Edit the notes; the sound stays yours.\n\n` +
        `Option 2 (Ableton): drop the .mid on a MIDI track, then drop a sample from\n` +
        `samples/ into Simpler on that track. Simpler repitches it as you play.\n\n` +
        `The slices came from moments where one note rang alone, so they carry your\n` +
        `track's real tone. Notes far from a slice's pitch will sound stretched -\n` +
        `that is the physics of repitching, not a bug.\n`
      );
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${base}-voice-pack.zip`; a.click();
      setStatus(`Downloaded ${base}-voice-pack.zip`);
    } catch (err) {
      setStatus("Pack error: " + err.message);
    }
  }

  /* ---------------- render --------------- */
  return (
    <div style={S.page}>
      <video autoPlay muted loop playsInline style={S.video}>
        <source src="/bg.mp4" type="video/mp4" />
      </video>
      <div style={S.overlay} />

      <div style={S.topBar}>
        <div>
          <a href="https://firsttakeaudio.com" style={{ color: "#8ea2c8", fontSize: 13, textDecoration: "none" }}>← Dashboard</a>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 10 }}>
            <div style={S.logoBox}>
              <svg width="30" height="30" viewBox="0 0 26 26" fill="none">
                <rect x="2" y="10" width="2.5" height="6" rx="1.25" fill="#3df0ff"/>
                <rect x="6.5" y="6" width="2.5" height="14" rx="1.25" fill="#3df0ff"/>
                <rect x="11" y="2" width="2.5" height="22" rx="1.25" fill="#2b6cff"/>
                <rect x="15.5" y="7" width="2.5" height="12" rx="1.25" fill="#3df0ff"/>
                <rect x="20" y="11" width="2.5" height="4" rx="1.25" fill="#3df0ff"/>
              </svg>
            </div>
            <div>
              <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.5px", lineHeight: 1.1 }}>
                First Take <span style={{ color: "#3df0ff" }}>MIDI Extractor</span>
              </div>
              <div style={{ fontSize: 12, color: "#8ea2c8", letterSpacing: "1.5px", textTransform: "uppercase", marginTop: 2 }}>Keep the sound. Rewrite the notes.</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>
                <a href="https://firsttakeaudio.com/forge" style={{ color: "#3df0ff", textDecoration: "none" }}>Music Forge →</a>
                <span style={{ color: "#54688a" }}> · </span>
                <a href="/" style={{ color: "#3df0ff", textDecoration: "none" }}>Humanizer →</a>
              </div>
              <div style={{ fontSize: 11, color: "#54688a", marginTop: 4 }}>
                Works best on melodies, basslines, leads, and single stems. Dense full mixes come out approximate.
              </div>
            </div>
          </div>
        </div>

        {user === undefined && (
          <div style={S.dropText}>Loading…</div>
        )}

        {user === null && (
          <a href="/login" style={S.drop}>
            <span style={S.dropText}>Log in to extract MIDI</span>
          </a>
        )}

        {user && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
            <label style={S.drop}>
              <input type="file" accept="audio/*" onChange={handleFile} disabled={busy} style={{ display: "none" }} />
              <span style={S.dropText}>{busy ? "Working..." : "＋ Choose an audio file"}</span>
            </label>
            <div style={{ color: "#3df0ff", fontSize: 13, fontWeight: 700 }}>
              Previews are free. The .mid costs 1 credit. The voice pack costs 1 more.
            </div>
            <div style={S.account}>
              <a href="https://firsttakeaudio.com/buy" target="_blank" rel="noopener noreferrer" style={S.creditChip}>
                {isOwner ? "∞ credits" : credits === null ? "…" : `${credits} credit${credits === 1 ? "" : "s"}`}
              </a>
              <span style={{ color: "#8ea2c8" }}>{user.email}</span>
              <button onClick={signOut} style={S.linkBtn}>Log out</button>
            </div>
          </div>
        )}
      </div>

      <div style={S.contentWrap}>

        {status && <p style={S.status}>{status}</p>}
        {busy && progress > 0 && (
          <div style={S.progressTrack}>
            <div style={{ ...S.progressBar, width: `${progress}%` }} />
          </div>
        )}
        {buyNeeded && (
          <a href="https://firsttakeaudio.com/buy" target="_blank" rel="noopener noreferrer" style={S.buyBtn}>
            Buy credits →
          </a>
        )}

        {notes && (
          <div style={S.card}>
            <canvas ref={canvasRef} width={1200} height={320} style={S.canvas} />
            <div style={S.rollRow}>
              <span style={S.rollInfo}>
                {notes.length} notes · synth voice: {waveType}
                {anchors && anchors.length > 0 ? ` · ${anchors.length} voice samples: ${anchors.map((a) => a.name).join(" ")}` : ""}
              </span>
            </div>
            <div style={S.btnRow}>
              <button onClick={playOriginal} style={playing === "original" ? S.btnOn : S.btn}>
                {playing === "original" ? "■ Stop" : "▶ Original"}
              </button>
              <button onClick={playMidi} style={playing === "midi" ? S.btnOn : S.btn}>
                {playing === "midi" ? "■ Stop" : "▶ Synth Preview"}
              </button>
              {anchors && anchors.length > 0 && (
                <button onClick={playVoice} style={playing === "voice" ? S.btnOn : S.btn}>
                  {playing === "voice" ? "■ Stop" : "▶ Voice Preview"}
                </button>
              )}
              <button onClick={downloadMidi} style={S.btnGo}>Download .mid</button>
              {anchors && anchors.length > 0 && (
                <button onClick={downloadPack} style={S.btnGo}>Download Voice Pack</button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const S = {
  page: { minHeight: "100vh", background: "#0a0e1a", color: "#ffffff", fontFamily: "system-ui, sans-serif", position: "relative", overflow: "hidden" },
  video: { position: "absolute", top: 0, left: 0, width: "100%", height: "100%", objectFit: "cover", zIndex: 0, opacity: 0.9 },
  overlay: { position: "absolute", top: 0, left: 0, width: "100%", height: "100%", background: "linear-gradient(180deg, rgba(10,14,26,0.45), rgba(10,14,26,0.78))", zIndex: 1 },
  topBar: { position: "relative", zIndex: 2, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 24, flexWrap: "wrap", padding: "32px 48px" },
  logoBox: { width: 54, height: 54, borderRadius: 14, background: "rgba(15,23,48,0.9)", border: "1px solid #2b6cff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  contentWrap: { position: "relative", zIndex: 2, padding: "0 48px 48px", maxWidth: 1100 },
  drop: { border: "2px dashed #2b6cff", borderRadius: 12, padding: "16px 28px", cursor: "pointer", background: "rgba(15,23,48,0.85)", display: "inline-block" },
  dropText: { color: "#3df0ff", fontSize: 15, fontWeight: 600 },
  account: { display: "flex", alignItems: "center", gap: 10, fontSize: 12 },
  creditChip: { background: "rgba(61,240,255,0.12)", border: "1px solid #3df0ff", color: "#3df0ff", borderRadius: 999, padding: "3px 12px", fontSize: 12, fontWeight: 700, textDecoration: "none" },
  linkBtn: { background: "transparent", color: "#3df0ff", border: "none", cursor: "pointer", fontSize: 12, textDecoration: "underline", padding: 0 },
  status: { color: "#8ea2c8", fontSize: 13, fontFamily: "monospace", marginTop: 4 },
  progressTrack: { marginTop: 10, height: 6, background: "rgba(15,23,48,0.9)", borderRadius: 4, overflow: "hidden", maxWidth: 400 },
  progressBar: { height: "100%", background: "#3df0ff", borderRadius: 4, transition: "width .3s ease" },
  buyBtn: { display: "inline-block", marginTop: 12, background: "#3df0ff", color: "#0a0e1a", borderRadius: 10, padding: "10px 20px", fontSize: 14, fontWeight: 700, textDecoration: "none" },
  card: { marginTop: 16, background: "rgba(8,11,22,0.7)", border: "1px solid rgba(43,108,255,0.5)", borderRadius: 12, padding: 16, backdropFilter: "blur(3px)" },
  canvas: { width: "100%", height: "auto", borderRadius: 8, display: "block" },
  rollRow: { marginTop: 12 },
  rollInfo: { color: "#8ea2c8", fontSize: 12, fontFamily: "monospace" },
  btnRow: { display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" },
  btn: { background: "rgba(20,29,56,0.9)", color: "#ffffff", border: "1px solid #2b6cff", borderRadius: 8, padding: "10px 16px", cursor: "pointer", fontSize: 14, fontWeight: 600 },
  btnOn: { background: "#2b6cff", color: "#ffffff", border: "1px solid #2b6cff", borderRadius: 8, padding: "10px 16px", cursor: "pointer", fontSize: 14, fontWeight: 600 },
  btnGo: { background: "#3df0ff", color: "#0a0e1a", border: "none", borderRadius: 8, padding: "10px 16px", cursor: "pointer", fontSize: 14, fontWeight: 700 },
};
