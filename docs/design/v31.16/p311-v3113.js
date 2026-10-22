// v31.13 · the bar grows, no second line · double-click makes a node only · rename on double-click · sub-settings as pills in place · How: step bands, hero centred · Make's wall as a real grid · Count 1 · 2 · 3 · 4
export function data3113(c) {
  c.STEPBANDS = [['BRIEF', 'Say what it is.', 'One interview, one question at a time. Format, cast, look and language are set here and never asked again.'], ['SCRIPT', 'The words first.', 'A page, then a list, then cards. Approve the script and the cards make themselves.'], ['TREATMENT', 'A deck a client signs.', 'The cover sets the system; every page flows from it; a client link with comments.'], ['ELEMENTS', 'Your cast, your places, your product.', 'From a line or from your references. A face with consent on file. A place made walkable.'], ['LOOK', 'Light, decided once.', 'Three directions inside the genre, or your LUT and your references. It carries into every frame.'], ['STORYBOARD', 'Coverage, not guesses.', 'Frames drawn from the cast and the look, on one side of the line, playable as a cut for free.'], ['SHOTS', 'One shot at a time.', 'Each take quoted, approved and judged. Keep one and the next begins.'], ['SOUND', 'Voice, music, room.', 'A voice bound to each character, music under or leading, a mix that keeps the dialogue clear.'], ['EDIT', 'Cut from a sentence.', 'Agent mode re-cuts on request. Director mode is the suite.'], ['DELIVER', 'Every size. Every language.', 'One table, a price in every cell, previewed before you approve.']];
  Object.keys(c.HELP || {}).forEach(k => { const h = c.HELP[k]; if (!h) return; for (let i = 0; i < h.length; i++) if (typeof h[i] === 'string') h[i] = h[i].replace(/How many takes a shot\?/g, 'Takes a shot?').replace(/How many/g, 'Count'); });
}

export function install3113(c) {
  Object.keys(M3113).forEach(k => { c[k] = M3113[k].bind(c); });
  const i0 = c.initState; c.initState = function () { return this.initState3113(i0.call(this)); };
  const q0 = c.questionsFor; if (q0) c.questionsFor = function (sk) { const qs = q0.call(this, sk) || []; return qs.map(q => { const o = Object.assign({}, q); if (typeof o.q === 'string') o.q = o.q.replace(/How many takes a shot\?/, 'Takes a shot?').replace(/How many/g, 'Count'); if (typeof o.t === 'string') o.t = o.t.replace(/How many takes a shot\?/, 'Takes a shot?').replace(/How many/g, 'Count'); if (Array.isArray(o.a) && o.a.join() === '1,3') o.a = ['1', '2', '3', '4']; if (Array.isArray(o.opts) && o.opts.join() === '1,3') o.opts = ['1', '2', '3', '4']; return o; }); };
}

export const M3113 = {
  initState3113(st) {
    const Q = this.Q; const g = k => Q.get(k);
    st.openRow = g('open') || null; if (st.openRow && st.view === 'studio') { st.mode = 'director'; st.insp = { open: true, pin: true, tab: 'settings' }; if (!st.sel.length) st.sel = ['cast-stranger']; }
    if (g('rename') === 'maya') { st.rename = { key: 'card:' + st.prodId + ':cast-maya', val: '' }; }
    if (g('new') === 'director' && !st.openRow) { st.insp = Object.assign({}, st.insp, { open: false }); st.newKind = { pending: true, onCard: true }; }
    if (g('sel') === 's3,s4' && st.view === 'studio') st.sel = ['s3', 's4'];
    return st;
  },
  toggleRow(key) { this.setState({ openRow: this.state.openRow === key ? null : key, menu: null }); }
};

const pill = (label, on, onClick, tip) => ({ label, bg: on ? '#F4F4F6' : 'rgba(244,244,246,0.08)', color: on ? '#0B0B0C' : '#F4F4F6', border: 'transparent', tip: tip || '', onClick: e => { if (e && e.stopPropagation) e.stopPropagation(); onClick(e); } });

