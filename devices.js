/* NetLab UI pieces shared by every window: DOM helpers, window manager, terminal, PC shell, device windows. */
(function () {
'use strict';
const NL = window.NL, U = NL.util;
const ui = NL.ui = {};

// ---------- DOM helpers
const h = ui.h = (tag, attrs, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(3)) { if (c == null || c === false) continue; el.append(c.nodeType ? c : String(c)); }
  return el;
};
const esc = ui.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
ui.toast = (msg, err) => {
  const box = document.getElementById('toast');
  const d = h('div', { class: err ? 'err' : '', role: 'status' }, msg);
  box.append(d); setTimeout(() => d.remove(), err ? 4200 : 2600);
};
ui.field = (label, input) => h('div', { class: 'fr' }, h('label', {}, label), input);
let uid = 0;
ui.uid = p => (p || 'f') + (++uid);

// ---------- tabs
ui.tabs = (defs, initial, onChange) => {
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  const body = h('div', { class: 'wbody' });
  const wrap = h('div', { style: 'display:grid;grid-template-rows:auto 1fr;min-height:0' }, bar, body);
  let cur = initial || defs[0].id;
  const render = () => {
    bar.innerHTML = '';
    defs.forEach(d => bar.append(h('button', { role: 'tab', 'aria-selected': String(d.id === cur), onclick: () => { cur = d.id; render(); onChange && onChange(cur); } }, d.label)));
    const d = defs.find(x => x.id === cur);
    body.className = 'wbody' + (d.flush ? ' flush' : '');
    body.innerHTML = '';
    d.render(body);
  };
  render();
  return { el: wrap, active: () => cur, rerender: render, go: id => { cur = id; render(); } };
};

// ---------- window manager
const WM = ui.WM = {
  wins: new Map(), z: 200, n: 0,
  open(key, title, opts = {}) {
    let w = this.wins.get(key);
    if (w) { this.focus(w); return w; }
    const el = h('section', { class: 'win', role: 'dialog', 'aria-label': title });
    const h3 = h('h3', {}, title);
    const close = h('button', { class: 'xbtn', 'aria-label': '閉じる', title: '閉じる', onclick: () => this.close(key) }, '×');
    const head = h('header', {}, h3, close);
    const body = h('div', { style: 'min-height:0;display:grid;grid-template-rows:1fr;overflow:hidden' });
    el.append(head, body);
    el.style.gridTemplateRows = 'auto 1fr';
    const vw = window.innerWidth, vh = window.innerHeight;
    const W = Math.min(opts.w || 700, vw - 16), H = Math.min(opts.h || 520, vh - 16);
    const k = this.n++ % 8;
    el.style.width = W + 'px'; el.style.height = H + 'px';
    el.style.left = Math.max(8, Math.min(vw - W - 8, (opts.x != null ? opts.x : 90 + k * 34))) + 'px';
    el.style.top = Math.max(8, Math.min(vh - H - 8, (opts.y != null ? opts.y : 70 + k * 28))) + 'px';
    document.getElementById('wins').append(el);
    w = { key, el, body, head, h3, refresh: null, onClose: opts.onClose, setTitle: t => { h3.textContent = t; } };
    this.wins.set(key, w);
    el.addEventListener('pointerdown', () => this.focus(w));
    head.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      const r = el.getBoundingClientRect(), sx = e.clientX, sy = e.clientY;
      head.setPointerCapture(e.pointerId);
      const mv = ev => {
        el.style.left = Math.max(-r.width + 80, Math.min(window.innerWidth - 60, r.left + ev.clientX - sx)) + 'px';
        el.style.top = Math.max(0, Math.min(window.innerHeight - 40, r.top + ev.clientY - sy)) + 'px';
      };
      const up = () => { head.removeEventListener('pointermove', mv); head.removeEventListener('pointerup', up); };
      head.addEventListener('pointermove', mv); head.addEventListener('pointerup', up);
    });
    this.focus(w);
    return w;
  },
  focus(w) { w.el.style.zIndex = ++this.z; },
  close(key) { const w = this.wins.get(key); if (!w) return; w.el.remove(); this.wins.delete(key); w.onClose && w.onClose(); },
  closeAll() { [...this.wins.keys()].forEach(k => this.close(k)); },
  refreshAll(what) { for (const w of this.wins.values()) if (w.refresh) { try { w.refresh(what); } catch (e) { console.error(e); } } }
};

// ---------- session hosts and terminal
class Host {
  constructor(base) { this.stack = []; this.buf = ''; this.term = null; this.hist = []; this.base = base; this.attach(base); this.stack.push(base); }
  get cur() { return this.stack[this.stack.length - 1]; }
  attach(s) { s.w = t => this.print(t); s.onAsync = t => { this.print(t); if (this.term) this.term.refresh(); }; s.host = this; }
  print(t) {
    this.buf += t;
    if (this.buf.length > 240000) this.buf = this.buf.slice(-180000);
    if (this.term) this.term.append(t);
  }
  push(s, closeMsg) { this.attach(s); s.closeMsg = closeMsg; s.onClose = () => this.popped(s); this.stack.push(s); if (this.term) this.term.refresh(); }
  popped(s) { const i = this.stack.indexOf(s); if (i > 0) this.stack.splice(i); if (s.closeMsg) this.print(s.closeMsg + '\n'); if (this.term) this.term.refresh(); }
  reset(base) { this.stack.forEach(s => { if (s.remote) NL.ios.sessions.delete(s); }); this.base = base; this.stack = [base]; this.attach(base); }
  clear() { this.buf = ''; if (this.term) this.term.out.textContent = ''; }
}
ui.Host = Host;
const hosts = ui.hosts = new Map();
ui.consoleHost = dev => {
  const key = 'con:' + dev.id;
  let host = hosts.get(key);
  if (!host) {
    const s = new NL.ios.Session(dev);
    host = new Host(s); hosts.set(key, host);
    if (dev.power) s.boot(true);
  }
  return host;
};
ui.pcHost = dev => {
  const key = 'cmd:' + dev.id;
  let host = hosts.get(key);
  if (!host) {
    host = new Host(new PcShell(dev)); hosts.set(key, host);
    host.print('Cisco Packet Tracer 互換 PC コマンドライン 1.0\n「help」でコマンド一覧を表示します。\n\n');
  }
  return host;
};
NL.on('power', (dev, on) => {
  for (const host of hosts.values()) {
    host.stack.slice(1).forEach(s => { if (s.dev === dev) s.close('\n[Connection closed]'); });
  }
  const host = hosts.get('con:' + dev.id);
  if (host && NL.isCisco(dev)) {
    const s = new NL.ios.Session(dev);
    host.reset(s);
    if (on) { host.print('\n'); s.boot(true); } else host.print('\n%% 電源が OFF になりました\n');
    if (host.term) host.term.refresh();
  }
});
NL.on('change', () => { for (const host of hosts.values()) if (host.term) host.term.refreshPrompt(); });

