"use client";
import { useState, useRef, useEffect } from "react";
import { createClient } from "../utils/supabase/client";
import * as lamejs from "@breezystack/lamejs";

const KNOBS = [
  ["warmth", "Warmth", 35],
  ["bright", "Brightness", 20],
  ["width", "Width", 25],
  ["room", "Room", 15],
  ["texture", "Texture", 8],
  ["tape", "Tape", 30],
  ["output", "Output", 85],
];

export default function Home() {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [abMode, setAbMode] = useState("B");
  const [user, setUser] = useState(undefined); // undefined = checking, null = logged out
  const [credits, setCredits] = useState(null);
  const [isOwner, setIsOwner] = useState(false);
  const [buyNeeded, setBuyNeeded] = useState(false);
  const [params, setParams] = useState(() => {
    const p = {};
    KNOBS.forEach(([id, , def]) => (p[id] = def));
    return p;
  });

  const acRef = useRef(null);
  const buffersRef = useRef({ vocals: null, instr: null });
  const liveRef = useRef(null);
  const rawRef = useRef(null);
  const startTimeRef = useRef(0);
  const endTimerRef = useRef(null);
  const authRef = useRef(null);
  const paidRef = useRef(false);

  async function loadCredits() {
    try {
      const res = await fetch("/api/credits");
      const json = await res.json();
      if (json && json.ok) {
        setCredits(json.balance);
        setIsOwner(!!json.isOwner);
      }
    } catch {}
  }

  useEffect(() => {
    const auth = createClient();
    authRef.current = auth;
    auth.auth.getUser().then(({ data }) => {
      const u = data && data.user ? data.user : null;
      setUser(u);
      if (u) loadCredits();
    });
  }, []);

  async function signOut() {
    if (authRef.current) await authRef.current.auth.signOut();
    setUser(null);
    setReady(false);
    setStatus("");
    stopAll();
    setPlaying(false);
  }

  const ctx = () => {
    if (!acRef.current) acRef.current = new (window.AudioContext || window.webkitAudioContext)();
    return acRef.current;
  };

  async function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setBusy(true); setReady(false); setPlaying(false); setBuyNeeded(false);
    paidRef.current = false;
    try {
      setStatus("Uploading your track...");
      const auth = authRef.current || createClient();
      const filename = `${Date.now()}-${file.name}`;
      const { error: upErr } = await auth.storage.from("uploads").upload(filename, file);
      if (upErr) throw new Error("Upload failed: " + upErr.message);
      const { data: signed, error: signErr } = await auth.storage
        .from("uploads")
        .createSignedUrl(filename, 600);
      if (signErr || !signed || !signed.signedUrl) {
        throw new Error("Could not create a link for processing: " + (signErr ? signErr.message : "no URL"));
      }

      setStatus("Separating (about 30 seconds)...");
      const res = await fetch("/api/separate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioUrl: signed.signedUrl }),
      });
      const json = await res.json();
      if (json.error) {
        if (json.needCredits) setBuyNeeded(true);
        throw new Error(json.error);
      }
      const s = json.stems;
      if (!s.vocals || !s.no_vocals) throw new Error("Missing stems in response");
      if (typeof json.creditsLeft === "number") setCredits(json.creditsLeft);

      setStatus("Loading stems...");
      const [voc, ins] = await Promise.all([fetchDecode(s.vocals), fetchDecode(s.no_vocals)]);
      buffersRef.current.vocals = voc;
      buffersRef.current.instr = ins;

      setReady(true);
      setStatus("Done. Your track is humanized. Press play to hear it, and flip Original / Humanized to compare.");
      loadCredits();
    } catch (err) {
      setStatus("Error: " + err.message);
    }
    setBusy(false);
  }

  async function fetchDecode(url) {
    const resp = await fetch(url);
    const arr = await resp.arrayBuffer();
    return await ctx().decodeAudioData(arr);
  }

  function satCurve(amount) {
    const n = 2048, c = new Float32Array(n), k = amount * 10;
    const norm = Math.tanh(1 + k * 0.6) || 1;
    for (let i = 0; i < n; i++) { const x = i * 2 / n - 1; c[i] = Math.tanh((1 + k) * x) / norm; }
    return c;
  }
  function makeImpulse(oc, dur, decay) {
    const n = oc.sampleRate * dur, b = oc.createBuffer(2, n, oc.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay); }
    return b;
  }
  function noiseBuffer(oc) {
    const n = oc.sampleRate * 2, b = oc.createBuffer(1, n, oc.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1; return b;
  }
  function bufferRMS(buf) {
    if (!buf) return 0; const d = buf.getChannelData(0); let s = 0, c = 0;
    const step = Math.max(1, Math.floor(d.length / 50000));
    for (let i = 0; i < d.length; i += step) { s += d[i] * d[i]; c++; }
    return Math.sqrt(s / Math.max(1, c));
  }

  function buildChain(oc, dest, P) {
    const src = buffersRef.current;
    const preMix = oc.createGain();
    preMix.gain.value = 0.7;
    const rms = Math.max(bufferRMS(src.vocals), bufferRMS(src.instr), 0.0001);
    const sources = [], sats = [];
    const lfos = [];
    const tapeGains = [];
    ["vocals", "instr"].forEach((kind) => {
      const buf = src[kind]; if (!buf) return;
      const s = oc.createBufferSource(); s.buffer = buf;
      const g = oc.createGain(); g.gain.value = 0.85;
      const sat = oc.createWaveShaper(); sat.oversample = "4x"; sat.curve = satCurve(P.warmth / 100);
      s.connect(g).connect(sat).connect(preMix); sources.push(s); sats.push(sat);

      const wow = oc.createOscillator(); wow.type = "sine"; wow.frequency.value = 0.7;
      const flutter = oc.createOscillator(); flutter.type = "sine"; flutter.frequency.value = 6.3;
      const wowGain = oc.createGain();
      const flutterGain = oc.createGain();
      const depth = P.tape / 100;
      wowGain.gain.value = depth * 12;
      flutterGain.gain.value = depth * 4;
      wow.connect(wowGain).connect(s.detune);
      flutter.connect(flutterGain).connect(s.detune);
      wow.start(); flutter.start();
      lfos.push(wow, flutter);
      tapeGains.push(wowGain, flutterGain);
    });

    const noise = oc.createBufferSource(); noise.buffer = noiseBuffer(oc); noise.loop = true;
    const nhp = oc.createBiquadFilter(); nhp.type = "highpass"; nhp.frequency.value = 3000;
    const nlp = oc.createBiquadFilter(); nlp.type = "lowpass"; nlp.frequency.value = 9000;
    const ng = oc.createGain(); ng.gain.value = (P.texture / 100) * rms * 0.08;
    noise.connect(nhp).connect(nlp).connect(ng).connect(preMix); sources.push(noise);

    const hp = oc.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 30;
    const shelf = oc.createBiquadFilter(); shelf.type = "highshelf"; shelf.frequency.value = 11000;
    shelf.gain.value = (P.bright / 100) * 6;

    const splitter = oc.createChannelSplitter(2);
    const merger = oc.createChannelMerger(2);
    const sum = oc.createGain(); sum.gain.value = 0.5;
    splitter.connect(sum, 0); splitter.connect(sum, 1);
    const diff = oc.createGain(); diff.gain.value = 0.5;
    const negR = oc.createGain(); negR.gain.value = -1;
    splitter.connect(diff, 0); splitter.connect(negR, 1); negR.connect(diff);
    const wgain = oc.createGain(); wgain.gain.value = 1 + (P.width / 100) * 0.8;
    diff.connect(wgain);
    const sideToR = oc.createGain(); sideToR.gain.value = -1;
    sum.connect(merger, 0, 0); wgain.connect(merger, 0, 0);
    sum.connect(merger, 0, 1); wgain.connect(sideToR); sideToR.connect(merger, 0, 1);

    const conv = oc.createConvolver(); conv.buffer = makeImpulse(oc, 1.8, 3.5);
    const revSend = oc.createGain(); revSend.gain.value = (P.room / 100) * 0.35;

    const glue = oc.createDynamicsCompressor();
    glue.threshold.value = -18; glue.ratio.value = 2; glue.attack.value = 0.03; glue.release.value = 0.25; glue.knee.value = 6;
    const limit = oc.createDynamicsCompressor();
    limit.threshold.value = -1; limit.ratio.value = 20; limit.attack.value = 0.002; limit.release.value = 0.1;
    const outGain = oc.createGain(); outGain.gain.value = P.output / 100;

    preMix.connect(hp).connect(shelf).connect(splitter);
    merger.connect(glue);
    merger.connect(revSend).connect(conv).connect(glue);
    glue.connect(limit).connect(outGain).connect(dest);

    return { sources, sats, lfos, tapeGains, midNodes: { wgain }, nodes: { shelf, revSend, outGain, ng, rms } };
  }

  function trackDur() {
    return Math.max(
      buffersRef.current.vocals ? buffersRef.current.vocals.duration : 0,
      buffersRef.current.instr ? buffersRef.current.instr.duration : 0
    );
  }

  function stopAll() {
    if (liveRef.current) { liveRef.current.sources.forEach((s) => { try { s.stop(); } catch (e) {} }); liveRef.current = null; }
    if (rawRef.current) { rawRef.current.forEach((s) => { try { s.stop(); } catch (e) {} }); rawRef.current = null; }
    if (endTimerRef.current) { clearTimeout(endTimerRef.current); endTimerRef.current = null; }
  }

  function playRaw(oc, offset) {
    const srcs = [];
    ["vocals", "instr"].forEach((kind) => {
      const buf = buffersRef.current[kind]; if (!buf) return;
      const s = oc.createBufferSource(); s.buffer = buf;
      const g = oc.createGain(); g.gain.value = 0.85;
      s.connect(g).connect(oc.destination); s.start(0, offset); srcs.push(s);
    });
    rawRef.current = srcs;
  }

  function startAt(oc, offset) {
    if (abMode === "A") {
      playRaw(oc, offset);
    } else {
      liveRef.current = buildChain(oc, oc.destination, params);
      liveRef.current.sources.forEach((s) => s.start(0, offset));
    }
    startTimeRef.current = oc.currentTime - offset;
    const remaining = trackDur() - offset;
    endTimerRef.current = setTimeout(() => { setPlaying(false); stopAll(); }, remaining * 1000 + 200);
  }

  async function togglePlay() {
    const oc = ctx(); await oc.resume();
    if (playing) { stopAll(); setPlaying(false); return; }
    startAt(oc, 0);
    setPlaying(true);
  }

  function switchAB(mode) {
    const oc = ctx();
    const wasPlaying = playing;
    let offset = 0;
    if (wasPlaying) {
      offset = (oc.currentTime - startTimeRef.current) % (trackDur() || 1);
      stopAll();
    }
    setAbMode(mode);
    if (wasPlaying) {
      if (mode === "A") playRaw(oc, offset);
      else { liveRef.current = buildChain(oc, oc.destination, params); liveRef.current.sources.forEach((s) => s.start(0, offset)); }
      startTimeRef.current = oc.currentTime - offset;
      const remaining = trackDur() - offset;
      endTimerRef.current = setTimeout(() => { setPlaying(false); stopAll(); }, remaining * 1000 + 200);
    }
  }

  function updateParam(id, v) {
    setParams((prev) => {
      const next = { ...prev, [id]: v };
      const live = liveRef.current;
      if (live && abMode === "B") {
        const N = live.nodes;
        if (id === "bright") N.shelf.gain.value = (v / 100) * 6;
        if (id === "room") N.revSend.gain.value = (v / 100) * 0.35;
        if (id === "output") N.outGain.gain.value = v / 100;
        if (id === "texture") N.ng.gain.value = (v / 100) * N.rms * 0.08;
        if (id === "width") live.midNodes.wgain.gain.value = 1 + (v / 100) * 0.8;
        if (id === "warmth") live.sats.forEach((s) => (s.curve = satCurve(v / 100)));
        if (id === "tape" && live.tapeGains) {
          const d = v / 100;
          live.tapeGains.forEach((gn, idx) => { gn.gain.value = (idx % 2 === 0) ? d * 12 : d * 4; });
        }
      }
      return next;
    });
  }

  async function renderBuffer() {
    const sr = (buffersRef.current.vocals || buffersRef.current.instr).sampleRate;
    const len = Math.max(
      buffersRef.current.vocals ? buffersRef.current.vocals.length : 0,
      buffersRef.current.instr ? buffersRef.current.instr.length : 0
    );
    const oc = new OfflineAudioContext(2, len, sr);
    const built = buildChain(oc, oc.destination, params);
    built.sources.forEach((s) => s.start());
    return await oc.startRendering();
  }

  async function ensurePaid() {
    if (isOwner || paidRef.current) return true;
    try {
      const res = await fetch("/api/spend-download", { method: "POST" });
      const json = await res.json();
      if (json && json.ok) {
        paidRef.current = true;
        if (typeof json.remaining === "number") setCredits(json.remaining);
        return true;
      }
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

  async function download() {
    if (!buffersRef.current.vocals && !buffersRef.current.instr) return;
    if (!(await ensurePaid())) return;
    setStatus("Rendering your humanized track...");
    try {
      const rendered = await renderBuffer();
      const wav = encodeWav(rendered);
      const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
      const a = document.createElement("a");
      a.href = url; a.download = "humanized.wav"; a.click();
      setStatus("Downloaded humanized.wav");
    } catch (err) {
      setStatus("Download error: " + err.message);
    }
  }

  async function downloadMp3() {
    if (!buffersRef.current.vocals && !buffersRef.current.instr) return;
    if (!(await ensurePaid())) return;
    setStatus("Rendering MP3...");
    try {
      const rendered = await renderBuffer();
      const sr = rendered.sampleRate;
      const left = rendered.getChannelData(0);
      const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : left;
      const l16 = floatTo16(left);
      const r16 = floatTo16(right);
      const enc = new lamejs.Mp3Encoder(2, sr, 192);
      const block = 1152;
      const out = [];
      for (let i = 0; i < l16.length; i += block) {
        const lc = l16.subarray(i, i + block);
        const rc = r16.subarray(i, i + block);
        const mp3buf = enc.encodeBuffer(lc, rc);
        if (mp3buf.length) out.push(new Int8Array(mp3buf));
      }
      const end = enc.flush();
      if (end.length) out.push(new Int8Array(end));
      const blob = new Blob(out, { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "humanized.mp3"; a.click();
      setStatus("Downloaded humanized.mp3");
    } catch (err) {
      setStatus("MP3 error: " + err.message);
    }
  }

  function floatTo16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      let s = f32[i]; if (s > 1) s = 1; if (s < -1) s = -1;
      out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
  }

  function encodeWav(buf) {
    const ch = buf.numberOfChannels, sr = buf.sampleRate, n = buf.length;
    const bytesPerSample = 2;
    const blockAlign = ch * bytesPerSample;
    const dataSize = n * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize);
    const dv = new DataView(ab);
    const writeStr = (o, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(o + i, str.charCodeAt(i)); };
    writeStr(0, "RIFF");
    dv.setUint32(4, 36 + dataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, ch, true);
    dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * blockAlign, true);
    dv.setUint16(32, blockAlign, true);
    dv.setUint16(34, 16, true);
    writeStr(36, "data");
    dv.setUint32(40, dataSize, true);
    const chans = [];
    for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
    let off = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        let x = chans[c][i];
        if (x > 1) x = 1; if (x < -1) x = -1;
        const v = x < 0 ? x * 0x8000 : x * 0x7FFF;
        dv.setInt16(off, v | 0, true);
        off += 2;
      }
    }
    return ab;
  }

  return (
    <div style={S.page}>
      <video autoPlay muted loop playsInline style={S.video}>
        <source src="/bg.mp4" type="video/mp4" />
      </video>
      <div style={S.overlay} />
      <style>{`
        @keyframes slide {0%{transform:translateX(-100%)}100%{transform:translateX(350%)}}
        .vfader{ -webkit-appearance:none; appearance:none; width:130px; height:6px; background:#1b2547; border-radius:3px; outline:none; transform:rotate(-90deg); cursor:pointer; }
        .vfader::-webkit-slider-thumb{ -webkit-appearance:none; appearance:none; width:22px; height:22px; border-radius:5px; background:#3df0ff; border:2px solid #0a0e1a; cursor:pointer; }
        .vfader::-moz-range-thumb{ width:22px; height:22px; border-radius:5px; background:#3df0ff; border:2px solid #0a0e1a; cursor:pointer; }
      `}</style>

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
                First Take <span style={{ color: "#3df0ff" }}>Humanizer</span>
              </div>
              <div style={{ fontSize: 12, color: "#8ea2c8", letterSpacing: "1.5px", textTransform: "uppercase", marginTop: 2 }}>AI in. Human out.</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>
                <a href="https://firsttakeaudio.com/forge" style={{ color: "#3df0ff", textDecoration: "none" }}>Music Forge →</a>
                <span style={{ color: "#54688a" }}> · </span>
                <a href="/extract" style={{ color: "#3df0ff", textDecoration: "none" }}>MIDI Extractor →</a>
              </div>
            </div>
          </div>
        </div>

        {user === undefined && (
          <div style={S.dropText}>Loading…</div>
        )}

        {user === null && (
          <a href="/login" style={S.drop}>
            <span style={S.dropText}>Log in to humanize your track</span>
          </a>
        )}

        {user && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
            <label style={S.drop}>
              <input type="file" accept="audio/*" onChange={handleFile} disabled={busy} style={{ display: "none" }} />
              <span style={S.dropText}>{busy ? "Working..." : "＋ Choose an audio file"}</span>
            </label>
            <div style={{ color: "#3df0ff", fontSize: 13, fontWeight: 700 }}>
              Your first track is free. Hearing it costs nothing.
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

      {status && <p style={S.status}>{status}</p>}
      {buyNeeded && (
        <a href="https://firsttakeaudio.com/buy" target="_blank" rel="noopener noreferrer" style={S.buyBtn}>
          Buy credits →
        </a>
      )}
      {busy && (<div style={S.progressTrack}><div style={S.progressBar} /></div>)}

      {ready && (
        <div style={S.console}>
          <div style={S.consoleTop}>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => switchAB("A")} style={abMode === "A" ? S.abOn : S.abOff}>Original</button>
              <button onClick={() => switchAB("B")} style={abMode === "B" ? S.abOn : S.abOff}>Humanized</button>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={togglePlay} style={S.btn}>{playing ? "■ Stop" : "▶ Play"}</button>
              <button onClick={download} style={S.btnGo}>WAV</button>
              <button onClick={downloadMp3} style={S.btn}>MP3</button>
            </div>
          </div>
          <div style={S.faders}>
            {KNOBS.map(([id, name]) => (
              <div key={id} style={S.channel}>
                <div style={S.faderValue}>{Math.round(params[id])}</div>
                <div style={S.faderWell}>
                  <input type="range" min="0" max="100" value={params[id]} step="1"
                    onChange={(e) => updateParam(id, Number(e.target.value))} className="vfader" />
                </div>
                <div style={S.faderLabel}>{name}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  page: { minHeight: "100vh", background: "#0a0e1a", color: "#ffffff", fontFamily: "system-ui, sans-serif", position: "relative", overflow: "hidden" },
  video: { position: "absolute", top: 0, left: 0, width: "100%", height: "100%", objectFit: "cover", zIndex: 0, opacity: 0.9 },
  overlay: { position: "absolute", top: 0, left: 0, width: "100%", height: "100%", background: "linear-gradient(180deg, rgba(10,14,26,0.45), rgba(10,14,26,0.78))", zIndex: 1 },
  topBar: { position: "relative", zIndex: 2, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24, flexWrap: "wrap", padding: "32px 48px" },
  logoBox: { width: 54, height: 54, borderRadius: 14, background: "rgba(15,23,48,0.9)", border: "1px solid #2b6cff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  drop: { border: "2px dashed #2b6cff", borderRadius: 12, padding: "16px 28px", cursor: "pointer", background: "rgba(15,23,48,0.85)", display: "inline-block" },
  dropText: { color: "#3df0ff", fontSize: 15, fontWeight: 600 },
  account: { display: "flex", alignItems: "center", gap: 10, fontSize: 12 },
  creditChip: { background: "rgba(61,240,255,0.12)", border: "1px solid #3df0ff", color: "#3df0ff", borderRadius: 999, padding: "3px 12px", fontSize: 12, fontWeight: 700 },
  buyBtn: { position: "relative", zIndex: 2, display: "inline-block", margin: "10px 48px 0", background: "#3df0ff", color: "#0a0e1a", borderRadius: 10, padding: "10px 20px", fontSize: 14, fontWeight: 700, textDecoration: "none" },
  linkBtn: { background: "transparent", color: "#3df0ff", border: "none", cursor: "pointer", fontSize: 12, textDecoration: "underline", padding: 0 },
  status: { position: "relative", zIndex: 2, color: "#8ea2c8", fontSize: 13, padding: "0 48px", fontFamily: "monospace" },
  progressTrack: { position: "relative", zIndex: 2, margin: "10px 48px", height: 6, background: "rgba(15,23,48,0.9)", borderRadius: 4, overflow: "hidden", maxWidth: 400 },
  progressBar: { height: "100%", width: "40%", background: "#3df0ff", borderRadius: 4, animation: "slide 1.2s ease-in-out infinite" },
  console: { position: "absolute", right: "2%", bottom: "14%", zIndex: 3, width: "42%", maxWidth: 620, minWidth: 440, background: "rgba(8,11,22,0.5)", border: "1px solid rgba(43,108,255,0.5)", borderRadius: 16, padding: 20, backdropFilter: "blur(3px)" },
  consoleTop: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 22, flexWrap: "wrap" },
  faders: { display: "flex", justifyContent: "space-between", gap: 10 },
  channel: { display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flex: 1, minWidth: 54 },
  faderValue: { fontFamily: "monospace", fontSize: 12, color: "#3df0ff" },
  faderWell: { height: 130, display: "flex", alignItems: "center", justifyContent: "center", width: 36 },
  faderLabel: { fontSize: 12, color: "#b8c6e4", textAlign: "center" },
  btn: { background: "rgba(20,29,56,0.9)", color: "#ffffff", border: "1px solid #2b6cff", borderRadius: 8, padding: "10px 16px", cursor: "pointer", fontSize: 14, fontWeight: 600 },
  btnGo: { background: "#2b6cff", color: "#ffffff", border: "none", borderRadius: 8, padding: "10px 16px", cursor: "pointer", fontSize: 14, fontWeight: 700 },
  abOn: { background: "#2b6cff", color: "#fff", border: "1px solid #2b6cff", borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontSize: 13, fontWeight: 600 },
  abOff: { background: "transparent", color: "#8ea2c8", border: "1px solid #16204a", borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontSize: 13 },
};
