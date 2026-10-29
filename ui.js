/* NetLab main app: workspace, palette, tools, simulation playback, PDUs, persistence. */
(function () {
'use strict';
const NL = window.NL, U = NL.util, ui = NL.ui, h = ui.h;
const $ = s => document.querySelector(s);
const SVGNS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs, html) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v); if (html) e.innerHTML = html; return e; };
const TYPECOL = { ICMP: '#d94f74', ARP: '#8a62e8', DHCP: '#2f9a4a', Cato: '#d2741c', HTTP: '#2f7fd0', TCP: '#2f7fd0', Telnet: '#55667c', SSH: '#55667c', UDP: '#6f7f90' };
const S = { tool: 'select', cable: 'auto', placing: null, sel: null, view: { x: 0, y: 0, k: 1 }, cableStart: null, pduSrc: null, sim: false, undo: [], caps: {} };
const ws = () => $('#ws');

// ---------- capabilities (all optional)
const capP = name => (window.claude && typeof window.claude.use === 'function') ? window.claude.use(name).catch(() => null) : Promise.resolve(null);
const caps = { db: capP('db'), user: capP('user'), downloads: capP('downloads'), sample: capP('sample') };
Object.entries(caps).forEach(([k, p]) => p.then(v => { S.caps[k] = v; if (k === 'sample' && NL.tutor) NL.tutor.render(); renderMenus(); }));

NL.app = {
  loadScenario(id) { const sc = NL.scenario(id); ui.WM.closeAll(); ui.hosts.clear(); sc.build(); afterLoad(); ui.toast('「' + sc.name + '」を読み込みました'); if (id === 'diagram-done') warmUp(); },
  sampleOK: () => !!S.caps.sample,
  sample: () => caps.sample,
  simMode: () => S.sim
};
function warmUp() { for (let i = 0; i < 4; i++) NL.tick(); }
function afterLoad() {
  S.undo = []; S.sel = null; S.cableStart = null; S.pduSrc = null; pdus.length = 0; renderPdus();
  $('#labName').value = NL.lab.name;
  NL.sim.log = []; play.idx = 0; renderSim();
  fit();
}

// ---------- undo
const pushUndo = (label, fn) => { S.undo.push({ label, fn }); if (S.undo.length > 60) S.undo.shift(); };
function undo() {
  const u = S.undo.pop(); if (!u) { ui.toast('元に戻せる操作はありません'); return; }
  u.fn(); NL.touch('topo'); ui.toast('元に戻しました: ' + u.label);
}

// ---------- coordinates
function toWorld(cx, cy) { const r = ws().getBoundingClientRect(); return { x: (cx - r.left - S.view.x) / S.view.k, y: (cy - r.top - S.view.y) / S.view.k }; }
function applyView() { $('#vp').setAttribute('transform', `translate(${S.view.x},${S.view.y}) scale(${S.view.k})`); }
function fit() {
  const ds = NL.lab.devices; const r = ws().getBoundingClientRect();
  if (!ds.length || !r.width) { S.view = { x: r.width / 2 - 600, y: 40, k: 1 }; applyView(); return; }
  const xs = ds.map(d => d.x), ys = ds.map(d => d.y);
  const x0 = Math.min(...xs) - 90, x1 = Math.max(...xs) + 90, y0 = Math.min(...ys) - 70, y1 = Math.max(...ys) + 80;
  const k = Math.max(0.35, Math.min(1.3, Math.min(r.width / (x1 - x0), r.height / (y1 - y0))));
  S.view = { k, x: (r.width - (x1 - x0) * k) / 2 - x0 * k, y: (r.height - (y1 - y0) * k) / 2 - y0 * k };
  applyView();
}
function zoom(f, cx, cy) {
  const r = ws().getBoundingClientRect();
  if (cx == null) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
  const w = toWorld(cx, cy);
  S.view.k = Math.max(0.25, Math.min(3, S.view.k * f));
  S.view.x = cx - r.left - w.x * S.view.k; S.view.y = cy - r.top - w.y * S.view.k;
  applyView();
}

