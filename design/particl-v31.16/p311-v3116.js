// v31.16 · the Director never starts blank (the Prompt row, Enhance · Compose, Again with…, wires drawn not required), Thinking in Agent mode, five fixes of v31.15
export function data3116(c) {
  c.THINK = { High: 'Asks the most, plans the deepest', Medium: 'The balance', Low: 'Quick, for simple films' };
  c.THINKPRICE = { High: 'Plans and writing quote higher at High', Medium: 'Plans and writing quote at the middle band', Low: 'Plans and writing quote lowest at Low' };
  c.THINKMUL = { High: 1.6, Medium: 1, Low: 0.7 };
  // Shot numbers are unique: the Scene 4 card is Shot 8, the blue room Shot 9
  
}

export function install3116(c) {
  Object.keys(M3116).forEach(k => { c[k] = M3116[k].bind(c); });
  const i0 = c.initState; c.initState = function () { return this.initState3116(i0.call(this)); };
  const n0 = c.newCardAt; c.newCardAt = function (cx, cy) { return this.newCardAt3116(cx, cy, n0); };
  const nd0 = c.nudge3115; if (nd0) c.nudge3115 = function () { return this.nudge3116(nd0); };
}

// the prompt as it will be sent, assembled from the node's line, its Inputs and the pickers' lines
const ANGLE = { 'Eye level': 'at eye level', 'From below': 'from below, looking up', 'From above': 'from above, looking down', 'Low angle': 'from a low angle', 'High angle': 'from a high angle', 'Dutch': 'tilted, a dutch angle' };
const SIZE = { 'Wide': 'a wide shot', 'Medium': 'a medium shot', 'Close': 'a close-up', 'Close-up': 'a close-up', 'Macro': 'a macro detail', 'Extreme close': 'an extreme close-up', 'Full': 'a full shot', 'Two-shot': 'a two-shot' };
const MOVE = { 'Static': 'the camera static', 'Drift': 'a slow drift', 'Push in': 'a slow push in', 'Pull back': 'a pull back', 'Pan': 'a pan', 'Tilt': 'a tilt', 'Handheld': 'handheld', 'Dolly': 'a dolly move', 'Orbit': 'an orbit' };
export const M3116 = {
  initState3116(st) {
    const Q = this.Q; const g = k => Q.get(k);
    st.thinkLevel = st.thinkLevel || { mirror: 'Medium', sand: 'Medium', new: 'Medium', make: 'Medium' }; st.thinkDefault = 'Medium'; st.thinkOpen = g('thinking') === '1'; if (st.thinkOpen && st.view === 'studio') { st.readback = true; st.step = 'brief'; st.mode = 'agent'; }
    st.promptEdits = {}; st.promptUndo = {}; st.promptFlash = null;
    const pm = g('prompt'); if (pm && st.view === 'studio') { st.mode = 'director'; st.step = 'shots'; st.sel = ['s4']; st.takeEdited = true; st.insp = { open: true, pin: true, tab: 'settings' }; st.promptOpen = true; if (pm === 'composed') { st.promptEdits = { [st.prodId + ':s4']: this.composeText('s4', st) }; st.promptUndo = { [st.prodId + ':s4']: this.assembleText('s4', st) }; st.promptFrom = 'Compose · 3 cr'; } }
    if (g('again') === 's4' && st.view === 'studio') { st.mode = 'director'; st.step = 'shots'; st.extra = (st.extra || []).concat([this.againCard('s4', st)]); st.sel = ['s4-again']; st.insp = { open: true, pin: true, tab: 'settings' }; st.takeEdited = true; st.promptOpen = true; st.promptFocus = 's4-again'; }
    if (g('view') === 'settings' && g('section') === 'workspace') st.settSec = 'workspace';
    return st;
  },
  thinkOf(pid) { return (this.state.thinkLevel || {})[pid || this.state.prodId] || 'Medium'; },
  setThink(pid, v) { const tl = Object.assign({}, this.state.thinkLevel, { [pid]: v }); this.setState({ thinkLevel: tl, thinkOpen: false }); this.toast('Thinking · ' + v + ' · ' + this.P(pid).title); },
  // the words of a take, from the record: scene line, cast and place, the Look, the start frame, the pickers
  srcOf(id, st) { const s = st || this.state || {}; const pid = s.prodId || 'mirror'; let cards = []; try { cards = (this.cardsFor(pid, 'shots') || []).slice(); } catch (e) { cards = []; } cards = cards.concat((s.extra || []).filter(z => z.scope === pid + ':shots')); return cards.find(c => c.id === id) || (this.laid || []).find(c => c.id === id) || null; },
  assembleText(id, st) {
    const s = st || this.state || {}; const c = this.srcOf(id, s); if (!c) return ''; const pid = s.prodId || 'mirror'; const k = pid + ':' + id; const kv = (s.knobs || {})[k] || {};
    const look = (((this.LOOK || {})[pid] || [[]])[0] || [])[1] || ''; const line = c.action || c.summary || ''; const who = (c.handles || c.cast || []).filter(h => /^@/.test(h)).join(', '); const where = c.where || c.place || ''; const slug = c.slug || '';
    const parts = [];
    if (slug) parts.push(slug + '.'); if (line) parts.push(line); if (who) parts.push('With ' + who + (where ? ' at ' + where : '') + '.'); else if (where) parts.push('At ' + where + '.');
    const size = kv['Shot size'] || c.cam || ''; const angle = kv.Angle || ''; const move = kv.Move || kv.Camera || ''; const lens = kv.Lens || ''; const grain = kv.Grain || ''; const light = kv.Light || '';
    const cam = [SIZE[size] || (size ? size.toLowerCase() : ''), ANGLE[angle] || (angle ? angle.toLowerCase() : ''), MOVE[move] || (move ? move.toLowerCase() : '')].filter(Boolean); if (cam.length) parts.push(cam.join(', ').replace(/^./, m => m.toUpperCase()) + '.');
    if (lens) parts.push(lens + ' lens.'); if (look) parts.push('Light as ' + look + (light ? ', ' + light.toLowerCase() : '') + '.'); if (grain) parts.push('Grain ' + grain.toLowerCase() + '.');
    const sf = (c.pre || []).find(p => /Start frame/.test(p.sub || p.label || '')); if (sf && !/empty/.test(sf.label)) parts.push('From the start frame.');
    return parts.join(' ');
  },
  composeText(id, st) { const s = st || this.state || {}; const base = this.assembleText(id, s); const pid = s.prodId || 'mirror'; let pr = {}; try { pr = this.P(pid) || {}; } catch (e) { pr = {}; } return base + ' ' + (pr.ratio || '16:9') + ' at ' + (pr.fps || 24) + ' fps; the colour and contrast of the kept takes before it; nothing added that the script does not say.'; },
  promptText(id) { const k = this.K(id); return (this.state.promptEdits || {})[k] !== undefined ? this.state.promptEdits[k] : this.assembleText(id); },
  setPromptText(id, v, from) { const k = this.K(id); const pe = Object.assign({}, this.state.promptEdits, { [k]: v }); const pu = Object.assign({}, this.state.promptUndo); if (from) pu[k] = this.promptText(id); this.setState({ promptEdits: pe, promptUndo: pu, promptFrom: from || null, promptFlash: from ? id : null }); if (from) setTimeout(() => this.setState({ promptFlash: null }), 900); },
  undoPrompt(id) { const k = this.K(id); const pu = Object.assign({}, this.state.promptUndo); const prev = pu[k]; delete pu[k]; const pe = Object.assign({}, this.state.promptEdits); if (prev === undefined) delete pe[k]; else pe[k] = prev; this.setState({ promptEdits: pe, promptUndo: pu, promptFrom: null }); this.toast('Prompt · as it was'); },
  // live prices: Enhance reads the line and the Setup; Compose reads the digests and the step's rows, more at High
  enhancePrice(id) { const n = this.promptText(id).split(/\s+/).filter(Boolean).length; const beats = (this.cardsFor(this.state.prodId, 'script') || []).length; return n > 40 || beats > 10 ? 2 : 1; },
  composePrice(id) { const pid = this.state.prodId; const rows = (this.cardsFor(pid, 'shots') || []).length + (this.cardsFor(pid, 'script') || []).length; const base = rows > 14 ? 3 : 2; return Math.max(1, Math.round(base * (this.THINKMUL[this.thinkOf(pid)] || 1))); },
  enhance(id) { const p = this.enhancePrice(id); const t = this.promptText(id); const out = t.replace(/\s+/g, ' ').replace(/\.\s*$/, '') + '. Natural skin, no haze, the frame held a beat longer.'; this.setPromptText(id, out, 'Enhance · ' + p + ' cr'); this.spend(p); this.toast('Enhanced · ' + p + ' cr'); },
  compose(id) { const p = this.composePrice(id); const used = Math.max(1, p - 1); this.setPromptText(id, this.composeText(id), 'Compose · ' + used + ' cr'); this.spend(used); this.toast('Composed · ' + used + ' cr of up to ' + p); },
  applyBarEdit(id, text) { if (!text || !text.trim()) return; const t = this.promptText(id).replace(/\.\s*$/, ''); this.setPromptText(id, t + '. ' + text.trim().replace(/\.$/, '') + '.', 'Change'); this.setState({ bar: '' }); this.toast('Applied to the Prompt row · free'); },
  // Again with…: the take duplicated with its settings and the Prompt row, the Inspector on it, Generate runs it
  againCard(id, st) { const s = st || this.state || {}; const c = this.srcOf(id, s) || {}; const pid = s.prodId; const k = pid + ':' + id; return Object.assign({}, c, { id: id + '-again', title: String(c.title || 'Shot').split(' · ')[0] + ' · again', src: '', kind: 'plate', st: 'open', scope: pid + ':shots', after: id, loose: false, price: c.price || 48, made: 'director', from: 'Again with… · ' + String(c.title || '').split(' · ')[0], againOf: id, noAsk: true, line: 'Change one thing · Generate · ' + (c.price || 48) + ' cr' }); },
  againWith(id) { const s = this.state; const nc = this.againCard(id); const k0 = this.K(id), k1 = this.K(nc.id); const knobs = Object.assign({}, s.knobs, { [k1]: Object.assign({}, s.knobs[k0] || {}) }); const pe = Object.assign({}, s.promptEdits, { [k1]: this.promptText(id) }); const st = Object.assign({}, s.st, { [k1]: 'open' }); this.setState({ extra: s.extra.concat([nc]), knobs, promptEdits: pe, st, sel: [nc.id], insp: { open: true, pin: true, tab: 'settings' }, takeEdited: true, promptOpen: true, promptFocus: nc.id, menu: null }); this.toast('Again with… · change one thing · free until Generate'); },
  // a new card lands with its top-left at the pointer, wholly inside the canvas, in the group under the pointer or none
  newCardAt3116(cx, cy, n0) { this._ptr = { cx, cy }; return n0.call(this, cx, cy); },
  nudge3116(nd0) {
    const s = this.state, id = s.nudge; if (!id) return; const laid = this.laid || []; const c = laid.find(z => z.id === id); if (!c) return nd0.call(this);
    const cam = s.cam || { x: 0, y: 0, z: 1 }; const z = cam.z || 1; const W = window.innerWidth, H = window.innerHeight; const u = this.u ? this.u() : 1;
    // the visible canvas, in world units
    const sx0 = 112, sy0 = 88, sx1 = W - (s.insp.open ? Math.round(320 * u) + 116 : 100), sy1 = Math.max(H - 96, sy0 + c.h * z + 24);
    const wx0 = (sx0 - cam.x) / z, wy0 = (sy0 - cam.y) / z, wx1 = (sx1 - cam.x) / z, wy1 = (sy1 - cam.y) / z;
    const w = c.w, h = c.h; const clampX = x => Math.max(wx0, Math.min(x, wx1 - w)); const clampY = y => Math.max(wy0, Math.min(y, Math.max(wy0, wy1 - h)));
    let from; if (this._ptr) from = { x: (this._ptr.cx - cam.x) / z, y: (this._ptr.cy - cam.y) / z }; else if (id === 'new-director') from = { x: (wx0 + wx1) / 2 - w / 2, y: (wy0 + wy1) / 2 - h / 2 }; else from = s.nudgeFrom || { x: c.x, y: c.y };
    from = { x: Math.round(clampX(from.x)), y: Math.round(clampY(from.y)) };
    const others = laid.filter(o => o.id !== id && o.w && o.h);
    const free = (x, y) => !others.some(o => x < o.x + o.w + 16 && x + w + 16 > o.x && y < o.y + o.h + 16 && y + h + 16 > o.y);
    let best = from;
    if (!free(from.x, from.y)) { let found = null; for (let ring = 1; ring < 4 && !found; ring++) { const st = 24 * ring; const cands = [[from.x + st, from.y], [from.x, from.y + st], [from.x - st, from.y], [from.x, from.y - st], [from.x + st, from.y + st], [from.x - st, from.y + st], [from.x + st, from.y - st], [from.x - st, from.y - st]]; for (const cd of cands) { const x = Math.round(clampX(cd[0])), y = Math.round(clampY(cd[1])); if (free(x, y)) { found = { x, y }; break; } } } if (found) best = found; else best = from; }
    const pos = Object.assign({}, s.pos); pos[this.K(id)] = best; this._ptr = null; this.setState({ pos, nudge: null, nudgeFrom: null });
  }
};