class Term {
  constructor(host, opts = {}) {
    this.host = host;
    this.out = h('pre', { class: 'out' });
    this.pr = h('span', { class: 'pr' });
    this.inp = h('input', { class: 'in', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'コマンド入力' });
    this.cur = h('div', { class: 'cur' }, this.pr, this.inp);
    this.scr = h('div', { class: 'scr' }, this.out, this.cur);
    const bar = h('div', { class: 'bar' }, h('span', {}, opts.hint || 'Enter で実行・Tab で補完・? でヘルプ・↑↓ で履歴・Ctrl+Z で特権モードへ'),
      h('span', { style: 'flex:1' }),
      h('button', { onclick: () => this.copy() }, 'コピー'),
      h('button', { onclick: () => { host.clear(); this.inp.focus(); } }, 'クリア'));
    this.el = h('div', { class: 'term' }, this.scr, bar);
    this.el.style.gridTemplateRows = '1fr auto';
    this.out.textContent = host.buf;
    if (host.term && host.term !== this) host.term.detached = true;
    host.term = this;
    this.hi = host.hist.length;
    this.inp.addEventListener('keydown', e => this.key(e));
    // a pasted config block runs line by line, the way a real console takes it
    this.inp.addEventListener('paste', e => {
      const t = (e.clipboardData || window.clipboardData).getData('text');
      if (!/[\r\n]/.test(t)) return;
      e.preventDefault();
      const lines = (this.inp.value + t).split(/\r?\n/);
      this.inp.value = '';
      this.pasteLines(lines);
    });
    this.scr.addEventListener('mouseup', () => { if (!String(window.getSelection())) this.inp.focus(); });
    this.refresh();
    setTimeout(() => { this.inp.focus(); this.scroll(); }, 30);
  }
  copy() { const t = this.host.buf; (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => ui.toast('ログをコピーしました'), () => { const r = document.createRange(); r.selectNodeContents(this.out); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); ui.toast('選択しました。Ctrl+C でコピーできます'); }); }
  append(t) {
    if (this.detached) return;
    this.out.append(document.createTextNode(t));
    if (this.out.childNodes.length > 1500) this.out.textContent = this.host.buf;
    this.scroll();
  }
  scroll() { this.scr.scrollTop = this.scr.scrollHeight; }
  refreshPrompt() { if (!this.busy && !this.detached) { const s = this.host.cur; this.pr.textContent = s.prompt(); } }
  refresh() {
    if (this.detached) return;
    const s = this.host.cur;
    this.pr.textContent = s.prompt();
    this.inp.type = s.pending && s.pending.secret ? 'password' : 'text';
    const dead = s.isIOS && !s.dev.power;
    this.cur.style.display = dead ? 'none' : '';
    this.scroll();
  }
  async pasteLines(lines) {
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const l of lines) {
      while (this.busy) await sleep(50);
      this.inp.value = l;
      await this.submit();
    }
  }
  async submit() {
    if (this.busy) return;
    const s = this.host.cur, line = this.inp.value;
    const secret = s.pending && s.pending.secret;
    this.host.print(s.prompt() + (secret ? '' : line) + '\n');
    this.inp.value = '';
    if (!secret && !s.pending && line.trim()) { this.host.hist.push(line); if (this.host.hist.length > 100) this.host.hist.shift(); }
    this.hi = this.host.hist.length;
    this.busy = true; this.cur.style.visibility = 'hidden';
    try { const r = s.input(line); if (r && typeof r.then === 'function') await r; }
    catch (e) { console.error(e); this.host.print('% 内部エラー: ' + e.message + '\n'); }
    this.busy = false; this.cur.style.visibility = '';
    this.refresh(); this.inp.focus();
    NL.emit('cli', s.dev, line);
  }
  key(e) {
    const s = this.host.cur;
    if (e.key === 'Enter') { e.preventDefault(); this.submit(); return; }
    if (this.busy) { if (e.ctrlKey && (e.key === 'c' || e.key === '^')) e.preventDefault(); return; }
    if (e.key === 'Tab') { e.preventDefault(); if (s.complete) this.inp.value = s.complete(this.inp.value); return; }
    if (e.key === '?' && s.isIOS && !s.pending) {
      e.preventDefault();
      const line = this.inp.value; const r = s.help(line);
      this.host.print(s.prompt() + line + '?\n' + (r ? r + '\n' : '') + '\n');
      this.refresh(); return;
    }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (this.hi > 0) { this.hi--; this.inp.value = this.host.hist[this.hi] || ''; } return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (this.hi < this.host.hist.length) { this.hi++; this.inp.value = this.host.hist[this.hi] || ''; } return; }
    if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (s.ctrlZ) s.ctrlZ(); this.inp.value = ''; this.refresh(); return; }
    if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && !String(window.getSelection())) { e.preventDefault(); if (s.ctrlC) s.ctrlC(); this.inp.value = ''; this.refresh(); }
  }
}
ui.Term = Term;

