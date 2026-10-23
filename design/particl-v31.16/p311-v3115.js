// v31.15 · eight defects of v31.14 fixed: group rename, Director double-click, new-node placement, the stray @maya on Shots, the Brief under the panel, the phone's question card and Make, the How bands
export function data3115(c) {}

export function install3115(c) {
  Object.keys(M3115).forEach(k => { c[k] = M3115[k].bind(c); });
  const i0 = c.initState; c.initState = function () { return this.initState3115(i0.call(this)); };
  const n0 = c.newCardAt; c.newCardAt = function (cx, cy) { return this.newCardAt3115(cx, cy, n0); };
  const m0 = c.mount; c.mount = function () { if (m0) m0.call(this); this.mountRename3115(); };
}

export const M3115 = {
  initState3115(st) {
    const Q = this.Q; const g = k => Q.get(k);
    st.extra = (st.extra || []).filter(z => !(/^(el-|lk-)/.test(z.id) && /:shots$/.test(z.scope || ''))); if (st.joins) Object.keys(st.joins).forEach(k => { st.joins[k] = (st.joins[k] || []).filter(id => !/^(el-|lk-)/.test(id)); if (st.joins[k].length < 2) delete st.joins[k]; });
    if (g('rename') === 'cast' && st.view === 'studio') { st.grpRename = { grp: 'Cast' }; st.rename = null; }
    if (g('new') === 'director' && st.view === 'studio') { st.mode = 'director'; st.insp = Object.assign({}, st.insp, { open: false, pin: false }); st.newKind = { pending: true, onCard: true, id: 'new-director' }; st.sel = ['new-director']; st.extra = (st.extra || []).concat([{ id: 'new-director', title: 'New element', kind: 'slot', grp: '', type: '', price: 24, out: 'Image', ar: .8, line: 'What is it?', st: 'draft', scope: st.prodId + ':elements', loose: true, askKind: true }]); st.st = Object.assign({}, st.st, { [st.prodId + ':new-director']: 'draft' }); st.nudge = 'new-director'; }
    return st;
  },
  // a native dblclick on a group header or a card name beats the canvas's listener
  mountRename3115() {
    this._dblRename = e => { const h = e.target.closest && e.target.closest('[data-ghead]'); if (h) { e.stopPropagation(); e.preventDefault(); const key = h.getAttribute('data-ghead'); this._gClick = null; this.setState({ grpRename: { grp: key }, sel: [], menu: null }); } };
    document.addEventListener('dblclick', this._dblRename, true);
    const u0 = this.unmount; this.unmount = () => { document.removeEventListener('dblclick', this._dblRename, true); if (u0) u0(); };
  },
  // the new card lands under the pointer; inside a group it joins that group; the free-space nudge runs after layout, against the real rects
  newCardAt3115(cx, cy, n0) {
    const s = this.state, sk = this.stepKey(), dir = s.mode === 'director'; const before = s.extra.length;
    n0.call(this, cx, cy);
    if (sk !== 'elements' && sk !== 'look' && sk !== 'storyboard' && sk !== 'shots' && sk !== 'sound') return;
    setTimeout(() => {
      const st = this.state; if (st.extra.length <= before) return; const c = st.extra[st.extra.length - 1]; if (!c || !c.loose) return;
      const k = this.K(c.id); const p = st.pos[k] || { x: 0, y: 0 }; const gboxes = this._gboxes || []; const hit = gboxes.find(g => p.x >= g.x && p.x <= g.x + g.w && p.y >= g.y && p.y <= g.y + g.h);
      const n2 = Object.assign({}, c); if (sk === 'elements') { n2.grp = hit ? hit.key : ''; n2.type = hit ? hit.key : ''; if (dir) { n2.askKind = true; n2.line = 'What is it?'; } }
      const patch = { extra: st.extra.map(z => z.id === c.id ? n2 : z), nudge: c.id, nudgeFrom: { x: p.x, y: p.y } };
      if (dir) patch.newKind = { pending: true, onCard: true, id: c.id }; else if (sk === 'elements') patch.newKind = null;
      this.setState(patch);
    }, 0);
  },
  // runs once the card has a real rect: the nearest free spot, never left of the first column, never over a card
  nudge3115() {
    const s = this.state, id = s.nudge; if (!id) return; const laid = this.laid || []; const c = laid.find(z => z.id === id); if (!c) return;
    const others = laid.filter(o => o.id !== id && o.w && o.h); const w = c.w, h = c.h; const x0 = 112, y0 = this.canvasTop ? this.canvasTop() : 88;
    const free = (x, y) => x >= x0 && y >= y0 && !others.some(o => x < o.x + o.w + 16 && x + w + 16 > o.x && y < o.y + o.h + 16 && y + h + 16 > o.y);
    const from = s.nudgeFrom || { x: c.x, y: c.y }; let best = null;
    if (free(from.x, from.y)) best = from; else { for (let ring = 1; ring < 40 && !best; ring++) { const step = 32 * ring; const cands = [[from.x + step, from.y], [from.x, from.y + step], [from.x - step, from.y], [from.x, from.y - step], [from.x + step, from.y + step], [from.x - step, from.y + step], [from.x + step, from.y - step], [from.x - step, from.y - step]]; for (const cd of cands) { if (free(cd[0], cd[1])) { best = { x: cd[0], y: cd[1] }; break; } } } }
    if (!best) { const bottom = others.reduce((m, o) => Math.max(m, o.y + o.h), y0); best = { x: x0, y: bottom + 48 }; }
    const pos = Object.assign({}, s.pos); pos[this.K(id)] = best; this.setState({ pos, nudge: null, nudgeFrom: null });
  },
  setKind3115(id, kind) {
    const s = this.state; const extra = s.extra.map(z => z.id === id ? Object.assign({}, z, { askKind: false, grp: kind, type: kind, title: 'New ' + kind.toLowerCase(), line: 'An empty ' + kind.toLowerCase() + ' · upload yours or let it be drawn' }) : z);
    this.setState({ extra, newKind: null, sel: [id] }); this.toast(kind + ' · its settings are in the Inspector');
    if (kind === 'World') setTimeout(() => this.makeWorld('env-flat'), 200);
  }
};

