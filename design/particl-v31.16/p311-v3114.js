// v31.14 · the bar is one line, always · questions live in the Inspector's Atomik tab (Agent mode) · the scrub time in the Viewer's corner · no × on How
export function data3114(c) {}

export function install3114(c) {
  Object.keys(M3114).forEach(k => { c[k] = M3114[k].bind(c); });
  const i0 = c.initState; c.initState = function () { return this.initState3114(i0.call(this)); };
  const au0 = c.afterUpdate; c.afterUpdate = function (ps) { if (au0) au0.call(this, ps); this.autoPanel3114(ps); };
}

export const M3114 = {
  initState3114(st) {
    const Q = this.Q; const g = k => Q.get(k);
    st.atomikOpen = null; st.openedBy = null;
    if (g('q') === '1' && st.view === 'studio') { st.mode = 'agent'; st.card = 'questions'; st.insp = { open: true, pin: false, tab: 'atomik' }; st.openedBy = 'atomik'; }
    if (g('suggest') === '1' && st.view === 'studio') { st.mode = 'agent'; st.card = 'receipt'; st.suggestSeen = false; st.insp = { open: true, pin: false, tab: 'atomik' }; st.openedBy = 'atomik'; }
    if (st.view === 'studio' && st.mode === 'agent' && (g('card') === 'questions' || g('card') === 'quote' || g('card') === 'checklist' || g('card') === 'receipt') && !(st.insp && st.insp.open)) { st.insp = { open: true, pin: false, tab: 'atomik' }; st.openedBy = 'atomik'; }
    return st;
  },
  // the panel opens itself for a question or a suggestion, and closes itself when they are gone if it opened itself
  autoPanel3114(ps) {
    const s = this.state; if (s.view !== 'studio' || s.mode !== 'agent') return;
    const has = s => !!(s.card === 'questions' || (s.card === 'receipt' && !s.suggestSeen));
    const now = has(s), was = has(ps);
    if (now && !was && !(s.insp && s.insp.open)) this.setState({ insp: { open: true, pin: false, tab: 'atomik' }, openedBy: 'atomik' });
    else if (now && !was && s.insp && s.insp.open && s.insp.tab !== 'atomik') this.setState({ insp: Object.assign({}, s.insp, { tab: 'atomik' }) });
    else if (!now && was && s.openedBy === 'atomik' && s.insp && s.insp.open) this.setState({ insp: Object.assign({}, s.insp, { open: false }), openedBy: null });
  }
};

const pill = (label, on, onClick, tip) => ({ label, bg: on ? '#F4F4F6' : 'rgba(244,244,246,0.08)', color: on ? '#0B0B0C' : '#F4F4F6', tip: tip || '', onClick: e => { if (e && e.stopPropagation) e.stopPropagation(); onClick(e); } });