// ---------- PC command prompt (Windows style, as on Packet Tracer PCs)
class PcShell {
  constructor(dev) { this.dev = dev; this.isIOS = false; this.pending = null; }
  prompt() { return this.pending ? this.pending.prompt : 'C:\\>'; }
  input(line) {
    if (this.pending) { const p = this.pending; this.pending = null; return p.cb(line); }
    return this.exec(line.trim());
  }
  out(t) { this.w(t + '\n'); }
  complete(l) { return l; }
  help() { return null; }
  ctrlC() { this.w('^C\n'); }
  async exec(line) {
    if (!line) return;
    if (!this.dev.power) { this.out('電源が OFF です'); return; }
    const t = line.split(/\s+/), c = t[0].toLowerCase();
    const d = this.dev;
    switch (c) {
      case 'help': case '?':
        this.out('Available Commands\n?          Display the list of available commands\narp        Display the arp table\ncls        Clear screen\nexit       Quits the CLI\nhelp       Display the list of available commands\nhostname   Display the host name\nipconfig   Display network interface configuration\nnetstat    Displays protocol statistics and current TCP/IP network connections\nnslookup   DNS Lookup\nping       Send echo messages\nroute      Display the routing table\nssh        Ssh client\ntelnet     Telnet client\ntracert    Trace route to destination');
        return;
      case 'cls': this.host.clear(); return;
      case 'hostname': this.out(d.name); return;
      case 'exit': this.out(''); return;
      case 'netstat': this.out('\nActive Connections\n\n  Proto  Local Address          Foreign Address        State\n'); return;
      case 'nslookup': this.out(`Server: [${(NL.hostAddr(d).dns) || '255.255.255.255'}]\nAddress: ${(NL.hostAddr(d).dns) || '255.255.255.255'}\n\nDNS request timed out.\n    timeout was 15000 milli seconds.\n*** UnKnown can't find ${t[1] || ''}: No response from server\n（このシミュレーターでは DNS は未対応です。IP アドレスを使ってください）`); return;
      case 'ipconfig': return this.ipconfig(t[1]);
      case 'arp': {
        if (t[1] === '-d') { NL.rt(d).arp = {}; return; }
        if (t[1] !== '-a') { this.out('ARP: invalid option. Use "arp -a" or "arp -d"'); return; }
        const a = NL.hostAddr(d); const rows = Object.entries(NL.rt(d).arp);
        if (!rows.length) { this.out('No ARP Entries Found'); return; }
        this.out(`\n  Internet Address      Physical Address      Type\n` + rows.map(([ip, e]) => '  ' + ip.padEnd(22) + e.mac.padEnd(22) + 'dynamic').join('\n') + '\n');
        void a; return;
      }
      case 'route': {
        const a = NL.hostAddr(d);
        this.out(`===========================================================================\nIPv4 Route Table\n===========================================================================\nActive Routes:\nNetwork Destination        Netmask          Gateway       Interface\n${a.gw ? '          0.0.0.0          0.0.0.0'.padEnd(34) + a.gw.padEnd(16) + a.ip : ''}\n${a.ip ? ('          ' + U.netOf(a.ip, a.mask)).padEnd(27) + a.mask.padEnd(17) + 'On-link'.padEnd(14) + a.ip : ''}\n===========================================================================`);
        return;
      }
      case 'ping': return this.ping(t.slice(1));
      case 'tracert': return this.tracert(t[1]);
      case 'telnet': {
        if (!U.isIP(t[1] || '')) { this.out('Usage: telnet <IP>（このシミュレーターでは IP アドレスで指定します）'); return; }
        NL.ios.openRemote({ dev: d, out: x => { if (x) this.out(x); }, host: this.host }, 'telnet', t[1]);
        return;
      }
      case 'ssh': {
        const li = t.indexOf('-l');
        if (li < 0 || !t[li + 1] || !U.isIP(t[t.length - 1])) { this.out('Usage: SSH -l username target'); return; }
        NL.ios.openRemote({ dev: d, out: x => { if (x) this.out(x); }, host: this.host }, 'ssh', t[t.length - 1], t[li + 1]);
        return;
      }
      default: this.out('Invalid Command.');
    }
  }
  ipconfig(opt) {
    const d = this.dev, a = NL.hostAddr(d), mac = d.macs.FastEthernet0;
    if (opt === '/release') { if (!d.cfg.dhcp) { this.out('IP 設定が静的なため解放できません（DHCP に切り替えてください）'); return; } NL.rt(d).lease = null; NL.touch('lease'); this.out('\n   IP Address......................: 0.0.0.0\n   Subnet Mask.....................: 0.0.0.0\n   Default Gateway.................: 0.0.0.0\n   DNS Server......................: 0.0.0.0\n'); return; }
    if (opt === '/renew') {
      if (!d.cfg.dhcp) { this.out('IP 設定が静的です。設定タブで DHCP に切り替えてください'); return; }
      const ok = NL.dhcpRequest(d, 'FastEthernet0'); const b = NL.hostAddr(d);
      this.out(ok ? `\n   IP Address......................: ${b.ip}\n   Subnet Mask.....................: ${b.mask}\n   Default Gateway.................: ${b.gw || '0.0.0.0'}\n   DNS Server......................: ${b.dns || '0.0.0.0'}\n` : 'DHCP request failed. (APIPA を使用します: ' + b.ip + ')');
      return;
    }
    const all = opt === '/all';
    let s = `\nFastEthernet0 Connection:(default port)\n\n${all ? `   Physical Address................: ${mac.toUpperCase()}\n   DHCP Enabled....................: ${d.cfg.dhcp ? 'Yes' : 'No'}\n` : ''}   Connection-specific DNS Suffix..: \n   Link-local IPv6 Address.........: FE80::${mac.replace(/\./g, '').slice(-6).toUpperCase().replace(/(..)(..)(..)/, '$1:$2$3')}\n   IPv6 Address....................: ::\n   IPv4 Address....................: ${a.ip || '0.0.0.0'}\n   Subnet Mask.....................: ${a.mask || '0.0.0.0'}\n   Default Gateway.................: ::\n                                     ${a.gw || '0.0.0.0'}\n${all ? `   DNS Servers.....................: ${a.dns || '0.0.0.0'}\n` : ''}`;
    const c = NL.rt(d).cato;
    if (c && c.state === 'connected') s += `\nCato Networks Client Connection:\n\n   IPv4 Address....................: ${c.clientIp}\n   Subnet Mask.....................: 255.255.255.255\n   Default Gateway.................: （トンネル経由）\n`;
    this.out(s);
  }
  async ping(args) {
    let n = 4, target = null;
    for (let i = 0; i < args.length; i++) { if (args[i] === '-n') n = Math.max(1, Math.min(100, +args[++i] || 4)); else if (args[i] === '-t') n = 20; else target = args[i]; }
    if (!target) { this.out('Usage: ping [-n count] [-t] target'); return; }
    if (!U.isIP(target)) { this.out(`Ping request could not find host ${target}. Please check the name and try again.（IP アドレスで指定してください）`); return; }
    this.out(`\nPinging ${target} with 32 bytes of data:\n`);
    let recv = 0, lost = 0;
    for (let i = 0; i < n; i++) {
      const r = NL.ping(this.dev, target, { count: 1 })[0];
      await sleep(r.r === 'timeout' ? 700 : 320);
      if (r.r === 'ok') { recv++; this.out(`Reply from ${target}: bytes=32 time<1ms TTL=${r.ttl}`); }
      else if (r.r === 'unreach') { recv++; this.out(`Reply from ${r.from}: Destination host unreachable.`); }
      else if (r.r === 'ttl') { recv++; this.out(`Reply from ${r.from}: TTL expired in transit.`); }
      else if (r.r === 'noroute') { lost++; this.out('PING: transmit failed. General failure. '); }
      else { lost++; this.out('Request timed out.'); }
    }
    this.out(`\nPing statistics for ${target}:\n    Packets: Sent = ${n}, Received = ${recv}, Lost = ${n - recv} (${Math.round((n - recv) * 100 / n)}% loss),${recv ? '\nApproximate round trip times in milli-seconds:\n    Minimum = 0ms, Maximum = 1ms, Average = 0ms' : ''}\n`);
    void lost;
  }
  async tracert(target) {
    if (!U.isIP(target || '')) { this.out('Usage: tracert target_name（IP アドレスで指定してください）'); return; }
    this.out(`\nTracing route to ${target} over a maximum of 30 hops: \n`);
    const hops = NL.trace(this.dev, target);
    for (const hp of hops) {
      await sleep(hp.from ? 200 : 700);
      const cols = hp.tries.map(t => (t ? '0 ms' : '*').padEnd(10)).join('');
      this.out(String(hp.ttl).padStart(3) + '   ' + cols + (hp.from || 'Request timed out.'));
    }
    this.out('\nTrace complete.');
  }
}
ui.PcShell = PcShell;

// ---------- icons
const ICON = {
  router: '<circle class="shape" cx="0" cy="0" r="19"/><path class="glyph" d="M-11 -3 h8 M-5 -7 l4 4 -4 4 M11 3 h-8 M5 7 l-4 -4 4 -4 M-3 -11 v8 M-7 -5 l4 -4 4 4 M3 11 v-8 M7 5 l-4 4 -4 -4" transform="rotate(45)"/>',
  switch: '<rect class="shape" x="-26" y="-14" width="52" height="28" rx="4"/><path class="glyph" d="M-16 -5 h22 M2 -9 l4 4 -4 4 M16 5 h-22 M-2 1 l-4 4 4 4"/>',
  l3switch: '<rect class="shape" x="-26" y="-14" width="52" height="28" rx="4"/><path class="glyph" d="M-18 -5 h18 M-4 -9 l4 4 -4 4 M18 5 h-18 M4 1 l-4 4 4 4"/><circle class="glyph" cx="17" cy="-7" r="4"/>',
  pc: '<rect class="shape" x="-20" y="-17" width="40" height="27" rx="2"/><path class="glyph" d="M-6 14 h12 M0 10 v4"/><rect class="glyph-fill host" x="-15" y="-12" width="30" height="17" rx="1" opacity=".18"/>',
  laptop: '<rect class="shape" x="-17" y="-15" width="34" height="22" rx="2"/><path class="shape" d="M-23 10 h46 l-4 6 h-38 z"/>',
  server: '<rect class="shape" x="-14" y="-20" width="28" height="40" rx="3"/><path class="glyph" d="M-8 -11 h16 M-8 -4 h16 M-8 3 h16"/><circle class="glyph-fill host" cx="0" cy="12" r="2"/>',
  socket: '<rect class="shape" x="-27" y="-14" width="54" height="28" rx="5"/><circle class="glyph-fill cato" cx="-17" cy="8" r="1.8"/><circle class="glyph-fill cato" cx="-11" cy="8" r="1.8"/><circle class="glyph-fill cato" cx="-5" cy="8" r="1.8"/><circle class="glyph-fill cato" cx="1" cy="8" r="1.8"/><text class="ctag" x="9" y="-2">CATO</text>',
  pop: '<path class="shape" d="M-22 10 a10 10 0 0 1 2 -19 a13 13 0 0 1 24 -4 a10 10 0 0 1 17 9 a8 8 0 0 1 -3 14 z"/><text class="ctag" x="0" y="5">CATO</text>'
};
ui.iconFor = dev => ICON[dev.model === 'laptop' ? 'laptop' : NL.kind(dev)] || ICON.pc;
ui.iconByModel = model => ICON[model === 'laptop' ? 'laptop' : NL.MODELS[model].kind];
ui.devClass = dev => NL.isCisco(dev) ? 'cisco' : (NL.kind(dev) === 'socket' || NL.kind(dev) === 'pop') ? 'cato' : 'host';
ui.modelClass = model => { const k = NL.MODELS[model].kind; return ['router', 'switch', 'l3switch'].includes(k) ? 'cisco' : (k === 'socket' || k === 'pop') ? 'cato' : 'host'; };