const pill = (label, on, onClick, tip) => ({ label, bg: on ? '#F4F4F6' : 'rgba(244,244,246,0.08)', color: on ? '#0B0B0C' : '#F4F4F6', border: 'transparent', tip: tip || '', onClick: e => { if (e && e.stopPropagation) e.stopPropagation(); onClick(e); } });

export function renderExtras3115(r, x) {
  const { s, S, stop, me, phone, dir, inStudio, inHome, inMake, sk, W, H, u } = x;
  // ---------- group header: a real rename field, the count kept ----------
  if (inStudio && Array.isArray(r.gboxes)) {
    r.gboxes.forEach(g => { const full = String(g.name || ''); const key = full.split(' · ')[0]; const cnt = (full.match(/· (\d+)$/) || [])[1] || ''; g.key = key; g.count = cnt ? '· ' + cnt : ''; const rn = s.grpRename && s.grpRename.grp === key; g.renaming = !!rn; g.notRenaming = !rn; g.renameVal = (s.grpNames || {})[key] || key; g.renameKey = e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); me.grpRenameCommit(e.target.value); } if (e.key === 'Escape') { e.preventDefault(); S({ grpRename: null }); } }; g.renameBlur = e => me.grpRenameCommit(e.target.value); g.dbl = e => { stop(e); e.preventDefault(); S({ grpRename: { grp: key }, sel: [], menu: null }); }; });
    me._gboxes = r.gboxes;
  }
  (r.cards || []).forEach(c => { c.notAskKind = true; });
  if (inStudio && s.nudge && (r.cards || []).some(c => c.id === s.nudge)) setTimeout(() => me.nudge3115(), 0);
  // ---------- Director double-click: the card asks "What is it?"; the Inspector stays as it was ----------
  if (inStudio && sk === 'elements' && (r.cards || []).length) {
    r.cards.forEach(c => { const src = (s.extra || []).find(z => z.id === c.id); if (src && src.askKind && dir) { c.askKind = true; c.kinds = me.KINDS8.map(k => pill(k, false, () => me.setKind3115(c.id, k))); c.line = 'What is it?'; c.noActs = true; c.chips = []; c.hoverChips = []; c.acts = []; } else c.askKind = false; c.notAskKind = !c.askKind; });
    r.whatIs = null;
  }
  // ---------- the Brief reflows to the panel's left edge ----------
  if (inStudio && sk === 'brief' && r.interview && s.insp && s.insp.open && !phone) { const pr = Math.round(320 * u) + 116; const parts = String(r.interview.pad || '88px 24px 140px').split(/\s+/); const top = parts[0] || '88px', bottom = parts[2] || parts[0] || '140px', left = parts[3] || parts[1] || '24px'; r.interview.pad = top + ' ' + pr + 'px ' + bottom + ' ' + left; }
  // ---------- the phone's question card: Count 1 · 2 · 3 · 4 and "Decide for me" ----------
  const fixChips = list => (list || []).map(ch => { const l = String(ch.label || ''); if (/Just make it/.test(l)) return Object.assign({}, ch, { label: 'Decide for me' }); return ch; });
  if (r.ph && r.ph.acard) { const a = Object.assign({}, r.ph.acard); if (/Takes a shot\?|How many/.test(a.title || '')) { a.title = String(a.title).replace(/How many takes a shot\?/, 'Takes a shot?'); const base = (a.chips || [])[0]; if (base) a.chips = ['1', '2', '3', '4'].map(n => Object.assign({}, base, { label: n, onClick: e => { stop(e); if (base.onClick) base.onClick(e); } })); } a.chips = fixChips(a.chips); a.acts = fixChips(a.acts); r.ph.acard = a; }
  if (r.acard) { r.acard.chips = fixChips(r.acard.chips); r.acard.acts = fixChips(r.acard.acts); if (r.acard.chips && /^(1|2|3)$/.test(String((r.acard.chips[0] || {}).label)) && r.acard.chips.length === 2) { const base = r.acard.chips[0]; r.acard.chips = ['1', '2', '3', '4'].map(n => Object.assign({}, base, { label: n })); } }
  if (r.interview && r.interview.justMake) r.interview.justMake = Object.assign({}, r.interview.justMake, { label: 'Decide for me · Script · 8 beats · 4 cr' });
  if (r.insp && r.insp.atomik && r.insp.atomik.q) { const q = r.insp.atomik.q; q.chips = fixChips(q.chips); }
  Object.keys(r).forEach(k => { const v = r[k]; if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.label === 'string' && /Just make it/.test(v.label)) r[k] = Object.assign({}, v, { label: v.label.replace(/Just make it/, 'Decide for me') }); });
  if (r.barBtn && /Just make it/.test(r.barBtn.label || '')) r.barBtn = Object.assign({}, r.barBtn, { label: r.barBtn.label.replace(/Just make it/, 'Decide for me') });
  if (r.barAction && /Just make it/.test(r.barAction.label || '')) r.barAction = Object.assign({}, r.barAction, { label: r.barAction.label.replace(/Just make it/, 'Decide for me') });
  // ---------- the phone's Make: one stack, the dock clear ----------
  if (inMake && phone && r.makeRoom2) { const m = r.makeRoom2; m.padTop = 72; m.padBottom = 200; m.padL = 12; m.padR = 12; m.w = W - 24; m.cols = 2; m.modeSeg = []; r.showBar = false; if (r.ph) { r.ph.isHome = true; r.ph.isList = false; r.ph.cards = []; } }
  else if (r.makeRoom2) r.makeRoom2.padBottom = 120;
  // ---------- How: the bands bleed to the edge ----------
  if (r.howPage) { const h = r.howPage; h.stepsLine = 'Tap a screen to play it.'; const pageW = W; const sbw = 0; const full = phone ? pageW : Math.max(280, Math.round(pageW * 0.7)); const colW = Math.min(h.cw || pageW, pageW); const mx = -Math.max(0, Math.round((pageW - colW) / 2)) + (phone ? -16 : 0); const ww = pageW - (W > 1000 ? 0 : 0); const edge = (b, i) => Object.assign(b, { bw: full, scale: full / 1440, mx, ww, flex: phone ? 'column' : (i % 2 ? 'row-reverse' : 'row'), radius: phone ? '0' : (i % 2 ? '12px 0 0 12px' : '0 12px 12px 0'), textPad: phone ? '16px' : (i % 2 ? '0 0 0 32px' : '0 32px 0 0') }); (h.stepBands || []).forEach(edge); (h.bands || []).forEach(edge); }
}