export function renderExtras3114(r, x) {
  const { s, S, stop, me, phone, dir, inStudio, inHome, inMake, sk } = x;
  // ---------- the bar is one line: nothing stacked ----------
  r.barRows2 = null; r.above = null; r.barChips = null; r.selChip = null;
  // the "What is it?" row that v31.12 drew above the bar stays on the card only
  // ---------- the scrub time reads in the Viewer's corner ----------
  r.scrubTc = (inStudio && sk === 'edit' && (s.scrubbing || s.playing)) ? me.tc(s.ph, me.P(s.prodId).fps) : null; if ((r.aedit && r.aedit.tc) || (r.nle && r.nle.view && r.nle.view.tc)) r.scrubTc = null;
  // ---------- How: no × ----------
  if (r.howPage) { r.howPage.close = null; r.howPage.noX = true; }
  // ---------- Agent mode: the Atomik tab ----------
  const agentStudio = inStudio && !dir && !phone;
  r.acardFloat = agentStudio ? null : r.acard;
  if (!agentStudio) return;
  const ac = r.acard || null; const isQ = ac && s.card === 'questions'; const isJob = ac && (s.card === 'quote' || s.card === 'checklist' || s.card === 'receipt');
  const done = s.card === 'receipt'; const run = s.card === 'checklist';
  const sugg = (done && !s.suggestSeen) ? { text: 'Reviewing · the label is soft at this size', chips: [pill('Fix the label · 2 cr', false, () => { S({ suggestSeen: true }); me.spend(2); me.toast('Fixed · 2 cr'); })], close: e => { stop(e); S({ suggestSeen: true }); } } : null;
  const selCards = s.sel.map(id => (r.cards || []).find(c => c.id === id)).filter(Boolean);
  const sel = selCards.length ? { label: selCards.map(c => String(c.title).split(' · ')[0]).join(' · '), chips: (selCards.length === 1 ? (selCards[0].chips || selCards[0].hoverChips || []) : []).slice(0, 6).map(ch => pill(ch.label, false, ch.onClick, ch.tip)), clear: e => { stop(e); S({ sel: [] }); } } : null;
  const askTxt = () => { const v = (s.qText || '').trim(); if (!v) return; S({ qText: '' }); if (ac && ac.chips && ac.chips[0] && ac.chips[0].onClick) ac.chips[0].onClick({ stopPropagation() {} }); me.toast(v); };
  const atomik = {
    q: isQ ? { title: ac.title, sub: ac.sub || '', chips: (ac.chips || []).slice(0, 4).map(ch => pill(ch.label, !!ch.on, ch.onClick, ch.tip)), val: s.qText || '', onChange: e => S({ qText: e.target.value }), onKey: e => { if (e.key === 'Enter') { stop(e); askTxt(); } } } : null,
    ticks: isJob ? [['Thinking', true], ['Making', run || done], ['Reviewing', done]].map(t => ({ label: t[0], state: t[1] ? 'done' : (t[0] === 'Making' && !run && !done) || (t[0] === 'Reviewing' && run) ? 'next' : 'waiting', color: t[1] ? 'var(--green)' : 'var(--fg3)' })) : null,
    jobHead: ac && ac.title ? String(ac.title) : 'The job',
    acts: isJob ? (ac.acts || []).map(a => ({ label: a.label, bg: a.filled ? '#F4F4F6' : 'rgba(244,244,246,0.08)', color: a.filled ? '#0B0B0C' : '#F4F4F6', onClick: a.onClick })) : [],
    sugg, sel,
    idle: (!isQ && !isJob && !sugg && !sel) ? 'Nothing to ask · say it in the bar' : null
  };
  // the panel: the Atomik tab first
  const tabOn = s.insp && s.insp.tab === 'atomik';
  if (!r.insp && s.insp && s.insp.open) r.insp = { title: me.P(s.prodId).name, tabs: [], knobs: [], actions: [], showTabs: true };
  if (r.insp) {
    const tabs = (r.insp.tabs || []).filter(tb => tb.label !== 'Atomik');
    const mk = (label, tb) => ({ label, bg: tabOn ? '#F4F4F6' : 'transparent', color: tabOn ? '#0B0B0C' : 'rgba(244,244,246,0.8)', onClick: e => { stop(e); S({ insp: Object.assign({}, s.insp, { tab: 'atomik', open: true }) }); } });
    r.insp.tabs = [mk('Atomik')].concat(tabs.slice(0, 1).map(tb => tabOn ? Object.assign({}, tb, { bg: 'transparent', color: 'rgba(244,244,246,0.8)' }) : tb));
    r.insp.showTabs = r.insp.tabs.length > 1;
    if (tabOn) { r.insp.atomik = atomik; r.insp.title = 'Atomik'; r.insp.knobs = []; r.insp.actions = []; r.insp.note = null; r.insp.stepSec = null; r.insp.engines = null; r.insp.isSettings = false; r.insp.isEngine = false; r.insp.isInputs = false; r.insp.isVersions = false; r.insp.isComments = false; r.insp.isLayers = false; r.insp.isSound = false; r.insp.isExport = false; r.insp.take = null; r.insp.lookAB = null; r.insp.footer = null; r.insp.generate = null; }
    const c0 = r.insp.close; r.insp.close = e => { stop(e); S({ openedBy: null }); if (c0) c0(e); else S({ insp: Object.assign({}, s.insp, { open: false }) }); };
  }
  // the right rail: Atomik first; a tile the person taps marks the panel as theirs
  (r.rrail || []).forEach(tl => { const o = tl.onClick; if (o) tl.onClick = e => { S({ openedBy: 'person' }); o(e); }; });
  if (Array.isArray(r.rrail) && !r.rrail.some(tl => tl.label === 'Atomik')) { const on = s.insp.open && tabOn; r.rrail = [{ label: 'Atomik', d: me.I.make, tip: 'Atomik · the question, the job, the suggestion', bg: on ? '#F4F4F6' : 'transparent', color: on ? '#0B0B0C' : 'rgba(244,244,246,0.8)', onClick: e => { stop(e); if (on) S({ insp: Object.assign({}, s.insp, { open: false }), openedBy: null }); else S({ insp: { open: true, pin: s.insp.pin, tab: 'atomik' }, openedBy: 'person' }); } }].concat(r.rrail); }
  if (r.insp && !tabOn) r.insp.showTabs = false;
}