// ---------- drawing
let raf = 0;
const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
function portEndState(d, p) {
  if (!NL.portLinkUp(d, p)) return 'down';
  if (NL.isSwPort(d, p) && Object.keys(d.vlans).some(v => NL.stpBlocked(d, p, +v))) return 'blk';
  return 'up';
}
function draw() {
  const gL = $('#gLinks'), gD = $('#gDevs'), gN = $('#gNotes');
  gL.innerHTML = ''; gD.innerHTML = ''; gN.innerHTML = '';
  const showPorts = $('#optPorts').checked;
  for (const l of NL.lab.links) {
    const a = NL.dev(l.a.d), b = NL.dev(l.b.d); if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    const g = sv('g', { class: 'lnk' + (l.cable === 'console' ? ' console' : '') + (!NL.cableOk(l) ? ' bad' : ''), 'data-id': l.id });
    g.append(sv('line', { class: 'hitline', x1: a.x, y1: a.y, x2: b.x, y2: b.y }), sv('line', { class: 'wire', x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
    const t = sv('title'); t.textContent = `${a.name} ${l.a.p} ↔ ${b.name} ${l.b.p}（${{ auto: '自動', straight: 'ストレート', cross: 'クロス', console: 'コンソール' }[l.cable] || l.cable}）`; g.append(t);
    if (l.cable !== 'console') {
      const off = Math.min(40, len * 0.3);
      g.append(sv('circle', { class: portEndState(a, l.a.p), cx: a.x + ux * off, cy: a.y + uy * off, r: 4.2 }), sv('circle', { class: portEndState(b, l.b.p), cx: b.x - ux * off, cy: b.y - uy * off, r: 4.2 }));
    }
    if (showPorts && len > 120) {
      const po = Math.min(64, len * 0.38), nx = -uy * 9, ny = ux * 9;
      const t1 = sv('text', { class: 'pl', x: a.x + ux * po + nx, y: a.y + uy * po + ny + 3 }); t1.textContent = U.shortIf(l.a.p);
      const t2 = sv('text', { class: 'pl', x: b.x - ux * po + nx, y: b.y - uy * po + ny + 3 }); t2.textContent = U.shortIf(l.b.p);
      g.append(t1, t2);
    }
    gL.append(g);
  }
  for (const n of NL.lab.notes) {
    const g = sv('g', { class: 'note', 'data-id': n.id }); const t = sv('text', { x: n.x, y: n.y }); t.textContent = n.text; g.append(t); gN.append(g);
  }
  for (const d of NL.lab.devices) {
    const g = sv('g', { class: `dev ${ui.devClass(d)}${d.power ? '' : ' off'}${S.sel === d.id ? ' sel' : ''}`, transform: `translate(${d.x},${d.y})`, 'data-id': d.id });
    g.append(sv('rect', { class: 'hit', x: -36, y: -28, width: 72, height: 56, rx: 7 }));
    g.append(sv('g', {}, ui.iconFor(d)));
    if (!d.power) g.append(sv('circle', { class: 'pwr', cx: 24, cy: -18, r: 5, fill: 'var(--bad)' }));
    const nm = sv('text', { class: 'nm', y: 40 }); nm.textContent = d.name;
    const md = sv('text', { class: 'md', y: 52 }); md.textContent = NL.MODELS[d.model].label.replace('Catalyst ', '').replace('Cisco ', '');
    const tt = sv('title'); tt.textContent = tooltip(d);
    g.append(nm, md, tt);
    gD.append(g);
  }
  updateHint();
}
function tooltip(d) {
  const L = [d.name + '（' + NL.MODELS[d.model].label + '）'];
  NL.l3ifs(d).filter(i => i.ip && i.name !== 'MGMT').forEach(i => L.push(`${i.name}: ${i.ip}/${U.maskLen(i.mask)}${i.vip ? ' VIP' : ''}${i.up ? '' : '（down）'}`));
  if (d.serial) L.push('シリアル: ' + d.serial);
  return L.join('\n');
}

// ---------- hint bar
const HINTS = {
  select: '<b>選択</b> 機器をクリックで開く・ドラッグで移動。空き領域のドラッグでスクロール、ホイールで拡大縮小',
  cable: '<b>ケーブル</b> 1 台目をクリック → ポートを選ぶ → 2 台目をクリック → ポートを選ぶ。Esc で終了',
  delete: '<b>削除</b> 機器・ケーブル・メモをクリックすると削除します（Ctrl+Z で元に戻す）',
  note: '<b>メモ</b> ワークスペースをクリックするとメモを置けます',
  inspect: '<b>検査</b> 機器をクリックすると ARP・MAC・ルーティング・NAT の表を表示します',
  pdu: '<b>PDU（ping）</b> 送信元の機器 → 宛先の機器の順にクリックします'
};
function updateHint() {
  let t = HINTS[S.tool];
  if (S.placing) t = `<b>配置</b> ${NL.MODELS[S.placing].label} を置く場所をクリック（Esc でキャンセル）`;
  if (S.cableStart) t = `<b>ケーブル</b> ${ui.esc(S.cableStart.dev.name)} ${S.cableStart.port} から — つなぐ相手の機器をクリック`;
  if (S.pduSrc) t = `<b>PDU</b> 送信元 ${ui.esc(S.pduSrc.name)} — 宛先の機器をクリック`;
  $('#hintText').innerHTML = t;
  ws().className.baseVal = S.placing ? 'placing' : S.tool === 'select' ? '' : S.tool === 'cable' ? 'cabling' : S.tool;
}

// ---------- popups
function closePop() { const p = $('#pop'); p.hidden = true; p.innerHTML = ''; }
function openPop(x, y, content) {
  const p = $('#pop'); p.innerHTML = ''; p.append(...[].concat(content)); p.hidden = false;
  const r = p.getBoundingClientRect();
  p.style.left = Math.max(8, Math.min(window.innerWidth - r.width - 8, x + 8)) + 'px';
  p.style.top = Math.max(8, Math.min(window.innerHeight - r.height - 8, y + 8)) + 'px';
}
function portMenu(dev, x, y, onPick) {
  const consoleOnly = S.cable === 'console';
  const items = NL.allPorts(dev).map(p => {
    const isC = p === 'Console' || p === 'RS232';
    const pe = NL.peer(dev.id, p);
    const allowed = consoleOnly ? isC : !isC;
    return h('button', { class: 'pi', disabled: (pe || !allowed) ? true : null, onclick: () => { closePop(); onPick(p); } }, h('span', {}, p), h('small', {}, pe ? '→ ' + pe.dev.name : !allowed ? (consoleOnly ? '' : 'コンソール用') : ''));
  });
  openPop(x, y, [h('h5', {}, dev.name + ' のポート'), ...items]);
}

// ---------- pointer interaction
let drag = null;
function onDown(e) {
  if (e.button === 1 || e.button === 2) return;
  closePop();
  const w = toWorld(e.clientX, e.clientY);
  const devEl = e.target.closest('.dev'), lnkEl = e.target.closest('.lnk'), noteEl = e.target.closest('.note');
  if (S.placing) {
    const m = S.placing; const d = NL.addDevice(m, w.x, w.y);
    pushUndo(d.name + ' の追加', () => NL.removeDevice(d.id));
    if (!e.shiftKey) { S.placing = null; markPalette(); }
    return;
  }
  ws().setPointerCapture(e.pointerId);
  if (devEl && S.tool === 'select') { const d = NL.dev(devEl.dataset.id); drag = { type: 'dev', d, sx: e.clientX, sy: e.clientY, ox: d.x, oy: d.y, moved: false }; return; }
  if (noteEl && S.tool === 'select') { const n = NL.lab.notes.find(x => x.id === noteEl.dataset.id); drag = { type: 'note', n, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y, moved: false }; return; }
  drag = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: S.view.x, oy: S.view.y, moved: false, devEl, lnkEl, noteEl, w };
}
function onMove(e) {
  if (S.cableStart) { const w = toWorld(e.clientX, e.clientY); const gh = $('#ghost'); gh.setAttribute('x2', w.x); gh.setAttribute('y2', w.y); }
  if (!drag) return;
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  if (drag.type === 'dev') { drag.d.x = Math.round(drag.ox + dx / S.view.k); drag.d.y = Math.round(drag.oy + dy / S.view.k); schedule(); }
  else if (drag.type === 'note') { drag.n.x = Math.round(drag.ox + dx / S.view.k); drag.n.y = Math.round(drag.oy + dy / S.view.k); schedule(); }
  else { S.view.x = drag.ox + dx; S.view.y = drag.oy + dy; applyView(); }
}
function onUp(e) {
  const d0 = drag; drag = null;
  if (!d0) return;
  if (d0.moved) {
    if (d0.type === 'dev') { const { d, ox, oy } = d0; pushUndo(d.name + ' の移動', () => { d.x = ox; d.y = oy; }); NL.touch('move'); }
    if (d0.type === 'note') { const { n, ox, oy } = d0; pushUndo('メモの移動', () => { n.x = ox; n.y = oy; }); NL.touch('move'); }
    return;
  }
  const devEl = d0.type === 'dev' ? e.target.closest('.dev') || { dataset: { id: d0.d.id } } : d0.devEl;
  const dev = devEl ? NL.dev(devEl.dataset.id) : null;
  const lnk = d0.lnkEl ? NL.lab.links.find(l => l.id === d0.lnkEl.dataset.id) : null;
  const note = d0.type === 'note' ? d0.n : d0.noteEl ? NL.lab.notes.find(n => n.id === d0.noteEl.dataset.id) : null;
  clickAction(e, dev, lnk, note, d0.w || toWorld(e.clientX, e.clientY));
}
function clickAction(e, dev, lnk, note, w) {
  switch (S.tool) {
    case 'select':
      if (dev) { S.sel = dev.id; schedule(); ui.openDevice(dev); }
      else if (note) editNote(e, note);
      else if (lnk) linkInfo(e, lnk);
      else { S.sel = null; schedule(); }
      return;
    case 'delete':
      if (dev) {
        const links = NL.lab.links.filter(l => l.a.d === dev.id || l.b.d === dev.id);
        ui.WM.close('dev:' + dev.id);
        NL.removeDevice(dev.id);
        pushUndo(dev.name + ' の削除', () => { NL.lab.devices.push(dev); links.forEach(l => NL.lab.links.push(l)); });
      } else if (lnk) { NL.disconnect(lnk.id); pushUndo('ケーブルの削除', () => NL.lab.links.push(lnk)); }
      else if (note) { NL.lab.notes = NL.lab.notes.filter(n => n !== note); NL.touch('topo'); pushUndo('メモの削除', () => NL.lab.notes.push(note)); }
      return;
    case 'inspect':
      if (dev) openPop(e.clientX, e.clientY, [h('h5', {}, dev.name + ' の検査'), h('pre', { class: 'insp' }, ui.inspectText(dev))]);
      return;
    case 'note': {
      const inp = h('input', { type: 'text', placeholder: 'メモの内容', 'aria-label': 'メモ', id: 'noteInp' });
      const add = () => { const t = inp.value.trim(); closePop(); if (!t) return; const n = { id: 'n' + (++NL.lab.seq), x: Math.round(w.x), y: Math.round(w.y), text: t }; NL.lab.notes.push(n); NL.touch('topo'); pushUndo('メモの追加', () => { NL.lab.notes = NL.lab.notes.filter(x => x !== n); }); };
      inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') add(); });
      openPop(e.clientX, e.clientY, [h('h5', {}, 'メモを追加'), inp, h('div', { class: 'rowbtns', style: 'margin-top:6px' }, h('button', { class: 'hbtn primary', onclick: add }, '追加'))]);
      setTimeout(() => inp.focus(), 20);
      return;
    }
    case 'cable':
      if (!dev) return;
      if (!S.cableStart) {
        portMenu(dev, e.clientX, e.clientY, p => {
          S.cableStart = { dev, port: p };
          const gh = $('#ghost'); gh.setAttribute('x1', dev.x); gh.setAttribute('y1', dev.y); gh.setAttribute('x2', dev.x); gh.setAttribute('y2', dev.y); gh.style.display = '';
          updateHint();
        });
      } else {
        if (dev === S.cableStart.dev) { ui.toast('別の機器をクリックしてください', true); return; }
        portMenu(dev, e.clientX, e.clientY, p => {
          const r = NL.connect(S.cableStart.dev, S.cableStart.port, dev, p, S.cable);
          if (typeof r === 'string') ui.toast(r, true);
          else { pushUndo('ケーブルの接続', () => { NL.lab.links = NL.lab.links.filter(l => l !== r); }); if (!NL.cableOk(r)) ui.toast('ケーブルの種類が合っていないため、リンクはダウンのままです', true); }
          cancelCable();
        });
      }
      return;
    case 'pdu':
      if (!dev) return;
      if (!S.pduSrc) { S.pduSrc = dev; updateHint(); return; }
      if (dev === S.pduSrc) return;
      pickIp(e, dev, ip => { firePdu(S.pduSrc, dev, ip); S.pduSrc = null; updateHint(); });
  }
}
function cancelCable() { S.cableStart = null; $('#ghost').style.display = 'none'; updateHint(); }
function editNote(e, n) {
  const inp = h('input', { type: 'text', value: n.text, 'aria-label': 'メモ', id: 'noteEdit' });
  const save = () => { const old = n.text; n.text = inp.value.trim() || n.text; closePop(); NL.touch('topo'); pushUndo('メモの編集', () => { n.text = old; }); };
  inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') save(); });
  openPop(e.clientX, e.clientY, [h('h5', {}, 'メモを編集'), inp, h('div', { class: 'rowbtns', style: 'margin-top:6px' }, h('button', { class: 'hbtn primary', onclick: save }, '保存'))]);
  setTimeout(() => inp.focus(), 20);
}
function linkInfo(e, l) {
  const a = NL.dev(l.a.d), b = NL.dev(l.b.d);
  const sel = h('select', { class: 'inp', 'aria-label': 'ケーブルの種類', id: 'lnkType' }, ...(l.cable === 'console' ? [['console', 'コンソール']] : [['auto', '自動'], ['straight', 'ストレート'], ['cross', 'クロス']]).map(([v, t]) => h('option', { value: v, selected: v === l.cable ? true : null }, t)));
  sel.addEventListener('change', () => { const old = l.cable; l.cable = sel.value; NL.touch('topo'); pushUndo('ケーブル種別の変更', () => { l.cable = old; }); });
  openPop(e.clientX, e.clientY, [h('h5', {}, 'ケーブル'), h('div', { class: 'mono', style: 'font-size:12px;padding:0 6px 6px' }, `${a.name} ${l.a.p}\n↔ ${b.name} ${l.b.p}`), h('div', { style: 'padding:0 6px 6px;display:grid;gap:6px' }, sel,
    h('button', { class: 'hbtn', onclick: () => { NL.disconnect(l.id); pushUndo('ケーブルの削除', () => NL.lab.links.push(l)); closePop(); } }, 'このケーブルを外す'))]);
}
function pickIp(e, dev, cb) {
  const ips = NL.l3ifs(dev).filter(i => i.ip && i.name !== 'MGMT' && i.t !== 'lo').map(i => i.ip);
  if (!ips.length) { ui.toast(dev.name + ' には IP アドレスがありません', true); S.pduSrc = null; updateHint(); return; }
  if (ips.length === 1) { cb(ips[0]); return; }
  openPop(e.clientX, e.clientY, [h('h5', {}, '宛先 IP を選ぶ'), ...[...new Set(ips)].map(ip => h('button', { class: 'pi', onclick: () => { closePop(); cb(ip); } }, ip))]);
}

// ---------- PDUs
const pdus = [];
function firePdu(src, dst, ip, existing) {
  const r = NL.ping(src, ip, { count: 1 })[0];
  const okk = r.r === 'ok';
  const row = existing || { id: pdus.length + 1, src, dst, ip };
  row.status = okk ? 'Successful' : 'Failed';
  row.time = new Date().toLocaleTimeString('ja-JP');
  row.why = okk ? '' : (r.r === 'noroute' ? '経路なし' : r.r === 'unreach' ? '到達不能 (' + r.from + ')' : r.r === 'ttl' ? 'TTL 超過' : (NL.sim.drops[0] ? NL.sim.drops[0].at + ': ' + NL.sim.drops[0].reason : 'タイムアウト'));
  if (!existing) pdus.unshift(row);
  renderPdus();
  if (!S.sim) ui.toast(`${src.name} → ${ip}: ${okk ? '成功' : '失敗'}`, !okk);
}
function renderPdus() {
  const tb = $('#pduBody'); tb.innerHTML = '';
  if (!pdus.length) { tb.append(h('tr', {}, h('td', { colspan: 5, style: 'color:var(--muted)' }, '封筒ツールで送信元と宛先をクリックすると、ここに結果が並びます'))); return; }
  pdus.forEach(p => tb.append(h('tr', {},
    h('td', {}, h('button', { class: 'linkbtn', title: 'もう一度送る', onclick: () => firePdu(p.src, p.dst, p.ip, p) }, '再送')),
    h('td', { class: p.status === 'Successful' ? 'st-ok' : 'st-bad', title: p.why }, p.status === 'Successful' ? '成功' : '失敗'),
    h('td', {}, p.src.name), h('td', {}, p.dst.name + ' ' + p.ip),
    h('td', {}, h('button', { class: 'linkbtn', onclick: () => { pdus.splice(pdus.indexOf(p), 1); renderPdus(); } }, '削除')))));
}

// ---------- simulation mode
const play = { idx: 0, timer: null, playing: false, sel: null };
const evType = ev => ev.kind === 'drop' ? '破棄' : NL.frameInfo(ev.frame).type;
const filtered = () => NL.sim.log.filter(ev => ev.kind === 'drop' ? $('#fDrop').checked : (($('#f_' + evType(ev)) || {}).checked !== false));
function setSim(on) {
  S.sim = on;
  NL.sim.recording = on;
  NL.sim.log = []; play.idx = 0; play.sel = null; stopPlay();
  $('#mRt').setAttribute('aria-pressed', String(!on)); $('#mSim').setAttribute('aria-pressed', String(on));
  $('#simPanel').hidden = !on;
  $('#clock').textContent = on ? 'シミュレーション中（時間停止）' : 'リアルタイム';
  renderSim();
}
function renderSim() {
  if (!S.sim) return;
  const list = filtered();
  if (play.idx > list.length) play.idx = list.length;
  const tb = $('#evBody'); tb.innerHTML = '';
  list.slice(0, play.idx).forEach((ev, i) => {
    const ty = evType(ev), fi = ev.kind === 'drop' ? { text: ev.reason } : NL.frameInfo(ev.frame);
    const from = NL.dev(ev.kind === 'drop' ? ev.at : ev.from), to = ev.kind === 'drop' ? null : NL.dev(ev.to);
    tb.append(h('tr', { class: (ev === play.sel ? 'cur ' : '') + (ev.kind === 'drop' ? 'drop' : ''), onclick: () => { play.sel = ev; renderSim(); } },
      h('td', { class: 'mono' }, i + 1), h('td', { class: 'mono' }, (ev.t / 10).toFixed(3)),
      h('td', {}, from ? from.name : '?'), h('td', {}, to ? to.name : '—'),
      h('td', {}, h('span', { class: 'tsq', style: 'background:' + (TYPECOL[ty] || 'var(--bad)') }), ty),
      h('td', { style: 'max-width:180px;overflow:hidden;text-overflow:ellipsis', title: fi.text }, fi.text)));
  });
  $('#evCount').textContent = `${play.idx} / ${list.length} イベント`;
  const sc = $('#evScroll'); sc.scrollTop = sc.scrollHeight;
  renderDetail();
  $('#btnPlay').textContent = play.playing ? '一時停止' : '再生';
}
function renderDetail() {
  const box = $('#evDetail'); box.innerHTML = '';
  const ev = play.sel;
  if (!ev) { box.append(h('p', { style: 'color:var(--muted);margin:0' }, 'イベントをクリックすると、各レイヤーの中身を表示します。')); return; }
  if (ev.kind === 'drop') { box.append(h('b', {}, NL.dev(ev.at) ? NL.dev(ev.at).name : '', ' で破棄'), h('p', { style: 'margin:4px 0 0' }, ev.reason)); return; }
  const f = ev.frame, rows = [];
  const R = (k, v) => rows.push(h('tr', {}, h('th', {}, k), h('td', {}, v)));
  R('レイヤー 1', `${NL.dev(ev.from).name} ${ev.fport} → ${NL.dev(ev.to).name} ${ev.tport}`);
  R('レイヤー 2', `Ethernet II  ${f.src} → ${f.dst}${f.vlan != null ? '  802.1Q VLAN ' + f.vlan : ''}`);
  if (f.type === 'arp') R('ARP', `${f.arp.op === 'req' ? '要求' : '応答'}  送信元 ${f.arp.sip} (${f.arp.smac})  対象 ${f.arp.tip} (${f.arp.tmac})`);
  else {
    const p = f.ip;
    const l3 = p => `IPv4  ${p.src} → ${p.dst}  TTL ${p.ttl}  プロトコル ${p.proto.toUpperCase()}`;
    const l4 = p => p.proto === 'icmp' ? `ICMP ${p.icmp.type}${p.icmp.id != null ? '  id ' + p.icmp.id : ''}${p.icmp.seq != null ? '  seq ' + p.icmp.seq : ''}${p.icmp.code ? '  code ' + p.icmp.code : ''}` : `${p.proto.toUpperCase()}  ${p.sport} → ${p.dport}${p.tcp ? '  ' + p.tcp.flags : ''}`;
    R('レイヤー 3', l3(p)); R('レイヤー 4', l4(p));
    if (p.dhcp) R('DHCP', `${p.dhcp.op}  client ${p.dhcp.chaddr}${p.dhcp.yiaddr ? '  割当 ' + p.dhcp.yiaddr + ' / ' + p.dhcp.mask + '  GW ' + (p.dhcp.router || '-') : ''}${p.dhcp.giaddr ? '  relay ' + p.dhcp.giaddr : ''}`);
    if (p.cato) {
      R('Cato', `${p.cato.kind}${p.cato.serial ? '  Socket ' + p.cato.serial : ''}${p.cato.wan ? ' ' + p.cato.wan : ''}${p.cato.email ? '  user ' + p.cato.email : ''}${p.cato.clientIp ? '  Client IP ' + p.cato.clientIp : ''}`);
      if (p.cato.inner) { R('内側 L3', l3(p.cato.inner)); R('内側 L4', l4(p.cato.inner)); }
    }
  }
  box.append(h('b', {}, NL.frameInfo(f).text), h('table', { style: 'margin-top:6px' }, rows));
}
function animate(ev) {
  const g = $('#gAnim');
  if (ev.kind === 'drop') {
    const d = NL.dev(ev.at); if (!d) return;
    const x = sv('g', {}, `<path class="xmark" d="M${d.x - 9} ${d.y - 9} L${d.x + 9} ${d.y + 9} M${d.x + 9} ${d.y - 9} L${d.x - 9} ${d.y + 9}"/>`);
    g.append(x); setTimeout(() => x.remove(), 900); return;
  }
  const a = NL.dev(ev.from), b = NL.dev(ev.to); if (!a || !b) return;
  const ty = evType(ev);
  const env = sv('g', { class: 'env' }, `<rect x="-13" y="-8" width="26" height="16" rx="2" fill="${TYPECOL[ty] || '#888'}"/><text y="3">${ty.slice(0, 4)}</text>`);
  g.append(env);
  const dur = Math.max(120, +$('#speed').value * 0.8), t0 = performance.now();
  const step = now => {
    const k = Math.min(1, (now - t0) / dur);
    env.setAttribute('transform', `translate(${a.x + (b.x - a.x) * k},${a.y + (b.y - a.y) * k})`);
    if (k < 1) requestAnimationFrame(step); else setTimeout(() => env.remove(), 60);
  };
  requestAnimationFrame(step);
}
function stepFwd() {
  const list = filtered();
  if (play.idx >= list.length) { stopPlay(); return false; }
  const ev = list[play.idx++];
  play.sel = ev; animate(ev); renderSim();
  return true;
}
function startPlay() { if (play.playing) return; play.playing = true; const tick = () => { if (!play.playing) return; if (!stepFwd()) return; play.timer = setTimeout(tick, +$('#speed').value); }; tick(); renderSim(); }
function stopPlay() { play.playing = false; clearTimeout(play.timer); }
let lastLogLen = 0;
setInterval(() => {
  if (!S.sim) return;
  if (NL.sim.log.length !== lastLogLen) { lastLogLen = NL.sim.log.length; renderSim(); if ($('#autoPlay').checked) startPlay(); }
}, 250);

// ---------- palette
function buildPalette() {
  const pal = $('#palette'); pal.innerHTML = '';
  const groups = {};
  Object.entries(NL.MODELS).forEach(([id, m]) => (groups[m.group] = groups[m.group] || []).push([id, m]));
  for (const [g, items] of Object.entries(groups)) {
    pal.append(h('div', { class: 'pgroup' }, h('b', {}, g), h('div', { class: 'row' }, items.map(([id, m]) => {
      const svg = `<svg viewBox="-34 -26 68 52" aria-hidden="true"><g class="dev ${ui.modelClass(id)}">${ui.iconByModel(id)}</g></svg>`;
      const b = h('button', { class: 'pitem', draggable: 'true', 'data-model': id, title: m.label + '（クリックしてから配置場所をクリック、またはドラッグ）', html: svg + `<span>${ui.esc(m.label.replace('Catalyst ', '').replace('Cisco ', ''))}</span>` });
      b.addEventListener('click', () => { S.placing = S.placing === id ? null : id; markPalette(); updateHint(); });
      b.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', id); });
      return b;
    }))));
  }
  const cab = $('#cables'); cab.innerHTML = '';
  [['auto', '自動', 'M2 5h18'], ['straight', 'ストレート', 'M2 5h18'], ['cross', 'クロス', 'M2 2l18 6M2 8l18-6'], ['console', 'コンソール', 'M2 5h18']].forEach(([id, l, d]) => {
    cab.append(h('button', { class: 'cbtn', 'data-cable': id, onclick: () => { S.cable = id; setTool('cable'); markCables(); }, html: `<svg viewBox="0 0 22 10" aria-hidden="true"><path d="${d}" stroke="${id === 'console' ? 'var(--console-link)' : 'var(--link)'}" stroke-width="1.8" fill="none" ${id === 'console' ? 'stroke-dasharray="3 2"' : ''}/></svg>${l}` }));
  });
  markCables();
}
function markPalette() { document.querySelectorAll('.pitem').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.model === S.placing))); updateHint(); }
function markCables() { document.querySelectorAll('.cbtn').forEach(b => b.setAttribute('aria-pressed', String(S.tool === 'cable' && b.dataset.cable === S.cable))); }
function setTool(t) {
  S.tool = t; S.placing = null; S.pduSrc = null; if (S.cableStart) cancelCable();
  document.querySelectorAll('.tool[data-tool]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  markPalette(); markCables(); updateHint();
}

// ---------- persistence
let saveT;
function autosave() { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem('netlab.autosave', NL.serialize()); } catch (e) { /* storage unavailable */ } }, 1200); }
async function cloudList() {
  const db = S.caps.db, user = S.caps.user; if (!db || !user) return null;
  const id = await user.id(); if (!id) return null;
  const snap = await db.collection('data/users/' + id).limit(100).get();
  const docs = snap.docs.map(d => Object.assign({ id: d.id }, d.data())).filter(d => d.json).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { id, docs };
}
async function cloudSave() {
  try {
    const db = S.caps.db, user = S.caps.user; const uid = user && await user.id();
    if (!db || !uid) { ui.toast('クラウド保存はサインイン中の claude.ai でのみ使えます', true); return; }
    NL.lab.cloudId = NL.lab.cloudId || ('lab' + Date.now().toString(36));
    const json = NL.serialize();
    if (json.length > 240000) { ui.toast('ラボが大きすぎてクラウドに保存できません。JSON でエクスポートしてください', true); return; }
    await db.doc('data/users/' + uid + '/' + NL.lab.cloudId).set({ name: NL.lab.name, updatedAt: Date.now(), devices: NL.lab.devices.length, json });
    ui.toast('クラウドに保存しました: ' + NL.lab.name);
  } catch (e) { ui.toast('保存できませんでした（' + ((e && e.code) || 'error') + '）', true); }
}
async function cloudOpen() {
  const w = ui.WM.open('cloud', 'クラウドに保存したラボ', { w: 560, h: 420 });
  w.body.innerHTML = '';
  const box = h('div', { class: 'wbody' }, h('p', {}, '読み込み中…'));
  w.body.append(box);
  try {
    const r = await cloudList();
    box.innerHTML = '';
    if (!r) { box.append(h('p', {}, 'クラウド保存はサインイン中の claude.ai でのみ使えます。')); return; }
    if (!r.docs.length) { box.append(h('p', {}, '保存したラボはまだありません。「ファイル」→「クラウドに保存」で保存できます。')); return; }
    box.append(h('table', { class: 'ports' }, h('tr', {}, h('th', {}, '名前'), h('th', {}, '機器数'), h('th', {}, '更新'), h('th', {})), r.docs.map(d => h('tr', {},
      h('td', {}, d.name), h('td', {}, d.devices), h('td', {}, new Date(d.updatedAt).toLocaleString('ja-JP')),
      h('td', {}, h('button', { class: 'linkbtn', onclick: () => { try { loadJson(d.json); ui.WM.close('cloud'); ui.toast('読み込みました: ' + d.name); } catch (e) { ui.toast('読み込めませんでした', true); } } }, '開く'), ' ',
        h('button', { class: 'linkbtn', onclick: async () => { await S.caps.db.doc('data/users/' + r.id + '/' + d.id).delete(); cloudOpen(); } }, '削除'))))));
  } catch (e) { box.innerHTML = ''; box.append(h('p', { class: 'err-msg' }, '一覧を取得できませんでした（' + ((e && e.code) || 'error') + '）')); }
}
function loadJson(json) {
  ui.WM.closeAll(); ui.hosts.clear();
  NL.loadLab(json);
  afterLoad();
}
async function exportJson() {
  const dl = S.caps.downloads;
  const filename = (NL.lab.name || 'netlab').replace(/[\\/:*?"<>|]/g, '_') + '.json', data = JSON.stringify(NL.lab, null, 1);
  if (!dl) {
    // outside claude.ai a plain download link works
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const a = h('a', { href: url, download: filename, style: 'display:none' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    ui.toast('保存しました: ' + filename);
    return;
  }
  try { await dl.save({ filename, data }); ui.toast('保存しました'); }
  catch (e) { if (e && e.code !== 'declined') ui.toast('保存できませんでした（' + e.code + '）', true); }
}
function importJson() {
  const inp = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
  inp.addEventListener('change', () => {
    const f = inp.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { try { const o = JSON.parse(rd.result); if (!o.devices) throw new Error('format'); loadJson(o); ui.toast('読み込みました: ' + NL.lab.name); } catch (e) { ui.toast('NetLab のラボファイルではありません', true); } };
    rd.readAsText(f);
  });
  document.body.append(inp); inp.click(); setTimeout(() => inp.remove(), 60000);
}

// ---------- menus
function renderMenus() {
  const fm = $('#fileMenu'); if (!fm) return;
  fm.innerHTML = '';
  const it = (t, sub, fn, dis) => h('button', { onclick: () => { closeMenus(); fn(); }, disabled: dis ? true : null }, h('span', {}, t), sub ? h('small', {}, sub) : null);
  fm.append(
    it('新しい空のラボ', '', () => NL.app.loadScenario('blank')),
    h('hr'),
    it('クラウドに保存', S.caps.db ? 'claude.ai のあなた専用の保存領域' : 'claude.ai 版でのみ使えます', cloudSave, !S.caps.db),
    it('クラウドから開く', '', cloudOpen, !S.caps.db),
    h('hr'),
    it('JSON をエクスポート', 'ファイルとして保存', exportJson),
    it('JSON をインポート', 'エクスポートしたファイルを開く', importJson));
  const sm = $('#sampleMenu'); sm.innerHTML = '';
  NL.scenarios.forEach(sc => sm.append(it(sc.name, sc.desc.slice(0, 46) + '…', () => NL.app.loadScenario(sc.id))));
}
function closeMenus() { document.querySelectorAll('.menu-list').forEach(m => { m.hidden = true; }); }
function toggleMenu(id) { const m = $('#' + id); const was = m.hidden; closeMenus(); m.hidden = !was; }

// ---------- welcome
function welcome() {
  const ov = h('div', { class: 'welcome', role: 'dialog', 'aria-label': 'はじめに' });
  const go = id => { ov.remove(); if (id) NL.app.loadScenario(id); };
  ov.append(h('div', { class: 'box' },
    h('h2', {}, 'NetLab — Cisco と Cato の実機トレーナー'),
    h('p', { class: 'lead' }, '機器を置いて配線し、Cisco は CLI、Cato は Socket のローカル画面と管理コンソールで設定します。右上の「ガイド」に手順付きのラボ、マニュアル、AI 講師があります。どこから始めますか？'),
    h('div', { class: 'grid2' }, NL.scenarios.map(sc => h('button', { onclick: () => go(sc.id) }, h('b', {}, sc.name), h('small', {}, sc.desc)))),
    h('div', { class: 'rowbtns', style: 'margin-top:14px' }, h('button', { class: 'hbtn primary', onclick: () => { go('diagram-cisco'); showGuide(true); NL.tutor.setLab('cato'); } }, 'Cato 入門ガイドで始める'),
      h('button', { class: 'hbtn', onclick: () => { go('cisco-basic'); showGuide(true); NL.tutor.setLab('cisco'); } }, 'Cisco 入門ガイドで始める'))));
  document.body.append(ov);
}
function showGuide(on) { $('#guide').hidden = !on; $('#btnGuide').setAttribute('aria-pressed', String(on)); setTimeout(() => { const r = ws().getBoundingClientRect(); if (r.width) applyView(); }, 0); }

// ---------- boot
function boot() {
  buildPalette(); renderMenus();
  NL.tutor.mount($('#guide'));
  const svg = ws();
  svg.addEventListener('pointerdown', onDown);
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerup', onUp);
  svg.addEventListener('pointercancel', () => { drag = null; });
  svg.addEventListener('wheel', e => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY); }, { passive: false });
  svg.addEventListener('dragover', e => e.preventDefault());
  svg.addEventListener('drop', e => { e.preventDefault(); const m = e.dataTransfer.getData('text/plain'); if (!NL.MODELS[m]) return; const w = toWorld(e.clientX, e.clientY); const d = NL.addDevice(m, w.x, w.y); pushUndo(d.name + ' の追加', () => NL.removeDevice(d.id)); });
  document.querySelectorAll('.tool[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#zIn').onclick = () => zoom(1.2); $('#zOut').onclick = () => zoom(1 / 1.2); $('#zFit').onclick = fit; $('#btnUndo').onclick = undo;
  $('#optPorts').onchange = schedule;
  $('#mRt').onclick = () => setSim(false); $('#mSim').onclick = () => setSim(true);
  $('#btnCma').onclick = () => NL.catoUI.open();
  $('#btnGuide').onclick = () => showGuide($('#guide').hidden);
  $('#btnFile').onclick = () => toggleMenu('fileMenu'); $('#btnSample').onclick = () => toggleMenu('sampleMenu');
  $('#labName').addEventListener('change', e => { NL.lab.name = e.target.value.trim() || NL.lab.name; autosave(); });
  $('#btnPlay').onclick = () => { if (play.playing) { stopPlay(); renderSim(); } else startPlay(); };
  $('#btnStep').onclick = () => { stopPlay(); stepFwd(); };
  $('#btnBack').onclick = () => { stopPlay(); if (play.idx > 0) { play.idx--; play.sel = filtered()[play.idx - 1] || null; renderSim(); } };
  $('#btnReset').onclick = () => { stopPlay(); NL.sim.log = []; play.idx = 0; play.sel = null; lastLogLen = 0; renderSim(); };
  $('#btnKa').onclick = () => { NL.tick({ record: true }); ui.toast('Cato キープアライブと定期処理を 1 回実行しました'); };
  document.querySelectorAll('#simFilters input').forEach(i => i.addEventListener('change', renderSim));
  document.addEventListener('pointerdown', e => {
    if (!e.target.closest('.menu')) closeMenus();
    if (!e.target.closest('#pop') && !e.target.closest('#ws')) closePop();
  });
  document.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (e.key === 'Escape') { closePop(); closeMenus(); if (S.cableStart) cancelCable(); S.placing = null; S.pduSrc = null; markPalette(); updateHint(); }
    if (typing) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) { const d = NL.dev(S.sel); if (d) { setTool('delete'); clickAction({ clientX: 0, clientY: 0 }, d, null, null, null); setTool('select'); S.sel = null; } }
  });
  window.addEventListener('resize', () => applyView());

  let refT = 0;
  NL.on('change', what => {
    schedule(); autosave();
    if (what === 'load') return;
    if (!refT) refT = setTimeout(() => { refT = 0; ui.WM.refreshAll(what); }, 300);
  });
  NL.on('cato', () => ui.WM.refreshAll('cato'));
  setInterval(() => { if (!S.sim && document.visibilityState !== 'hidden') NL.tick(); }, 2000);

  let restored = false;
  try { const j = localStorage.getItem('netlab.autosave'); if (j) { NL.loadLab(j); restored = true; } } catch (e) { restored = false; }
  if (!restored) NL.scenario('diagram').build();
  afterLoad();
  setTool('select');
  draw();
  if (restored) { warmUp(); ui.toast('前回の作業を復元しました（' + NL.lab.name + '）'); }
  else welcome();
  requestAnimationFrame(fit);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
