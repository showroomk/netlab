/* NetLab engine: topology, L2/L3 forwarding, ARP, STP, NAT, ACL, DHCP, OSPF and the Cato fabric.
   DOM-free so it can run anywhere. Everything hangs off window.NL. */
(function (G) {
'use strict';
const NL = G.NL = G.NL || {};

// ---------- address helpers
const ip2n = s => { const p = String(s).split('.'); return (((+p[0]) << 24) >>> 0) + ((+p[1]) << 16) + ((+p[2]) << 8) + (+p[3]); };
const n2ip = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const isIP = s => typeof s === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every(x => +x <= 255);
const len2mask = l => l <= 0 ? 0 : (0xFFFFFFFF << (32 - l)) >>> 0;
const maskLen = m => { const n = typeof m === 'number' ? m : ip2n(m); let l = 0; while (l < 32 && ((n >>> (31 - l)) & 1)) l++; return l; };
const validMask = m => isIP(m) && len2mask(maskLen(m)) === ip2n(m);
const netN = (ip, mask) => (ip2n(ip) & ip2n(mask)) >>> 0;
const netOf = (ip, mask) => n2ip(netN(ip, mask));
const sameNet = (a, b, mask) => isIP(a) && isIP(b) && isIP(mask) && netN(a, mask) === netN(b, mask);
const parseCidr = c => {
  const [a, l] = String(c || '').trim().split('/');
  if (!isIP(a) || l === undefined || l === '' || isNaN(+l) || +l < 0 || +l > 32) return null;
  const mask = n2ip(len2mask(+l));
  return { net: netOf(a, mask), len: +l, mask, addr: a };
};
const inCidr = (ip, c) => { const p = typeof c === 'string' ? parseCidr(c) : c; return !!p && isIP(ip) && netOf(ip, p.mask) === p.net; };
const wildMatch = (ip, addr, wild) => ((ip2n(ip) | ip2n(wild)) >>> 0) === ((ip2n(addr) | ip2n(wild)) >>> 0);
const clone = o => o == null ? o : JSON.parse(JSON.stringify(o));
const shortIf = n => String(n).replace('GigabitEthernet', 'Gi').replace('FastEthernet', 'Fa').replace('Loopback', 'Lo').replace(/^Ethernet/, 'Eth');
const BCAST = 'ffff.ffff.ffff';
NL.util = { ip2n, n2ip, isIP, len2mask, maskLen, validMask, netOf, sameNet, parseCidr, inCidr, wildMatch, clone, shortIf, BCAST };

// ---------- device models
const rng = (p, a, b) => Array.from({ length: b - a + 1 }, (_, i) => p + (a + i));
const SWP = [...rng('FastEthernet0/', 1, 24), ...rng('GigabitEthernet0/', 1, 2)];
NL.MODELS = {
  '2911':   { kind: 'router',   label: 'Cisco 2911',          group: 'ルーター', ports: rng('GigabitEthernet0/', 0, 2), console: true, defName: 'Router' },
  '4331':   { kind: 'router',   label: 'Cisco ISR4331',       group: 'ルーター', ports: rng('GigabitEthernet0/0/', 0, 2), console: true, defName: 'Router' },
  '2960':   { kind: 'switch',   label: 'Catalyst 2960-24TT',  group: 'スイッチ', ports: SWP, console: true, defName: 'Switch' },
  '3560':   { kind: 'l3switch', label: 'Catalyst 3560-24PS',  group: 'スイッチ', ports: SWP, console: true, defName: 'MLSwitch' },
  'pc':     { kind: 'pc',       label: 'PC',                  group: '端末', ports: ['FastEthernet0'], rs232: true, defName: 'PC' },
  'laptop': { kind: 'pc',       label: 'ノート PC',           group: '端末', ports: ['FastEthernet0'], rs232: true, defName: 'Laptop' },
  'server': { kind: 'server',   label: 'サーバー',            group: '端末', ports: ['FastEthernet0'], rs232: true, defName: 'Server' },
  'x1500':  { kind: 'socket',   label: 'Cato Socket X1500',   group: 'Cato', ports: ['WAN1', 'WAN2', 'LAN1', 'LAN2', 'MGMT'], defName: 'Socket' },
  'pop':    { kind: 'pop',      label: 'Cato Cloud (PoP)',    group: 'Cato', ports: ['eth0'], defName: 'CatoCloud' }
};
const M = d => NL.MODELS[d.model];
const kindOf = d => M(d).kind;
const isCisco = d => { const k = kindOf(d); return k === 'router' || k === 'switch' || k === 'l3switch'; };
const isSwitch = d => { const k = kindOf(d); return k === 'switch' || k === 'l3switch'; };
NL.kind = kindOf; NL.isCisco = isCisco; NL.isSwitch = isSwitch;
NL.allPorts = d => [...M(d).ports, ...(M(d).console ? ['Console'] : []), ...(M(d).rs232 ? ['RS232'] : [])];

// ---------- events
const handlers = {};
NL.on = (e, f) => { (handlers[e] = handlers[e] || []).push(f); };
NL.emit = (e, ...a) => (handlers[e] || []).forEach(f => { try { f(...a); } catch (x) { console.error(x); } });

// ---------- lab state
NL.defaultCato = () => ({
  account: 'lab-account', popName: 'Tokyo', sites: [], users: [], sdpRange: '10.0.3.0/24',
  wanFw: { rules: [{ id: 'w1', name: 'Allow all（初期ルール）', enabled: true, src: 'any', dst: 'any', svc: 'any', action: 'allow' }] },
  inetFw: { rules: [] }
});
NL.newLab = name => ({ v: 1, name: name || '新しいラボ', seq: 0, ver: 0, devices: [], links: [], notes: [], cato: NL.defaultCato() });
let RT = {};
let CR = null;
let cache = {};
let prevSt = null;
let TICK = 0;
const freshCR = () => ({ eps: {}, clients: {}, inet: [], active: {}, events: [], hits: {}, nextPort: 20000 });
NL.rt = d => RT[d.id] || (RT[d.id] = { arp: {}, mac: {}, pend: {}, nat: [], aclHits: {}, lease: null, wanLease: {}, tun: {}, cato: null, dhcpBind: {} });
NL.dev = id => NL.lab.devices.find(d => d.id === id);
NL.byName = n => NL.lab.devices.find(d => d.name === n);
const devBySerial = s => s ? NL.lab.devices.find(d => d.serial === s) : null;
NL.devBySerial = devBySerial;
const cached = (k, f) => (k in cache ? cache[k] : (cache[k] = f()));

NL.loadLab = obj => {
  const lab = typeof obj === 'string' ? JSON.parse(obj) : clone(obj);
  lab.cato = Object.assign(NL.defaultCato(), lab.cato || {});
  lab.notes = lab.notes || []; lab.links = lab.links || []; lab.devices = lab.devices || [];
  lab.devices.forEach(d => { if (isCisco(d) && !d.vlans) d.vlans = kindOf(d) === 'router' ? {} : { 1: { name: 'default' } }; });
  NL.lab = lab; RT = {}; CR = freshCR(); cache = {}; prevSt = null; TICK = 0;
  NL.sim.log = []; NL.sim.q = [];
  NL.touch('load');
};
NL.serialize = () => JSON.stringify(NL.lab);

NL.touch = what => {
  NL.lab.ver = (NL.lab.ver || 0) + 1; cache = {};
  if (what === 'topo') Object.values(RT).forEach(r => { r.mac = {}; });
  statusDiff();
  NL.emit('change', what);
};

// ---------- device lifecycle
const hex4 = () => Math.floor(Math.random() * 65536).toString(16).padStart(4, '0');
const genMac = () => ['00' + Math.floor(Math.random() * 256).toString(16).padStart(2, '0'), hex4(), hex4()].join('.');
const genSerial = () => 'X15' + Math.random().toString(36).slice(2, 7).toUpperCase() + Math.floor(Math.random() * 900 + 100);

function ciscoDefault(dev) {
  const r = kindOf(dev) === 'router';
  const c = {
    hostname: r ? 'Router' : 'Switch', interfaces: {}, routes: [], acls: {}, nat: { rules: [], pools: {} },
    dhcp: { excluded: [], pools: {} }, ospf: null, lines: { con: {}, vty: { login: true, transport: 'all' } }, users: {},
    ipRouting: r, defaultGateway: '', domainName: '', domainLookup: true, nameServers: [], banner: '',
    enableSecret: '', enablePassword: '', pwEnc: false, sshVersion: 0, rsa: 0, cdp: true, stpPrio: {}, stpMode: 'pvst', misc: []
  };
  M(dev).ports.forEach(p => {
    c.interfaces[p] = r ? { shutdown: true } : { shutdown: false, switchport: true, mode: 'dynamic auto', accessVlan: 1, allowed: null, nativeVlan: 1 };
  });
  if (!r) c.interfaces.Vlan1 = { shutdown: true };
  return c;
}
NL.ciscoDefault = ciscoDefault;
function defaultCfg(dev) {
  const k = kindOf(dev);
  if (isCisco(dev)) return ciscoDefault(dev);
  if (k === 'pc' || k === 'server') return { ip: '', mask: '', gw: '', dns: '', dhcp: false, http: k === 'server', html: '<h1>Welcome</h1><p>' + dev.name + ' の Web ページです。</p>' };
  if (k === 'socket') return { wan: { WAN1: { mode: 'dhcp', ip: '', mask: '', gw: '', dns: '' }, WAN2: { mode: 'dhcp', ip: '', mask: '', gw: '', dns: '' } } };
  if (k === 'pop') return { ip: '', mask: '', gw: '' };
  return {};
}
NL.addDevice = (model, x, y, opts = {}) => {
  const m = NL.MODELS[model], lab = NL.lab;
  const id = 'd' + (++lab.seq);
  let name = opts.name;
  if (!name) { let i = 0; while (lab.devices.some(d => d.name === m.defName + i)) i++; name = m.defName + i; }
  const dev = { id, model, name, x: Math.round(x), y: Math.round(y), power: true, macs: {}, baseMac: genMac() };
  m.ports.forEach(p => { dev.macs[p] = genMac(); });
  if (m.kind === 'socket') dev.serial = genSerial();
  dev.cfg = defaultCfg(dev); dev.startup = null;
  if (isCisco(dev)) dev.vlans = m.kind === 'router' ? {} : { 1: { name: 'default' } };
  lab.devices.push(dev);
  NL.touch('topo');
  return dev;
};
NL.removeDevice = id => {
  const lab = NL.lab;
  lab.links = lab.links.filter(l => l.a.d !== id && l.b.d !== id);
  lab.devices = lab.devices.filter(d => d.id !== id);
  delete RT[id];
  NL.touch('topo');
};
NL.linkOf = (devId, port) => NL.lab.links.find(l => (l.a.d === devId && l.a.p === port) || (l.b.d === devId && l.b.p === port));
NL.peer = (devId, port) => {
  const l = NL.linkOf(devId, port); if (!l) return null;
  const e = (l.a.d === devId && l.a.p === port) ? l.b : l.a;
  return { dev: NL.dev(e.d), port: e.p, link: l };
};
const isCon = p => p === 'Console' || p === 'RS232';
NL.connect = (a, ap, b, bp, cable) => {
  if (a.id === b.id) return '同じ機器の中ではつなげません';
  if (NL.linkOf(a.id, ap) || NL.linkOf(b.id, bp)) return 'そのポートは使用中です';
  if (isCon(ap) || isCon(bp)) {
    if (!(isCon(ap) && isCon(bp) && ap !== bp)) return 'コンソールケーブルは PC の RS232 と機器の Console をつなぎます';
    cable = 'console';
  } else if (cable === 'console') return 'コンソールケーブルは RS232 / Console ポート専用です';
  const l = { id: 'l' + (++NL.lab.seq), a: { d: a.id, p: ap }, b: { d: b.id, p: bp }, cable: cable || 'auto' };
  NL.lab.links.push(l);
  NL.touch('topo');
  return l;
};
NL.disconnect = id => { NL.lab.links = NL.lab.links.filter(l => l.id !== id); NL.touch('topo'); };

NL.setPower = (dev, on) => {
  dev.power = !!on;
  delete RT[dev.id];
  if (on && isCisco(dev)) dev.cfg = dev.startup ? clone(dev.startup) : ciscoDefault(dev);
  NL.touch('topo');
  NL.emit('power', dev, !!on);
};
NL.reload = dev => { NL.setPower(dev, false); NL.setPower(dev, true); };

// ---------- link and interface state
NL.portAdminUp = (dev, p) => {
  if (!dev || !dev.power) return false;
  if (isCisco(dev)) { const i = dev.cfg.interfaces[p]; return !!i && !i.shutdown; }
  return true;
};
const cableOk = l => {
  if (l.cable === 'auto' || l.cable === 'console' || l.cable === 'fiber') return true;
  const grp = d => isSwitch(d) ? 'S' : 'H';
  const same = grp(NL.dev(l.a.d)) === grp(NL.dev(l.b.d));
  return l.cable === 'cross' ? same : !same;
};
NL.cableOk = cableOk;
NL.portLinkUp = (dev, p) => {
  if (isCon(p)) return false;
  const pe = NL.peer(dev.id, p);
  if (!pe || pe.link.cable === 'console') return false;
  return cableOk(pe.link) && NL.portAdminUp(dev, p) && NL.portAdminUp(pe.dev, pe.port);
};
function isSwPort(dev, p) {
  if (!isSwitch(dev) || !M(dev).ports.includes(p)) return false;
  const i = dev.cfg.interfaces[p];
  return !!i && i.switchport !== false;
}
NL.isSwPort = isSwPort;
function effMode(dev, p) {
  const i = dev.cfg.interfaces[p]; const m = i.mode || 'dynamic auto';
  if (m === 'access' || m === 'trunk') return m;
  const pe = NL.peer(dev.id, p);
  if (!pe || !isSwPort(pe.dev, pe.port) || i.nonegotiate) return 'access';
  const pi = pe.dev.cfg.interfaces[pe.port];
  if (pi.nonegotiate) return 'access';
  const pm = pi.mode || 'dynamic auto';
  if (pm === 'access') return 'access';
  if (pm === 'trunk' || pm === 'dynamic desirable') return 'trunk';
  return m === 'dynamic desirable' ? 'trunk' : 'access';
}
NL.effMode = effMode;
const trunkAllows = (i, v) => !i.allowed || i.allowed.includes(v);
NL.trunkAllows = trunkAllows;
function portCarries(dev, p, v) {
  if (!isSwPort(dev, p) || !NL.portLinkUp(dev, p) || !dev.vlans[v]) return false;
  const i = dev.cfg.interfaces[p];
  return effMode(dev, p) === 'access' ? (i.accessVlan || 1) === v : trunkAllows(i, v);
}
const sviUp = (dev, v) => !!dev.vlans[v] && M(dev).ports.some(p => portCarries(dev, p, v));

NL.ifState = (dev, name) => {
  const i = dev.cfg.interfaces[name]; if (!i) return null;
  if (i.shutdown) return { status: 'administratively down', proto: 'down' };
  let up;
  if (!dev.power) up = false;
  else if (name.startsWith('Vlan')) up = sviUp(dev, +name.slice(4));
  else if (name.startsWith('Loopback')) up = true;
  else if (name.includes('.')) up = NL.portLinkUp(dev, name.split('.')[0]) && i.dot1q != null;
  else up = NL.portLinkUp(dev, name);
  return { status: up ? 'up' : 'down', proto: up ? 'up' : 'down' };
};

function hostAddr(dev) {
  const c = dev.cfg;
  if (c.dhcp) return NL.rt(dev).lease || {};
  return { ip: c.ip, mask: c.mask, gw: c.gw, dns: c.dns };
}
NL.hostAddr = hostAddr;
function socketWan(dev, w) {
  const c = dev.cfg.wan[w];
  if (c.mode === 'static') return c;
  return NL.rt(dev).wanLease[w] || {};
}
NL.socketWan = socketWan;

NL.l3ifs = dev => cached('l3:' + dev.id, () => buildL3(dev));
function buildL3(dev) {
  const k = kindOf(dev), out = [];
  if (!dev.power) return out;
  if (isCisco(dev)) {
    for (const [name, i] of Object.entries(dev.cfg.interfaces)) {
      if (!i.ip) continue;
      if (M(dev).ports.includes(name) && isSwPort(dev, name)) continue;
      let t, port = null, vlan = null, up;
      if (name.startsWith('Vlan')) { t = 'svi'; vlan = +name.slice(4); up = !i.shutdown && sviUp(dev, vlan); }
      else if (name.startsWith('Loopback')) { t = 'lo'; up = !i.shutdown; }
      else if (name.includes('.')) { t = 'sub'; port = name.split('.')[0]; vlan = i.dot1q == null ? null : i.dot1q; up = !i.shutdown && vlan != null && NL.portLinkUp(dev, port); }
      else { t = 'phys'; port = name; up = NL.portLinkUp(dev, name); }
      const mac = t === 'phys' ? dev.macs[name] : t === 'sub' ? dev.macs[port] : dev.baseMac;
      const base = { name, port, vlan, t, up, mac, cfg: i, native: !!i.dot1qNative };
      out.push(Object.assign({}, base, { ip: i.ip, mask: i.mask }));
      (i.secondary || []).forEach(s => out.push(Object.assign({}, base, { ip: s.ip, mask: s.mask, secondary: true })));
    }
  } else if (k === 'pc' || k === 'server') {
    const a = hostAddr(dev);
    if (a.ip) out.push({ name: 'FastEthernet0', port: 'FastEthernet0', t: 'host', up: NL.portLinkUp(dev, 'FastEthernet0'), mac: dev.macs.FastEthernet0, ip: a.ip, mask: a.mask, gw: a.gw, cfg: {} });
    const c = NL.rt(dev).cato;
    if (c && c.state === 'connected') out.push({ name: 'Cato', t: 'cato', up: true, ip: c.clientIp, mask: '255.255.255.255', cfg: {} });
  } else if (k === 'socket') {
    ['WAN1', 'WAN2'].forEach(w => {
      const a = socketWan(dev, w);
      if (a.ip) out.push({ name: w, port: w, t: 'host', up: NL.portLinkUp(dev, w), mac: dev.macs[w], ip: a.ip, mask: a.mask, gw: a.gw, cfg: {} });
    });
    const s = NL.cato.siteOf(dev);
    if (s) {
      const lan = NL.cato.lanAddr(s.site, s.role);
      if (lan) {
        const up = NL.portLinkUp(dev, 'LAN1');
        out.push({ name: 'LAN1', port: 'LAN1', t: 'host', up, mac: dev.macs.LAN1, ip: lan.ip, mask: lan.mask, cfg: {} });
        const vip = NL.cato.vip(s.site);
        if (vip && NL.cato.isActive(dev)) out.push({ name: 'LAN1', port: 'LAN1', t: 'host', up, mac: NL.cato.vmac(s.site), ip: vip, mask: lan.mask, cfg: {}, vip: true });
      }
    }
    out.push({ name: 'MGMT', port: 'MGMT', t: 'host', up: NL.portLinkUp(dev, 'MGMT'), mac: dev.macs.MGMT, ip: '169.254.1.1', mask: '255.255.0.0', cfg: {} });
  } else if (k === 'pop') {
    if (dev.cfg.ip) out.push({ name: 'eth0', port: 'eth0', t: 'host', up: NL.portLinkUp(dev, 'eth0'), mac: dev.macs.eth0, ip: dev.cfg.ip, mask: dev.cfg.mask, gw: dev.cfg.gw, cfg: {} });
  }
  return out;
}
const isMine = (dev, ip) => NL.l3ifs(dev).some(i => i.ip === ip && (i.up || i.t === 'lo'));
NL.isMine = isMine;
const canRoute = dev => { const k = kindOf(dev); return dev.power && (k === 'router' || (k === 'l3switch' && dev.cfg.ipRouting)); };
NL.canRoute = canRoute;

// ---------- simulation core
const SIM = NL.sim = { q: [], t: 0, recording: false, log: [], seq: 0, drops: [] };
const sched = fn => SIM.q.push({ t: SIM.t + 1, fn });
SIM.run = () => {
  let n = 0;
  while (SIM.q.length && n++ < 30000) { const e = SIM.q.shift(); SIM.t = Math.max(SIM.t, e.t); e.fn(); }
  SIM.q.length = 0;
};
function rec(ev) { if (SIM.recording) { ev.id = ++SIM.seq; SIM.log.push(ev); } }
function drop(dev, reason, pkt) {
  SIM.drops.unshift({ at: dev.name, reason, time: Date.now() });
  if (SIM.drops.length > 40) SIM.drops.length = 40;
  rec({ kind: 'drop', at: dev.id, t: SIM.t, reason, frame: pkt ? clone(pkt.ip ? pkt : { type: 'ip', ip: pkt }) : null });
  return false;
}
NL.drop = drop;

function transmit(dev, port, frame) {
  const pe = NL.peer(dev.id, port);
  if (!pe || !NL.portLinkUp(dev, port)) return drop(dev, `${shortIf(port)} がリンクダウンのため送信できません`, frame);
  frame = Object.assign({}, frame, { hop: (frame.hop || 0) + 1 });
  if (frame.hop > 80) return drop(dev, 'フレームがループしています', frame);
  if (SIM.recording) rec({ kind: 'tx', from: dev.id, to: pe.dev.id, link: pe.link.id, fport: port, tport: pe.port, t: SIM.t + 1, frame: clone(frame) });
  sched(() => receive(pe.dev, pe.port, frame));
  return true;
}
function receive(dev, port, frame) {
  if (!dev.power) return;
  if (isSwitch(dev) && isSwPort(dev, port)) return swIn(dev, port, frame);
  if (isCisco(dev)) return rtIn(dev, port, frame);
  return hostIn(dev, port, frame);
}
function hostIn(dev, port, frame) {
  if (frame.vlan != null) return drop(dev, 'タグ付き (802.1Q) フレームは受け取れません', frame);
  const mymac = dev.macs[port];
  if (frame.type === 'ip' && frame.ip.proto === 'udp' && frame.ip.dport === 68 && frame.ip.dhcp && (frame.dst === mymac || frame.dst === BCAST)) return dhcpClientIn(dev, port, frame.ip);
  const ifs = NL.l3ifs(dev).filter(i => i.port === port);
  const li = ifs.find(i => frame.dst === BCAST ? !i.vip : i.mac === frame.dst);
  if (!li) return;
  l3In(dev, li, frame);
}
function rtIn(dev, port, frame) {
  const ifs = NL.l3ifs(dev).filter(i => i.port === port && i.up && !i.secondary);
  const li = frame.vlan != null
    ? ifs.find(i => i.t === 'sub' && i.vlan === frame.vlan)
    : (ifs.find(i => i.t === 'phys') || ifs.find(i => i.t === 'sub' && i.native));
  if (!li) return drop(dev, frame.vlan != null ? `VLAN ${frame.vlan} 用のサブインターフェースがありません` : `${shortIf(port)} に IP アドレスがありません`, frame);
  if (frame.dst !== BCAST && frame.dst !== li.mac) return;
  l3In(dev, li, frame);
}

// ---------- switching
function swIn(dev, port, frame) {
  const i = dev.cfg.interfaces[port]; const mode = effMode(dev, port);
  let v;
  if (mode === 'access') {
    if (frame.vlan != null) return drop(dev, `アクセスポート ${shortIf(port)} にタグ付きフレームが届きました`, frame);
    v = i.accessVlan || 1;
  } else {
    v = frame.vlan != null ? frame.vlan : (i.nativeVlan || 1);
    if (!trunkAllows(i, v)) return drop(dev, `トランク ${shortIf(port)} で VLAN ${v} は許可されていません`, frame);
  }
  if (!dev.vlans[v]) return drop(dev, `VLAN ${v} が VLAN データベースにありません`, frame);
  if (stpBlocked(dev, port, v)) return drop(dev, `${shortIf(port)} は STP でブロッキング中です`, frame);
  NL.rt(dev).mac[v + '|' + frame.src] = port;
  swFwd(dev, v, Object.assign({}, frame, { vlan: null }), port);
}
function swPorts(dev, v) { return M(dev).ports.filter(p => portCarries(dev, p, v) && !stpBlocked(dev, p, v)); }
function swOut(dev, p, v, frame) {
  const i = dev.cfg.interfaces[p];
  const tag = effMode(dev, p) === 'trunk' && v !== (i.nativeVlan || 1) ? v : null;
  transmit(dev, p, Object.assign({}, frame, { vlan: tag }));
}
function swFwd(dev, v, frame, inPort) {
  const rt = NL.rt(dev);
  const svi = NL.l3ifs(dev).find(i => i.t === 'svi' && i.vlan === v && i.up && !i.secondary);
  if (inPort !== null && svi && (frame.dst === BCAST || frame.dst === svi.mac)) {
    l3In(dev, svi, frame);
    if (frame.dst !== BCAST) return;
  }
  if (frame.dst !== BCAST) {
    const p = rt.mac[v + '|' + frame.dst];
    if (p) { if (p !== inPort && portCarries(dev, p, v) && !stpBlocked(dev, p, v)) swOut(dev, p, v, frame); return; }
  }
  swPorts(dev, v).forEach(p => { if (p !== inPort) swOut(dev, p, v, frame); });
}

// ---------- STP (per-VLAN, computed from the topology)
function stpState() {
  return cached('stp', () => {
    const blocked = new Set(), info = {};
    const sws = NL.lab.devices.filter(d => d.power && isSwitch(d));
    const vl = new Set(); sws.forEach(s => Object.keys(s.vlans).forEach(v => vl.add(+v)));
    const pcost = p => p.startsWith('Gig') ? 4 : 19;
    const pidx = (d, p) => M(d).ports.indexOf(p) + 1;
    const bid = (d, v) => [((d.cfg.stpPrio || {})[v] != null ? d.cfg.stpPrio[v] : 32768) + v, d.baseMac];
    const cmp = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };
    for (const v of vl) {
      const mem = sws.filter(s => s.vlans[v]);
      const carries = (d, p) => {
        if (!isSwPort(d, p) || !NL.portLinkUp(d, p)) return false;
        const i = d.cfg.interfaces[p];
        return effMode(d, p) === 'access' ? (i.accessVlan || 1) === v : trunkAllows(i, v);
      };
      const adj = new Map(); mem.forEach(s => adj.set(s.id, []));
      for (const s of mem) for (const p of M(s).ports) {
        if (!carries(s, p)) continue;
        const pe = NL.peer(s.id, p);
        if (pe && adj.has(pe.dev.id) && carries(pe.dev, pe.port)) adj.get(s.id).push({ p, t: pe.dev, q: pe.port });
      }
      const byId = new Map(mem.map(s => [s.id, s]));
      const compOf = new Map();
      const vinfo = info[v] = { roles: {}, root: {}, cost: {} };
      for (const s of mem) {
        if (compOf.has(s.id)) continue;
        const comp = [], st = [s.id]; compOf.set(s.id, s.id);
        while (st.length) { const u = st.pop(); comp.push(byId.get(u)); for (const e of adj.get(u)) if (!compOf.has(e.t.id)) { compOf.set(e.t.id, s.id); st.push(e.t.id); } }
        let root = comp[0];
        comp.forEach(c => { if (cmp(bid(c, v), bid(root, v)) < 0) root = c; });
        const dist = new Map(comp.map(c => [c.id, c === root ? 0 : Infinity]));
        for (let k = 0; k < comp.length; k++) for (const c of comp) { if (c === root) continue; for (const e of adj.get(c.id)) { const d = dist.get(e.t.id) + pcost(e.p); if (d < dist.get(c.id)) dist.set(c.id, d); } }
        const rootPort = new Map();
        for (const c of comp) {
          vinfo.root[c.id] = root.id; vinfo.cost[c.id] = dist.get(c.id);
          if (c === root) continue;
          let best = null, bv = null;
          for (const e of adj.get(c.id)) {
            const vec = [dist.get(e.t.id) + pcost(e.p), ...bid(e.t, v), pidx(e.t, e.q), pidx(c, e.p)];
            if (!best || cmp(vec, bv) < 0) { best = e; bv = vec; }
          }
          if (best) rootPort.set(c.id, best.p);
        }
        for (const c of comp) for (const e of adj.get(c.id)) {
          const mine = [dist.get(c.id), ...bid(c, v), pidx(c, e.p)];
          const theirs = [dist.get(e.t.id), ...bid(e.t, v), pidx(e.t, e.q)];
          let role;
          if (rootPort.get(c.id) === e.p) role = 'Root';
          else role = cmp(mine, theirs) < 0 ? 'Desg' : 'Altn';
          vinfo.roles[c.id + '|' + e.p] = role;
          if (role === 'Altn') blocked.add(c.id + '|' + e.p + '|' + v);
        }
      }
    }
    return { blocked, info, bid };
  });
}
const stpBlocked = (d, p, v) => stpState().blocked.has(d.id + '|' + p + '|' + v);
NL.stp = stpState; NL.stpBlocked = stpBlocked;
NL.stpRole = (d, p, v) => { const s = stpState().info[v]; return (s && s.roles[d.id + '|' + p]) || 'Desg'; };

// ---------- L3
function l3In(dev, li, frame) {
  if (frame.type === 'arp') return arpIn(dev, li, frame.arp);
  if (frame.type === 'ip') return ipIn(dev, li, clone(frame.ip));
}
function sendL2(dev, li, frame) {
  if (li.t === 'svi') return swFwd(dev, li.vlan, frame, null);
  if (li.t === 'sub') return transmit(dev, li.port, Object.assign({}, frame, { vlan: li.native ? null : li.vlan }));
  if (li.t === 'lo' || li.t === 'cato') return;
  return transmit(dev, li.port, Object.assign({}, frame, { vlan: null }));
}
function arpIn(dev, li, a) {
  const rt = NL.rt(dev);
  const mine = NL.l3ifs(dev).filter(i => i.name === li.name && i.up);
  const tgt = mine.find(i => i.ip === a.tip);
  if (tgt || rt.arp[a.sip]) learnArp(dev, a.sip, a.smac, li.name);
  if (a.op === 'req' && tgt && a.sip !== a.tip) {
    sendL2(dev, tgt, { src: tgt.mac, dst: a.smac, type: 'arp', arp: { op: 'rep', sip: tgt.ip, smac: tgt.mac, tip: a.sip, tmac: a.smac } });
  }
}
function learnArp(dev, ip, mac, ifn) {
  const rt = NL.rt(dev);
  rt.arp[ip] = { mac, ifn, t: Date.now() };
  const q = rt.pend[ip];
  if (q) { delete rt.pend[ip]; q.forEach(x => sendL2(dev, x.li, { src: x.li.mac, dst: mac, type: 'ip', ip: x.pkt })); }
}
function arpReq(dev, li, tgt) {
  const same = NL.l3ifs(dev).find(i => i.name === li.name && !i.vip && sameNet(i.ip, tgt, i.mask)) || li;
  sendL2(dev, li, { src: li.mac, dst: BCAST, type: 'arp', arp: { op: 'req', sip: same.ip, smac: li.mac, tip: tgt, tmac: '0000.0000.0000' } });
}
function l3Out(dev, li, nh, pkt) {
  if (li.t === 'lo') return drop(dev, 'ループバック宛ての転送は行いません', pkt);
  const tgt = nh || pkt.dst;
  if (tgt === '255.255.255.255') return sendL2(dev, li, { src: li.mac, dst: BCAST, type: 'ip', ip: pkt });
  const rt = NL.rt(dev); const e = rt.arp[tgt];
  if (e && e.ifn === li.name) return sendL2(dev, li, { src: li.mac, dst: e.mac, type: 'ip', ip: pkt });
  arpReq(dev, li, tgt);
  if (isCisco(dev)) return drop(dev, `${tgt} の ARP が未解決のため、このパケットは破棄されました（IOS の動作。次から届きます）`, pkt);
  (rt.pend[tgt] = rt.pend[tgt] || []).push({ li, pkt });
}
const defTTL = dev => isCisco(dev) ? 255 : (kindOf(dev) === 'pc' || kindOf(dev) === 'server') ? 128 : 64;

function ipIn(dev, li, pkt) {
  if (isCisco(dev)) {
    if (li.cfg.aclIn && !aclPermit(dev, li.cfg.aclIn, pkt)) { drop(dev, `ACL ${li.cfg.aclIn}（in, ${shortIf(li.name)}）で拒否されました`, pkt); icmpErr(dev, li, pkt, 'admin'); return; }
    if (li.cfg.natOutside) natOutIn(dev, pkt);
  }
  if (pkt.proto === 'udp' && pkt.dport === 67 && pkt.dhcp) return dhcpServerIn(dev, li, pkt);
  if (isMine(dev, pkt.dst) || pkt.dst === '255.255.255.255') return local(dev, li, pkt);
  if (canRoute(dev)) return forward(dev, li, pkt);
  if (kindOf(dev) === 'socket') return socketFwd(dev, li, pkt);
  drop(dev, `宛先 ${pkt.dst} は自分ではないため破棄（この機器はルーティングしません）`, pkt);
}
function forward(dev, inIf, pkt) {
  if (pkt.ttl <= 1) { drop(dev, 'TTL が 0 になりました', pkt); icmpErr(dev, inIf, pkt, 'ttl'); return; }
  pkt.ttl--;
  const r = rtLookup(dev, pkt.dst);
  if (!r) { drop(dev, `ルーティングテーブルに ${pkt.dst} への経路がありません`, pkt); icmpErr(dev, inIf, pkt, 'net'); return; }
  if (inIf.cfg.natInside && r.li.cfg.natOutside) natInOut(dev, pkt, r.li);
  if (r.li.cfg.aclOut && !aclPermit(dev, r.li.cfg.aclOut, pkt)) { drop(dev, `ACL ${r.li.cfg.aclOut}（out, ${shortIf(r.li.name)}）で拒否されました`, pkt); icmpErr(dev, inIf, pkt, 'admin'); return; }
  l3Out(dev, r.li, r.nh, pkt);
}
function icmpErr(dev, inIf, pkt, code) {
  if (pkt.proto === 'icmp' && pkt.icmp.type !== 'echo') return;
  if (!pkt.src || pkt.src === '0.0.0.0' || pkt.dst === '255.255.255.255') return;
  const orig = { probe: pkt.probe, proto: pkt.proto, src: pkt.src, dst: pkt.dst, sport: pkt.sport, dport: pkt.dport, id: pkt.icmp ? pkt.icmp.id : undefined };
  const src = inIf.ip || (NL.l3ifs(dev).find(i => i.up && i.ip) || {}).ip;
  ipSend(dev, { src, dst: pkt.src, proto: 'icmp', icmp: { type: code === 'ttl' ? 'ttl' : 'unreach', code }, orig });
}
function local(dev, li, pkt) {
  const k = kindOf(dev);
  if (k === 'pop' && !pkt.cato && popReturn(dev, pkt)) return;
  if (pkt.proto === 'icmp') {
    const ic = pkt.icmp;
    if (ic.type === 'echo') {
      const opt = (k === 'socket' && /^WAN/.test(li.name)) ? { ifName: li.name } : {};
      ipSend(dev, { src: pkt.dst, dst: pkt.src, proto: 'icmp', icmp: { type: 'echo-reply', id: ic.id, seq: ic.seq }, probe: pkt.probe, size: pkt.size }, opt);
      return;
    }
    if (ic.type === 'echo-reply') return probeDone(pkt.probe, { r: 'ok', from: pkt.src, ttl: pkt.ttl });
    if (ic.type === 'unreach' || ic.type === 'ttl') return probeDone(pkt.orig && pkt.orig.probe, { r: ic.type, code: ic.code, from: pkt.src });
    return;
  }
  if (pkt.proto === 'udp') {
    if (pkt.cato) {
      if (k === 'pop') return popIn(dev, li, pkt);
      if (k === 'socket') return socketCatoIn(dev, li, pkt);
      if (k === 'pc' || k === 'server') return pcCatoIn(dev, li, pkt);
    }
    return;
  }
  if (pkt.proto === 'tcp') return tcpIn(dev, li, pkt);
}
function tcpIn(dev, li, pkt) {
  const t = pkt.tcp || {};
  if (t.flags === 'SYN') {
    let ok = false, data = null; const k = kindOf(dev);
    if ((k === 'server' || k === 'pc') && pkt.dport === 80 && dev.cfg.http) { ok = true; data = dev.cfg.html; }
    if (isCisco(dev) && (pkt.dport === 23 || pkt.dport === 22)) ok = vtyAccepts(dev, pkt.dport);
    ipSend(dev, { src: pkt.dst, dst: pkt.src, proto: 'tcp', sport: pkt.dport, dport: pkt.sport, tcp: { flags: ok ? 'SYN-ACK' : 'RST', data }, probe: pkt.probe });
    return;
  }
  probeDone(pkt.probe, { r: t.flags === 'RST' ? 'rst' : 'ok', data: t.data, from: pkt.src });
}
function vtyAccepts(dev, port) {
  const v = dev.cfg.lines.vty || {}; const tr = v.transport || 'all';
  if (tr === 'none') return false;
  if (port === 22) return (tr === 'all' || tr.includes('ssh')) && dev.cfg.rsa > 0;
  return tr === 'all' || tr.includes('telnet');
}

function ipSend(dev, pkt, opt = {}) {
  if (pkt.ttl == null) pkt.ttl = defTTL(dev);
  const k = kindOf(dev);
  if ((k === 'pc' || k === 'server') && !opt.phys && sdpShould(dev, pkt)) return sdpOut(dev, pkt);
  if (k === 'socket' && !opt.ifName) {
    const s = NL.cato.siteOf(dev);
    const lan = NL.l3ifs(dev).find(i => i.name === 'LAN1' && !i.vip);
    if (!s || !lan) return drop(dev, 'Socket の LAN 側が未設定です', pkt) || 'noroute';
    if (!pkt.src) pkt.src = lan.ip;
    socketRoute(dev, s.site, pkt); return true;
  }
  if (isMine(dev, pkt.dst)) {
    const me = NL.l3ifs(dev).find(i => i.ip === pkt.dst);
    if (!pkt.src) pkt.src = pkt.dst;
    sched(() => local(dev, me, pkt)); return true;
  }
  const r = opt.ifName ? routeVia(dev, opt.ifName, pkt.dst) : lookup(dev, pkt.dst);
  if (!r) { drop(dev, `${pkt.dst} への経路（またはデフォルトゲートウェイ）がありません`, pkt); return 'noroute'; }
  if (!pkt.src) pkt.src = r.li.ip;
  l3Out(dev, r.li, r.nh, pkt);
  return true;
}
NL.ipSend = ipSend;
function routeVia(dev, ifName, dst) {
  const li = NL.l3ifs(dev).find(i => i.name === ifName && i.up && i.ip && !i.vip);
  if (!li) return null;
  if (sameNet(li.ip, dst, li.mask)) return { li, nh: null };
  if (li.gw && sameNet(li.ip, li.gw, li.mask)) return { li, nh: li.gw };
  return null;
}
function lookup(dev, dst) {
  if (canRoute(dev)) return rtLookup(dev, dst);
  const ifs = NL.l3ifs(dev).filter(i => i.up && i.t !== 'cato' && i.ip && i.name !== 'MGMT' && !i.vip);
  let li = ifs.find(i => sameNet(i.ip, dst, i.mask));
  if (li) return { li, nh: null };
  const gw = isCisco(dev) ? dev.cfg.defaultGateway : (ifs[0] || {}).gw;
  if (!gw) return null;
  li = ifs.find(i => sameNet(i.ip, gw, i.mask));
  return li ? { li, nh: gw } : null;
}

// ---------- routing table
function connectedFor(dev, ip) {
  return NL.l3ifs(dev).find(i => i.up && i.t !== 'lo' && sameNet(i.ip, ip, i.mask));
}
NL.routes = dev => cached('rt:' + dev.id, () => buildRoutes(dev));
function buildRoutes(dev) {
  const out = [];
  if (!dev.power) return out;
  for (const li of NL.l3ifs(dev)) {
    if (!li.up) continue;
    const len = maskLen(li.mask);
    out.push({ code: 'C', net: netOf(li.ip, li.mask), len, ifn: li.name, ad: 0, metric: 0 });
    if (len < 32) out.push({ code: 'L', net: li.ip, len: 32, ifn: li.name, ad: 0, metric: 0 });
  }
  const conn = out.slice();
  const cand = [];
  for (const r of dev.cfg.routes || []) {
    const len = maskLen(r.mask), net = netOf(r.net, r.mask);
    if (r.iface) {
      const st = NL.ifState(dev, r.iface);
      if (!st || st.proto !== 'up') continue;
      cand.push({ code: 'S', net, len, ifn: r.iface, nh: r.nh || null, ad: r.ad || 1, metric: 0 });
    } else if (r.nh) {
      cand.push({ code: 'S', net, len, nh: r.nh, ad: r.ad || 1, metric: 0, rec: true });
    }
  }
  const ospf = (ospfState().routes.get(dev.id) || []).map(r => Object.assign({}, r, { ad: 110 }));
  const all = [...cand, ...ospf];
  const resolvable = (ip, depth) => {
    if (conn.some(c => c.code === 'C' && inCidr(ip, c.net + '/' + c.len))) return true;
    if (depth > 2) return false;
    return all.some(c => c !== null && !c.rec && inCidr(ip, c.net + '/' + c.len)) ||
      all.some(c => c.rec && c.len > 0 && inCidr(ip, c.net + '/' + c.len) && resolvable(c.nh, depth + 1));
  };
  const valid = all.filter(c => !c.rec || resolvable(c.nh, 0));
  const best = new Map();
  for (const c of valid) {
    const key = c.net + '/' + c.len;
    if (conn.some(x => x.code === 'C' && x.net === c.net && x.len === c.len)) continue;
    const b = best.get(key);
    if (!b || c.ad < b[0].ad) best.set(key, [c]);
    else if (c.ad === b[0].ad && c.code === 'S') b.push(c);
  }
  best.forEach(arr => out.push(...arr));
  return out;
}
function rtLookup(dev, dst, depth = 0) {
  let best = null;
  for (const r of NL.routes(dev)) {
    if (!inCidr(dst, r.net + '/' + r.len)) continue;
    if (!best || r.len > best.len || (r.len === best.len && r.ad < best.ad)) best = r;
  }
  if (!best) return null;
  if (best.code === 'C' || best.code === 'L') {
    const li = NL.l3ifs(dev).find(i => i.name === best.ifn && i.up && sameNet(i.ip, dst, i.mask) && !i.secondary) || NL.l3ifs(dev).find(i => i.name === best.ifn && i.up);
    return li ? { li, nh: null } : null;
  }
  if (best.nh) {
    const c = connectedFor(dev, best.nh);
    if (c) return { li: c, nh: best.nh };
    if (depth > 3) return null;
    const r2 = rtLookup(dev, best.nh, depth + 1);
    return r2 ? { li: r2.li, nh: r2.nh || best.nh } : null;
  }
  if (best.ifn) {
    const li = NL.l3ifs(dev).find(i => i.name === best.ifn && i.up && !i.secondary);
    return li ? { li, nh: null } : null;
  }
  return null;
}
NL.lookup = (dev, dst) => canRoute(dev) ? rtLookup(dev, dst) : lookup(dev, dst);

// ---------- NAT
function natOutIn(dev, pkt) {
  const rt = NL.rt(dev);
  const isErr = pkt.proto === 'icmp' && (pkt.icmp.type === 'unreach' || pkt.icmp.type === 'ttl') && pkt.orig;
  const proto = isErr ? pkt.orig.proto : pkt.proto;
  const port = isErr ? (proto === 'icmp' ? pkt.orig.id : pkt.orig.sport) : (proto === 'icmp' ? pkt.icmp.id : pkt.dport);
  const e = rt.nat.find(x => x.ig === pkt.dst && x.proto === proto && x.igp === port);
  if (e) {
    pkt.dst = e.il;
    if (isErr) { pkt.orig = Object.assign({}, pkt.orig, { src: e.il }); if (proto === 'icmp') pkt.orig.id = e.ilp; else pkt.orig.sport = e.ilp; }
    else if (proto === 'icmp') pkt.icmp = Object.assign({}, pkt.icmp, { id: e.ilp });
    else pkt.dport = e.ilp;
    e.hits = (e.hits || 0) + 1;
    return;
  }
  const s = (dev.cfg.nat.rules || []).find(r => r.kind === 'static' && r.global === pkt.dst);
  if (s) pkt.dst = s.local;
}
function natInOut(dev, pkt, outIf) {
  const rt = NL.rt(dev), rules = dev.cfg.nat.rules || [];
  const proto = pkt.proto, lport = proto === 'icmp' ? pkt.icmp.id : pkt.sport;
  const setPort = p => { if (proto === 'icmp') pkt.icmp = Object.assign({}, pkt.icmp, { id: p }); else pkt.sport = p; };
  const olp = proto === 'icmp' ? lport : pkt.dport;
  const st = rules.find(r => r.kind === 'static' && r.local === pkt.src);
  if (st) {
    if (!rt.nat.some(x => x.proto === proto && x.il === pkt.src && x.ilp === lport)) rt.nat.push({ proto, il: pkt.src, ilp: lport, ig: st.global, igp: lport, ol: pkt.dst, olp });
    pkt.src = st.global; return true;
  }
  for (const r of rules) {
    if (r.kind !== 'dynamic') continue;
    if (!aclPermit(dev, r.acl, { src: pkt.src, dst: pkt.dst, proto, sport: pkt.sport, dport: pkt.dport, icmp: pkt.icmp })) continue;
    let ig;
    const overload = r.overload || !!r.iface;
    if (r.iface) {
      const li = NL.l3ifs(dev).find(i => i.name === r.iface && !i.secondary);
      if (!li || !li.up) return false;
      ig = li.ip;
    } else {
      ig = poolAddr(dev, r.pool, pkt.src, overload);
      if (!ig) { drop(dev, `NAT プール ${r.pool} に空きがありません`, pkt); return false; }
    }
    let e = rt.nat.find(x => x.proto === proto && x.il === pkt.src && x.ilp === lport && x.ig === ig);
    if (!e) {
      let gp = lport;
      if (overload) while (rt.nat.some(x => x.proto === proto && x.ig === ig && x.igp === gp)) gp = gp < 1024 ? 1024 : gp + 1;
      e = { proto, il: pkt.src, ilp: lport, ig, igp: gp, ol: pkt.dst, olp };
      rt.nat.push(e);
    }
    pkt.src = ig; setPort(e.igp);
    return true;
  }
  return false;
}
function poolAddr(dev, name, il, overload) {
  const p = dev.cfg.nat.pools[name]; if (!p) return null;
  if (overload) return p.start;
  const rt = NL.rt(dev);
  const ex = rt.nat.find(x => x.il === il && inRange(x.ig, p.start, p.end));
  if (ex) return ex.ig;
  for (let n = ip2n(p.start); n <= ip2n(p.end); n++) {
    const a = n2ip(n >>> 0);
    if (!rt.nat.some(x => x.ig === a)) return a;
  }
  return null;
}
const inRange = (ip, a, b) => ip2n(ip) >= ip2n(a) && ip2n(ip) <= ip2n(b);

// ---------- ACL
const PORTN = { www: 80, http: 80, telnet: 23, ftp: 21, smtp: 25, domain: 53, pop3: 110, ssh: 22, https: 443, tftp: 69, snmp: 161, bootps: 67, bootpc: 68, ntp: 123 };
NL.PORTN = PORTN;
function aclPermit(dev, name, pkt) {
  const acl = dev.cfg.acls[name]; if (!acl) return true;
  const rt = NL.rt(dev); const hits = rt.aclHits[name] = rt.aclHits[name] || {};
  for (const e of acl.entries) {
    if (e.remark != null) continue;
    if (aclMatch(acl.type, e, pkt)) { hits[e.seq] = (hits[e.seq] || 0) + 1; return e.action === 'permit'; }
  }
  return false;
}
NL.aclPermit = aclPermit;
const addrMatch = (s, ip) => s.any || (isIP(ip) && wildMatch(ip, s.a, s.w || '0.0.0.0'));
function portMatch(s, p) {
  if (!s) return true; if (p == null) return false;
  switch (s.op) { case 'eq': return p === s.p; case 'neq': return p !== s.p; case 'gt': return p > s.p; case 'lt': return p < s.p; case 'range': return p >= s.p && p <= s.p2; }
  return true;
}
function aclMatch(type, e, pkt) {
  if (type === 'standard') return addrMatch(e.src, pkt.src);
  if (e.proto !== 'ip' && e.proto !== pkt.proto) return false;
  if (!addrMatch(e.src, pkt.src) || !addrMatch(e.dst, pkt.dst)) return false;
  if (e.proto === 'tcp' || e.proto === 'udp') { if (!portMatch(e.sport, pkt.sport) || !portMatch(e.dport, pkt.dport)) return false; }
  if (e.proto === 'icmp' && e.icmpType) {
    const t = { 'echo': 'echo', 'echo-reply': 'echo-reply', 'unreachable': 'unreach', 'time-exceeded': 'ttl' }[e.icmpType];
    if (!pkt.icmp || pkt.icmp.type !== t) return false;
  }
  if (e.est && pkt.proto === 'tcp' && pkt.tcp && pkt.tcp.flags === 'SYN') return false;
  return true;
}
NL.parseAce = (type, t) => {
  let i = 0; const e = {};
  const act = t[i++];
  if (act !== 'permit' && act !== 'deny') return { err: true, at: 0 };
  e.action = act;
  const addr = () => {
    const x = t[i];
    if (x === 'any') { i++; return { any: true }; }
    if (x === 'host') { const a = t[i + 1]; if (!isIP(a)) { i++; return null; } i += 2; return { a, w: '0.0.0.0' }; }
    if (!isIP(x)) return null;
    i++;
    if (isIP(t[i])) return { a: x, w: t[i++] };
    return type === 'standard' ? { a: x, w: '0.0.0.0' } : null;
  };
  if (type === 'standard') {
    const s = addr(); if (!s) return { err: true, at: i };
    e.src = s;
    if (t[i] === 'log') { e.log = true; i++; }
    if (i < t.length) return { err: true, at: i };
    return { e };
  }
  const pr = t[i++];
  if (!['ip', 'icmp', 'tcp', 'udp'].includes(pr)) return { err: true, at: i - 1 };
  e.proto = pr;
  e.src = addr(); if (!e.src) return { err: true, at: i };
  const pv = v => v == null ? null : (isNaN(+v) ? (PORTN[v] == null ? null : PORTN[v]) : +v);
  const port = () => {
    const op = t[i];
    if (!['eq', 'neq', 'gt', 'lt', 'range'].includes(op)) return undefined;
    i++;
    const p = pv(t[i++]); if (p == null) return null;
    const r = { op, p };
    if (op === 'range') { r.p2 = pv(t[i++]); if (r.p2 == null) return null; }
    return r;
  };
  if (pr === 'tcp' || pr === 'udp') { const sp = port(); if (sp === null) return { err: true, at: i - 1 }; if (sp) e.sport = sp; }
  e.dst = addr(); if (!e.dst) return { err: true, at: i };
  if (pr === 'tcp' || pr === 'udp') { const dp = port(); if (dp === null) return { err: true, at: i - 1 }; if (dp) e.dport = dp; }
  if (pr === 'icmp' && ['echo', 'echo-reply', 'unreachable', 'time-exceeded'].includes(t[i])) e.icmpType = t[i++];
  if (t[i] === 'established') { e.est = true; i++; }
  if (t[i] === 'log') { e.log = true; i++; }
  if (i < t.length) return { err: true, at: i };
  return { e };
};
const PNAME = Object.fromEntries(Object.entries({ 80: 'www', 23: 'telnet', 21: 'ftp', 25: 'smtp', 53: 'domain', 110: 'pop3', 69: 'tftp', 161: 'snmp', 67: 'bootps', 68: 'bootpc', 123: 'ntp' }));
NL.aceText = (type, e) => {
  if (e.remark != null) return 'remark ' + e.remark;
  const a = s => s.any ? 'any' : (s.w === '0.0.0.0' ? (type === 'standard' ? s.a : 'host ' + s.a) : s.a + ' ' + s.w);
  const p = s => s ? ' ' + s.op + ' ' + (PNAME[s.p] || s.p) + (s.op === 'range' ? ' ' + (PNAME[s.p2] || s.p2) : '') : '';
  if (type === 'standard') return e.action + ' ' + a(e.src) + (e.log ? ' log' : '');
  return e.action + ' ' + e.proto + ' ' + a(e.src) + p(e.sport) + ' ' + a(e.dst) + p(e.dport) + (e.icmpType ? ' ' + e.icmpType : '') + (e.est ? ' established' : '') + (e.log ? ' log' : '');
};

// ---------- DHCP
function excluded(dev, ip) { return (dev.cfg.dhcp.excluded || []).some(([a, b]) => inRange(ip, a, b || a)); }
function dhcpServerIn(dev, li, pkt) {
  if (!isCisco(dev)) return;
  const d = pkt.dhcp;
  if (d.op === 'discover') {
    const key = d.giaddr || li.ip;
    const pool = Object.entries(dev.cfg.dhcp.pools).find(([, p]) => p.network && sameNet(key, p.network, p.mask));
    if (pool) return dhcpOffer(dev, li, pkt, pool);
    const helpers = (li.cfg && li.cfg.helper) || [];
    if (helpers.length && !d.giaddr) { helpers.forEach(h => ipSend(dev, { src: li.ip, dst: h, proto: 'udp', sport: 67, dport: 67, dhcp: Object.assign({}, d, { giaddr: li.ip }) })); return; }
    if (Object.keys(dev.cfg.dhcp.pools).length) drop(dev, `${key} に合う DHCP プールがありません`, pkt);
    return;
  }
  if (d.op === 'ack' && d.giaddr && isMine(dev, d.giaddr)) {
    const out = NL.l3ifs(dev).find(i => i.ip === d.giaddr);
    if (out) sendL2(dev, out, { src: out.mac, dst: d.chaddr, type: 'ip', ip: { src: out.ip, dst: '255.255.255.255', proto: 'udp', sport: 67, dport: 68, ttl: 255, dhcp: d } });
  }
}
function dhcpOffer(dev, li, pkt, [name, p]) {
  const rt = NL.rt(dev), mac = pkt.dhcp.chaddr;
  let ip = Object.keys(rt.dhcpBind).find(k => rt.dhcpBind[k].mac === mac);
  if (!ip && isIP(p.network) && validMask(p.mask)) {
    const base = netN(p.network, p.mask), bc = (base | (~ip2n(p.mask) >>> 0)) >>> 0;
    for (let n = base + 1, c = 0; n < bc && c < 70000; n++, c++) {
      const a = n2ip(n >>> 0);
      if (excluded(dev, a) || rt.dhcpBind[a] || NL.l3ifs(dev).some(i => i.ip === a)) continue;
      ip = a; break;
    }
  }
  if (!ip) return drop(dev, `DHCP プール ${name} に空きアドレスがありません`, pkt);
  rt.dhcpBind[ip] = { mac, pool: name, t: Date.now() };
  const ack = { op: 'ack', xid: pkt.dhcp.xid, chaddr: mac, yiaddr: ip, mask: p.mask, router: p.defaultRouter || '', dns: p.dns || '', giaddr: pkt.dhcp.giaddr || null };
  if (pkt.dhcp.giaddr) ipSend(dev, { src: li.ip, dst: pkt.dhcp.giaddr, proto: 'udp', sport: 67, dport: 67, dhcp: ack });
  else sendL2(dev, li, { src: li.mac, dst: mac, type: 'ip', ip: { src: li.ip, dst: '255.255.255.255', proto: 'udp', sport: 67, dport: 68, ttl: 255, dhcp: ack } });
}
function dhcpClientIn(dev, port, pkt) {
  const rt = NL.rt(dev), d = pkt.dhcp;
  if (d.op !== 'ack' || d.chaddr !== dev.macs[port]) return;
  const lease = { ip: d.yiaddr, mask: d.mask, gw: d.router, dns: d.dns, server: pkt.src };
  if (kindOf(dev) === 'socket') rt.wanLease[port] = lease; else rt.lease = lease;
  cache = {};
  NL.emit('change', 'lease');
}
NL.dhcpRequest = (dev, port) => {
  const rt = NL.rt(dev);
  if (kindOf(dev) === 'socket') delete rt.wanLease[port]; else rt.lease = null;
  cache = {};
  transmit(dev, port, { src: dev.macs[port], dst: BCAST, type: 'ip', ip: { src: '0.0.0.0', dst: '255.255.255.255', proto: 'udp', sport: 68, dport: 67, ttl: 128, dhcp: { op: 'discover', xid: Math.random(), chaddr: dev.macs[port] } } });
  SIM.run();
  const got = kindOf(dev) === 'socket' ? rt.wanLease[port] : rt.lease;
  if (!got && kindOf(dev) !== 'socket') rt.lease = { ip: '169.254.' + (1 + Math.floor(Math.random() * 254)) + '.' + (1 + Math.floor(Math.random() * 254)), mask: '255.255.0.0', gw: '', dns: '', apipa: true };
  NL.touch('lease');
  return !!got;
};

// ---------- probes: ping / traceroute / tcp
const PROBES = {}; let probeSeq = 0, icmpId = 0;
const newProbe = () => { const id = ++probeSeq; PROBES[id] = null; return id; };
const probeDone = (id, res) => { if (id && id in PROBES && !PROBES[id]) PROBES[id] = res; };
NL.ping = (dev, dst, o = {}) => {
  const count = o.count || (isCisco(dev) ? 5 : 4), res = [];
  icmpId = (icmpId % 60000) + 1;
  for (let s = 0; s < count; s++) {
    const pid = newProbe();
    const pkt = { dst, proto: 'icmp', icmp: { type: 'echo', id: icmpId, seq: s }, probe: pid, size: o.size || (isCisco(dev) ? 100 : 32) };
    if (o.src) pkt.src = o.src;
    if (o.ttl) pkt.ttl = o.ttl;
    const st = ipSend(dev, pkt, o.srcIf ? { ifName: o.srcIf } : {});
    SIM.run();
    res.push(st === 'noroute' ? { r: 'noroute' } : (PROBES[pid] || { r: 'timeout' }));
    delete PROBES[pid];
  }
  NL.emit('ping', dev, dst, res);
  return res;
};
NL.trace = (dev, dst, o = {}) => {
  const hops = []; let silent = 0;
  for (let ttl = 1; ttl <= (o.max || 30); ttl++) {
    const tries = []; let from = null, done = false;
    for (let k = 0; k < 3; k++) {
      const pid = newProbe();
      ipSend(dev, { dst, proto: 'icmp', icmp: { type: 'echo', id: 30000 + ttl, seq: k }, probe: pid, ttl });
      SIM.run();
      const r = PROBES[pid]; delete PROBES[pid];
      tries.push(r);
      if (r) { from = r.from; if (r.r === 'ok' || r.r === 'unreach') done = true; }
    }
    hops.push({ ttl, from, tries });
    silent = from ? 0 : silent + 1;
    if (done || silent >= 4) break;
  }
  return hops;
};
NL.tcp = (dev, dst, port, data) => {
  const pid = newProbe();
  const st = ipSend(dev, { dst, proto: 'tcp', sport: 1025 + Math.floor(Math.random() * 30000), dport: port, tcp: { flags: 'SYN', data }, probe: pid });
  SIM.run();
  const r = PROBES[pid]; delete PROBES[pid];
  return st === 'noroute' ? { r: 'noroute' } : (r || { r: 'timeout' });
};
NL.ipToDev = ip => NL.lab.devices.find(d => NL.l3ifs(d).some(i => i.ip === ip && i.up));

// ---------- OSPF
function routerId(dev) {
  const o = dev.cfg.ospf;
  if (o && o.routerId) return o.routerId;
  const ifs = NL.l3ifs(dev).filter(i => i.up);
  const lo = ifs.filter(i => i.t === 'lo').map(i => i.ip);
  const pick = arr => arr.sort((a, b) => ip2n(b) - ip2n(a))[0];
  return pick(lo) || pick(ifs.map(i => i.ip)) || '0.0.0.0';
}
NL.routerId = routerId;
function ospfIfaces(dev) {
  const o = dev.cfg.ospf;
  if (!o || !canRoute(dev)) return [];
  const out = [];
  for (const li of NL.l3ifs(dev)) {
    if (!li.up) continue;
    const st = (o.networks || []).find(n => wildMatch(li.ip, n.addr, n.wild));
    if (!st) continue;
    const passive = li.t === 'lo' || (o.passiveDefault ? !(o.noPassive || []).includes(li.name) : (o.passive || []).includes(li.name));
    out.push({ li, area: String(st.area), passive, cost: li.cfg.ospfCost || (/^Ethernet/.test(li.name) ? 10 : 1) });
  }
  return out;
}
function ospfState() {
  return cached('ospf', () => {
    const R = NL.lab.devices.filter(d => isCisco(d) && d.cfg.ospf && canRoute(d));
    const info = new Map();
    for (const d of R) info.set(d.id, { dev: d, rid: routerId(d), ifs: ospfIfaces(d), nbrs: [] });
    for (const a of info.values()) for (const ai of a.ifs) {
      if (ai.passive) continue;
      for (const r of l2reach(a.dev, ai.li)) {
        const b = info.get(r.dev.id); if (!b || b === a) continue;
        const bi = b.ifs.find(x => x.li.name === r.li.name && x.li.ip === r.li.ip);
        if (!bi || bi.passive || bi.area !== ai.area || bi.li.mask !== ai.li.mask || !sameNet(ai.li.ip, bi.li.ip, ai.li.mask) || b.rid === a.rid) continue;
        if (a.nbrs.some(n => n.rid === b.rid && n.ifn === ai.li.name)) continue;
        a.nbrs.push({ rid: b.rid, ip: bi.li.ip, ifn: ai.li.name, dev: b.dev, cost: ai.cost, area: ai.area });
      }
    }
    const routes = new Map();
    for (const a of info.values()) {
      const dist = new Map([[a.dev.id, 0]]), first = new Map(), done = new Set();
      for (;;) {
        let u = null, ud = Infinity;
        for (const [k, v] of dist) if (!done.has(k) && v < ud) { u = k; ud = v; }
        if (u === null) break;
        done.add(u);
        for (const nb of info.get(u).nbrs) {
          const nd = ud + nb.cost;
          if (!dist.has(nb.dev.id) || nd < dist.get(nb.dev.id)) { dist.set(nb.dev.id, nd); first.set(nb.dev.id, u === a.dev.id ? nb : first.get(u)); }
        }
      }
      const rs = [];
      const connected = (net, len) => NL.l3ifs(a.dev).some(i => i.up && netOf(i.ip, i.mask) === net && maskLen(i.mask) === len);
      for (const [id, dd] of dist) {
        if (id === a.dev.id) continue;
        const b = info.get(id), fh = first.get(id);
        if (!fh) continue;
        for (const bi of b.ifs) {
          const isLo = bi.li.t === 'lo';
          const len = isLo ? 32 : maskLen(bi.li.mask), net = isLo ? bi.li.ip : netOf(bi.li.ip, bi.li.mask);
          if (connected(net, len)) continue;
          const key = net + '/' + len, cost = dd + (isLo ? 1 : bi.cost);
          const ex = rs.find(r => r.key === key);
          if (!ex || cost < ex.metric) { if (ex) rs.splice(rs.indexOf(ex), 1); rs.push({ key, net, len, nh: fh.ip, ifn: fh.ifn, metric: cost, code: 'O' }); }
        }
        if (b.dev.cfg.ospf.defaultOriginate && (b.dev.cfg.routes || []).some(r => r.net === '0.0.0.0' && r.mask === '0.0.0.0')) {
          if (!rs.some(r => r.key === '0.0.0.0/0')) rs.push({ key: '0.0.0.0/0', net: '0.0.0.0', len: 0, nh: fh.ip, ifn: fh.ifn, metric: 1, code: 'O*E2' });
        }
      }
      routes.set(a.dev.id, rs);
    }
    return { info, routes };
  });
}
NL.ospf = ospfState;
NL.ospfNbrs = dev => { const i = ospfState().info.get(dev.id); return i ? i.nbrs : []; };
NL.ospfIfaces = ospfIfaces;

function l2reach(dev, li) {
  const res = [], seen = new Set();
  const visitSw = (d, v, inPort) => {
    const key = d.id + '|' + v; if (seen.has(key)) return; seen.add(key);
    NL.l3ifs(d).filter(x => x.t === 'svi' && x.vlan === v && x.up && !(d === dev && x.name === li.name)).forEach(x => res.push({ dev: d, li: x }));
    for (const p of swPorts(d, v)) {
      if (p === inPort) continue;
      const i = d.cfg.interfaces[p];
      cross(d, p, effMode(d, p) === 'trunk' && v !== (i.nativeVlan || 1) ? v : null);
    }
  };
  const cross = (d, p, tag) => {
    const pe = NL.peer(d.id, p); if (!pe || !NL.portLinkUp(d, p)) return;
    const pd = pe.dev;
    if (isSwPort(pd, pe.port)) {
      const i = pd.cfg.interfaces[pe.port]; let v;
      if (effMode(pd, pe.port) === 'access') { if (tag != null) return; v = i.accessVlan || 1; }
      else { v = tag != null ? tag : (i.nativeVlan || 1); if (!trunkAllows(i, v)) return; }
      if (!pd.vlans[v] || stpBlocked(pd, pe.port, v)) return;
      visitSw(pd, v, pe.port); return;
    }
    NL.l3ifs(pd).filter(x => x.port === pe.port && x.up && (tag != null ? (x.t === 'sub' && x.vlan === tag && !x.native) : (x.t !== 'sub' || x.native))).forEach(x => res.push({ dev: pd, li: x }));
  };
  if (li.t === 'svi') visitSw(dev, li.vlan, null);
  else if (li.port) cross(dev, li.port, li.t === 'sub' && !li.native ? li.vlan : null);
  return res;
}
NL.l2reach = l2reach;

// ---------- CDP
NL.cdpNeighbors = dev => {
  if (!isCisco(dev) || !dev.cfg.cdp) return [];
  const out = [];
  for (const p of M(dev).ports) {
    const pe = NL.peer(dev.id, p);
    if (!pe || !NL.portLinkUp(dev, p) || !isCisco(pe.dev) || !pe.dev.cfg.cdp) continue;
    out.push({ port: p, dev: pe.dev, rport: pe.port });
  }
  return out;
};

// ---------- syslog: interface and adjacency changes
function statusSnapshot() {
  const s = {};
  for (const d of NL.lab.devices) {
    if (!isCisco(d) || !d.power) continue;
    for (const n of Object.keys(d.cfg.interfaces)) { const st = NL.ifState(d, n); s[d.id + '\u0001' + n] = st.status + '/' + st.proto; }
    for (const nb of NL.ospfNbrs(d)) s[d.id + '\u0001ospf\u0001' + nb.rid + '\u0001' + nb.ifn] = 'FULL';
  }
  return s;
}
function statusDiff() {
  if (!NL.lab) return;
  let cur;
  try { cur = statusSnapshot(); } catch (e) { console.error(e); return; }
  if (prevSt) {
    const devsBefore = new Set(Object.keys(prevSt).map(k => k.split('\u0001')[0]));
    const say = (id, msg) => { const d = NL.dev(id); if (d) NL.emit('syslog', d, msg); };
    for (const [k, v] of Object.entries(cur)) {
      const parts = k.split('\u0001'); const id = parts[0];
      if (!devsBefore.has(id)) continue;
      const old = prevSt[k];
      if (parts[1] === 'ospf') {
        if (!old) say(id, `%OSPF-5-ADJCHG: Process ${NL.dev(id).cfg.ospf.pid}, Nbr ${parts[2]} on ${parts[3]} from LOADING to FULL, Loading Done`);
        continue;
      }
      if (old === undefined || old === v) continue;
      const n = parts[1];
      const [os, op] = old.split('/'), [ns, np] = v.split('/');
      if (os !== ns && !(os === 'administratively down' && ns === 'down')) say(id, `%LINK-5-CHANGED: Interface ${n}, changed state to ${ns}`);
      if (op !== np) say(id, `%LINEPROTO-5-UPDOWN: Line protocol on Interface ${n}, changed state to ${np}`);
    }
    for (const k of Object.keys(prevSt)) {
      const parts = k.split('\u0001');
      if (parts[1] === 'ospf' && !(k in cur)) { const d = NL.dev(parts[0]); if (d && d.power && d.cfg.ospf) say(parts[0], `%OSPF-5-ADJCHG: Process ${d.cfg.ospf.pid}, Nbr ${parts[2]} on ${parts[3]} from FULL to DOWN, Neighbor Down: Interface down or detached`); }
    }
  }
  prevSt = cur;
}

// ---------- Cato fabric
const C = NL.cato = {};
C.cfg = () => NL.lab.cato;
C.popDev = () => NL.lab.devices.find(d => kindOf(d) === 'pop' && d.power && d.cfg.ip);
C.siteOf = dev => {
  if (!dev || !dev.serial) return null;
  for (const s of NL.lab.cato.sites) {
    if (s.primarySerial === dev.serial) return { site: s, role: 'primary' };
    if (s.secondarySerial === dev.serial) return { site: s, role: 'secondary' };
  }
  return null;
};
C.lanAddr = (site, role) => {
  const p = parseCidr(site.nativeRange); if (!p) return null;
  const ha = site.secondarySerial && site.ha;
  const ip = ha ? (role === 'primary' ? site.ha.primaryIp : site.ha.secondaryIp) : site.localIp;
  if (!isIP(ip) || !inCidr(ip, p)) return null;
  return { ip, mask: p.mask };
};
C.vip = site => (site.secondarySerial && site.ha && isIP(site.localIp)) ? site.localIp : null;
C.vmac = site => '0000.5e00.01' + (NL.lab.cato.sites.indexOf(site) + 1).toString(16).padStart(2, '0');
C.activeSerial = site => {
  let cur = CR.active[site.id];
  if (cur !== site.primarySerial && cur !== site.secondarySerial) cur = CR.active[site.id] = site.primarySerial || null;
  return cur;
};
C.isActive = dev => { const s = C.siteOf(dev); return !!s && C.activeSerial(s.site) === dev.serial; };
C.tunUp = (dev, w) => { const t = NL.rt(dev).tun[w]; return !!dev.power && !!t && t.state === 'up' && NL.portLinkUp(dev, w); };
C.activeWan = dev => {
  const s = C.siteOf(dev);
  const prec = w => (s && s.site.wan && s.site.wan[w] && s.site.wan[w].precedence) || 'active';
  for (const level of ['active', 'passive', 'last-resort']) for (const w of ['WAN1', 'WAN2']) if (prec(w) === level && C.tunUp(dev, w)) return w;
  return null;
};
C.rt = () => CR;
C.events = () => CR.events;
C.hits = id => CR.hits[id] || 0;
function catoEvent(type, site, msg) {
  CR.events.unshift({ time: new Date().toLocaleTimeString('ja-JP'), type, site: site || '-', msg });
  if (CR.events.length > 300) CR.events.length = 300;
  NL.emit('cato');
}
C.event = catoEvent;
function siteNext(site, dst) {
  if (inCidr(dst, site.nativeRange)) return { nh: null };
  for (const r of site.ranges || []) if (inCidr(dst, r.cidr)) return { nh: r.type === 'routed' ? r.gw : null };
  return null;
}
C.siteNext = siteNext;
C.siteForIp = ip => NL.lab.cato.sites.find(s => siteNext(s, ip));

function socketFwd(dev, inIf, pkt) {
  if (/^WAN|MGMT/.test(inIf.name)) return drop(dev, 'Socket は WAN 側で受けたパケットを LAN へ転送しません', pkt);
  const s = C.siteOf(dev);
  if (!s) return drop(dev, 'Socket がサイトに割り当てられていません（管理コンソールで割り当てが必要）', pkt);
  if (!C.isActive(dev)) return drop(dev, 'HA のスタンバイ側 Socket なので転送しません', pkt);
  if (pkt.ttl <= 1) { icmpErr(dev, inIf, pkt, 'ttl'); return; }
  pkt.ttl--;
  socketRoute(dev, s.site, pkt);
}
function socketRoute(dev, site, pkt) {
  const lan = NL.l3ifs(dev).find(i => i.name === 'LAN1' && !i.vip);
  const loc = siteNext(site, pkt.dst);
  if (loc) {
    if (!lan || !lan.up) return drop(dev, 'Socket の LAN1 がダウンしています', pkt);
    return l3Out(dev, lan, loc.nh, pkt);
  }
  const w = C.activeWan(dev);
  if (!w) return drop(dev, 'Cato トンネルが確立していないため Cato Cloud へ送れません', pkt);
  catoSend(dev, w, { kind: 'data', serial: dev.serial, inner: pkt });
}
function catoSend(dev, w, payload) {
  const pop = C.popDev();
  if (!pop) return drop(dev, 'Cato Cloud (PoP) がラボ内にありません', null);
  const rt = NL.rt(dev);
  const t = rt.tun[w] = rt.tun[w] || { state: 'connecting', ack: -99 };
  t.sport = w === 'WAN2' ? 40002 : 40001;
  ipSend(dev, { dst: pop.cfg.ip, proto: 'udp', sport: t.sport, dport: 443, cato: payload }, { ifName: w });
}
function setTun(dev, w, state) {
  const rt = NL.rt(dev); const t = rt.tun[w] = rt.tun[w] || { ack: -99 };
  if (t.state === state) return;
  const was = t.state; t.state = state;
  const s = C.siteOf(dev);
  if (state === 'up') catoEvent('接続', s && s.site.name, `${dev.name} ${w}: トンネル確立（PoP ${NL.lab.cato.popName}）`);
  else if (was === 'up') catoEvent('接続', s && s.site.name, `${dev.name} ${w}: トンネル切断`);
  NL.touch('tun');
}
function socketCatoIn(dev, li, pkt) {
  const c = pkt.cato;
  if (c.kind === 'ka-ack') {
    const t = NL.rt(dev).tun[c.wan] = NL.rt(dev).tun[c.wan] || {};
    t.ack = TICK;
    setTun(dev, c.wan, 'up');
    return;
  }
  if (c.kind === 'data') {
    const s = C.siteOf(dev); if (!s) return drop(dev, 'サイト未割当', pkt);
    const inner = c.inner;
    const lan = NL.l3ifs(dev).find(i => i.name === 'LAN1' && !i.vip);
    if (isMine(dev, inner.dst)) return local(dev, lan || li, inner);
    const loc = siteNext(s.site, inner.dst);
    if (!loc || !lan) return drop(dev, `${inner.dst} はこのサイトのネットワークではありません`, inner);
    if (inner.ttl <= 1) return drop(dev, 'TTL 超過', inner);
    inner.ttl--;
    l3Out(dev, lan, loc.nh, inner);
  }
}
// SDP client (Cato Client on a PC)
function sdpShould(dev, pkt) {
  const c = NL.rt(dev).cato; if (!c || c.state !== 'connected') return false;
  const pop = C.popDev();
  if (!pop || pkt.dst === pop.cfg.ip || pkt.dst === '255.255.255.255') return false;
  const a = hostAddr(dev);
  if (a.ip && sameNet(a.ip, pkt.dst, a.mask)) return false;
  return true;
}
function sdpOut(dev, pkt) {
  const c = NL.rt(dev).cato, pop = C.popDev();
  if (!pkt.src || pkt.src === hostAddr(dev).ip) pkt.src = c.clientIp;
  return ipSend(dev, { dst: pop.cfg.ip, proto: 'udp', sport: 45000, dport: 443, cato: { kind: 'sdp-data', email: c.email, inner: pkt } }, { phys: true });
}
function pcCatoIn(dev, li, pkt) {
  const c = pkt.cato, st = NL.rt(dev).cato;
  if (!st) return;
  if (c.kind === 'sdp-ack') { const was = st.state; st.state = 'connected'; st.clientIp = c.clientIp; st.ack = TICK; st.err = ''; if (was !== 'connected') { cache = {}; NL.emit('change', 'sdp'); } return; }
  if (c.kind === 'sdp-nak') { st.state = 'error'; st.err = c.reason; cache = {}; NL.emit('change', 'sdp'); return; }
  if (c.kind === 'sdp-data') {
    const inner = c.inner;
    if (inner.dst === st.clientIp) return local(dev, { name: 'Cato', t: 'cato', ip: st.clientIp, cfg: {} }, inner);
  }
}
C.clientConnect = (dev, email) => {
  const rt = NL.rt(dev);
  rt.cato = { state: 'connecting', email: String(email || '').trim().toLowerCase(), clientIp: '', err: '', ack: TICK };
  const pop = C.popDev();
  if (!pop) { rt.cato.state = 'error'; rt.cato.err = 'Cato Cloud (PoP) がラボ内にありません'; NL.touch('sdp'); return rt.cato; }
  const rec0 = SIM.recording;
  ipSend(dev, { dst: pop.cfg.ip, proto: 'udp', sport: 45000, dport: 443, cato: { kind: 'sdp-ka', email: rt.cato.email } }, { phys: true });
  SIM.run();
  SIM.recording = rec0;
  if (rt.cato.state === 'connecting') {
    // Windows-style hosts wait for ARP, so give it one more round
    ipSend(dev, { dst: pop.cfg.ip, proto: 'udp', sport: 45000, dport: 443, cato: { kind: 'sdp-ka', email: rt.cato.email } }, { phys: true });
    SIM.run();
  }
  if (rt.cato.state === 'connecting') { rt.cato.state = 'error'; rt.cato.err = 'Cato Cloud に到達できません（IP 設定・経路・ケーブルを確認）'; }
  else if (rt.cato.state === 'error') rt.cato.err = { user: 'ユーザーが管理コンソールに登録されていません', pool: 'SDP 用 IP 範囲に空きがありません' }[rt.cato.err] || rt.cato.err;
  if (rt.cato.state === 'connected') catoEvent('SDP', '-', `${rt.cato.email} が Cato Client で接続（${rt.cato.clientIp}）`);
  NL.touch('sdp');
  return rt.cato;
};
C.clientDisconnect = dev => {
  const rt = NL.rt(dev);
  if (rt.cato) { delete CR.clients[rt.cato.email]; catoEvent('SDP', '-', `${rt.cato.email} が切断`); }
  rt.cato = null; NL.touch('sdp');
};
// PoP
function popIn(pop, li, pkt) {
  const c = pkt.cato, from = { ip: pkt.src, port: pkt.sport };
  const reply = payload => ipSend(pop, { dst: from.ip, proto: 'udp', sport: 443, dport: from.port, cato: payload });
  switch (c.kind) {
    case 'ka':
      CR.eps[c.serial + '|' + c.wan] = Object.assign({}, from, { seen: TICK, wan: c.wan, serial: c.serial });
      reply({ kind: 'ka-ack', wan: c.wan, pop: NL.lab.cato.popName });
      return;
    case 'data': return popRoute(pop, { serial: c.serial }, c.inner);
    case 'sdp-ka': {
      const u = NL.lab.cato.users.find(x => x.email.toLowerCase() === c.email);
      if (!u) return reply({ kind: 'sdp-nak', reason: 'user' });
      const ipc = clientIpFor(c.email);
      if (!ipc) return reply({ kind: 'sdp-nak', reason: 'pool' });
      CR.clients[c.email] = Object.assign({}, from, { clientIp: ipc, seen: TICK });
      return reply({ kind: 'sdp-ack', clientIp: ipc });
    }
    case 'sdp-data':
      if (!CR.clients[c.email]) return drop(pop, '未接続の SDP ユーザーからのトラフィック', c.inner);
      return popRoute(pop, { email: c.email }, c.inner);
  }
}
function clientIpFor(email) {
  if (CR.clients[email]) return CR.clients[email].clientIp;
  const p = parseCidr(NL.lab.cato.sdpRange); if (!p) return null;
  const used = new Set(Object.values(CR.clients).map(x => x.clientIp));
  const base = ip2n(p.net), size = Math.pow(2, 32 - p.len);
  for (let i = 1; i < size - 1 && i < 5000; i++) { const a = n2ip((base + i) >>> 0); if (!used.has(a)) return a; }
  return null;
}
const isReturn = p => p.proto === 'icmp' ? p.icmp.type !== 'echo' : (p.proto === 'tcp' && p.tcp && p.tcp.flags !== 'SYN');
function entMatch(ent, side, ip) {
  if (!ent || ent === 'any') return true;
  if (ent === 'sdp') return !!side && !!side.email;
  const i = ent.indexOf(':'), t = ent.slice(0, i), v = ent.slice(i + 1);
  if (t === 'site') return !!side && !!side.site && side.site.id === v;
  if (t === 'user') return !!side && side.email === v;
  if (t === 'cidr') return inCidr(ip, v);
  return false;
}
function svcMatch(svc, p) {
  if (!svc || svc === 'any') return true;
  if (svc === 'icmp') return p.proto === 'icmp';
  const m = { http: ['tcp', 80], https: ['tcp', 443], dns: ['udp', 53], ssh: ['tcp', 22], telnet: ['tcp', 23] }[svc];
  if (m) return p.proto === m[0] && p.dport === m[1];
  const mm = /^(tcp|udp)\/(\d+)$/.exec(svc);
  return !!mm && p.proto === mm[1] && p.dport === +mm[2];
}
function fwEval(kind, src, dst, p) {
  const pol = kind === 'wan' ? NL.lab.cato.wanFw : NL.lab.cato.inetFw;
  for (const r of pol.rules) {
    if (!r.enabled) continue;
    const dstOk = kind === 'wan' ? entMatch(r.dst, dst, p.dst) : (r.dst === 'any' || (String(r.dst).startsWith('cidr:') && inCidr(p.dst, r.dst.slice(5))));
    if (entMatch(r.src, src, p.src) && dstOk && svcMatch(r.svc, p)) {
      CR.hits[r.id] = (CR.hits[r.id] || 0) + 1;
      return { allow: r.action === 'allow', name: r.name };
    }
  }
  return kind === 'wan' ? { allow: false, name: '暗黙のブロック（Any → Any）' } : { allow: true, name: '暗黙の許可' };
}
C.fwEval = fwEval;
function popRoute(pop, src, inner) {
  const sd = src.serial ? C.siteOf(devBySerial(src.serial)) : null;
  if (src.serial && !sd) return drop(pop, 'サイトに割り当てられていない Socket からのトラフィックです', inner);
  const side = { site: sd && sd.site, email: src.email };
  const dSite = C.siteForIp(inner.dst);
  const dCli = Object.keys(CR.clients).find(e => CR.clients[e].clientIp === inner.dst);
  if (dSite || dCli) {
    if (!isReturn(inner)) {
      const r = fwEval('wan', side, { site: dSite, email: dCli }, inner);
      if (!r.allow) { drop(pop, `WAN Firewall「${r.name}」でブロックされました`, inner); catoEvent('セキュリティ', side.site ? side.site.name : src.email, `WAN Firewall ブロック: ${inner.src} → ${inner.dst}（${r.name}）`); return; }
    }
    return popDeliver(pop, dSite ? { site: dSite } : { email: dCli }, inner);
  }
  if (!isReturn(inner)) {
    const r = fwEval('inet', side, null, inner);
    if (!r.allow) { drop(pop, `Internet Firewall「${r.name}」でブロックされました`, inner); catoEvent('セキュリティ', side.site ? side.site.name : src.email, `Internet Firewall ブロック: ${inner.src} → ${inner.dst}（${r.name}）`); return; }
  }
  const proto = inner.proto, port = proto === 'icmp' ? inner.icmp.id : inner.sport;
  const fromKey = src.serial ? 's:' + sd.site.id : 'u:' + src.email;
  let e = CR.inet.find(x => x.proto === proto && x.src === inner.src && x.port === port && x.from === fromKey);
  if (!e) { e = { proto, src: inner.src, port, gport: CR.nextPort++, from: fromKey }; CR.inet.push(e); if (CR.inet.length > 500) CR.inet.shift(); }
  const out = clone(inner);
  out.src = pop.cfg.ip;
  if (proto === 'icmp') out.icmp.id = e.gport; else out.sport = e.gport;
  out.ttl = Math.max(1, (out.ttl || 64) - 1);
  ipSend(pop, out);
}
function popReturn(pop, pkt) {
  const isErr = pkt.proto === 'icmp' && (pkt.icmp.type === 'unreach' || pkt.icmp.type === 'ttl') && pkt.orig;
  const proto = isErr ? pkt.orig.proto : pkt.proto;
  const port = isErr ? (proto === 'icmp' ? pkt.orig.id : pkt.orig.sport) : (proto === 'icmp' ? pkt.icmp.id : pkt.dport);
  if (!isErr && proto === 'icmp' && pkt.icmp.type === 'echo') return false;
  const e = CR.inet.find(x => x.proto === proto && x.gport === port);
  if (!e) return false;
  const inner = clone(pkt);
  inner.dst = e.src;
  if (isErr) { inner.orig.src = e.src; if (proto === 'icmp') inner.orig.id = e.port; else inner.orig.sport = e.port; }
  else if (proto === 'icmp') inner.icmp.id = e.port; else inner.dport = e.port;
  const target = e.from.startsWith('s:') ? { site: NL.lab.cato.sites.find(s => s.id === e.from.slice(2)) } : { email: e.from.slice(2) };
  popDeliver(pop, target, inner);
  return true;
}
function popDeliver(pop, target, inner) {
  if (target.email) {
    const c = CR.clients[target.email];
    if (!c) return drop(pop, `SDP ユーザー ${target.email} は接続していません`, inner);
    return ipSend(pop, { dst: c.ip, proto: 'udp', sport: 443, dport: c.port, cato: { kind: 'sdp-data', inner } });
  }
  const site = target.site; if (!site) return drop(pop, '宛先サイトが見つかりません', inner);
  const sock = devBySerial(C.activeSerial(site));
  if (!sock) return drop(pop, `サイト ${site.name} に Socket が割り当てられていません`, inner);
  const w = C.activeWan(sock);
  const ep = w && CR.eps[sock.serial + '|' + w];
  if (!ep) return drop(pop, `サイト ${site.name} のトンネルが確立していません`, inner);
  ipSend(pop, { dst: ep.ip, proto: 'udp', sport: 443, dport: ep.port, cato: { kind: 'data', inner } });
}
C.haStatus = site => {
  if (!site.secondarySerial) return { ready: false, reason: 'セカンダリ Socket が未設定' };
  if (!site.ha || !isIP(site.ha.primaryIp) || !isIP(site.ha.secondaryIp)) return { ready: false, reason: 'HA 用の LAN IP が未設定' };
  const P = devBySerial(site.primarySerial), S = devBySerial(site.secondarySerial);
  if (!P || !S) return { ready: false, reason: 'Socket がラボ内に見つかりません' };
  if (!P.power || !S.power) return { ready: false, reason: (P.power ? S.name : P.name) + ' の電源が OFF' };
  const up = d => ['WAN1', 'WAN2'].some(w => C.tunUp(d, w));
  if (!up(P) || !up(S)) return { ready: false, reason: (up(P) ? S.name : P.name) + ' のトンネルが未接続' };
  const pl = NL.l3ifs(P).find(i => i.name === 'LAN1' && !i.vip);
  if (!pl || !pl.up) return { ready: false, reason: P.name + ' の LAN1 がダウン' };
  if (!l2reach(P, pl).some(r => r.dev === S)) return { ready: false, reason: 'LAN 側で 2 台の Socket が同じセグメントにいません' };
  return { ready: true, reason: 'Ready' };
};
function haEval() {
  for (const s of NL.lab.cato.sites) {
    const cur = C.activeSerial(s);
    if (!s.secondarySerial || !s.ha) continue;
    const healthy = d => d && d.power && ['WAN1', 'WAN2'].some(w => C.tunUp(d, w));
    const cd = devBySerial(cur);
    CR.bad = CR.bad || {};
    if (healthy(cd)) { CR.bad[s.id] = 0; continue; }
    // wait two keepalive rounds before declaring the active Socket dead
    CR.bad[s.id] = (CR.bad[s.id] || 0) + 1;
    if (CR.bad[s.id] < 3) continue;
    const other = devBySerial(cur === s.primarySerial ? s.secondarySerial : s.primarySerial);
    if (!healthy(other)) continue;
    CR.bad[s.id] = 0;
    CR.active[s.id] = other.serial;
    catoEvent('HA', s.name, `フェイルオーバー: ${other.name} がアクティブになりました`);
    NL.touch('ha');
    const vip = NL.l3ifs(other).find(i => i.vip);
    if (vip) { sendL2(other, vip, { src: vip.mac, dst: BCAST, type: 'arp', arp: { op: 'req', sip: vip.ip, smac: vip.mac, tip: vip.ip, tmac: '0000.0000.0000' } }); SIM.run(); }
  }
}
C.inventory = () => NL.lab.devices.filter(d => kindOf(d) === 'socket').map(d => {
  const eps = ['WAN1', 'WAN2'].map(w => CR.eps[d.serial + '|' + w]).filter(Boolean);
  const s = C.siteOf(d);
  return { dev: d, serial: d.serial, seen: eps.length > 0, publicIp: eps.map(e => e.ip).join(', '), site: s && s.site, role: s && s.role, connected: ['WAN1', 'WAN2'].some(w => C.tunUp(d, w)) };
});
C.clients = () => CR.clients;

// ---------- periodic tick (keepalives, DHCP retries, HA)
NL.tick = (opt = {}) => {
  if (!NL.lab) return;
  TICK++;
  const rec0 = SIM.recording; SIM.recording = opt.record ? rec0 : false;
  try {
    for (const d of NL.lab.devices) {
      if (!d.power) continue;
      const k = kindOf(d), rt = NL.rt(d);
      if (k === 'socket') {
        for (const w of ['WAN1', 'WAN2']) {
          if (!NL.portLinkUp(d, w)) { if (rt.tun[w]) setTun(d, w, 'down'); continue; }
          if (d.cfg.wan[w].mode === 'dhcp' && !rt.wanLease[w] && TICK % 3 === 1) NL.dhcpRequest(d, w);
          if (!socketWan(d, w).ip) { if (rt.tun[w]) setTun(d, w, 'down'); continue; }
          catoSend(d, w, { kind: 'ka', serial: d.serial, wan: w });
          SIM.run();
          const t = rt.tun[w];
          if (t && t.state === 'up' && TICK - t.ack > 2) setTun(d, w, 'down');
          else if (t && !t.state) t.state = 'connecting';
        }
      }
      if ((k === 'pc' || k === 'server')) {
        if (d.cfg.dhcp && (!rt.lease || rt.lease.apipa) && TICK % 4 === 0 && NL.portLinkUp(d, 'FastEthernet0')) NL.dhcpRequest(d, 'FastEthernet0');
        if (d.cfg.catoEmail && (!rt.cato || rt.cato.state === 'error') && TICK % 3 === 0 && C.popDev()) C.clientConnect(d, d.cfg.catoEmail);
        if (rt.cato && rt.cato.state === 'connected') {
          const pop = C.popDev();
          if (pop) { ipSend(d, { dst: pop.cfg.ip, proto: 'udp', sport: 45000, dport: 443, cato: { kind: 'sdp-ka', email: rt.cato.email } }, { phys: true }); SIM.run(); }
          if (TICK - rt.cato.ack > 3) { rt.cato.state = 'error'; rt.cato.err = 'Cato Cloud との接続が切れました'; delete CR.clients[rt.cato.email]; NL.touch('sdp'); }
        }
      }
    }
    haEval();
  } finally { SIM.recording = rec0; }
  NL.emit('tick', TICK);
};
NL.tickNo = () => TICK;

// ---------- describing frames for the simulation panel
NL.frameInfo = f => {
  if (!f) return { type: '—', text: '' };
  if (f.type === 'arp') return { type: 'ARP', text: f.arp.op === 'req' ? `ARP 要求: ${f.arp.tip} の MAC は？（送信元 ${f.arp.sip}）` : `ARP 応答: ${f.arp.sip} は ${f.arp.smac}` };
  const p = f.ip || f; if (!p) return { type: '—', text: '' };
  if (p.cato) {
    const c = p.cato, inner = c.inner ? '（中身: ' + NL.frameInfo({ type: 'ip', ip: c.inner }).text + '）' : '';
    const label = { ka: 'トンネル キープアライブ', 'ka-ack': 'キープアライブ応答', data: 'トンネル内データ', 'sdp-ka': 'Cato Client 接続要求', 'sdp-ack': 'Cato Client 接続許可', 'sdp-nak': 'Cato Client 接続拒否', 'sdp-data': 'Cato Client データ' }[c.kind] || c.kind;
    return { type: 'Cato', text: `${label} ${p.src}:${p.sport} → ${p.dst}:${p.dport}${inner}` };
  }
  if (p.dhcp) return { type: 'DHCP', text: `DHCP ${p.dhcp.op === 'discover' ? 'Discover' : 'Ack'}${p.dhcp.yiaddr ? '（割当 ' + p.dhcp.yiaddr + '）' : ''}` };
  if (p.proto === 'icmp') {
    const t = { echo: 'Echo Request', 'echo-reply': 'Echo Reply', unreach: 'Destination Unreachable', ttl: 'Time Exceeded' }[p.icmp.type] || p.icmp.type;
    return { type: 'ICMP', text: `ICMP ${t} ${p.src} → ${p.dst} TTL=${p.ttl}` };
  }
  if (p.proto === 'tcp') {
    const port = Math.min(p.sport, p.dport);
    const ty = port === 80 ? 'HTTP' : port === 23 ? 'Telnet' : port === 22 ? 'SSH' : 'TCP';
    return { type: ty, text: `${ty} ${p.tcp ? p.tcp.flags : ''} ${p.src}:${p.sport} → ${p.dst}:${p.dport}` };
  }
  return { type: 'UDP', text: `UDP ${p.src}:${p.sport} → ${p.dst}:${p.dport}` };
};

NL.loadLab(NL.newLab());
})(typeof window !== 'undefined' ? window : globalThis);