export function renderExtras3113(r, x) {
  const { s, S, stop, me, W, H, phone, dir, I, inHome, inMake, inStudio, sk, u, popAt } = x;
  // ---------- the bar grows: the second line folds into the bar ----------
  const ab = r.above; r.above = null;
  const rows = [];
  if (ab && (ab.text || (ab.chips || []).length)) rows.push({ text: ab.text || '', chips: (ab.chips || []).slice(0, 4), onClose: ab.onClose || null, isQ: /\?$/.test(ab.text || '') });
  if (inStudio && s.sel.length > 1 && !(sk === 'edit' && dir) && !rows.some(rw => /Shot|@/.test(rw.text || ''))) { const names = s.sel.map(id => { const c = (r.cards || []).find(y => y.id === id); return c ? String(c.title).split(' · ')[0] : id; }); rows.push({ text: names.join(' · '), chips: [], onClose: e => { stop(e); S({ sel: [] }); } }); }
  if (inStudio && sk === 'edit' && (s.scrubbing || s.playing)) rows.push({ text: me.tc(s.ph, me.P(s.prodId).fps), chips: [], onClose: null, mono: true });
  const max = phone ? 5 : 8; r.barRows2 = rows.slice(0, max).map(rw => Object.assign(rw, { close: rw.onClose ? (e => { stop(e); rw.onClose(e); }) : null })); r.barRowsScroll = rows.length > max - 1 ? 'auto' : 'visible'; r.barMaxH = ((max - 1) * 44) + 'px';
  if (r.barRows2.length) { r.barChips = null; r.selChip = null; }
  // ---------- double-click makes a node, nothing more; "What is it?" on the card ----------
  if (inStudio && (r.cards || []).length) (r.cards || []).forEach(c => { if (c.dbl && !c.isNode && !c.isSlot) { const d0 = c.dbl; c.dbl = e => { stop(e); if (e && e.target && e.target.closest && e.target.closest('[data-name]')) return; const insp = s.insp; d0(e); setTimeout(() => me.setState({ insp }), 0); }; } });
  if (inStudio && sk === 'elements' && dir && s.newKind && s.newKind.pending && !s.newKind.id) { const nd = (r.cards || []).find(c => c.isNode && c.empty) || (r.cards || []).find(c => c.isNode); if (nd) { nd.whatIs = { head: 'What is it?', kinds: me.KINDS8.map(k => pill(k, false, () => { me.mkSetKind(k); S({ newKind: { kind: k }, insp: s.insp }); })) }; nd.line = ''; } r.barRows2 = r.barRows2.filter(rw => rw.text !== 'What is it?'); }
  // ---------- rename on double-click: names carry data-name and a dblclick ----------
  (r.cards || []).forEach(c => { if (c.renameStart) { const rs = c.renameStart; c.renameDbl = e => { stop(e); if (e && e.preventDefault) e.preventDefault(); rs(e); }; c.renameStart = e => { stop(e); }; } });
  if (r.ptab && r.ptab.renameStart) { const rs = r.ptab.renameStart; r.ptab.renameDbl = e => { stop(e); rs(e); }; r.ptab.renameStart = e => { stop(e); }; }
  (r.gboxes || []).forEach(g => { g.dbl = e => { stop(e); if (e && e.preventDefault) e.preventDefault(); const key = String(g.name || '').split(' · ')[0]; const real = Object.keys(s.grpNames || {}).find(k => (s.grpNames || {})[k] === key) || key; S({ grpRename: { grp: real } }); }; });
  if (r.lib && Array.isArray(r.lib.items)) r.lib.items.forEach(it => { if (it.rename) { const rn = it.rename; it.renameDbl = e => { stop(e); rn(e); }; } else it.renameDbl = e => { stop(e); me.toast(it.title + ' · rename from its card'); }; });
  // ---------- sub-settings as pills in place ----------
  const openKey = s.openRow;
  const inline = (list, keyOf) => (list || []).map(k => { if (!k || k.head || !k.onClick) return k; const key = keyOf(k); const opts = k.opts || k.options || (k.values ? k.values : null); const open = openKey === key; const row = Object.assign({}, k, { open, chev: open ? 'rotate(90deg)' : 'none', toggle: e => { stop(e); me.toggleRow(key); } }); if (!opts && k.onClick) { row.toggle = e => { stop(e); const prev = me.state.menu; k.onClick(e); setTimeout(() => { const mn = me.state.menu; if (mn && mn !== prev && Array.isArray(mn.items)) { me.setState({ menu: null, openRow: key, rowMenus: Object.assign({}, me.state.rowMenus || {}, { [key]: mn.items.filter(it => it.label) }) }); } }, 0); }; const cached = (s.rowMenus || {})[key]; if (open && cached) row.pills = cached.map(it => pill(it.label + (it.right ? ' · ' + it.right : ''), !!it.on, ev => { it.onClick(ev); })); } else if (opts) row.pills = open ? opts.map(o => { const label = typeof o === 'string' ? o : o.label; const on = label === k.val; return pill(label, on, ev => { if (typeof o === 'object' && o.onClick) o.onClick(ev); else if (k.set) k.set(label); }); }) : null; return row; });
  if (r.insp && Array.isArray(r.insp.knobs)) r.insp.knobs = inline(r.insp.knobs, k => 'knob:' + (k.label || '').toLowerCase());
  if (r.makeRoom2 && r.makeRoom2.settings) r.makeRoom2.settings.rows = inline(r.makeRoom2.settings.rows, k => 'mk:' + (k.label || '').toLowerCase());
  if (inStudio && sk === 'elements' && dir && openKey === 'background' && r.insp && Array.isArray(r.insp.knobs)) { let bg = r.insp.knobs.find(k => /Background/i.test(k.label || '')); if (!bg) { bg = { label: 'Background', val: 'Dark', color: '#F4F4F6', toggle: e => { stop(e); me.toggleRow('background'); } }; r.insp.knobs = [bg].concat(r.insp.knobs); } if (bg) { bg.open = true; bg.chev = 'rotate(90deg)'; bg.pills = ['Dark', 'Paper', 'Tint', 'Picture'].map(o => pill(o, o === (bg.val || 'Dark'), () => { me.toast('Background · ' + o); S({ openRow: null }); })); } }
  // the canvas menus and knob pop-ups lose their hairline
  r.menuBorder = '0'; r.menuBg = 'rgba(24,24,27,0.98)';
  // ---------- How: the steps as bands · the hero centred ----------
  if (r.howPage) { const h = r.howPage; const cw = h.cw; const base = 'Particl home v31.16.html?'; const url = q => base + q + '&embed=1&w=1440&h=900'; const bandW = cw >= 900 ? Math.round(cw * 0.62) : cw; h.stepBands = me.STEPS.map((st, i) => { const b = me.STEPBANDS[i]; return { n: String(i + 1).padStart(2, '0'), k: b[0], t: b[1], line: b[2], src: url(me.STEPURL[st]), scale: bandW / 1440, bw: bandW, cw: cw >= 900 ? cw - bandW - 32 : cw, flex: i % 2 ? 'row-reverse' : 'row' }; }); h.steps = []; h.heroAlign = 'center'; h.heroItems = 'center'; (h.bands || []).forEach(b => { b.src = b.src.replace('v31.12', 'v31.16'); }); (h.atomik && h.atomik.screens || []).forEach(sc => { sc.src = sc.src.replace('v31.12', 'v31.16'); }); }
  // ---------- Make's wall as a real grid ----------
  if (inMake && r.makeRoom2) { const m = r.makeRoom2; const cols = phone ? 2 : Math.max(2, Math.floor((W - (m.padL || 16) - (m.padR || 100)) / 288)); m.cols = cols; const place = items => { const heights = Array.from({ length: cols }, () => 0); const colsArr = Array.from({ length: cols }, () => []); (items || []).forEach(it => { let ci = 0; for (let i = 1; i < cols; i++) if (heights[i] < heights[ci]) ci = i; colsArr[ci].push(it); const ar = String(it.ar || '16/9').split('/'); heights[ci] += (+ar[1] || 9) / (+ar[0] || 16) + 0.05; }); return colsArr.map((items2, i) => ({ i, items: items2 })); }; m.gridCols = place(m.wall); m.gridTpl = 'repeat(' + cols + ', minmax(0, 1fr))'; if (m.fromLib) m.fromLib.gridCols = place(m.fromLib.items); m.foot = (m.foot || []).map(ch => Object.assign({}, ch, { label: String(ch.label).replace(/^How many/, 'Count') })); if (m.settings) m.settings.rows = m.settings.rows.map(rw => Object.assign({}, rw, { label: String(rw.label).replace(/^How many/, 'Count') })); }
  if (r.insp && Array.isArray(r.insp.knobs)) r.insp.knobs = r.insp.knobs.map(k => k && k.label ? Object.assign({}, k, { label: String(k.label).replace(/^How many/, 'Count') }) : k);
  if (r.acard) { if (r.acard.title) r.acard.title = String(r.acard.title).replace(/How many takes a shot\?/, 'Takes a shot?').replace(/How many/g, 'Count'); if (Array.isArray(r.acard.chips) && r.acard.chips.length === 2 && r.acard.chips.map(c => c.label).join() === '1,3') { const c1 = r.acard.chips[0]; r.acard.chips = ['1', '2', '3', '4'].map(v => Object.assign({}, c1, { label: v, onClick: e => { stop(e); if (c1.onClick) c1.onClick(e); } })); } }
}
