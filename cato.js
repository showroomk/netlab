/* NetLab: Cato management console (simplified training replica of the cloud console). */
(function () {
'use strict';
const NL = window.NL, U = NL.util, ui = NL.ui, h = ui.h;
const st = { page: 'topology', siteId: null, siteTab: 'general' };
const cfg = () => NL.lab.cato;
const siteById = id => cfg().sites.find(s => s.id === id);
const newId = p => p + Math.random().toString(36).slice(2, 8);
const entLabel = e => {
  if (!e || e === 'any') return 'Any';
  if (e === 'sdp') return 'SDP ユーザー全員';
  const i = e.indexOf(':'), t = e.slice(0, i), v = e.slice(i + 1);
  if (t === 'site') { const s = siteById(v); return 'サイト: ' + (s ? s.name : '(削除済み)'); }
  if (t === 'user') return 'ユーザー: ' + v;
  if (t === 'cidr') return 'IP 範囲: ' + v;
  return e;
};
const SVC = [['any', 'Any'], ['icmp', 'ICMP (ping)'], ['http', 'HTTP (TCP 80)'], ['https', 'HTTPS (TCP 443)'], ['dns', 'DNS (UDP 53)'], ['ssh', 'SSH (TCP 22)'], ['telnet', 'Telnet (TCP 23)']];
const svcLabel = s => (SVC.find(x => x[0] === s) || [s, s.toUpperCase()])[1];

function open(page) {
  const w = ui.WM.open('cma', 'Cato 管理コンソール（練習用シミュレーション）', { w: 1000, h: 640, x: 60, y: 50 });
  if (page) { st.page = page; st.siteId = null; }
  if (!w.built) {
    w.built = true;
    w.nav = h('nav');
    w.main = h('main');
    w.body.append(h('div', { class: 'cma' }, w.nav, w.main));
    w.refresh = () => { if (!w.el.contains(document.activeElement) || document.activeElement.tagName === 'BUTTON') render(w); };
  }
  render(w);
  return w;
}
NL.on('cato', () => { const w = ui.WM.wins.get('cma'); if (w && w.refresh) w.refresh(); });

function render(w) {
  const nav = w.nav; nav.innerHTML = '';
  nav.append(h('div', { class: 'acct' }, h('b', {}, cfg().account), '練習用アカウント'));
  const items = [
    ['監視', [['topology', 'トポロジー'], ['events', 'イベント']]],
    ['ネットワーク', [['sites', 'サイト'], ['inventory', 'Socket インベントリ'], ['ipalloc', 'IP 割り当て（SDP）']]],
    ['アクセス', [['users', 'ユーザー（SDP）']]],
    ['セキュリティ', [['wanfw', 'WAN Firewall'], ['inetfw', 'Internet Firewall']]]
  ];
  for (const [g, list] of items) {
    nav.append(h('h6', {}, g));
    list.forEach(([id, l]) => nav.append(h('button', { 'aria-current': st.page === id ? 'page' : null, onclick: () => { st.page = id; st.siteId = null; render(w); } }, l)));
  }
  const m = w.main; m.innerHTML = '';
  const fn = { topology: pTopology, events: pEvents, sites: st.siteId ? pSite : pSites, inventory: pInventory, ipalloc: pIpAlloc, users: pUsers, wanfw: p => pFw(p, 'wan'), inetfw: p => pFw(p, 'inet') }[st.page];
  fn(m, w);
  m.append(h('p', { class: 'disclaimer' }, 'この画面は Cato の管理コンソールの考え方を練習するための簡略版です。実際の画面のメニュー名・項目・既定値はバージョンやアカウント設定で異なります。本番作業の前には公式ドキュメント（Cato Knowledge Base）で確認してください。'));
}
const lead = t => h('p', { class: 'lead' }, t);
const pill = (ok, a, b) => h('span', { class: 'pill ' + (ok ? 'ok' : 'bad') }, ok ? a : b);

function pTopology(m) {
  const sites = cfg().sites;
  m.append(h('h2', {}, 'トポロジー'), lead('各サイトの Socket とトンネルの状態、接続中の SDP ユーザーを一覧します。'));
  if (!sites.length) m.append(h('div', { class: 'card' }, h('p', {}, 'サイトがまだありません。「サイト」から作成し、Socket を割り当てます。')));
  const wrap = h('div', { class: 'sitecards' });
  for (const s of sites) {
    const socks = [[s.primarySerial, 'プライマリ'], [s.secondarySerial, 'セカンダリ']].filter(x => x[0]).map(([ser, role]) => {
      const d = NL.devBySerial(ser);
      if (!d) return h('div', { class: 'mono' }, ser + '（ラボ内に見つかりません）');
      const act = NL.cato.isActive(d);
      return h('div', { style: 'display:grid;gap:2px;padding:6px 0;border-top:1px solid var(--rule-2)' },
        h('div', { class: 'rowbtns' }, h('b', {}, d.name), h('span', { class: 'pill' }, role), s.secondarySerial ? h('span', { class: 'pill ' + (act ? 'ok' : '') }, act ? 'Active' : 'Standby') : null, d.power ? null : h('span', { class: 'pill bad' }, '電源 OFF')),
        h('div', { class: 'rowbtns', style: 'font-size:12px' }, ['WAN1', 'WAN2'].map(wn => h('span', {}, h('span', { class: 'dot ' + (NL.cato.tunUp(d, wn) ? 'up' : 'down') }), wn + ' ' + (NL.cato.tunUp(d, wn) ? 'UP' : 'DOWN')))));
    });
    const up = [s.primarySerial, s.secondarySerial].some(ser => { const d = NL.devBySerial(ser); return d && ['WAN1', 'WAN2'].some(x => NL.cato.tunUp(d, x)); });
    wrap.append(h('div', { class: 'card' }, h('div', { class: 'rowbtns' }, h('h3', { style: 'margin:0' }, s.name), pill(up, '接続', '未接続')),
      h('div', { class: 'mono', style: 'font-size:12px;color:var(--muted);margin:4px 0' }, s.nativeRange + (s.ranges || []).map(r => ' / ' + r.cidr).join('')),
      socks.length ? socks : h('div', { style: 'color:var(--muted);font-size:12px' }, 'Socket 未割り当て'),
      s.secondarySerial ? h('div', { style: 'font-size:12px;margin-top:4px' }, 'HA: ', (() => { const r = NL.cato.haStatus(s); return h('span', { class: 'pill ' + (r.ready ? 'ok' : 'warn') }, r.reason); })()) : null));
  }
  m.append(wrap);
  const cl = Object.entries(NL.cato.clients());
  m.append(h('div', { class: 'card' }, h('h3', {}, 'SDP ユーザー（接続中）'), cl.length ? h('table', { class: 'grid' }, h('tr', {}, h('th', {}, 'ユーザー'), h('th', {}, 'Client IP'), h('th', {}, '送信元')), cl.map(([e, c]) => h('tr', {}, h('td', {}, e), h('td', { class: 'mono' }, c.clientIp), h('td', { class: 'mono' }, c.ip)))) : h('p', { style: 'color:var(--muted);margin:0' }, '接続中のユーザーはいません')));
}
function pEvents(m) {
  m.append(h('h2', {}, 'イベント'), lead('トンネルの確立・切断、HA の切り替え、SDP 接続、ファイアウォールのブロックを記録します（新しい順）。'));
  const ev = NL.cato.events();
  m.append(h('div', { class: 'tblwrap' }, h('table', { class: 'grid' }, h('tr', {}, h('th', {}, '時刻'), h('th', {}, '種類'), h('th', {}, 'サイト / ユーザー'), h('th', {}, '内容')),
    ev.length ? ev.slice(0, 200).map(e => h('tr', {}, h('td', { class: 'mono' }, e.time), h('td', {}, e.type), h('td', {}, e.site), h('td', {}, e.msg))) : h('tr', {}, h('td', { colspan: 4, style: 'color:var(--muted)' }, 'まだイベントはありません')))));
}
function pSites(m, w) {
  m.append(h('h2', {}, 'サイト'), lead('サイトは「拠点」の単位です。サイトを作ってから Socket を割り当て、LAN のネットワーク（ネイティブ範囲）や追加のネットワーク範囲を登録します。'));
  const rows = cfg().sites.map(s => h('tr', { class: 'click', onclick: () => { st.siteId = s.id; st.siteTab = 'general'; render(w); } },
    h('td', {}, h('b', {}, s.name)), h('td', {}, s.type), h('td', {}, 'Socket ' + s.conn), h('td', { class: 'mono' }, s.nativeRange), h('td', {}, s.primarySerial ? (s.secondarySerial ? '2 台（HA）' : '1 台') : '未割り当て'), h('td', {}, s.bw + ' Mbps')));
  m.append(h('div', { class: 'tblwrap' }, h('table', { class: 'grid' }, h('tr', {}, h('th', {}, 'サイト名'), h('th', {}, '種類'), h('th', {}, '接続方式'), h('th', {}, 'ネイティブ範囲'), h('th', {}, 'Socket'), h('th', {}, 'ライセンス帯域')), rows.length ? rows : h('tr', {}, h('td', { colspan: 6, style: 'color:var(--muted)' }, 'サイトはまだありません')))));
  const f = {
    name: h('input', { type: 'text', id: ui.uid(), placeholder: '例 拠点A' }),
    type: h('select', { id: ui.uid() }, ['Branch', 'Datacenter', 'Headquarters'].map(x => h('option', {}, x))),
    country: h('select', { id: ui.uid() }, ['Japan', 'United States', 'Singapore', 'Germany'].map(x => h('option', {}, x))),
    bw: h('select', { id: ui.uid() }, [25, 50, 100, 250, 500, 1000].map(x => h('option', { value: x }, x + ' Mbps'))),
    range: h('input', { type: 'text', class: 'mono', id: ui.uid(), placeholder: '例 10.0.0.0/28' }),
    lip: h('input', { type: 'text', class: 'mono', id: ui.uid(), placeholder: '例 10.0.0.3' })
  };
  f.bw.value = '100';
  const msg = h('span', { 'aria-live': 'polite' });
  m.append(h('div', { class: 'card', style: 'margin-top:12px' }, h('h3', {}, 'サイトを追加'), h('div', { class: 'form' },
    ui.field('サイト名', f.name), ui.field('サイトの種類', f.type), ui.field('接続方式', h('select', { id: ui.uid() }, h('option', {}, 'Socket X1500'))), ui.field('国', f.country), ui.field('ライセンス帯域', f.bw),
    ui.field('ネイティブ範囲 (CIDR)', f.range), ui.field('ローカル IP', f.lip),
    h('p', { style: 'margin:0;color:var(--muted);font-size:12px' }, 'ネイティブ範囲は Socket の LAN ポートがつながるセグメントです。ローカル IP はその範囲の中で Socket が持つアドレス（LAN 側機器のゲートウェイ）です。HA 構成ではこの値が VIP になります。'),
    h('div', { class: 'rowbtns' }, h('button', { class: 'hbtn primary', onclick: () => {
      const name = f.name.value.trim(), r = U.parseCidr(f.range.value), lip = f.lip.value.trim();
      const err = !name ? 'サイト名を入れてください' : cfg().sites.some(s => s.name === name) ? '同じ名前のサイトがあります' : !r ? 'ネイティブ範囲を CIDR（例 10.0.0.0/24）で入力してください' : r.net !== r.addr ? `ネットワークアドレスで入力してください（${r.net}/${r.len}）` : !U.inCidr(lip, r) || lip === r.net ? 'ローカル IP はネイティブ範囲内のホストアドレスにしてください' : overlap(r) ? '他のサイトの範囲と重なっています: ' + overlap(r) : '';
      if (err) { msg.className = 'err-msg'; msg.textContent = err; return; }
      const s = { id: newId('s'), name, type: f.type.value, conn: 'X1500', country: f.country.value, bw: +f.bw.value, nativeRange: r.net + '/' + r.len, localIp: lip, primarySerial: '', secondarySerial: '', ha: null,
        wan: { WAN1: { precedence: 'active', up: +f.bw.value, down: +f.bw.value }, WAN2: { precedence: 'active', up: +f.bw.value, down: +f.bw.value } }, ranges: [] };
      cfg().sites.push(s);
      NL.cato.event('設定', name, 'サイトを作成しました');
      NL.touch('cfg');
      st.siteId = s.id; st.siteTab = 'socket'; render(w);
      ui.toast('サイト「' + name + '」を作成しました。次に Socket を割り当てます');
    } }, '作成'), msg))));
}
function overlap(r, exceptId) {
  for (const s of cfg().sites) {
    if (s.id === exceptId) continue;
    for (const c of [s.nativeRange, ...(s.ranges || []).map(x => x.cidr)]) {
      const p = U.parseCidr(c); if (!p) continue;
      const m = Math.min(p.len, r.len);
      if (U.netOf(p.net, U.n2ip(U.len2mask(m))) === U.netOf(r.net, U.n2ip(U.len2mask(m)))) return s.name + ' ' + c;
    }
  }
  return '';
}
function pSite(m, w) {
  const s = siteById(st.siteId);
  if (!s) { st.siteId = null; return pSites(m, w); }
  m.append(h('div', { class: 'crumb' }, h('button', { class: 'linkbtn', onclick: () => { st.siteId = null; render(w); } }, 'サイト'), ' / ', s.name), h('h2', {}, s.name));
  const tabs = [['general', '一般'], ['socket', 'Socket'], ['ifs', 'ネットワーク インターフェース'], ['ranges', 'ネットワーク範囲'], ['ha', '高可用性 (HA)']];
  m.append(h('div', { class: 'tabs', style: 'margin:6px 0 12px;padding:0' }, tabs.map(([id, l]) => h('button', { 'aria-selected': String(st.siteTab === id), onclick: () => { st.siteTab = id; render(w); } }, l))));
  const msg = h('span', { 'aria-live': 'polite' });
  const ok = t => { msg.className = 'ok-msg'; msg.textContent = t; NL.touch('cfg'); NL.emit('cato'); };
  const bad = t => { msg.className = 'err-msg'; msg.textContent = t; };
  if (st.siteTab === 'general') {
    const name = h('input', { type: 'text', value: s.name, id: ui.uid() }), type = h('select', { id: ui.uid() }, ['Branch', 'Datacenter', 'Headquarters'].map(x => h('option', {}, x))), bw = h('input', { type: 'text', value: s.bw, class: 'mono', id: ui.uid() });
    type.value = s.type;
    m.append(h('div', { class: 'form' }, ui.field('サイト名', name), ui.field('種類', type), ui.field('ライセンス帯域 (Mbps)', bw), ui.field('国', h('span', {}, s.country)),
      h('div', { class: 'rowbtns' }, h('button', { class: 'hbtn primary', onclick: () => { if (!name.value.trim()) return bad('サイト名は必須です'); s.name = name.value.trim(); s.type = type.value; s.bw = +bw.value || s.bw; ok('保存しました'); } }, '保存'),
        h('button', { class: 'hbtn', onclick: () => { if (msg.dataset.arm !== '1') { msg.dataset.arm = '1'; bad('もう一度押すとサイトを削除します'); return; } cfg().sites = cfg().sites.filter(x => x !== s); NL.cato.event('設定', s.name, 'サイトを削除しました'); NL.touch('cfg'); st.siteId = null; render(w); } }, 'サイトを削除'), msg)));
    return;
  }
  if (st.siteTab === 'socket') {
    const inv = NL.cato.inventory();
    const opts = cur => [h('option', { value: '' }, '（なし）'), ...inv.filter(i => !i.site || i.site === s).map(i => h('option', { value: i.serial, selected: i.serial === cur ? true : null }, `${i.serial}  ${i.dev.name}${i.seen ? '' : '（未接続）'}`))];
    const p = h('select', { id: ui.uid(), class: 'mono' }, opts(s.primarySerial)), sec = h('select', { id: ui.uid(), class: 'mono' }, opts(s.secondarySerial));
    m.append(lead('Socket はシリアル番号でサイトに結び付けます。Socket の物理タブやローカル WebUI でシリアル番号を確認できます。Cato Cloud に接続済みの Socket は「Socket インベントリ」にも表示されます。'),
      h('div', { class: 'form' }, ui.field('プライマリ Socket', p), ui.field('セカンダリ Socket（HA）', sec),
        h('div', { class: 'rowbtns' }, h('button', { class: 'hbtn primary', onclick: () => {
          if (p.value && p.value === sec.value) return bad('同じ Socket を両方に指定できません');
          if (!p.value && sec.value) return bad('先にプライマリを指定してください');
          s.primarySerial = p.value; s.secondarySerial = sec.value;
          if (sec.value && !s.ha) s.ha = { primaryIp: '', secondaryIp: '' };
          NL.cato.event('設定', s.name, `Socket 割り当て: プライマリ ${p.value || 'なし'} / セカンダリ ${sec.value || 'なし'}`);
          ok('割り当てを保存しました' + (sec.value ? '。「高可用性 (HA)」タブで LAN の IP を設定してください' : ''));
        } }, '保存'), msg)));
    return;
  }
  if (st.siteTab === 'ifs') {
    const box = h('div', { style: 'display:grid;gap:10px' });
    ['WAN1', 'WAN2'].forEach(wn => {
      const c = s.wan[wn] = s.wan[wn] || { precedence: 'active', up: s.bw, down: s.bw };
      const pr = h('select', { id: ui.uid() }, [['active', 'Active'], ['passive', 'Passive'], ['last-resort', 'Last-resort']].map(([v, l]) => h('option', { value: v }, l)));
      pr.value = c.precedence;
      const up = h('input', { type: 'text', class: 'mono', value: c.up, id: ui.uid() }), dn = h('input', { type: 'text', class: 'mono', value: c.down, id: ui.uid() });
      box.append(h('div', { class: 'card' }, h('h3', {}, wn + '（WAN）'), h('div', { class: 'form' }, ui.field('優先度 (Precedence)', pr), ui.field('上り帯域 (Mbps)', up), ui.field('下り帯域 (Mbps)', dn),
        h('div', { class: 'rowbtns' }, h('button', { class: 'hbtn', onclick: () => { c.precedence = pr.value; c.up = +up.value || c.up; c.down = +dn.value || c.down; ok(wn + ' を保存しました'); } }, '保存')))));
    });
    const rng = h('input', { type: 'text', class: 'mono', value: s.nativeRange, id: ui.uid() }), lip = h('input', { type: 'text', class: 'mono', value: s.localIp, id: ui.uid() });
    box.append(h('div', { class: 'card' }, h('h3', {}, 'LAN1（ネイティブ範囲）'), h('div', { class: 'form' }, ui.field('ネイティブ範囲 (CIDR)', rng), ui.field(s.secondarySerial ? 'ローカル IP（= VIP）' : 'ローカル IP', lip),
      h('div', { class: 'rowbtns' }, h('button', { class: 'hbtn', onclick: () => {
        const r = U.parseCidr(rng.value);
        if (!r || r.net !== r.addr) return bad('ネイティブ範囲をネットワークアドレスの CIDR で入力してください');
        if (!U.inCidr(lip.value.trim(), r)) return bad('ローカル IP が範囲外です');
        const ov = overlap(r, s.id); if (ov) return bad('他サイトと重複: ' + ov);
        s.nativeRange = r.net + '/' + r.len; s.localIp = lip.value.trim(); ok('LAN1 を保存しました');
      } }, '保存')))));
    m.append(lead('WAN の優先度は、2 回線のどちらを使うかの方針です。Active 同士なら両方を使い（ここでは WAN1 を優先）、Passive は Active が全滅したときだけ使います。'), box, msg);
    return;
  }
  if (st.siteTab === 'ranges') {
    m.append(lead('ネイティブ範囲以外に、このサイトの裏にあるネットワークを登録します。L3 スイッチやルーターの先にあるセグメントは「Routed」で登録し、ゲートウェイにその機器の IP（ネイティブ範囲内）を指定します。登録しないと Cato はその宛先をサイトへ届けられません。'));
    const rows = (s.ranges || []).map(r => h('tr', {}, h('td', {}, r.name), h('td', {}, r.type === 'routed' ? 'Routed' : r.type), h('td', { class: 'mono' }, r.cidr), h('td', { class: 'mono' }, r.gw || '—'),
      h('td', {}, h('button', { class: 'linkbtn', onclick: () => { s.ranges = s.ranges.filter(x => x !== r); ok('削除しました'); render(w); } }, '削除'))));
    m.append(h('table', { class: 'grid' }, h('tr', {}, h('th', {}, '名前'), h('th', {}, '種類'), h('th', {}, 'サブネット'), h('th', {}, 'ゲートウェイ'), h('th', {}, '')),
      h('tr', {}, h('td', {}, 'Native Range'), h('td', {}, 'Native'), h('td', { class: 'mono' }, s.nativeRange), h('td', { class: 'mono' }, s.localIp + '（Socket）'), h('td')), rows));
    const n = h('input', { type: 'text', id: ui.uid(), placeholder: '例 VLAN20' }), c = h('input', { type: 'text', class: 'mono', id: ui.uid(), placeholder: '例 10.0.1.0/24' }), g = h('input', { type: 'text', class: 'mono', id: ui.uid(), placeholder: '例 10.0.0.4' });
    m.append(h('div', { class: 'card', style: 'margin-top:12px' }, h('h3', {}, '範囲を追加（Routed）'), h('div', { class: 'form' }, ui.field('名前', n), ui.field('サブネット (CIDR)', c), ui.field('ゲートウェイ', g),
      h('div', { class: 'rowbtns' }, h('button', { class: 'hbtn primary', onclick: () => {
        const r = U.parseCidr(c.value);
        if (!r || r.net !== r.addr) return bad('サブネットをネットワークアドレスの CIDR で入力してください');
        if (!U.inCidr(g.value.trim(), s.nativeRange)) return bad('ゲートウェイはネイティブ範囲（' + s.nativeRange + '）の中の IP にしてください');
        const ov = overlap(r); if (ov) return bad('既存の範囲と重複: ' + ov);
        s.ranges = s.ranges || []; s.ranges.push({ id: newId('r'), name: n.value.trim() || r.net, type: 'routed', cidr: r.net + '/' + r.len, gw: g.value.trim() });
        ok('追加しました'); render(w);
      } }, '追加'), msg))));
    return;
  }
  if (st.siteTab === 'ha') {
    if (!s.secondarySerial) { m.append(lead('HA を使うには「Socket」タブでセカンダリ Socket を割り当てます。')); return; }
    s.ha = s.ha || { primaryIp: '', secondaryIp: '' };
    const pi = h('input', { type: 'text', class: 'mono', value: s.ha.primaryIp, id: ui.uid() }), si = h('input', { type: 'text', class: 'mono', value: s.ha.secondaryIp, id: ui.uid() });
    const r = NL.cato.haStatus(s);
    m.append(lead('HA 構成では 2 台の Socket が同じ LAN にいて、アクティブ側が VIP（ネイティブ範囲のローカル IP）を持ちます。各 Socket 自身の LAN アドレスを別に決めます。アクティブ側のトンネルがすべて落ちるか電源が切れると、スタンバイ側が VIP を引き継ぎます。'),
      h('div', { class: 'card' }, h('div', { class: 'rowbtns' }, h('b', {}, 'HA 状態'), h('span', { class: 'pill ' + (r.ready ? 'ok' : 'warn') }, r.reason)),
        h('dl', { class: 'kv', style: 'margin-top:8px' }, h('dt', {}, 'VIP'), h('dd', {}, s.localIp), h('dt', {}, 'アクティブ'), h('dd', {}, (NL.devBySerial(NL.cato.activeSerial(s)) || {}).name || '—'))),
      h('div', { class: 'form' }, ui.field('プライマリの LAN IP', pi), ui.field('セカンダリの LAN IP', si),
        h('div', { class: 'rowbtns' }, h('button', { class: 'hbtn primary', onclick: () => {
          const a = pi.value.trim(), b = si.value.trim();
          if (!U.inCidr(a, s.nativeRange) || !U.inCidr(b, s.nativeRange)) return bad('どちらもネイティブ範囲（' + s.nativeRange + '）の中にしてください');
          if (a === b || a === s.localIp || b === s.localIp) return bad('プライマリ・セカンダリ・VIP はすべて別のアドレスにしてください');
          s.ha.primaryIp = a; s.ha.secondaryIp = b; ok('HA 設定を保存しました');
        } }, '保存'), msg)));
  }
}
function pInventory(m, w) {
  m.append(h('h2', {}, 'Socket インベントリ'), lead('ラボ内の Socket の一覧です。WAN から Cato Cloud に到達できた Socket は「接続済み」になり、サイトに割り当てられるようになります。'));
  const inv = NL.cato.inventory();
  m.append(h('div', { class: 'tblwrap' }, h('table', { class: 'grid' }, h('tr', {}, h('th', {}, 'シリアル番号'), h('th', {}, '名前（ラボ）'), h('th', {}, 'モデル'), h('th', {}, 'Cato Cloud'), h('th', {}, '送信元 IP（NAT 後）'), h('th', {}, 'サイト')),
    inv.length ? inv.map(i => h('tr', {}, h('td', { class: 'mono' }, i.serial), h('td', {}, i.dev.name), h('td', {}, 'X1500'), h('td', {}, pill(i.connected, '接続済み', i.seen ? '切断' : '未接続')), h('td', { class: 'mono' }, i.publicIp || '—'),
      h('td', {}, i.site ? h('button', { class: 'linkbtn', onclick: () => { st.page = 'sites'; st.siteId = i.site.id; st.siteTab = 'socket'; render(w); } }, `${i.site.name}（${i.role === 'primary' ? 'P' : 'S'}）`) : '未割り当て'))) : h('tr', {}, h('td', { colspan: 6, style: 'color:var(--muted)' }, 'ラボに Socket がありません')))));
}
function pIpAlloc(m) {
  const inp = h('input', { type: 'text', class: 'mono', value: cfg().sdpRange, id: ui.uid() });
  const msg = h('span');
  m.append(h('h2', {}, 'IP 割り当て（SDP）'), lead('Cato Client で接続したユーザーに配る IP アドレスの範囲です。サイトの範囲と重ならないようにします。'),
    h('div', { class: 'form' }, ui.field('SDP 用 IP 範囲 (CIDR)', inp), h('div', { class: 'rowbtns' }, h('button', { class: 'hbtn primary', onclick: () => {
      const r = U.parseCidr(inp.value);
      if (!r || r.net !== r.addr) { msg.className = 'err-msg'; msg.textContent = 'ネットワークアドレスの CIDR で入力してください'; return; }
      const ov = overlap(r); if (ov) { msg.className = 'err-msg'; msg.textContent = 'サイトの範囲と重複: ' + ov; return; }
      cfg().sdpRange = r.net + '/' + r.len; NL.touch('cfg'); msg.className = 'ok-msg'; msg.textContent = '保存しました（次の接続から反映）';
    } }, '保存'), msg)));
}
function pUsers(m, w) {
  m.append(h('h2', {}, 'ユーザー（SDP）'), lead('Cato Client で接続できるユーザーです。PC の Cato Client アプリでこのメールアドレスを入れると接続できます。'));
  const cl = NL.cato.clients();
  m.append(h('table', { class: 'grid' }, h('tr', {}, h('th', {}, '名前'), h('th', {}, 'メール'), h('th', {}, '状態'), h('th', {}, 'Client IP'), h('th', {}, '')),
    cfg().users.length ? cfg().users.map(u => { const c = cl[u.email.toLowerCase()]; return h('tr', {}, h('td', {}, u.name), h('td', { class: 'mono' }, u.email), h('td', {}, pill(!!c, '接続中', '未接続')), h('td', { class: 'mono' }, c ? c.clientIp : '—'),
      h('td', {}, h('button', { class: 'linkbtn', onclick: () => { cfg().users = cfg().users.filter(x => x !== u); NL.touch('cfg'); render(w); } }, '削除'))); }) : h('tr', {}, h('td', { colspan: 5, style: 'color:var(--muted)' }, 'ユーザーはまだいません'))));
  const n = h('input', { type: 'text', id: ui.uid(), placeholder: '例 User 01' }), e = h('input', { type: 'text', class: 'mono', id: ui.uid(), placeholder: '例 user01@lab.local' });
  const msg = h('span');
  m.append(h('div', { class: 'card', style: 'margin-top:12px' }, h('h3', {}, 'ユーザーを追加'), h('div', { class: 'form' }, ui.field('名前', n), ui.field('メール', e),
    h('div', { class: 'rowbtns' }, h('button', { class: 'hbtn primary', onclick: () => {
      const em = e.value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(em)) { msg.className = 'err-msg'; msg.textContent = 'メールアドレスの形式で入力してください'; return; }
      if (cfg().users.some(u => u.email.toLowerCase() === em)) { msg.className = 'err-msg'; msg.textContent = '登録済みです'; return; }
      cfg().users.push({ id: newId('u'), name: n.value.trim() || em, email: em }); NL.touch('cfg'); render(w); ui.toast('ユーザーを追加しました');
    } }, '追加'), msg))));
}
function entOptions(kind, includeCidr) {
  const o = [['any', 'Any']];
  cfg().sites.forEach(s => o.push(['site:' + s.id, 'サイト: ' + s.name]));
  o.push(['sdp', 'SDP ユーザー全員']);
  cfg().users.forEach(u => o.push(['user:' + u.email.toLowerCase(), 'ユーザー: ' + u.email]));
  if (includeCidr) o.push(['cidr', 'IP 範囲を指定…']);
  void kind;
  return o;
}
function pFw(m, kind) {
  const pol = kind === 'wan' ? cfg().wanFw : cfg().inetFw;
  m.append(h('h2', {}, kind === 'wan' ? 'WAN Firewall' : 'Internet Firewall'),
    lead(kind === 'wan' ? 'サイト間・SDP ユーザーとサイト間の通信を制御します。上から順に評価し、最初に一致したルールを適用します。どのルールにも一致しない通信はブロックされます（ホワイトリスト型）。戻りの通信は自動で許可されます。' : 'サイトや SDP ユーザーからインターネット（どのサイトにも属さない宛先）への通信を制御します。上から順に評価し、どれにも一致しなければ許可されます（ブラックリスト型）。'));
  const rows = pol.rules.map((r, i) => h('tr', {},
    h('td', { class: 'mono' }, i + 1),
    h('td', {}, h('input', { type: 'checkbox', checked: r.enabled, 'aria-label': '有効', onchange: e => { r.enabled = e.target.checked; NL.touch('cfg'); } })),
    h('td', {}, r.name), h('td', {}, entLabel(r.src)), h('td', {}, kind === 'wan' ? entLabel(r.dst) : (r.dst === 'any' ? 'Any（インターネット）' : entLabel(r.dst))), h('td', {}, svcLabel(r.svc)),
    h('td', {}, h('span', { class: 'pill ' + (r.action === 'allow' ? 'ok' : 'bad') }, r.action === 'allow' ? '許可' : 'ブロック')),
    h('td', { class: 'mono' }, NL.cato.hits(r.id)),
    h('td', { style: 'white-space:nowrap' },
      h('button', { class: 'linkbtn', disabled: i === 0 ? true : null, onclick: () => { pol.rules.splice(i - 1, 0, pol.rules.splice(i, 1)[0]); NL.touch('cfg'); NL.emit('cato'); } }, '↑'), ' ',
      h('button', { class: 'linkbtn', disabled: i === pol.rules.length - 1 ? true : null, onclick: () => { pol.rules.splice(i + 1, 0, pol.rules.splice(i, 1)[0]); NL.touch('cfg'); NL.emit('cato'); } }, '↓'), ' ',
      h('button', { class: 'linkbtn', onclick: () => { pol.rules.splice(i, 1); NL.touch('cfg'); NL.emit('cato'); } }, '削除'))));
  m.append(h('div', { class: 'tblwrap' }, h('table', { class: 'grid' }, h('tr', {}, ['#', '有効', 'ルール名', '送信元', '宛先', 'サービス', 'アクション', 'ヒット', ''].map(t => h('th', {}, t))), rows,
    h('tr', {}, h('td', {}, '—'), h('td'), h('td', { style: 'color:var(--muted)' }, '暗黙のルール'), h('td', {}, 'Any'), h('td', {}, 'Any'), h('td', {}, 'Any'), h('td', {}, h('span', { class: 'pill ' + (kind === 'wan' ? 'bad' : 'ok') }, kind === 'wan' ? 'ブロック' : '許可')), h('td'), h('td')))));
  const name = h('input', { type: 'text', id: ui.uid(), placeholder: '例 拠点B から拠点A への ping' });
  const mkSel = inc => h('select', { id: ui.uid() }, entOptions(kind, inc).map(([v, l]) => h('option', { value: v }, l)));
  const src = mkSel(true), dst = kind === 'wan' ? mkSel(true) : h('select', { id: ui.uid() }, h('option', { value: 'any' }, 'Any（インターネット）'), h('option', { value: 'cidr' }, 'IP 範囲を指定…'));
  const srcC = h('input', { type: 'text', class: 'mono', placeholder: '送信元 CIDR', id: ui.uid(), hidden: true }), dstC = h('input', { type: 'text', class: 'mono', placeholder: '宛先 CIDR', id: ui.uid(), hidden: true });
  src.addEventListener('change', () => { srcC.hidden = src.value !== 'cidr'; }); dst.addEventListener('change', () => { dstC.hidden = dst.value !== 'cidr'; });
  const svc = h('select', { id: ui.uid() }, SVC.map(([v, l]) => h('option', { value: v }, l)), h('option', { value: 'custom' }, 'TCP/UDP ポートを指定…'));
  const port = h('input', { type: 'text', class: 'mono', placeholder: '例 tcp/8080', id: ui.uid(), hidden: true });
  svc.addEventListener('change', () => { port.hidden = svc.value !== 'custom'; });
  const act = h('select', { id: ui.uid() }, h('option', { value: kind === 'wan' ? 'allow' : 'block' }, kind === 'wan' ? '許可' : 'ブロック'), h('option', { value: kind === 'wan' ? 'block' : 'allow' }, kind === 'wan' ? 'ブロック' : '許可'));
  const msg = h('span');
  m.append(h('div', { class: 'card', style: 'margin-top:12px' }, h('h3', {}, 'ルールを追加（一番下に追加されます）'), h('div', { class: 'form' },
    ui.field('ルール名', name), ui.field('送信元', h('div', { style: 'display:grid;gap:4px' }, src, srcC)), ui.field('宛先', h('div', { style: 'display:grid;gap:4px' }, dst, dstC)), ui.field('サービス', h('div', { style: 'display:grid;gap:4px' }, svc, port)), ui.field('アクション', act),
    h('div', { class: 'rowbtns' }, h('button', { class: 'hbtn primary', onclick: () => {
      const ent = (sel, c) => { if (sel.value !== 'cidr') return sel.value; const r = U.parseCidr(c.value); return r ? 'cidr:' + r.net + '/' + r.len : null; };
      const s = ent(src, srcC), d = ent(dst, dstC);
      if (!s || !d) { msg.className = 'err-msg'; msg.textContent = 'CIDR を正しく入力してください'; return; }
      let sv = svc.value;
      if (sv === 'custom') { if (!/^(tcp|udp)\/\d+$/.test(port.value.trim())) { msg.className = 'err-msg'; msg.textContent = 'tcp/番号 または udp/番号 の形で入力してください'; return; } sv = port.value.trim(); }
      pol.rules.push({ id: newId('f'), name: name.value.trim() || '新しいルール', enabled: true, src: s, dst: d, svc: sv, action: act.value });
      NL.touch('cfg'); NL.emit('cato'); ui.toast('ルールを追加しました');
    } }, '追加'), msg))));
}
NL.catoUI = { open };
})();