const pill = (label, on, onClick, tip) => ({ label, bg: on ? '#F4F4F6' : 'rgba(244,244,246,0.08)', color: on ? '#0B0B0C' : '#F4F4F6', border: 'transparent', tip: tip || '', onClick: e => { if (e && e.stopPropagation) e.stopPropagation(); onClick(e); } });

export function renderExtras3116(r, x) {
  const { s, S, stop, me, phone, dir, inStudio, inHome, inMake, sk, W, H, u } = x;
  const pid = s.prodId; const think = me.thinkOf(pid);
  // ---------- console clean: no path binds before its d exists ----------
  (r.blines || []).forEach(b => { b.has = !!b.d; }); if (r.blines) r.blines = r.blines.filter(b => b.d);
  (r.plus || []).forEach(p => { if (!p.d) p.d = undefined; });
  // ---------- the bar in Director mode is for the change ----------
  if (dir && !phone) { if (/Describe the node/.test(r.barPh || '')) r.barPh = 'Change something · tighter, from below, warmer'; if (inStudio && (sk === 'shots' || sk === 'storyboard' || sk === 'elements') && s.sel.length === 1) { const id = s.sel[0]; const c = (r.cards || []).find(z => z.id === id); if (c && (c.isMedia || c.isNode || c.kind === 'plate')) { r.barPh = 'Change something · tighter, from below, warmer'; const k0 = r.barKey; r.barKey = e => { if (e.key === 'Enter' && !e.shiftKey && (s.bar || '').trim()) { e.preventDefault(); me.applyBarEdit(id, s.bar); return; } if (k0) k0(e); }; } } }
  if (inMake && dir && r.makeRoom2 && /Describe/.test(r.makeRoom2.ph || '')) r.makeRoom2.ph = 'Change something · tighter, from below, warmer';
  if (r.barPh && /Describe the node/.test(r.barPh)) r.barPh = 'Change something · tighter, from below, warmer';
  // ---------- the Prompt row at the top of Settings ----------
  if (inStudio && dir && r.insp && r.insp.isSettings && s.sel.length === 1 && (sk === 'shots' || sk === 'storyboard' || sk === 'elements')) {
    const id = s.sel[0]; const text = me.promptText(id); const words = text.split(/\s+/).filter(Boolean).length; const k = me.K(id); const hasUndo = (s.promptUndo || {})[k] !== undefined; const ep = me.enhancePrice(id), cp = me.composePrice(id);
    r.insp.prompt = { head: 'Prompt · as it will be sent', words: words + (words === 1 ? ' word' : ' words'), text, lit: s.promptFlash === id ? 'rgba(244,244,246,0.16)' : 'rgba(244,244,246,0.06)', onInput: e => me.setPromptText(id, e.target.value), rows: Math.max(3, Math.min(9, Math.ceil(text.length / 44))), focus: s.promptFocus === id, from: s.promptFrom || '', hasUndo, undo: e => { stop(e); me.undoPrompt(id); }, enhance: { label: '✦ Enhance · ' + ep + ' cr', tip: 'Polishes the line as written · reads the line and the Setup', onClick: e => { stop(e); me.enhance(id); } }, compose: { label: 'Compose · up to ' + cp + ' cr', tip: 'Atomik writes the prompt in full from the record · settles at what it used', onClick: e => { stop(e); me.compose(id); } } };
    if (s.promptFocus === id) setTimeout(() => { const el = document.querySelector('[data-promptrow] textarea'); if (el && document.activeElement !== el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); S({ promptFocus: null }); } }, 80);
  } else if (r.insp) r.insp.prompt = null;
  // the Take tab shows the prompt as sent, read-only, under its settings
  if (r.insp && r.insp.take && s.sel.length === 1) { const id = s.sel[0]; const sent = me.promptText(id); r.insp.take.rows = (r.insp.take.rows || []).filter(y => y.label !== 'Prompt'); r.insp.take.sent = sent; }
  // ---------- Again with… on every take ----------
  if (inStudio && (sk === 'shots' || sk === 'storyboard') && !phone) (r.cards || []).forEach(c => { if (!c.isMedia || c.isFrame) return; const act = { label: 'Again with…', sub: 'The take again, every setting kept · change one thing · free until Generate', d: 'M3 8a5 5 0 0 1 9-3M13 8a5 5 0 0 1-9 3M12 2v3H9M4 14v-3h3', onClick: e => { stop(e); me.againWith(c.id); } }; if (Array.isArray(c.strip)) c.strip = c.strip.concat([act]); const mi = c.menuItems; if (typeof mi === 'function') c.menuItems = e => { const mm = mi(e); if (mm && mm.items && !mm.items.some(it => it.label === 'Again with…')) mm.items.splice(Math.min(4, mm.items.length), 0, act); return mm; }; });
  // ---------- wires are drawn, never required ----------
  if (inStudio && !phone) { const showFor = id => s.hover === id || s.sel.includes(id); (r.cards || []).forEach(c => { c.port = false; c.portDown = null; }); const keep = []; (r.wires || []).forEach(w => { if (!w.to && !w.from) { keep.push(w); return; } if (showFor(w.to) || showFor(w.from)) keep.push(Object.assign(w, { op: .85 })); }); r.wires = keep; r.ports = (r.ports || []).filter(p => showFor(p.of || p.to)); }
  // ---------- Thinking · Agent mode ----------
  if (inStudio && !dir && sk === 'brief' && r.interview && r.interview.readback) {
    const row = { k: 'Thinking', v: think, status: 'known', srcLabel: 'set once · for this production', seg: [{ plain: true, t: think }], isOpen: false, isAssumed: false, color: 'var(--fg2)', chips: [], change: e => { stop(e); S({ thinkOpen: !s.thinkOpen }); }, isThink: true, open: !!s.thinkOpen, pills: ['High', 'Medium', 'Low'].map(v => ({ label: v, line: me.THINK[v], price: me.THINKPRICE[v], on: v === think, bg: v === think ? '#F4F4F6' : 'rgba(244,244,246,0.06)', color: v === think ? '#0B0B0C' : '#F4F4F6', sub: v === think ? 'rgba(11,11,12,0.7)' : 'var(--fg3)', onClick: e => { stop(e); me.setThink(pid, v); } })) };
    r.interview.rows = (r.interview.rows || []).concat([row]); r.interview.thinkRow = row;
  }
  if (r.insp && r.insp.atomik && r.insp.atomik.ticks && !dir) { const a = r.insp.atomik; a.jobHead = String(a.jobHead || '').replace(/ · Thinking · \w+$/, '') + ' · Thinking · ' + think; }
  if (r.acard && r.acard.pre && !dir) { const lines = r.acard.pre.lines; const tl = { t: 'Thinking · ' + think, k: 'Thinking' }; if (Array.isArray(lines)) { if (!lines.some(l => /^Thinking/.test(l.t || l))) lines.push(typeof lines[0] === 'string' ? tl.t : tl); } else r.acard.pre.thinkLine = 'Thinking · ' + think; }
  if (inMake && !dir && r.makeRoom2 && r.makeRoom2.settings && Array.isArray(r.makeRoom2.settings.rows)) { const rows = r.makeRoom2.settings.rows; const tk = me.thinkOf('make'); if (!rows.some(k => k.label === 'Thinking')) rows.push({ label: 'Thinking', val: tk, bg: 'rgba(244,244,246,0.06)', onClick: e => x.popAt(e, { kind: 'knob', w: 260, items: [{ head: 'Thinking' }].concat(['High', 'Medium', 'Low'].map(o => ({ label: o, sub: me.THINK[o], on: tk === o, onClick: ev => { stop(ev); me.setThink('make', o); S({ menu: null }); } }))) }) }); }
  if (r.settingsPage && Array.isArray(r.settingsPage.rows) && r.settingsPage.head === 'Workspace') { const d = s.thinkDefault || 'Medium'; if (!r.settingsPage.rows.some(k => k.label === 'Thinking')) r.settingsPage.rows.push({ label: 'Thinking', sub: 'default for new productions · admins only', isSeg: true, opts: ['High', 'Medium', 'Low'].map(v => ({ label: v, bg: v === d ? '#F4F4F6' : 'transparent', color: v === d ? '#0B0B0C' : '#F4F4F6', onClick: e => { stop(e); S({ thinkDefault: v }); me.toast('Thinking · ' + v + ' · default for new productions'); } })) }); }
  // ---------- the How page: the pill is one size ----------
  if (r.howPage && r.howPage.pill) r.howPage.pill.scale = 1;
  // ---------- the phone's Make: the line wraps inside the gutters ----------
  if (r.makeRoom2) { if (phone) r.makeRoom2.h1 = Math.min(r.makeRoom2.h1 || 30, Math.floor((W - 48) / 10.4)); r.makeRoom2.lines = (r.makeRoom2.lines || []).map(l => Object.assign({}, l, phone ? { anim: 'none', pos: 'relative', wrap: 'normal', clip: 'none' } : { pos: 'absolute', wrap: 'nowrap', clip: 'inset(0 100% 0 0)' })); if (phone) r.makeRoom2.lines = r.makeRoom2.lines.slice(0, 1); }
  // ---------- Shot numbers unique on the canvas and in the rail ----------
  if (inStudio && pid === 'mirror') { (r.cards || []).forEach(c => { if (c.id === 's7' && /Shot 7 · The watch/.test(c.title)) c.title = 'Shot 8 · The watch'; if (c.id === 's8' && /Shot 8 · Blue room/.test(c.title)) c.title = 'Shot 9 · Blue room'; if (c.id === 'fr-s7') c.title = 'Shot 7 · The watch'; }); if (r.insp && /Shot 7 · The watch/.test(r.insp.title || '')) r.insp.title = r.insp.title.replace('Shot 7 · The watch', 'Shot 8 · The watch'); }
}
