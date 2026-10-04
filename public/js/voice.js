/* Voice announcements for the TV board. Uses the browser's built-in speech; no audio files needed. */
(function () {
  'use strict';
  const V = (Q.voice = { supported: 'speechSynthesis' in window, unlocked: false, last: null, busy: Promise.resolve() });
  let ctx = null;
  const chime = (volume) => new Promise((res) => { try { ctx ||= new (window.AudioContext || window.webkitAudioContext)(); const t = ctx.currentTime; [[660, 0], [880, 0.18]].forEach(([f, d]) => { const o = ctx.createOscillator(); const g = ctx.createGain(); o.frequency.value = f; o.type = 'sine'; o.connect(g); g.connect(ctx.destination); g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(Math.max(0.001, 0.25 * volume), t + d + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.3); o.start(t + d); o.stop(t + d + 0.32); }); setTimeout(res, 520); } catch { res(); } });
  V.unlock = () => { try { ctx ||= new (window.AudioContext || window.webkitAudioContext)(); ctx.resume && ctx.resume(); } catch { /* ignore */ } if (V.supported) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } V.unlocked = true; };
  // "D-025" -> "D 25", "LAB-014" -> "L A B 14" so every letter is clear from across the room
  V.sentence = (a) => { const m = String(a.number).match(/^([A-Za-z]+)\D*0*(\d+)$/); const say = m ? m[1].toUpperCase().split('').join(' ') + ' ' + m[2] : a.number; return `Queue number ${say}, please proceed to ${a.counter || a.dept}.`; };
  const pickVoice = (lang) => { const vs = speechSynthesis.getVoices(); return vs.find((v) => v.lang === lang) || vs.find((v) => v.lang.replace('_', '-').startsWith(lang.split('-')[0])) || null; };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const once = (text, o) => new Promise((res) => { const u = new SpeechSynthesisUtterance(text); u.lang = o.lang; u.volume = o.volume; u.rate = 0.92; const v = pickVoice(o.lang); if (v) u.voice = v; u.onend = u.onerror = () => res(); speechSynthesis.speak(u); setTimeout(res, 15000); });
  // Announcements are queued so two calls never talk over each other.
  V.announce = (a, o) => { V.last = { a, o }; if (!V.supported) return Promise.resolve(); V.busy = V.busy.then(async () => { const opt = { volume: 0.9, lang: 'en-PH', repeat: 1, delay: 3, ...o }; await chime(opt.volume); for (let i = 0; i < opt.repeat; i++) { await once(V.sentence(a), opt); if (i < opt.repeat - 1) await wait(opt.delay * 1000); } }).catch(() => {}); return V.busy; };
  V.repeatLast = () => V.last && V.announce(V.last.a, V.last.o);
  if (V.supported) speechSynthesis.getVoices();
})();