// ---------- inspect text
ui.inspectText = dev => {
  const rt = NL.rt(dev), out = [];
  const ifs = NL.l3ifs(dev).filter(i => i.ip);
  out.push('■ IP アドレス');
  ifs.forEach(i => out.push(`  ${i.name.padEnd(22)} ${(i.ip + '/' + U.maskLen(i.mask)).padEnd(20)} ${i.up ? 'up' : 'down'}${i.vip ? ' (VIP)' : ''}`));
  if (!ifs.length) out.push('  （なし）');
  out.push('', '■ ARP テーブル');
  const arp = Object.entries(rt.arp);
  arp.forEach(([ip, e]) => out.push(`  ${ip.padEnd(17)} ${e.mac}  ${e.ifn}`));
  if (!arp.length) out.push('  （空）');
  if (NL.isSwitch(dev)) {
    out.push('', '■ MAC アドレステーブル');
    const m = Object.entries(rt.mac).filter(([, p]) => p);
    m.forEach(([k, p]) => { const [v, mac] = k.split('|'); out.push(`  VLAN ${v.padEnd(5)} ${mac}  ${U.shortIf(p)}`); });
    if (!m.length) out.push('  （空）');
  }
  if (NL.canRoute(dev)) {
    out.push('', '■ ルーティングテーブル');
    NL.routes(dev).filter(r => r.code !== 'L').forEach(r => out.push(`  ${r.code.padEnd(5)} ${(r.net + '/' + r.len).padEnd(19)} ${r.nh ? 'via ' + r.nh : (r.ifn || '')}`));
  }
  if (rt.nat && rt.nat.length) {
    out.push('', '■ NAT 変換');
    rt.nat.forEach(e => out.push(`  ${e.proto.padEnd(5)} ${e.il}:${e.ilp} → ${e.ig}:${e.igp}`));
  }
  if (NL.kind(dev) === 'socket') {
    out.push('', '■ Cato トンネル');
    ['WAN1', 'WAN2'].forEach(w => out.push(`  ${w}: ${NL.cato.tunUp(dev, w) ? '確立' : '未確立'}`));
  }
  return out.join('\n');
};

