"use client";
import { useState, useRef, useEffect } from "react";
import { createClient } from "../../utils/supabase/client";

const MODEL_URL = "/basic-pitch/model.json";

export default function Extract() {
  const [user, setUser] = useState(undefined);
  const [isOwner, setIsOwner] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [notes, setNotes] = useState(null);
  const [waveType, setWaveType] = useState(null);
  const [playing, setPlaying] = useState(null); // null | "original" | "midi"
  const [buyNeeded, setBuyNeeded] = useState(false);
  const [fileName, setFileName] = useState("");

  const acRef = useRef(null);
  const bufferRef = useRef(null);
  const paidRef = useRef(false);
  const toneRef = useRef(null);
  const synthRef = useRef(null);
  const srcRef = useRef(null);
  const stopTimerRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const auth = createClient();
    auth.auth.getUser().then(({ data }) => {
      const u = data && data.user ? data.user : null;
      setUser(u);
      if (u) {
        fetch("/api/credits").then((r) => r.json()).then((j) => {
          if (j && j.ok) setIsOwner(!!j.isOwner);
        }).catch(() => {});
      }
    });
  }, []);

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
    const hops = 24; // sample 24 windows across the track
    let centroidSum = 0, flatnessSum = 0, frames = 0;
    for (let h = 0; h < hops; h++) {
      const start = Math.floor((data.length - win) * (h / hops));
      if (start < 0) break;
      const re = new Float64Array(win), im = new Float64Array(win);
      for (let i = 0; i < win; i++) {
        // Hann window
        re[i] = data[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1)));
      }
      fft(re, im);
      let mag = new Float64Array(win / 2);
      let sum = 0, weighted = 0, logSum = 0, nonzero = 0;
      for (let k = 1; k < win / 2; k++) {
        mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        const freq = (k * sr) / win;
        sum += mag[k];
        weighted += mag[k] * freq;
        if (mag[k] > 0) { logSum += Math.log(mag[k]); nonzero++; }
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
    // Same thresholds as the Python rebuilder
    if (meanFlatness > 0.04) return "sawtooth";
    if (meanCentroid > 2200) return "square";
    return "triangle";
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
    setBusy(true); setNotes(null); setBuyNeeded(false); setProgress(0);
    paidRef.current = false;
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

      setNotes(cleaned);
      setStatus(`Done. ${cleaned.length} notes found. Preview is free; the .mid costs 1 credit.`);
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
    // faint row stripes
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
    if (toneRef.current) {
      try { toneRef.current.Transport.stop(); toneRef.current.Transport.cancel(); } catch {}
    }
    if (synthRef.current) { try { synthRef.current.releaseAll(); } catch {} }
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
    const synth = synthRef.current;
    const now = Tone.now() + 0.1;
    notes.forEach((n) => {
      synth.triggerAttackRelease(
        Tone.Frequency(n.midi, "midi").toFrequency(),
        Math.max(0.05, n.duration),
        now + n.time,
        n.velocity
      );
    });
    setPlaying("midi");
    const total = Math.max(...notes.map((n) => n.time + n.duration));
    stopTimerRef.current = setTimeout(() => stopAll(), total * 1000 + 400);
  }

  /* ---------------- download gate --------------- */
  async function ensurePaid() {
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

  async function downloadMidi() {
    if (!notes) return;
    if (!(await ensurePaid())) return;
    setStatus("Writing your MIDI file...");
    try {
      const { Midi } = await import("@tonejs/midi");
      const midi = new Midi();
      const track = midi.addTrack();
      notes.forEach((n) => {
        track.addNote({ midi: n.midi, time: n.time, duration: n.duration, velocity: n.velocity });
      });
      const blob = new Blob([midi.toArray()], { type: "audio/midi" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const base = (fileName || "track").replace(/\.[^.]+$/, "");
      a.href = url; a.download = `${base}.mid`; a.click();
      setStatus(`Downloaded ${base}.mid`);
    } catch (err) {
      setStatus("MIDI error: " + err.message);
    }
  }

  /* ---------------- render --------------- */
  return (
    <div style={S.page}>
      <div style={S.wrap}>
        <a href="/" style={S.back}>← Back to the Humanizer</a>
        <div style={{ marginTop: 24, marginBottom: 6, fontSize: 30, fontWeight: 700, letterSpacing: "-0.5px" }}>
          MIDI <span style={{ color: "#3df0ff" }}>Extractor</span>
        </div>
        <div style={{ fontSize: 12, color: "#8ea2c8", letterSpacing: "1.5px", textTransform: "uppercase", marginBottom: 6 }}>
          Your AI track's notes, as MIDI, ready for your DAW
        </div>
        <div style={{ fontSize: 12, color: "#54688a", marginBottom: 28 }}>
          Works best on melodies, basslines, leads, and single stems. Dense full mixes come out approximate.
        </div>

        {user === undefined && <p style={S.muted}>Loading…</p>}

        {user === null && (
          <a href="/login" style={S.drop}>
            <span style={S.dropText}>Log in to extract MIDI</span>
          </a>
        )}

        {user && (
          <>
            <label style={S.drop}>
              <input type="file" accept="audio/*" onChange={handleFile} disabled={busy} style={{ display: "none" }} />
              <span style={S.dropText}>{busy ? "Working..." : "＋ Choose an audio file"}</span>
            </label>
            <p style={{ color: "#3df0ff", fontSize: 13, fontWeight: 700, marginTop: 10 }}>
              Preview is free. Downloading the .mid costs 1 credit.
            </p>
          </>
        )}

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
                {notes.length} notes · preview voice: {waveType}
              </span>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={playOriginal} style={playing === "original" ? S.btnOn : S.btn}>
                  {playing === "original" ? "■ Stop" : "▶ Original"}
                </button>
                <button onClick={playMidi} style={playing === "midi" ? S.btnOn : S.btn}>
                  {playing === "midi" ? "■ Stop" : "▶ MIDI Preview"}
                </button>
                <button onClick={downloadMidi} style={S.btnGo}>Download .mid</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const S = {
  page: { minHeight: "100vh", background: "#0a0e1a", color: "#ffffff", fontFamily: "system-ui, sans-serif" },
  wrap: { maxWidth: 900, margin: "0 auto", padding: "40px 24px" },
  back: { color: "#8ea2c8", fontSize: 13, textDecoration: "none" },
  muted: { color: "#8ea2c8", fontSize: 13 },
  drop: { display: "inline-block", border: "2px dashed #2b6cff", borderRadius: 12, padding: "16px 28px", cursor: "pointer", background: "rgba(15,23,48,0.85)" },
  dropText: { color: "#3df0ff", fontSize: 15, fontWeight: 600 },
  status: { color: "#8ea2c8", fontSize: 13, fontFamily: "monospace", marginTop: 16 },
  progressTrack: { marginTop: 10, height: 6, background: "rgba(15,23,48,0.9)", borderRadius: 4, overflow: "hidden", maxWidth: 400 },
  progressBar: { height: "100%", background: "#3df0ff", borderRadius: 4, transition: "width .3s ease" },
  buyBtn: { display: "inline-block", marginTop: 12, background: "#3df0ff", color: "#0a0e1a", borderRadius: 10, padding: "10px 20px", fontSize: 14, fontWeight: 700, textDecoration: "none" },
  card: { marginTop: 24, background: "rgba(8,11,22,0.7)", border: "1px solid rgba(43,108,255,0.5)", borderRadius: 12, padding: 16 },
  canvas: { width: "100%", height: "auto", borderRadius: 8, display: "block" },
  rollRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 12, flexWrap: "wrap" },
  rollInfo: { color: "#8ea2c8", fontSize: 12, fontFamily: "monospace" },
  btn: { background: "rgba(20,29,56,0.9)", color: "#ffffff", border: "1px solid #2b6cff", borderRadius: 8, padding: "10px 16px", cursor: "pointer", fontSize: 14, fontWeight: 600 },
  btnOn: { background: "#2b6cff", color: "#ffffff", border: "1px solid #2b6cff", borderRadius: 8, padding: "10px 16px", cursor: "pointer", fontSize: 14, fontWeight: 600 },
  btnGo: { background: "#3df0ff", color: "#0a0e1a", border: "none", borderRadius: 8, padding: "10px 16px", cursor: "pointer", fontSize: 14, fontWeight: 700 },
};