// ---------- device windows
ui.openDevice = dev => {
  const k = NL.kind(dev);
  const w = WM.open('dev:' + dev.id, dev.name, { w: k === 'pop' ? 560 : 760, h: 560 });
  w.setTitle(dev.name + '  —  ' + NL.MODELS[dev.model].label);
  if (w.built) return w;
  w.built = true;
  let defs;
  if (NL.isCisco(dev)) defs = [{ id: 'phys', label: '物理', render: b => physTab(b, dev) }, { id: 'cfg', label: '設定', render: b => ciscoCfgTab(b, dev) }, { id: 'cli', label: 'CLI', flush: true, render: b => cliTab(b, dev) }];
  else if (k === 'pc' || k === 'server') {
    defs = [{ id: 'phys', label: '物理', render: b => physTab(b, dev) }, { id: 'cfg', label: '設定', render: b => pcCfgTab(b, dev) }, { id: 'desk', label: 'デスクトップ', flush: true, render: b => deskTab(b, dev) }];
    if (k === 'server') defs.push({ id: 'svc', label: 'サービス', render: b => svcTab(b, dev) });
  } else if (k === 'socket') defs = [{ id: 'phys', label: '物理', render: b => physTab(b, dev) }, { id: 'web', label: 'ローカル WebUI', flush: true, render: b => socketWeb(b, dev) }, { id: 'stat', label: '状態', render: b => socketStatus(b, dev) }];
  else defs = [{ id: 'cfg', label: '設定', render: b => popCfg(b, dev) }, { id: 'stat', label: '状態', render: b => popStatus(b, dev) }];
  const t = ui.tabs(defs, NL.isCisco(dev) ? 'cli' : k === 'socket' ? 'web' : (k === 'pc' || k === 'server') ? 'desk' : 'cfg');
  w.body.append(t.el);
  w.tabs = t;
  w.refresh = () => {
    if (!NL.lab.devices.includes(dev)) { WM.close(w.key); return; }
    w.setTitle(dev.name + '  —  ' + NL.MODELS[dev.model].label);
    const a = t.active();
    if ((a === 'phys' || a === 'stat') && !w.el.contains(document.activeElement)) t.rerender();
  };
  return w;
};
function physTab(b, dev) {
  const pb = h('button', { class: 'powerbtn' + (dev.power ? ' on' : ''), onclick: () => { NL.setPower(dev, !dev.power); ui.toast(dev.name + ' の電源を' + (dev.power ? '入れました' : '切りました')); } }, h('i'), dev.power ? '電源 ON（クリックで OFF）' : '電源 OFF（クリックで ON）');
  b.append(h('div', { class: 'rowbtns', style: 'margin-bottom:10px' }, pb,
    dev.serial ? h('span', { class: 'pill cato' }, 'シリアル ' + dev.serial) : null,
    h('span', { class: 'pill' }, NL.MODELS[dev.model].label)));
  if (NL.isCisco(dev)) b.append(h('p', { class: 'lead', style: 'color:var(--muted);font-size:12px;margin:0 0 10px' }, '電源を切ると running-config は消え、次の起動時は startup-config が読み込まれます。設定を残すには CLI で copy running-config startup-config（または write memory）を実行します。'));
  const rows = NL.allPorts(dev).map(p => {
    const pe = NL.peer(dev.id, p);
    const isC = p === 'Console' || p === 'RS232';
    const up = !isC && NL.portLinkUp(dev, p);
    let blk = false;
    if (up && NL.isSwPort(dev, p)) blk = Object.keys(dev.vlans).some(v => NL.stpBlocked(dev, p, +v));
    const ip = NL.l3ifs(dev).filter(i => i.port === p).map(i => i.ip + '/' + U.maskLen(i.mask) + (i.vip ? ' (VIP)' : '')).join(', ');
    const mac = dev.macs[p] || '';
    return h('tr', {},
      h('td', {}, h('span', { class: 'dot ' + (isC ? (pe ? 'up' : '') : up ? (blk ? 'warn' : 'up') : pe ? 'down' : '') }), p),
      h('td', {}, isC ? (pe ? 'コンソール接続' : '—') : up ? (blk ? 'STP ブロッキング' : 'リンク UP') : pe ? (NL.cableOk(pe.link) ? 'ダウン' : 'ダウン（ケーブル種別違い）') : '未接続'),
      h('td', {}, pe ? `${pe.dev.name} / ${pe.port}` : ''),
      h('td', { class: 'mono' }, ip),
      h('td', { class: 'mono', style: 'color:var(--muted)' }, mac));
  });
  b.append(h('div', { class: 'tblwrap' }, h('table', { class: 'ports' }, h('thead', {}, h('tr', {}, h('th', {}, 'ポート'), h('th', {}, '状態'), h('th', {}, '接続先'), h('th', {}, 'IP'), h('th', {}, 'MAC'))), h('tbody', {}, rows))));
}
function cliTab(b, dev) {
  const host = ui.consoleHost(dev);
  const t = new Term(host);
  b.append(t.el);
}
function ciscoCfgTab(b, dev) {
  const log = h('div', { class: 'cfglog', 'aria-live': 'polite' }, '同等の IOS コマンドがここに表示されます。');
  const run = (lines, msg) => {
    const out = NL.ios.batch(dev, ['configure terminal', ...lines, 'end']);
    log.textContent = out; log.scrollTop = log.scrollHeight;
    NL.touch('cfg'); if (msg) ui.toast(msg);
  };
  const c = dev.cfg;
  const disp = h('input', { type: 'text', value: dev.name, id: ui.uid() });
  const hn = h('input', { type: 'text', value: c.hostname, class: 'mono', id: ui.uid() });
  b.append(h('h4', { style: 'margin:0 0 6px' }, '全体'), h('div', { class: 'form' },
    ui.field('表示名（図の名前）', disp), ui.field('ホスト名', hn),
    h('div', { class: 'rowbtns' }, h('button', { class: 'hbtn primary', onclick: () => { dev.name = disp.value.trim() || dev.name; if (hn.value.trim() && hn.value.trim() !== c.hostname) run(['hostname ' + hn.value.trim()]); else NL.touch('cfg'); ui.toast('適用しました'); } }, '適用'),
      h('button', { class: 'hbtn', onclick: () => { log.textContent = NL.ios.batch(dev, ['write memory']); ui.toast('startup-config に保存しました'); } }, '設定を保存（write memory）'))));
  const names = NL.ios.ifOrder(dev);
  const sel = h('select', { id: ui.uid() }, names.map(n => h('option', { value: n }, n)));
  const ipI = h('input', { type: 'text', class: 'mono', placeholder: '例 192.168.1.1', id: ui.uid() });
  const mkI = h('input', { type: 'text', class: 'mono', placeholder: '例 255.255.255.0', id: ui.uid() });
  const onI = h('input', { type: 'checkbox', id: ui.uid() });
  const modeS = h('select', { id: ui.uid() }, ['access', 'trunk', 'dynamic auto', 'dynamic desirable'].map(m => h('option', { value: m }, m)));
  const vlanI = h('input', { type: 'text', class: 'mono', placeholder: '1', id: ui.uid() });
  const swRows = h('div', { style: 'display:grid;gap:8px' }, ui.field('スイッチポートモード', modeS), ui.field('アクセス VLAN', vlanI));
  const ipRows = h('div', { style: 'display:grid;gap:8px' }, ui.field('IP アドレス', ipI), ui.field('サブネットマスク', mkI));
  const load = () => {
    const n = sel.value, i = c.interfaces[n] || {};
    ipI.value = i.ip || ''; mkI.value = i.mask || ''; onI.checked = !i.shutdown;
    const sw = NL.isSwPort(dev, n);
    swRows.hidden = !sw; ipRows.hidden = sw;
    modeS.value = i.mode || 'dynamic auto'; vlanI.value = i.accessVlan || 1;
  };
  sel.addEventListener('change', load); load();
  b.append(h('h4', { style: 'margin:14px 0 6px' }, 'インターフェース'), h('div', { class: 'form' },
    ui.field('インターフェース', sel),
    ui.field('ポート状態', h('label', { style: 'display:flex;gap:6px;align-items:center;color:var(--ink)' }, onI, 'オン（no shutdown）')),
    ipRows, swRows,
    h('div', { class: 'rowbtns' }, h('button', { class: 'hbtn primary', onclick: () => {
      const n = sel.value, L = ['interface ' + n];
      if (NL.isSwPort(dev, n)) { L.push('switchport mode ' + modeS.value); if (modeS.value === 'access') L.push('switchport access vlan ' + (parseInt(vlanI.value, 10) || 1)); }
      else if (ipI.value.trim()) L.push(`ip address ${ipI.value.trim()} ${mkI.value.trim()}`);
      else L.push('no ip address');
      L.push(onI.checked ? 'no shutdown' : 'shutdown');
      run(L);
    } }, 'インターフェースに適用'))));
  if (NL.kind(dev) !== 'switch') {
    const rn = h('input', { type: 'text', class: 'mono', placeholder: '宛先 例 10.0.0.0', id: ui.uid() }), rm = h('input', { type: 'text', class: 'mono', placeholder: 'マスク 例 255.255.255.0', id: ui.uid() }), rh = h('input', { type: 'text', class: 'mono', placeholder: 'ネクストホップ', id: ui.uid() });
    const list = h('div', { style: 'display:grid;gap:4px' }, c.routes.map(r => h('div', { class: 'rowbtns mono' }, `ip route ${r.net} ${r.mask} ${[r.iface, r.nh].filter(Boolean).join(' ')}${r.ad !== 1 ? ' ' + r.ad : ''}`,
      h('button', { class: 'linkbtn', onclick: () => run([`no ip route ${r.net} ${r.mask} ${[r.iface, r.nh].filter(Boolean).join(' ')}`], '削除しました') }, '削除'))));
    b.append(h('h4', { style: 'margin:14px 0 6px' }, 'スタティックルート'), h('div', { class: 'form' }, ui.field('宛先ネットワーク', rn), ui.field('マスク', rm), ui.field('ネクストホップ', rh),
      h('div', { class: 'rowbtns' }, h('button', { class: 'hbtn', onclick: () => run([`ip route ${rn.value.trim()} ${rm.value.trim()} ${rh.value.trim()}`]) }, 'ルートを追加')), list));
  } else {
    const gw = h('input', { type: 'text', class: 'mono', value: c.defaultGateway, id: ui.uid() });
    b.append(h('h4', { style: 'margin:14px 0 6px' }, '管理用'), h('div', { class: 'form' }, ui.field('デフォルトゲートウェイ', gw), h('div', { class: 'rowbtns' }, h('button', { class: 'hbtn', onclick: () => run([gw.value.trim() ? 'ip default-gateway ' + gw.value.trim() : 'no ip default-gateway']) }, '適用'))));
  }
  if (NL.isSwitch(dev)) {
    const vi = h('input', { type: 'text', class: 'mono', placeholder: '例 10', id: ui.uid() }), vn = h('input', { type: 'text', placeholder: '例 SALES', id: ui.uid() });
    b.append(h('h4', { style: 'margin:14px 0 6px' }, 'VLAN データベース'), h('div', { class: 'form' },
      h('div', { class: 'mono', style: 'font-size:12px' }, Object.entries(dev.vlans).map(([v, x]) => `${v} ${x.name}`).join('  /  ')),
      ui.field('VLAN 番号', vi), ui.field('名前', vn),
      h('div', { class: 'rowbtns' }, h('button', { class: 'hbtn', onclick: () => run(['vlan ' + vi.value.trim(), ...(vn.value.trim() ? ['name ' + vn.value.trim()] : [])]) }, 'VLAN を追加'))));
  }
  b.append(h('h4', { style: 'margin:14px 0 6px' }, '同等の IOS コマンド'), log);
}
function pcCfgTab(b, dev) {
  const c = dev.cfg;
  const disp = h('input', { type: 'text', value: dev.name, id: ui.uid() });
  const mode = h('select', { id: ui.uid() }, h('option', { value: 'static' }, '静的 (Static)'), h('option', { value: 'dhcp' }, 'DHCP'));
  mode.value = c.dhcp ? 'dhcp' : 'static';
  const ip = h('input', { type: 'text', class: 'mono', value: c.ip, id: ui.uid() }), mk = h('input', { type: 'text', class: 'mono', value: c.mask, id: ui.uid(), placeholder: '255.255.255.0' }),
    gw = h('input', { type: 'text', class: 'mono', value: c.gw, id: ui.uid() }), dns = h('input', { type: 'text', class: 'mono', value: c.dns, id: ui.uid() });
  const msg = h('div', { 'aria-live': 'polite' });
  const sync = () => { const st = mode.value === 'static'; [ip, mk, gw, dns].forEach(i => { i.disabled = !st; }); if (!st) { const a = NL.hostAddr(dev); ip.value = a.ip || ''; mk.value = a.mask || ''; gw.value = a.gw || ''; dns.value = a.dns || ''; } };
  mode.addEventListener('change', sync); sync();
  ip.addEventListener('blur', () => { if (U.isIP(ip.value) && !mk.value) { const a = +ip.value.split('.')[0]; mk.value = a < 128 ? '255.0.0.0' : a < 192 ? '255.255.0.0' : '255.255.255.0'; } });
  const apply = () => {
    msg.textContent = ''; msg.className = '';
    dev.name = disp.value.trim() || dev.name;
    if (mode.value === 'dhcp') {
      c.dhcp = true; NL.touch('cfg');
      const ok = NL.dhcpRequest(dev, 'FastEthernet0'); sync();
      msg.className = ok ? 'ok-msg' : 'err-msg'; msg.textContent = ok ? 'DHCP request successful.' : 'DHCP failed. APIPA is being used.';
      return;
    }
    const bad = [[ip, 'IP アドレス'], [mk, 'サブネットマスク']].find(([i]) => i.value && !U.isIP(i.value.trim()));
    if (bad) { msg.className = 'err-msg'; msg.textContent = bad[1] + 'の形式が正しくありません'; return; }
    if (mk.value && !U.validMask(mk.value.trim())) { msg.className = 'err-msg'; msg.textContent = 'サブネットマスクが不正です'; return; }
    if (gw.value && !U.isIP(gw.value.trim())) { msg.className = 'err-msg'; msg.textContent = 'デフォルトゲートウェイの形式が正しくありません'; return; }
    Object.assign(c, { dhcp: false, ip: ip.value.trim(), mask: mk.value.trim(), gw: gw.value.trim(), dns: dns.value.trim() });
    NL.rt(dev).lease = null; NL.rt(dev).arp = {};
    NL.touch('cfg');
    msg.className = 'ok-msg'; msg.textContent = '保存しました';
  };
  b.append(h('div', { class: 'form' }, ui.field('表示名', disp), ui.field('IP 設定', mode), ui.field('IPv4 アドレス', ip), ui.field('サブネットマスク', mk), ui.field('デフォルトゲートウェイ', gw), ui.field('DNS サーバー', dns),
    h('div', { class: 'rowbtns' }, h('button', { class: 'hbtn primary', onclick: apply }, '保存'), msg)));
}
const APPICON = {
  ip: '<svg viewBox="0 0 34 34" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="6" width="26" height="18" rx="2"/><path d="M10 13h4M10 17h9M20 13h4"/><path d="M13 28h8"/></svg>',
  cmd: '<svg viewBox="0 0 34 34" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="28" height="24" rx="2"/><path d="M8 12l4 4-4 4M15 21h8"/></svg>',
  term: '<svg viewBox="0 0 34 34" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="28" height="20" rx="2"/><path d="M9 29h16M17 25v4M8 11l3 3-3 3"/></svg>',
  web: '<svg viewBox="0 0 34 34" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="17" cy="17" r="12"/><path d="M5 17h24M17 5c4 4 4 20 0 24M17 5c-4 4-4 20 0 24"/></svg>',
  cato: '<svg viewBox="0 0 34 34" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M17 4l11 5v8c0 7-5 11-11 13C11 28 6 24 6 17V9z"/><path d="M12 17l4 4 7-8"/></svg>'
};
function deskTab(b, dev) {
  const area = h('div', { style: 'min-height:0;height:100%;display:grid' });
  b.append(area);
  const home = () => {
    area.innerHTML = '';
    const apps = [['ip', 'IP 設定', () => app('IP 設定', x => pcCfgTab(x, dev))], ['cmd', 'コマンドプロンプト', () => app('コマンドプロンプト', x => { x.append(new Term(ui.pcHost(dev), { hint: 'Enter で実行・↑↓ で履歴・help でコマンド一覧' }).el); }, true)],
      ['term', 'ターミナル', () => app('ターミナル（コンソール）', x => terminalApp(x, dev), true)], ['web', 'Web ブラウザ', () => app('Web ブラウザ', x => browserApp(x, dev), true)],
      ['cato', 'Cato Client', () => app('Cato Client', x => catoClientApp(x, dev))]];
    area.append(h('div', { class: 'wbody' }, h('div', { class: 'desk' }, apps.map(([ic, label, fn]) => h('button', { class: 'app', onclick: fn, html: APPICON[ic] + '<span>' + esc(label) + '</span>' })))));
  };
  const app = (title, render, flush) => {
    area.innerHTML = '';
    const body = h('div', { class: flush ? '' : 'wbody', style: 'min-height:0;display:grid;overflow:auto' });
    area.append(h('div', { class: 'appwin' }, h('div', { class: 'appbar' }, h('button', { class: 'hbtn', onclick: home }, '← デスクトップ'), h('b', {}, title)), body));
    render(body);
  };
  home();
}
function terminalApp(x, dev) {
  const pe = NL.peer(dev.id, 'RS232');
  if (!pe) {
    x.append(h('div', { class: 'wbody' }, h('p', {}, 'RS232 ポートにコンソールケーブルがつながっていません。'), h('p', { style: 'color:var(--muted)' }, '下のケーブル欄で「コンソール」を選び、この PC の RS232 と Cisco 機器の Console をつないでください。')));
    return;
  }
  const box = h('div', { style: 'display:grid;min-height:0' });
  x.append(h('div', { class: 'wbody', style: 'padding:8px 12px' }, h('div', { class: 'kv' }, h('dt', {}, '接続先'), h('dd', {}, pe.dev.name + ' / Console'), h('dt', {}, '設定'), h('dd', {}, '9600 bps, 8 data bits, parity none, 1 stop bit, flow control none'))), box);
  x.style.gridTemplateRows = 'auto 1fr';
  box.append(new Term(ui.consoleHost(pe.dev)).el);
}
function browserApp(x, dev) {
  const url = h('input', { type: 'text', class: 'inp', value: 'http://', 'aria-label': 'URL', id: ui.uid() });
  const page = h('div', { class: 'page' }, h('div', { class: 'msg' }, 'URL に http://<IP アドレス> を入力して「移動」を押します。'));
  const go = () => {
    const m = /^(?:https?:\/\/)?([^\/:\s]+)/i.exec(url.value.trim());
    page.innerHTML = '';
    if (!m) { page.append(h('div', { class: 'msg' }, 'URL を入力してください')); return; }
    const ip = m[1];
    if (!U.isIP(ip)) { page.append(h('div', { class: 'msg' }, 'このシミュレーターには DNS がないため、IP アドレスで指定してください。')); return; }
    const r = NL.tcp(dev, ip, 80);
    if (r.r === 'ok') page.append(h('iframe', { sandbox: '', title: 'Web ページ', srcdoc: String(r.data || '') }));
    else page.append(h('div', { class: 'msg' }, r.r === 'rst' ? 'Server Reset Connection（HTTP サービスが動いていません）' : r.r === 'noroute' ? 'Host Unreachable（経路がありません）' : 'Request Timeout'));
  };
  url.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  x.append(h('div', { class: 'browser' }, h('div', { class: 'urlbar' }, url, h('button', { class: 'hbtn', onclick: go }, '移動')), page));
}
function catoClientApp(x, dev) {
  const rt = NL.rt(dev);
  const email = h('input', { type: 'text', class: 'mono', value: (rt.cato && rt.cato.email) || dev.cfg.catoEmail || '', placeholder: 'user@example.com', id: ui.uid() });
  const st = rt.cato;
  const state = !st ? ['未接続', ''] : st.state === 'connected' ? ['接続済み', 'ok'] : st.state === 'connecting' ? ['接続中…', 'warn'] : ['エラー', 'bad'];
  const pop = NL.cato.popDev();
  const render = () => { x.innerHTML = ''; catoClientApp(x, dev); };
  x.append(h('div', { class: 'form' },
    h('div', { class: 'rowbtns' }, h('span', { class: 'pill ' + state[1] }, state[0]), st && st.err ? h('span', { class: 'err-msg' }, st.err) : null),
    ui.field('ユーザー（メール）', email),
    h('dl', { class: 'kv' }, h('dt', {}, 'Client IP'), h('dd', {}, (st && st.clientIp) || '—'), h('dt', {}, '接続先 PoP'), h('dd', {}, pop ? `${NL.lab.cato.popName}（${pop.cfg.ip}）` : 'ラボ内に Cato Cloud がありません'), h('dt', {}, '物理 NIC'), h('dd', {}, NL.hostAddr(dev).ip || '未設定')),
    h('div', { class: 'rowbtns' },
      h('button', { class: 'hbtn primary', onclick: () => { dev.cfg.catoEmail = email.value.trim(); const r = NL.cato.clientConnect(dev, email.value); ui.toast(r.state === 'connected' ? '接続しました（' + r.clientIp + '）' : '接続できません: ' + r.err, r.state !== 'connected'); render(); } }, '接続'),
      h('button', { class: 'hbtn', onclick: () => { dev.cfg.catoEmail = ''; NL.cato.clientDisconnect(dev); render(); } }, '切断')),
    h('p', { style: 'color:var(--muted);font-size:12px;margin:4px 0 0' }, 'Cato Client（SDP クライアント）は PC の物理 NIC から Cato Cloud へトンネルを張り、管理コンソールの「IP 割り当て」で決めた範囲から Client IP を受け取ります。接続できるのは管理コンソールの「ユーザー」に登録したメールアドレスだけです。接続中は他拠点やインターネット宛ての通信がトンネルを通ります。')));
}
function svcTab(b, dev) {
  const on = h('input', { type: 'checkbox', checked: dev.cfg.http, id: ui.uid() });
  const ta = h('textarea', { rows: 10, class: 'mono', id: ui.uid() }); ta.value = dev.cfg.html || '';
  b.append(h('div', { class: 'form' }, h('h4', { style: 'margin:0' }, 'HTTP'), h('label', { style: 'display:flex;gap:6px;align-items:center;color:var(--ink)' }, on, 'HTTP サービスを有効にする（TCP 80）'),
    ui.field('index.html', ta), h('div', { class: 'rowbtns' }, h('button', { class: 'hbtn primary', onclick: () => { dev.cfg.http = on.checked; dev.cfg.html = ta.value; NL.touch('cfg'); ui.toast('保存しました'); } }, '保存'))));
}

// Socket local WebUI
function socketWeb(b, dev) {
  let page = 'dash';
  const main = h('main');
  const nav = h('nav');
  const pages = [['dash', 'ダッシュボード'], ['net', 'ネットワーク設定'], ['diag', '診断'], ['about', 'このページについて']];
  const draw = () => {
    nav.innerHTML = '';
    pages.forEach(([id, l]) => nav.append(h('button', { 'aria-current': id === page ? 'page' : null, onclick: () => { page = id; draw(); } }, l)));
    main.innerHTML = '';
    if (!dev.power) { main.append(h('p', {}, '電源が OFF のため表示できません。')); return; }
    ({ dash: webDash, net: webNet, diag: webDiag, about: webAbout })[page](main, dev, draw);
  };
  b.append(h('div', { class: 'sweb' }, h('div', { class: 'shead' }, h('b', {}, 'Socket ローカル管理画面'), h('span', { class: 'addr' }, 'https://169.254.1.1（MGMT ポート）'), h('span', { style: 'flex:1' }), h('span', { style: 'font-size:11px;color:#9fb0c2' }, dev.serial)), h('div', { class: 'sbody2' }, nav, main)));
  draw();
}
function webDash(m, dev) {
  const s = NL.cato.siteOf(dev);
  const tun = w => NL.cato.tunUp(dev, w);
  const row = (k, v) => [h('dt', {}, k), h('dd', {}, v)];
  m.append(h('h4', { style: 'margin:0 0 8px' }, '状態'), h('dl', { class: 'kv' },
    row('Cato Cloud 接続', ['WAN1', 'WAN2'].some(tun) ? '接続済み（PoP ' + NL.lab.cato.popName + '）' : '未接続'),
    row('WAN1 トンネル', tun('WAN1') ? 'UP' : 'DOWN'), row('WAN2 トンネル', tun('WAN2') ? 'UP' : 'DOWN'),
    row('サイト', s ? `${s.site.name}（${s.role === 'primary' ? 'プライマリ' : 'セカンダリ'}）` : '未割り当て（管理コンソールでサイトに割り当てます）'),
    row('HA 状態', s && s.site.secondarySerial ? (NL.cato.isActive(dev) ? 'Active' : 'Standby') : '—'),
    row('シリアル番号', dev.serial), row('モデル', 'X1500'),
    ...['WAN1', 'WAN2'].flatMap(w => { const a = NL.socketWan(dev, w); return row(w + ' アドレス', a.ip ? `${a.ip}/${U.maskLen(a.mask)} gw ${a.gw || '—'}（${dev.cfg.wan[w].mode === 'static' ? '静的' : 'DHCP'}）` : (dev.cfg.wan[w].mode === 'dhcp' ? 'DHCP 取得待ち' : '未設定')); }),
    row('LAN1 アドレス', (NL.l3ifs(dev).filter(i => i.name === 'LAN1').map(i => i.ip + (i.vip ? ' (VIP)' : '')).join(', ')) || '管理コンソールのサイト設定から配布されます')));
  m.append(h('div', { class: 'callout', style: 'margin-top:12px' }, 'Socket は WAN 側でインターネット（ここでは Cato Cloud ノード）に到達できると、自動でトンネルを張って管理コンソールの「Socket インベントリ」に現れます。WAN が DHCP で取れない環境では、ここで静的 IP を入れるのが最初の作業です。'));
}
function webNet(m, dev, redraw) {
  m.append(h('h4', { style: 'margin:0 0 8px' }, 'WAN インターフェース'));
  ['WAN1', 'WAN2'].forEach(w => {
    const c = dev.cfg.wan[w];
    const mode = h('select', { id: ui.uid() }, h('option', { value: 'dhcp' }, 'DHCP'), h('option', { value: 'static' }, '静的 (Static)')); mode.value = c.mode;
    const ip = h('input', { type: 'text', class: 'mono', value: c.ip, id: ui.uid() }), mk = h('input', { type: 'text', class: 'mono', value: c.mask, id: ui.uid() }), gw = h('input', { type: 'text', class: 'mono', value: c.gw, id: ui.uid() }), dns = h('input', { type: 'text', class: 'mono', value: c.dns, id: ui.uid() });
    const msg = h('span', { 'aria-live': 'polite' });
    const sync = () => [ip, mk, gw, dns].forEach(i => { i.disabled = mode.value !== 'static'; });
    mode.addEventListener('change', sync); sync();
    m.append(h('div', { class: 'card', style: 'border:1px solid var(--rule);border-radius:6px;padding:10px;margin-bottom:10px;background:var(--panel)' }, h('b', {}, w),
      h('div', { class: 'form', style: 'margin-top:8px' }, ui.field('アドレス取得', mode), ui.field('IP アドレス', ip), ui.field('サブネットマスク', mk), ui.field('デフォルトゲートウェイ', gw), ui.field('DNS', dns),
        h('div', { class: 'rowbtns' }, h('button', { class: 'hbtn primary', onclick: () => {
          if (mode.value === 'static') {
            if (!U.isIP(ip.value.trim()) || !U.validMask(mk.value.trim()) || !U.isIP(gw.value.trim())) { msg.className = 'err-msg'; msg.textContent = 'IP・マスク・ゲートウェイを正しく入力してください'; return; }
            if (!U.sameNet(ip.value.trim(), gw.value.trim(), mk.value.trim())) { msg.className = 'err-msg'; msg.textContent = 'ゲートウェイが同じサブネットにありません'; return; }
          }
          Object.assign(c, { mode: mode.value, ip: ip.value.trim(), mask: mk.value.trim(), gw: gw.value.trim(), dns: dns.value.trim() });
          delete NL.rt(dev).wanLease[w]; NL.rt(dev).tun[w] = { state: 'connecting', ack: -99 };
          NL.touch('cfg'); NL.tick();
          msg.className = 'ok-msg'; msg.textContent = '保存しました。接続を試行します';
        } }, '保存'), msg))));
  });
  void redraw;
}
function webDiag(m, dev) {
  const w = h('select', { id: ui.uid() }, h('option', { value: 'WAN1' }, 'WAN1'), h('option', { value: 'WAN2' }, 'WAN2'));
  const tg = h('input', { type: 'text', class: 'mono', value: (NL.cato.popDev() || { cfg: {} }).cfg.ip || '', id: ui.uid() });
  const out = h('pre', { class: 'cfglog', style: 'min-height:80px' });
  m.append(h('h4', { style: 'margin:0 0 8px' }, 'Ping（WAN から）'), h('div', { class: 'form' }, ui.field('送信元', w), ui.field('宛先', tg),
    h('div', { class: 'rowbtns' }, h('button', { class: 'hbtn primary', onclick: () => {
      if (!U.isIP(tg.value.trim())) { out.textContent = '宛先は IP アドレスで指定してください'; return; }
      const r = NL.ping(dev, tg.value.trim(), { count: 4, srcIf: w.value });
      out.textContent = r.map((x, i) => `#${i + 1} ${x.r === 'ok' ? '応答あり' : x.r === 'noroute' ? '送信できません（IP / ゲートウェイ未設定）' : x.r === 'unreach' ? '到達不能 (' + x.from + ')' : 'タイムアウト'}`).join('\n');
    } }, '実行')), out));
}
function webAbout(m) {
  m.append(h('p', {}, '実機の Socket には、初期設定やトラブル時に使うローカル管理画面（WebUI）があります。主な用途は、WAN を静的 IP にする・回線状態を見る・簡単な診断をすることです。サイトのネットワーク設定（LAN の IP、ネットワーク範囲、HA など）はクラウド側の管理コンソールで行います。'),
    h('p', { style: 'color:var(--muted);font-size:12px' }, 'この画面は練習用に簡略化したものです。実機の画面構成・項目名・アクセス方法は機種とバージョンで異なるため、作業前に公式ドキュメントで確認してください。'));
}
function socketStatus(b, dev) {
  const s = NL.cato.siteOf(dev);
  b.append(h('dl', { class: 'kv' },
    h('dt', {}, 'サイト'), h('dd', {}, s ? s.site.name + '（' + (s.role === 'primary' ? 'プライマリ' : 'セカンダリ') + '）' : '未割り当て'),
    h('dt', {}, 'HA'), h('dd', {}, s && s.site.secondarySerial ? (NL.cato.isActive(dev) ? 'Active' : 'Standby') + ' / ' + NL.cato.haStatus(s.site).reason : '—'),
    h('dt', {}, 'WAN1'), h('dd', {}, NL.cato.tunUp(dev, 'WAN1') ? 'トンネル UP' : 'トンネル DOWN'),
    h('dt', {}, 'WAN2'), h('dd', {}, NL.cato.tunUp(dev, 'WAN2') ? 'トンネル UP' : 'トンネル DOWN'),
    h('dt', {}, '使用中の WAN'), h('dd', {}, NL.cato.activeWan(dev) || '—')),
    h('h4', {}, '内部テーブル'), h('pre', { class: 'cfglog', style: 'max-height:none' }, ui.inspectText(dev)));
}
function popCfg(b, dev) {
  const c = dev.cfg;
  const disp = h('input', { type: 'text', value: dev.name, id: ui.uid() });
  const ip = h('input', { type: 'text', class: 'mono', value: c.ip, id: ui.uid() }), mk = h('input', { type: 'text', class: 'mono', value: c.mask, id: ui.uid() }), gw = h('input', { type: 'text', class: 'mono', value: c.gw, id: ui.uid() });
  const pn = h('input', { type: 'text', value: NL.lab.cato.popName, id: ui.uid() });
  const msg = h('span');
  b.append(h('div', { class: 'callout' }, 'このノードはインターネット上の Cato Cloud（PoP）を 1 台にまとめた練習用の装置です。Socket や Cato Client は、ここの IP に到達できるとトンネルを張ります。ラボの外側（インフラ側）なので、普段は設定を変える必要はありません。'),
    h('div', { class: 'form' }, ui.field('表示名', disp), ui.field('PoP 名', pn), ui.field('IP アドレス', ip), ui.field('サブネットマスク', mk), ui.field('デフォルトゲートウェイ', gw),
      h('div', { class: 'rowbtns' }, h('button', { class: 'hbtn primary', onclick: () => {
        if (!U.isIP(ip.value.trim()) || !U.validMask(mk.value.trim())) { msg.className = 'err-msg'; msg.textContent = 'IP とマスクを正しく入力してください'; return; }
        dev.name = disp.value.trim() || dev.name; NL.lab.cato.popName = pn.value.trim() || 'PoP';
        Object.assign(c, { ip: ip.value.trim(), mask: mk.value.trim(), gw: gw.value.trim() }); NL.touch('cfg');
        msg.className = 'ok-msg'; msg.textContent = '保存しました';
      } }, '保存'), msg)));
}
function popStatus(b) {
  const inv = NL.cato.inventory().filter(i => i.seen);
  const cl = Object.entries(NL.cato.clients());
  b.append(h('h4', { style: 'margin:0 0 6px' }, '接続中の Socket'),
    inv.length ? h('table', { class: 'ports' }, h('tr', {}, h('th', {}, 'Socket'), h('th', {}, 'シリアル'), h('th', {}, '見えている送信元（NAT 後）')), inv.map(i => h('tr', {}, h('td', {}, i.dev.name), h('td', { class: 'mono' }, i.serial), h('td', { class: 'mono' }, i.publicIp)))) : h('p', { style: 'color:var(--muted)' }, 'まだありません'),
    h('h4', {}, '接続中の Cato Client'),
    cl.length ? h('table', { class: 'ports' }, h('tr', {}, h('th', {}, 'ユーザー'), h('th', {}, 'Client IP'), h('th', {}, '送信元')), cl.map(([e, c]) => h('tr', {}, h('td', {}, e), h('td', { class: 'mono' }, c.clientIp), h('td', { class: 'mono' }, c.ip + ':' + c.port)))) : h('p', { style: 'color:var(--muted)' }, 'まだありません'));
}
})();
