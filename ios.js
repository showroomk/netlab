/* NetLab IOS: command grammar, ?-help, tab completion, modes, config handlers and show output. */
(function (G) {
'use strict';
const NL = G.NL, U = NL.util;
const { isIP, validMask, maskLen, netOf, sameNet, ip2n, n2ip, clone, shortIf } = U;

// ---------- grammar compiler
const lex = spec => spec.match(/<[^>]*>|[\[\]{}|]|[^\s\[\]{}|<>]+/g) || [];
function parseSpec(toks) {
  let i = 0;
  const seq = stop => {
    const items = [];
    while (i < toks.length && !stop.includes(toks[i])) {
      const t = toks[i++];
      if (t === '[') { items.push({ opt: seq([']']) }); i++; }
      else if (t === '{') { const alts = [seq(['|', '}'])]; while (toks[i] === '|') { i++; alts.push(seq(['|', '}'])); } i++; items.push({ alt: alts }); }
      else if (t[0] === '<') {
        const body = t.slice(1, -1), c = body.indexOf(':');
        const ty = c < 0 ? body : body.slice(0, c);
        const m = /^N(\d+)-(\d+)$/.exec(ty);
        items.push({ arg: m ? { t: 'N', lo: +m[1], hi: +m[2] } : { t: ty }, help: c < 0 ? '' : body.slice(c + 1) });
      } else items.push({ lit: t.toLowerCase(), disp: t });
    }
    return items;
  };
  return seq([]);
}
function expand(items) {
  let out = [[]];
  for (const it of items) {
    if (it.opt) { const sub = expand(it.opt); out = out.flatMap(p => [p, ...sub.map(s => p.concat(s))]); }
    else if (it.alt) { const subs = it.alt.flatMap(expand); out = out.flatMap(p => subs.map(s => p.concat(s))); }
    else out = out.map(p => p.concat([it]));
  }
  return out;
}
const newNode = () => ({ lits: {}, args: [], end: null });
function insert(root, path, spec) {
  let n = root;
  for (const tk of path) {
    if (tk.lit) n = n.lits[tk.lit] || (n.lits[tk.lit] = Object.assign(newNode(), { disp: tk.disp }));
    else {
      const key = JSON.stringify(tk.arg) + '|' + tk.help;
      let a = n.args.find(x => x.key === key);
      if (!a) { a = { key, arg: tk.arg, help: tk.help, node: newNode() }; n.args.push(a); }
      n = a.node;
    }
  }
  if (!n.end) n.end = spec;
}
const tokenize = line => { const out = [], re = /\S+/g; let m; while ((m = re.exec(line))) out.push({ v: m[0], p: m.index }); return out; };

const IFT = [['gigabitethernet', 'GigabitEthernet'], ['fastethernet', 'FastEthernet'], ['ethernet', 'Ethernet'], ['vlan', 'Vlan'], ['loopback', 'Loopback'], ['port-channel', 'Port-channel'], ['serial', 'Serial']];
function ifType(p) {
  p = p.toLowerCase();
  const exact = IFT.find(([k]) => k === p); if (exact) return exact[1];
  const c = IFT.filter(([k]) => k.startsWith(p));
  return c.length === 1 ? c[0][1] : null;
}
function parseIfTok(toks, i) {
  const m = /^([a-zA-Z-]+)([\d\/\.]*)$/.exec(toks[i].v); if (!m) return null;
  const ty = ifType(m[1]); if (!ty) return null;
  let num = m[2], n = 1;
  if (!num && toks[i + 1] && /^[\d\/\.]+$/.test(toks[i + 1].v)) { num = toks[i + 1].v; n = 2; }
  if (!num || !/^\d+(\/\d+)*(\.\d+)?$/.test(num)) return null;
  return { val: ty + num, n };
}
const normIf = s => { const t = tokenize(s); const r = t.length ? parseIfTok(t, 0) : null; return r ? r.val : null; };
function parseVl(t) {
  const out = [];
  for (const part of t.split(',')) {
    if (!part) continue;
    const [a, b] = part.split('-').map(Number);
    if (isNaN(a)) return null;
    for (let v = a; v <= (isNaN(b) ? a : b) && v - a < 4095; v++) out.push(v);
  }
  return out;
}
const vlStr = arr => {
  const s = [...new Set(arr)].sort((a, b) => a - b), out = [];
  for (let i = 0; i < s.length; i++) { let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++; out.push(j > i ? s[i] + '-' + s[j] : String(s[i])); i = j; }
  return out.join(',');
};
function matchArg(a, toks, i, line) {
  const t = toks[i].v;
  switch (a.t) {
    case 'IP': return isIP(t) ? { val: t, n: 1 } : null;
    case 'N': return /^\d+$/.test(t) && +t >= a.lo && +t <= a.hi ? { val: +t, n: 1 } : null;
    case 'WORD': return { val: t, n: 1 };
    case 'LINE': return { val: line.slice(toks[i].p).trim(), n: toks.length - i };
    case 'VL': { const v = /^[\d,\-]+$/.test(t) ? parseVl(t) : null; return v && v.length ? { val: v, n: 1 } : null; }
    case 'IF': return parseIfTok(toks, i);
  }
  return null;
}
function walk(root, toks, line) {
  let node = root; const vals = [], words = [];
  for (let i = 0; i < toks.length;) {
    const tl = toks[i].v.toLowerCase();
    let cand = Object.keys(node.lits).filter(w => w.startsWith(tl));
    if (cand.includes(tl)) cand = [tl];
    if (cand.length === 1) { words.push(cand[0]); node = node.lits[cand[0]]; i++; continue; }
    let hit = null;
    for (const a of node.args) { const r = matchArg(a.arg, toks, i, line); if (r) { hit = { a, r }; break; } }
    if (hit) { vals.push(hit.r.val); words.push(String(hit.r.val)); node = hit.a.node; i += hit.r.n; continue; }
    return { err: cand.length > 1 ? 'amb' : 'inv', at: i, node };
  }
  if (!node.end) return { err: 'inc', node };
  return { spec: node.end, vals, words, node };
}
const argName = a => ({ IP: 'A.B.C.D', N: `<${a.lo}-${a.hi}>`, WORD: 'WORD', LINE: 'LINE', VL: 'WORD', IF: 'WORD' }[a.t] || a.t);

// ---------- help text for keywords
const H = {
  enable: 'Turn on privileged commands', disable: 'Turn off privileged commands', exit: 'Exit from the EXEC', logout: 'Exit from the EXEC',
  ping: 'Send echo messages', traceroute: 'Trace route to destination', telnet: 'Open a telnet connection', ssh: 'Open a secure shell client connection',
  show: 'Show running system information', configure: 'Enter configuration mode', terminal: 'Configure from the terminal', copy: 'Copy from one file to another',
  write: 'Write running configuration to memory, network, or terminal', erase: 'Erase a filesystem', reload: 'Halt and perform a cold restart',
  clock: 'Manage the system clock', clear: 'Reset functions', debug: 'Debugging functions (see also \'undebug\')', undebug: 'Disable debugging functions (see also \'debug\')',
  delete: 'Delete a file', dir: 'List files on a filesystem', 'running-config': 'Current operating configuration', 'startup-config': 'Contents of startup configuration',
  version: 'System hardware and software status', ip: 'IP information', interface: 'Select an interface to configure', interfaces: 'Interface status and configuration',
  brief: 'Brief summary of IP status and configuration', route: 'IP routing table', arp: 'IP ARP table', nat: 'IP NAT information', translations: 'Translation entries',
  statistics: 'Translation statistics', 'access-lists': 'List access lists', 'access-list': 'Add an access list entry', vlan: 'VTP VLAN status',
  'mac': 'MAC configuration', 'address-table': 'MAC forwarding table', cdp: 'CDP information', neighbors: 'CDP neighbor entries', 'spanning-tree': 'Spanning tree topology',
  ospf: 'OSPF information', neighbor: 'Neighbor list', protocols: 'IP routing protocol process parameters and statistics', dhcp: 'Show items in the DHCP database',
  binding: 'DHCP address bindings', pool: 'DHCP pools information', history: 'Display the session command history', users: 'Display information about terminal lines',
  'flash:': 'display information about flash: file system', trunk: 'Show interface trunk information', status: 'Show interface line status', vtp: 'VTP information',
  hostname: 'Set system\'s network name', 'default-gateway': 'Specify default gateway (if not routing IP)', routing: 'Enable IP routing', 'domain-name': 'Define the default domain name',
  'domain-lookup': 'Enable IP Domain Name System hostname translation', 'name-server': 'Specify address of name server to use', 'excluded-address': 'Prevent DHCP Server from assigning certain addresses',
  inside: 'Inside address translation', outside: 'Outside address translation', source: 'Source address translation', list: 'Specify access list describing local addresses',
  overload: 'Overload an address translation', static: 'Specify static local->global mapping', permit: 'Specify packets to forward', deny: 'Specify packets to reject',
  remark: 'Access list entry comment', standard: 'Standard Access List', extended: 'Extended Access List', router: 'Enable a routing process', secret: 'Assign the privileged level secret',
  password: 'Assign the terminal connection password', service: 'Modify use of network based services', 'password-encryption': 'Encrypt system passwords', banner: 'Define a login banner',
  motd: 'Set Message of the Day banner', line: 'Configure a terminal line', console: 'Primary terminal line', vty: 'Virtual terminal', username: 'Establish User Name Authentication',
  privilege: 'Set user privilege level', crypto: 'Encryption module', key: 'Long term key operations', generate: 'Generate new keys', rsa: 'Generate RSA keys',
  'general-keys': 'Generate a general purpose RSA key pair for signing and encryption', modulus: 'Provide number of modulus bits on the command line', version2: '',
  end: 'Exit from configure mode', do: 'To run exec commands in config mode', no: 'Negate a command or set its defaults', address: 'Set the IP address of an interface',
  secondary: 'Make this IP address a secondary address', shutdown: 'Shutdown the selected interface', description: 'Interface specific description',
  'access-group': 'Specify access control for packets', in: 'inbound packets', out: 'outbound packets', 'helper-address': 'Specify a destination address for UDP broadcasts',
  switchport: 'Set switching mode characteristics', mode: 'Set trunking mode of the interface', access: 'Set access mode characteristics of the interface',
  dynamic: 'Set trunking mode to dynamically negotiate access or trunk mode', auto: 'Set trunking mode dynamic negotiation parameter to AUTO', desirable: 'Set trunking mode dynamic negotiation parameter to DESIRABLE',
  allowed: 'Set allowed VLAN characteristics when interface is in trunking mode', native: 'Set trunking native characteristics when interface is in trunking mode',
  encapsulation: 'Set encapsulation type for an interface', dot1q: 'IEEE 802.1Q Virtual LAN', nonegotiate: 'Device will not engage in negotiation protocol on this interface',
  speed: 'Configure speed operation.', duplex: 'Configure duplex operation.', bandwidth: 'Set bandwidth informational parameter', portfast: 'Enable an interface to move directly to forwarding on link up',
  network: 'Enable routing on an IP network', area: 'Set the OSPF area ID', 'router-id': 'router-id for this OSPF process', 'passive-interface': 'Suppress routing updates on an interface',
  'default-information': 'Control distribution of default information', originate: 'Distribute a default route', login: 'Enable password checking', local: 'Local password checking',
  transport: 'Define transport protocols for line', input: 'Define which protocols to use when connecting to the terminal server', 'exec-timeout': 'Set the EXEC timeout',
  'logging': 'Modify message logging facilities', synchronous: 'Synchronized message output', name: 'Ascii name of the VLAN', 'default-router': 'Default routers', 'dns-server': 'DNS servers',
  lease: 'Address lease time', priority: 'Set the bridge priority for the spanning tree', cost: 'Interface cost', default: 'Suppress routing updates on all interfaces',
  translation: 'Clear dynamic translation', 'arp-cache': 'Clear the entire ARP cache', 'dynamic': 'dynamic entry type', counters: 'Clear counters on one or all interfaces',
  length: 'Set number of lines on a screen', monitor: 'Copy debug output to the current terminal line', memory: 'Write to NV memory', set: 'Set the time and date',
  run: 'Run run', 'ssh_': '', rapid: '', pvst: 'Per-Vlan spanning tree mode', 'rapid-pvst': 'Per-Vlan rapid spanning tree mode', all: 'all VLANs', none: 'no VLANs', add: 'add VLANs to the current list',
  remove: 'remove VLANs from the current list', except: 'all VLANs except the following', range: 'interface range command', repeat: 'specify repeat count', size: 'specify datagram size',
  detail: 'Show detailed information', dhcp_: '', 'ntp': 'Configure NTP', server: 'Configure NTP server', 'lldp': 'Global LLDP configuration subcommands', vtp_: '',
  'cdp_': '', 'ospf_': '', '-l': 'Log in using this user name', 'flash': '', timezone: 'Configure time zone', timestamps: 'Timestamp debug/log messages',
  zeroize: 'Remove keys', connected: 'Connected', 'netmask': 'Specify the network mask', 'authentication-retries': 'Specify number of authentication retries', 'time-out': 'Specify connection time-out',
  'c:ip': 'Global IP configuration subcommands', 'c:dhcp': 'Configure DHCP server and relay parameters', 'c:nat': 'NAT configuration commands', 'c:route': 'Establish static routes',
  'c:ssh': 'Configure ssh options', 'c:domain': 'IP DNS Resolver', 'c:access-list': 'Named access-list', 'c:interface': 'Select an interface to configure', 'c:vlan': 'Vlan commands',
  'c:spanning-tree': 'Spanning Tree Subsystem', 'c:cdp': 'Global CDP configuration subcommands', 'c:enable': 'Modify enable password parameters', 'c:exit': 'Exit from configure mode',
  'c:pool': 'Configure DHCP address pools', 'c:mode': 'Spanning tree operating mode', 'c:vtp': 'Configure global VTP state', 'c:clock': 'Configure time-of-day clock', 'c:logging': 'Modify message logging facilities',
  'i:ip': 'Interface Internet Protocol config commands', 'i:nat': 'NAT interface commands', 'i:ospf': 'OSPF interface commands', 'i:exit': 'Exit from interface configuration mode',
  'i:trunk': 'Set trunking characteristics of the interface', 'i:vlan': 'Set VLAN when interface is in access mode', 'i:spanning-tree': 'Spanning Tree Subsystem', 'i:cdp': 'CDP interface subcommands',
  'r:exit': 'Exit from routing protocol configuration mode', 'l:exit': 'Exit from line configuration mode', 'v:exit': 'Apply changes, bump revision number, and exit mode',
  'd:exit': 'Exit from DHCP pool configuration mode', 's:exit': 'Exit from access-list configuration mode', 'e:exit': 'Exit from access-list configuration mode',
  'p:ip': 'IP information', 'u:ip': 'IP information'
};

// ---------- passwords as IOS shows them
const XLAT = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87';
const type7 = pw => { const seed = pw.length % 10; let o = String(seed).padStart(2, '0'); for (let i = 0; i < pw.length; i++) o += ((pw.charCodeAt(i) ^ XLAT.charCodeAt((seed + i) % XLAT.length)) & 255).toString(16).toUpperCase().padStart(2, '0'); return o; };
const md5ish = pw => {
  let h1 = 0x811c9dc5, h2 = 0x1234567;
  for (let i = 0; i < pw.length; i++) { h1 = Math.imul(h1 ^ pw.charCodeAt(i), 16777619) >>> 0; h2 = Math.imul(h2 + pw.charCodeAt(i), 2654435761) >>> 0; }
  const A = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let s = '', x = h1, y = h2;
  for (let i = 0; i < 22; i++) { s += A[(x ^ y) & 63]; x = (x >>> 6) | ((y & 63) << 26); y = (y >>> 6) | (i * 7919 << 20); }
  return '$1$mERr$' + s;
};

// ---------- command table
const SPECS = [];
const cmd = (modes, kinds, spec, f, o = {}) => SPECS.push({ modes, kinds, spec, f, no: !!o.no, onlyNo: !!o.onlyNo, cfg: o.cfg !== false });
const kindChar = d => ({ router: 'r', switch: 's', l3switch: 'l' }[NL.kind(d)]);
const TRIES = {};
function trie(mode, kc, neg) {
  const key = mode + kc + (neg ? 'n' : '');
  if (TRIES[key]) return TRIES[key];
  const root = newNode();
  for (const s of SPECS) {
    if (!s.modes.includes(mode) || !s.kinds.includes(kc)) continue;
    if (neg ? !s.no : s.onlyNo) continue;
    for (const p of expand(parseSpec(lex(s.spec)))) insert(root, p, s);
  }
  return (TRIES[key] = root);
}

// ---------- helpers for handlers
const PROMPTS = { u: '>', p: '#', c: '(config)#', r: '(config-router)#', l: '(config-line)#', v: '(config-vlan)#', d: '(dhcp-config)#', s: '(config-std-nacl)#', e: '(config-ext-nacl)#' };
const INV = 'INV';
function ifExists(dev, name) {
  if (dev.cfg.interfaces[name]) return true;
  return false;
}
function createIf(x, name) {
  const d = x.d, c = d.cfg, k = NL.kind(d);
  if (c.interfaces[name]) return true;
  const ports = NL.MODELS[d.model].ports;
  let m;
  if ((m = /^(.+)\.(\d+)$/.exec(name)) && ports.includes(m[1]) && k === 'router') { c.interfaces[name] = { shutdown: false }; return true; }
  if ((m = /^Loopback(\d+)$/.exec(name)) && +m[1] <= 2147483647) {
    c.interfaces[name] = { shutdown: false };
    x.out(`\n%LINK-5-CHANGED: Interface ${name}, changed state to up\n\n%LINEPROTO-5-UPDOWN: Line protocol on Interface ${name}, changed state to up`);
    return true;
  }
  if ((m = /^Vlan(\d+)$/.exec(name)) && k !== 'router' && +m[1] >= 1 && +m[1] <= 4094) { c.interfaces[name] = { shutdown: false }; return true; }
  return false;
}
function ifOrder(dev) {
  const ports = NL.MODELS[dev.model].ports, names = Object.keys(dev.cfg.interfaces);
  const rank = n => {
    if (n.startsWith('Loopback')) return [0, +n.slice(8), 0];
    if (n.startsWith('Vlan')) return [3, +n.slice(4), 0];
    const base = n.split('.')[0], sub = n.includes('.') ? +n.split('.')[1] : -1;
    return [1, ports.indexOf(base), sub];
  };
  return names.sort((a, b) => { const A = rank(a), B = rank(b); for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] - B[i]; return 0; });
}
function parseRange(dev, str) {
  const out = [];
  for (const part of str.split(',')) {
    const p = part.trim().replace(/\s*-\s*/g, '-');
    const m = /^([a-zA-Z-]+)\s*([\d\/]*?)(\d+)(?:-(\d+))?$/.exec(p);
    if (!m) return null;
    const ty = ifType(m[1]); if (!ty) return null;
    const a = +m[3], b = m[4] ? +m[4] : a;
    if (b < a) return null;
    for (let i = a; i <= b; i++) {
      const n = ty + m[2] + i;
      if (!dev.cfg.interfaces[n] && !(ty === 'Vlan')) return null;
      out.push(n);
    }
  }
  return out;
}
const curIfs = x => x.s.ifs.map(n => [n, x.c.interfaces[n]]).filter(e => e[1]);
const isPhys = (d, n) => NL.MODELS[d.model].ports.includes(n);
function overlapCheck(x, name, ip, mask) {
  for (const li of Object.entries(x.c.interfaces)) {
    const [n, i] = li;
    if (n === name || !i.ip) continue;
    const m = maskLen(i.mask) < maskLen(mask) ? i.mask : mask;
    if (sameNet(ip, i.ip, m)) return `% ${netOf(ip, mask)} overlaps with ${n}`;
  }
  return null;
}
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const uptime = d => { const ms = Date.now() - (NL.rt(d).bootAt || (NL.rt(d).bootAt = Date.now())); const m = Math.floor(ms / 60000); return `${Math.floor(m / 60)} hours, ${m % 60} minutes`; };

// =====================================================================
// EXEC commands
// =====================================================================
cmd('up', 'rsl', 'enable', x => x.s.doEnable(), { cfg: false });
cmd('p', 'rsl', 'disable', x => { x.s.mode = 'u'; }, { cfg: false });
cmd('up', 'rsl', '{exit|logout}', x => x.s.logout(), { cfg: false });
cmd('up', 'rsl', 'ping <IP:Ping destination address or hostname> [repeat <N1-2147483647:specify repeat count>] [size <N36-18024:specify datagram size>] [source <WORD:specify source address or name>]', x => x.s.doPing(x), { cfg: false });
cmd('up', 'rsl', 'traceroute <IP:Trace route to destination address or hostname>', x => x.s.doTrace(x.v[0]), { cfg: false });
cmd('up', 'rsl', 'telnet <IP:IP address or hostname of a remote system>', x => x.s.remote('telnet', x.v[0]), { cfg: false });
cmd('up', 'rsl', 'ssh -l <WORD:Log in using this user name> <IP:IP address or hostname of a remote system>', x => x.s.remote('ssh', x.v[1], x.v[0]), { cfg: false });
cmd('up', 'rsl', 'ssh -v <N1-2:Specify SSH Protocol Version> -l <WORD:Log in using this user name> <IP:IP address or hostname of a remote system>', x => x.s.remote('ssh', x.v[2], x.v[1]), { cfg: false });
cmd('p', 'rsl', 'configure [terminal]', x => {
  if (!x.w.includes('terminal')) { x.s.ask('Configuring from terminal, memory, or network [terminal]? ', a => { if (a && !'terminal'.startsWith(a.toLowerCase())) { x.out('?Must be "terminal", "memory" or "network"'); return; } x.out('Enter configuration commands, one per line.  End with CNTL/Z.'); x.s.mode = 'c'; }); return; }
  x.out('Enter configuration commands, one per line.  End with CNTL/Z.'); x.s.mode = 'c';
}, { cfg: false });
const saveStartup = x => { x.d.startup = clone(x.c); x.out('Building configuration...\n[OK]'); NL.emit('saved', x.d); };
cmd('p', 'rsl', 'copy running-config startup-config', x => x.s.ask('Destination filename [startup-config]? ', () => saveStartup(x)), { cfg: false });
cmd('p', 'rsl', 'copy startup-config running-config', x => {
  if (!x.d.startup) { x.out('%Error opening nvram:/startup-config (File not found)'); return; }
  x.s.ask('Destination filename [running-config]? ', () => { x.d.cfg = clone(x.d.startup); NL.touch('cfg'); x.out(`${JSON.stringify(x.d.startup).length} bytes copied in 0.416 secs (2504 bytes/sec)`); });
}, { cfg: false });
cmd('p', 'rsl', 'write [memory]', x => saveStartup(x), { cfg: false });
const eraseNv = x => x.s.ask('Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]', a => {
  if (a && !/^y/i.test(a)) return;
  x.d.startup = null; x.out('[OK]\nErase of nvram: complete\n%SYS-7-NV_BLOCK_INIT: Initialized the geometry of nvram');
});
cmd('p', 'rsl', 'write erase', eraseNv, { cfg: false });
cmd('p', 'rsl', 'erase startup-config', eraseNv, { cfg: false });
cmd('p', 'rsl', 'reload', x => {
  const go = () => x.s.ask('Proceed with reload? [confirm]', a => { if (a && !/^y/i.test(a)) return; x.s.doReload(); });
  if (JSON.stringify(x.c) !== JSON.stringify(x.d.startup)) {
    x.s.ask('System configuration has been modified. Save? [yes/no]:', a => {
      if (/^y/i.test(a)) { saveStartup(x); }
      else if (!/^n/i.test(a)) { x.out('% Please answer \'yes\' or \'no\'.'); return; }
      go();
    });
  } else go();
}, { cfg: false });
cmd('p', 'rsl', 'clock set <LINE:Current Time (hh:mm:ss) and date>', x => { NL.rt(x.d).clock = x.v[0]; }, { cfg: false });
cmd('p', 'rl', 'clear ip nat translation *', x => { NL.rt(x.d).nat = []; }, { cfg: false });
cmd('p', 'rsl', 'clear arp-cache', x => { NL.rt(x.d).arp = {}; }, { cfg: false });
cmd('p', 'sl', 'clear mac address-table dynamic', x => { NL.rt(x.d).mac = {}; }, { cfg: false });
cmd('p', 'rsl', 'clear counters', x => x.s.ask('Clear "show interface" counters on all interfaces [confirm]', () => {}), { cfg: false });
cmd('p', 'rsl', 'clear access-list counters', x => { NL.rt(x.d).aclHits = {}; }, { cfg: false });
cmd('p', 'rl', 'clear ip ospf process', x => x.s.ask('Reset ALL OSPF processes? [no]: ', a => { if (/^y/i.test(a)) NL.touch('cfg'); }), { cfg: false });
cmd('up', 'rsl', 'terminal length <N0-512:Number of lines on screen (0 for no pausing)>', () => {}, { cfg: false });
cmd('up', 'rsl', 'terminal monitor', () => {}, { cfg: false });
cmd('p', 'rsl', 'debug <LINE:debug target>', x => x.out('% このシミュレーターでは debug は使えません。パケットの流れはシミュレーションモードで確認できます。'), { cfg: false });
cmd('p', 'rsl', 'undebug all', x => x.out('All possible debugging has been turned off'), { cfg: false });
cmd('p', 'rsl', 'delete <WORD:Name of file to delete>', x => {
  const f = String(x.v[0]).replace(/^flash:\/?/, '');
  if (f !== 'vlan.dat' || NL.kind(x.d) === 'router') { x.out(`%Error deleting flash:/${f} (No such file or directory)`); return; }
  x.s.ask('Delete filename [vlan.dat]?', () => x.s.ask('Delete flash:/vlan.dat? [confirm]', () => { NL.rt(x.d).vlanDatDeleted = true; }));
}, { cfg: false });
cmd('up', 'rsl', 'dir [flash:]', x => x.out(flashList(x.d)), { cfg: false });

// ---------- show
cmd('p', 'rsl', 'show running-config', x => x.out('Building configuration...\n\nCurrent configuration : ' + runConf(x.d, x.c).length + ' bytes\n' + runConf(x.d, x.c)), { cfg: false });
cmd('p', 'rsl', 'show running-config interface <IF:Show interface configuration>', x => {
  const n = x.v[0]; if (!x.c.interfaces[n]) { x.out('                                         ^\n% Invalid input detected at \'^\' marker.'); return; }
  const blk = ifBlock(x.d, x.c, n);
  x.out('Building configuration...\n\nCurrent configuration : ' + blk.join('\n').length + ' bytes\n!\n' + blk.join('\n') + '\nend');
}, { cfg: false });
cmd('p', 'rsl', 'show startup-config', x => x.out(x.d.startup ? 'Using ' + runConf(x.d, x.d.startup).length + ' bytes\n' + runConf(x.d, x.d.startup) : 'startup-config is not present'), { cfg: false });
cmd('up', 'rsl', 'show version', x => x.out(showVersion(x.d)), { cfg: false });
cmd('up', 'rsl', 'show ip interface brief', x => x.out(showIpIntBrief(x.d)), { cfg: false });
cmd('up', 'rsl', 'show ip interface [<IF:Interface name>]', x => x.out(showIpInt(x.d, x.v[0])), { cfg: false });
cmd('up', 'rsl', 'show interfaces [<IF:Interface name>]', x => x.out(showInterfaces(x.d, x.v[0])), { cfg: false });
cmd('up', 'sl', 'show interfaces status', x => x.out(showIntStatus(x.d)), { cfg: false });
cmd('up', 'sl', 'show interfaces trunk', x => x.out(showTrunk(x.d)), { cfg: false });
cmd('up', 'rsl', 'show ip route [{static|connected|ospf}]', x => x.out(showIpRoute(x.d, x.w[3])), { cfg: false });
cmd('up', 'rsl', '{show arp|show ip arp}', x => x.out(showArp(x.d)), { cfg: false });
cmd('up', 'rl', 'show ip nat translations [verbose]', x => x.out(showNat(x.d)), { cfg: false });
cmd('up', 'rl', 'show ip nat statistics', x => x.out(showNatStats(x.d)), { cfg: false });
cmd('up', 'rsl', 'show access-lists [<WORD:ACL number or name>]', x => x.out(showAcl(x.d, x.v[0])), { cfg: false });
cmd('up', 'rsl', 'show ip access-lists [<WORD:ACL number or name>]', x => x.out(showAcl(x.d, x.v[0])), { cfg: false });
cmd('up', 'sl', 'show vlan [brief]', x => x.out(showVlan(x.d, x.w.includes('brief'))), { cfg: false });
cmd('up', 'sl', 'show mac address-table [dynamic]', x => x.out(showMac(x.d)), { cfg: false });
cmd('up', 'rsl', 'show cdp neighbors [detail]', x => x.out(showCdp(x.d, x.w.includes('detail'))), { cfg: false });
cmd('up', 'sl', 'show spanning-tree [vlan <N1-4094:VLAN ID>]', x => x.out(showStp(x.d, x.v[0])), { cfg: false });
cmd('up', 'rl', 'show ip ospf neighbor', x => x.out(showOspfNbr(x.d)), { cfg: false });
cmd('up', 'rl', 'show ip ospf interface brief', x => x.out(showOspfIntBrief(x.d)), { cfg: false });
cmd('up', 'rsl', 'show ip protocols', x => x.out(showProtocols(x.d)), { cfg: false });
cmd('up', 'rl', 'show ip dhcp binding', x => x.out(showDhcpBinding(x.d)), { cfg: false });
cmd('up', 'rl', 'show ip dhcp pool', x => x.out(showDhcpPool(x.d)), { cfg: false });
cmd('up', 'rsl', 'show history', x => x.out(x.s.hist.slice(-10).map(h => '  ' + h).join('\n')), { cfg: false });
cmd('up', 'rsl', 'show clock', x => { const n = new Date(); x.out('*' + n.toTimeString().slice(0, 8) + '.' + String(n.getMilliseconds()).padStart(3, '0') + ' UTC ' + n.toDateString()); }, { cfg: false });
cmd('up', 'rsl', 'show users', x => x.out('    Line       User       Host(s)              Idle       Location\n*  0 con 0                idle                 00:00:00 '), { cfg: false });
cmd('up', 'rsl', 'show flash:', x => x.out(flashList(x.d)), { cfg: false });
cmd('up', 'rsl', 'show ip ssh', x => x.out(x.c.rsa ? `SSH Enabled - version ${x.c.sshVersion === 2 ? '2.0' : '1.99'}\nAuthentication timeout: 120 secs; Authentication retries: 3` : 'SSH Disabled - version 1.99\n%Please create RSA keys to enable SSH (and of atleast 768 bits for SSH v2).'), { cfg: false });
cmd('up', 'sl', 'show vtp status', x => x.out(`VTP Version                     : 2\nConfiguration Revision          : 0\nMaximum VLANs supported locally : 255\nNumber of existing VLANs        : ${Object.keys(x.d.vlans).length + 4}\nVTP Operating Mode              : Server\nVTP Domain Name                 : \nVTP Pruning Mode                : Disabled`), { cfg: false });

// =====================================================================
// global configuration
// =====================================================================
cmd('c', 'rsl', 'hostname <WORD:This system\'s network name>', x => {
  const h = x.v[0];
  if (!/^[A-Za-z][A-Za-z0-9-]{0,62}$/.test(h)) { x.out('% Hostname contains one or more illegal characters.'); return false; }
  x.c.hostname = h;
});
cmd('c', 'rsl', 'interface <IF:Interface name>', x => {
  const n = x.v[0];
  if (!createIf(x, n)) return INV;
  x.s.mode = 'i'; x.s.ifs = [n]; x.s.sub = n.includes('.') ? 'subif' : 'if';
});
cmd('c', 'rsl', 'interface range <LINE:Interface range e.g. fa0/1 - 24>', x => {
  const r = parseRange(x.d, x.v[0]);
  if (!r || !r.length) return INV;
  r.forEach(n => createIf(x, n));
  x.s.mode = 'i'; x.s.ifs = r; x.s.sub = 'range';
});
cmd('c', 'rsl', 'interface <IF:Interface name>', x => {
  const n = x.v[0];
  if (isPhys(x.d, n) || !x.c.interfaces[n]) { x.out('% Physical interfaces cannot be removed.'); return false; }
  if (n === 'Vlan1') return INV;
  delete x.c.interfaces[n];
}, { no: true, onlyNo: true });
cmd('c', 'rl', 'ip route <IP:Destination prefix> <IP:Destination prefix mask> {<IP:Forwarding router\'s address>|<IF:Interface> [<IP:Forwarding router\'s address>]} [<N1-255:Distance metric for this route>] [name <WORD:Specify name of the next hop>] [permanent]', x => {
  const [net, mask] = x.v;
  if (!validMask(mask)) { x.out('%Inconsistent address and mask'); return false; }
  if (netOf(net, mask) !== net) { x.out('%Inconsistent address and mask'); return false; }
  let nh = null, iface = null, ad = 1, name = null;
  const rest = x.v.slice(2);
  if (x.w.includes('name')) name = rest.pop();
  for (const v of rest) { if (typeof v === 'number') ad = v; else if (isIP(v)) nh = v; else iface = v; }
  if (iface && !x.c.interfaces[iface]) return INV;
  const same = r => r.net === net && r.mask === mask && (r.nh || null) === nh && (r.iface || null) === iface;
  if (x.neg) { const before = x.c.routes.length; x.c.routes = x.c.routes.filter(r => !(r.net === net && r.mask === mask && (!nh || r.nh === nh) && (!iface || r.iface === iface))); if (before === x.c.routes.length) x.out('%No matching route to delete'); return; }
  x.c.routes = x.c.routes.filter(r => !same(r));
  x.c.routes.push({ net, mask, nh, iface, ad, name, permanent: x.w.includes('permanent') });
}, { no: true });
cmd('c', 'rl', 'ip route <IP:Destination prefix> <IP:Destination prefix mask>', x => {
  const [net, mask] = x.v; x.c.routes = x.c.routes.filter(r => !(r.net === net && r.mask === mask));
}, { no: true, onlyNo: true });
cmd('c', 'sl', 'ip default-gateway <IP:IP address of default gateway>', x => { x.c.defaultGateway = x.neg ? '' : x.v[0]; }, { no: true });
cmd('c', 'sl', 'ip default-gateway', x => { x.c.defaultGateway = ''; }, { no: true, onlyNo: true });
cmd('c', 'rl', 'ip routing', x => { x.c.ipRouting = !x.neg; if (x.neg && NL.kind(x.d) === 'router') { x.c.ipRouting = false; } }, { no: true });
cmd('c', 'rsl', '{ip domain-name|ip domain name} <WORD:Default domain name>', x => { x.c.domainName = x.neg ? '' : x.v[0]; }, { no: true });
cmd('c', 'rsl', 'ip domain-lookup', x => { x.c.domainLookup = !x.neg; }, { no: true });
cmd('c', 'rsl', 'ip name-server <IP:Domain server IP address>', x => { x.c.nameServers = x.neg ? x.c.nameServers.filter(n => n !== x.v[0]) : [...new Set([...x.c.nameServers, x.v[0]])]; }, { no: true });
cmd('c', 'rl', 'ip dhcp pool <WORD:Pool name>', x => {
  if (x.neg) { delete x.c.dhcp.pools[x.v[0]]; return; }
  x.c.dhcp.pools[x.v[0]] = x.c.dhcp.pools[x.v[0]] || {};
  x.s.mode = 'd'; x.s.pool = x.v[0];
}, { no: true });
cmd('c', 'rl', 'ip dhcp excluded-address <IP:Low IP address> [<IP:High IP address>]', x => {
  const a = x.v[0], b = x.v[1] || x.v[0];
  if (ip2n(b) < ip2n(a)) { x.out('% Invalid address range'); return false; }
  x.c.dhcp.excluded = x.c.dhcp.excluded.filter(([p, q]) => !(p === a && (q || p) === b));
  if (!x.neg) x.c.dhcp.excluded.push([a, b]);
}, { no: true });
cmd('c', 'rl', 'ip nat inside source list {<N1-199:Access list number for local addresses>|<WORD:Access list name for local addresses>} {interface <IF:Specify interface for global address>|pool <WORD:Name pool of global addresses>} [overload]', x => {
  const acl = String(x.v[0]); const iface = x.w.includes('interface') ? x.v[1] : null; const pool = x.w.includes('pool') ? x.v[1] : null;
  if (iface && !x.c.interfaces[iface]) return INV;
  const rules = x.c.nat.rules;
  x.c.nat.rules = rules.filter(r => !(r.kind === 'dynamic' && r.acl === acl));
  if (!x.neg) x.c.nat.rules.push({ kind: 'dynamic', acl, iface, pool, overload: x.w.includes('overload') });
  else NL.rt(x.d).nat = NL.rt(x.d).nat.filter(e => !e.static);
}, { no: true });
cmd('c', 'rl', 'ip nat inside source static <IP:Inside local IP address> <IP:Inside global IP address>', x => {
  x.c.nat.rules = x.c.nat.rules.filter(r => !(r.kind === 'static' && r.local === x.v[0]));
  if (!x.neg) x.c.nat.rules.push({ kind: 'static', local: x.v[0], global: x.v[1] });
}, { no: true });
cmd('c', 'rl', 'ip nat pool <WORD:Pool name> <IP:Start IP address> <IP:End IP address> netmask <IP:Specify the network mask>', x => {
  if (x.neg) { delete x.c.nat.pools[x.v[0]]; return; }
  if (!validMask(x.v[3])) { x.out('%Invalid netmask'); return false; }
  x.c.nat.pools[x.v[0]] = { start: x.v[1], end: x.v[2], mask: x.v[3] };
}, { no: true });
function aclAdd(x, name, type, text, seq) {
  const acl = x.c.acls[name] = x.c.acls[name] || { type, entries: [] };
  if (acl.type !== type) { x.out(`% ${name} is not a ${type} access list`); return false; }
  let e;
  if (/^remark\b/.test(text)) e = { remark: text.replace(/^remark\s*/, '') };
  else {
    const t = tokenize(text).map(z => z.v.toLowerCase());
    const r = NL.parseAce(type, t);
    if (r.err) {
      const tt = tokenize(text), skip = text.indexOf(' ') + 1;
      x.s.markErr((x.tokOffset || 0) + Math.max(0, (tt[r.at] || { p: text.length }).p - skip));
      return false;
    }
    e = r.e;
  }
  const max = acl.entries.reduce((m, q) => Math.max(m, q.seq), 0);
  e.seq = seq || max + 10;
  if (acl.entries.some(q => q.seq === e.seq)) { x.out('% Duplicate sequence number'); return false; }
  acl.entries.push(e);
  acl.entries.sort((a, b) => a.seq - b.seq);
}
cmd('c', 'rsl', 'access-list <N1-99:IP standard access list> {permit|deny} <LINE:Address to match (A.B.C.D / any / host)>', x => aclAdd(Object.assign(x, { tokOffset: x.posOf(3) }), String(x.v[0]), 'standard', x.w[2] + ' ' + x.v[1]));
cmd('c', 'rsl', 'access-list <N100-199:IP extended access list> {permit|deny} <LINE:Protocol and addresses (ip / icmp / tcp / udp ...)>', x => aclAdd(Object.assign(x, { tokOffset: x.posOf(3) }), String(x.v[0]), 'extended', x.w[2] + ' ' + x.v[1]));
cmd('c', 'rsl', 'access-list <N1-199:IP access list> remark <LINE:Comment up to 100 characters>', x => aclAdd(x, String(x.v[0]), x.v[0] < 100 ? 'standard' : 'extended', 'remark ' + x.v[1]));
cmd('c', 'rsl', 'access-list <N1-199:IP access list>', x => { delete x.c.acls[String(x.v[0])]; }, { no: true, onlyNo: true });
cmd('c', 'rsl', 'ip access-list {standard|extended} <WORD:Access-list name>', x => {
  const type = x.w[2], name = x.v[0];
  if (x.neg) { delete x.c.acls[name]; return; }
  if (x.c.acls[name] && x.c.acls[name].type !== type) { x.out(`% A ${x.c.acls[name].type} access list named ${name} already exists`); return false; }
  x.c.acls[name] = x.c.acls[name] || { type, entries: [], named: true };
  x.s.mode = type === 'standard' ? 's' : 'e'; x.s.acl = name;
}, { no: true });
cmd('c', 'sl', 'vlan <N1-4094:ISL VLAN IDs 1-1005>', x => {
  const v = x.v[0];
  if (x.neg) { if (v === 1) { x.out('%Default VLAN 1 may not be deleted.'); return false; } delete x.d.vlans[v]; return; }
  if (!x.d.vlans[v]) x.d.vlans[v] = { name: 'VLAN' + String(v).padStart(4, '0') };
  x.s.mode = 'v'; x.s.vlans = [v];
}, { no: true });
cmd('c', 'rl', 'router ospf <N1-65535:Process ID>', x => {
  if (x.neg) { if (x.c.ospf && x.c.ospf.pid === x.v[0]) x.c.ospf = null; return; }
  if (x.c.ospf && x.c.ospf.pid !== x.v[0]) { x.out('% このシミュレーターでは OSPF プロセスは 1 つまでです（no router ospf ' + x.c.ospf.pid + ' で削除できます）'); return false; }
  x.c.ospf = x.c.ospf || { pid: x.v[0], networks: [], passive: [], noPassive: [], passiveDefault: false, routerId: '', defaultOriginate: false };
  x.s.mode = 'r';
}, { no: true });
cmd('c', 'rsl', 'enable secret [0] <LINE:The UNENCRYPTED (cleartext) \'enable\' secret>', x => {
  if (x.c.enablePassword && x.c.enablePassword === x.v[0]) x.out('The enable secret you have chosen is the same as your enable password.\nThis is not recommended.  Re-enter the enable secret.');
  x.c.enableSecret = x.v[0];
});
cmd('c', 'rsl', 'enable password [0] <LINE:The UNENCRYPTED (cleartext) \'enable\' password>', x => { x.c.enablePassword = x.v[0]; });
cmd('c', 'rsl', 'enable secret', x => { x.c.enableSecret = ''; }, { no: true, onlyNo: true });
cmd('c', 'rsl', 'enable password', x => { x.c.enablePassword = ''; }, { no: true, onlyNo: true });
cmd('c', 'rsl', 'service password-encryption', x => { x.c.pwEnc = !x.neg; }, { no: true });
cmd('c', 'rsl', 'banner motd <LINE:c banner-text c, where \'c\' is a delimiting character>', x => {
  const t = x.v[0]; const dlm = t[0]; const end = t.indexOf(dlm, 1);
  x.c.banner = end > 0 ? t.slice(1, end) : t.slice(1);
});
cmd('c', 'rsl', 'banner motd', x => { x.c.banner = ''; }, { no: true, onlyNo: true });
cmd('c', 'rsl', 'line console <N0-0:First Line number>', x => { x.s.mode = 'l'; x.s.line = 'con'; });
cmd('c', 'rsl', 'line vty <N0-15:First Line number> [<N1-15:Last Line number>]', x => { x.s.mode = 'l'; x.s.line = 'vty'; });
cmd('c', 'rsl', 'username <WORD:User name> [privilege <N0-15:User privilege level>] {secret|password} [0] <LINE:The UNENCRYPTED (cleartext) user password>', x => {
  const name = x.v[0]; const priv = x.w.includes('privilege') ? x.v[1] : 1; const pw = x.v[x.v.length - 1];
  x.c.users[name] = { priv, pw, secret: x.w.includes('secret') };
});
cmd('c', 'rsl', 'username <WORD:User name>', x => { delete x.c.users[x.v[0]]; }, { no: true, onlyNo: true });
cmd('c', 'rsl', 'crypto key generate rsa [general-keys] [modulus <N360-4096:size of the key modulus in the range of 360 to 4096>]', x => {
  if (x.c.hostname === 'Router' || x.c.hostname === 'Switch') { x.out('% Please define a hostname other than Router.'); return false; }
  if (!x.c.domainName) { x.out('% Please define a domain-name first.'); return false; }
  const done = bits => {
    if (bits < 360 || bits > 4096 || isNaN(bits)) { x.out('% Invalid modulus'); return; }
    x.c.rsa = bits;
    x.out(`% Generating ${bits} bit RSA keys, keys will be non-exportable...[OK]\n\n%SSH-5-ENABLED: SSH 1.99 has been enabled`);
    NL.touch('cfg');
  };
  x.out(`The name for the keys will be: ${x.c.hostname}.${x.c.domainName}`);
  if (x.w.includes('modulus')) { done(x.v[0]); return; }
  x.out('Choose the size of the key modulus in the range of 360 to 4096 for your\n  General Purpose Keys. Choosing a key modulus greater than 512 may take\n  a few minutes.\n');
  x.s.ask('How many bits in the modulus [512]: ', a => done(a ? parseInt(a, 10) : 512));
});
cmd('c', 'rsl', 'crypto key zeroize rsa', x => { x.c.rsa = 0; x.out('% All RSA keys will be removed.'); });
cmd('c', 'rsl', 'ip ssh version <N1-2:Protocol version>', x => { x.c.sshVersion = x.neg ? 0 : x.v[0]; }, { no: true });
cmd('c', 'rsl', 'ip ssh {time-out|authentication-retries} <N0-120:value>', () => {});
cmd('c', 'sl', 'spanning-tree vlan <N1-4094:VLAN ID> priority <N0-61440:bridge priority in increments of 4096>', x => {
  const [v, p] = x.v;
  if (x.neg) { delete x.c.stpPrio[v]; return; }
  if (p % 4096) { x.out('% Bridge Priority must be in increments of 4096.\n% Allowed values are:\n  0     4096  8192  12288 16384 20480 24576 28672\n  32768 36864 40960 45056 49152 53248 57344 61440'); return false; }
  x.c.stpPrio[v] = p;
}, { no: true });
cmd('c', 'sl', 'spanning-tree vlan <N1-4094:VLAN ID> root primary', x => { x.c.stpPrio[x.v[0]] = 24576; });
cmd('c', 'sl', 'spanning-tree mode {pvst|rapid-pvst}', x => { x.c.stpMode = x.w[2]; });
cmd('c', 'rsl', 'cdp run', x => { x.c.cdp = !x.neg; }, { no: true });
const misc = (x, line) => { x.c.misc = x.c.misc.filter(m => m !== line); if (!x.neg) x.c.misc.push(line); };
cmd('c', 'rsl', 'ntp server <IP:IP address of peer>', x => misc(x, 'ntp server ' + x.v[0]), { no: true });
cmd('c', 'rsl', 'logging <LINE:logging settings>', x => misc(x, 'logging ' + x.v[0]), { no: true });
cmd('c', 'rsl', 'clock timezone <LINE:name and offset>', x => misc(x, 'clock timezone ' + x.v[0]), { no: true });
cmd('c', 'rsl', 'service timestamps <LINE:options>', x => misc(x, 'service timestamps ' + x.v[0]), { no: true });
cmd('c', 'rsl', 'lldp run', x => misc(x, 'lldp run'), { no: true });
cmd('c', 'sl', 'vtp {mode|domain} <WORD:value>', x => misc(x, `vtp ${x.w[1]} ${x.v[0]}`), { no: true });
cmd('cirlvdse', 'rsl', 'end', x => { x.s.mode = 'p'; x.s.configured(); }, { cfg: false });
cmd('cirlvdse', 'rsl', 'exit', x => {
  if (x.s.mode === 'c') { x.s.mode = 'p'; x.s.configured(); }
  else x.s.mode = 'c';
}, { cfg: false });

// =====================================================================
// interface configuration
// =====================================================================
cmd('i', 'rsl', 'ip address <IP:IP address> <IP:IP subnet mask> [secondary]', x => {
  const [ip, mask] = x.v; const sec = x.w.includes('secondary');
  for (const [n, i] of curIfs(x)) {
    if (isPhys(x.d, n) && NL.isSwPort(x.d, n)) { if (NL.kind(x.d) === 'switch') return INV; x.out('% IP addresses may not be configured on L2 links.'); return false; }
    if (!validMask(mask)) { x.out(`Bad mask /${maskLen(mask)} for address ${ip}`); return false; }
    const len = maskLen(mask);
    if (len < 31 && (netOf(ip, mask) === ip || n2ip((ip2n(netOf(ip, mask)) | (~ip2n(mask) >>> 0)) >>> 0) === ip)) { x.out(`Bad mask 0x${ip2n(mask).toString(16).toUpperCase()} for address ${ip}`); return false; }
    const ov = overlapCheck(x, n, ip, mask);
    if (ov) { x.out(ov); return false; }
    if (sec) { if (!i.ip) { x.out('% Primary address not set'); return false; } i.secondary = (i.secondary || []).filter(s => s.ip !== ip).concat([{ ip, mask }]); }
    else { i.ip = ip; i.mask = mask; }
  }
});
cmd('i', 'rsl', 'ip address [<IP:IP address> <IP:IP subnet mask> [secondary]]', x => {
  for (const [, i] of curIfs(x)) {
    if (x.w.includes('secondary')) i.secondary = (i.secondary || []).filter(s => s.ip !== x.v[0]);
    else { delete i.ip; delete i.mask; delete i.secondary; }
  }
}, { no: true, onlyNo: true });
cmd('i', 'rsl', 'shutdown', x => { curIfs(x).forEach(([, i]) => { i.shutdown = !x.neg; }); }, { no: true });
cmd('i', 'rsl', 'description <LINE:Up to 240 characters describing this interface>', x => { curIfs(x).forEach(([, i]) => { i.description = x.v[0]; }); });
cmd('i', 'rsl', 'description', x => { curIfs(x).forEach(([, i]) => { delete i.description; }); }, { no: true, onlyNo: true });
cmd('i', 'rl', 'ip nat {inside|outside}', x => {
  curIfs(x).forEach(([, i]) => { if (x.w[2] === 'inside') i.natInside = !x.neg; else i.natOutside = !x.neg; });
}, { no: true });
cmd('i', 'rsl', 'ip access-group {<N1-199:IP access list (standard or extended)>|<WORD:Access-list name>} {in|out}', x => {
  const acl = String(x.v[0]), dir = x.w[x.w.length - 1];
  curIfs(x).forEach(([, i]) => { if (dir === 'in') i.aclIn = x.neg ? '' : acl; else i.aclOut = x.neg ? '' : acl; });
}, { no: true });
cmd('i', 'rl', 'ip helper-address <IP:IP destination address>', x => {
  curIfs(x).forEach(([, i]) => { i.helper = (i.helper || []).filter(h => h !== x.v[0]); if (!x.neg) i.helper.push(x.v[0]); });
}, { no: true });
cmd('i', 'rl', 'ip ospf cost <N1-65535:Cost>', x => { curIfs(x).forEach(([, i]) => { if (x.neg) delete i.ospfCost; else i.ospfCost = x.v[0]; }); }, { no: true });
const swOnly = (x, fn) => {
  for (const [n, i] of curIfs(x)) {
    if (!isPhys(x.d, n)) return INV;
    if (i.switchport === false) { x.out('% Interface is not a switchport.'); return false; }
    const r = fn(i, n); if (r === false || r === INV) return r;
  }
};
cmd('i', 'sl', 'switchport mode {access|trunk|dynamic {auto|desirable}}', x => swOnly(x, i => {
  if (x.neg) { i.mode = 'dynamic auto'; return; }
  const m = x.w[2] === 'dynamic' ? 'dynamic ' + x.w[3] : x.w[2];
  if (m === 'trunk' && NL.kind(x.d) === 'l3switch' && i.encap !== 'dot1q') { x.out('Command rejected: An interface whose trunk encapsulation is "Auto" can not be configured to "trunk" mode.'); return false; }
  i.mode = m;
}), { no: true });
cmd('i', 'sl', 'switchport mode', x => swOnly(x, i => { i.mode = 'dynamic auto'; }), { no: true, onlyNo: true });
cmd('i', 'sl', 'switchport access vlan <N1-4094:VLAN ID of the VLAN when this port is in access mode>', x => {
  const v = x.v[0];
  const r = swOnly(x, i => { i.accessVlan = x.neg ? 1 : v; });
  if (r !== undefined) return r;
  if (!x.neg && !x.d.vlans[v]) { x.d.vlans[v] = { name: 'VLAN' + String(v).padStart(4, '0') }; x.out('% Access VLAN does not exist. Creating vlan ' + v); }
}, { no: true });
cmd('i', 'sl', 'switchport access vlan', x => swOnly(x, i => { i.accessVlan = 1; }), { no: true, onlyNo: true });
cmd('i', 'sl', 'switchport trunk allowed vlan {<VL:VLAN IDs of the allowed VLANs when this port is in trunking mode>|add <VL:VLAN IDs of the allowed VLANs>|remove <VL:VLAN IDs of disallowed VLANS>|except <VL:All VLANs except the following>|all|none}', x => swOnly(x, i => {
  const op = x.w[4], list = x.v[0];
  const all = Array.from({ length: 4094 }, (_, k) => k + 1);
  const cur = i.allowed ? i.allowed.slice() : all;
  if (x.neg || op === 'all') i.allowed = null;
  else if (op === 'none') i.allowed = [];
  else if (op === 'add') i.allowed = [...new Set([...cur, ...list])].sort((a, b) => a - b);
  else if (op === 'remove') i.allowed = cur.filter(v => !list.includes(v));
  else if (op === 'except') i.allowed = all.filter(v => !list.includes(v));
  else i.allowed = list.slice().sort((a, b) => a - b);
  if (i.allowed && i.allowed.length === 4094) i.allowed = null;
}), { no: true });
cmd('i', 'sl', 'switchport trunk native vlan <N1-4094:VLAN ID of the native VLAN when this port is in trunking mode>', x => swOnly(x, i => { i.nativeVlan = x.neg ? 1 : x.v[0]; }), { no: true });
cmd('i', 'sl', 'switchport trunk native vlan', x => swOnly(x, i => { i.nativeVlan = 1; }), { no: true, onlyNo: true });
cmd('i', 'l', 'switchport trunk encapsulation {dot1q|isl|negotiate}', x => swOnly(x, i => {
  if (x.w[3] === 'isl') { x.out('% このシミュレーターでは ISL は使えません。dot1q を指定してください。'); return false; }
  i.encap = x.neg ? '' : x.w[3];
}), { no: true });
cmd('i', 'sl', 'switchport nonegotiate', x => swOnly(x, i => {
  if (!x.neg && (i.mode || 'dynamic auto').startsWith('dynamic')) { x.out('Command rejected: Conflict between \'nonegotiate\' and \'dynamic\' status.'); return false; }
  i.nonegotiate = !x.neg;
}), { no: true });
cmd('i', 'l', 'switchport', x => {
  for (const [n, i] of curIfs(x)) {
    if (!isPhys(x.d, n)) return INV;
    if (x.neg) { i.switchport = false; delete i.mode; }
    else { i.switchport = true; i.mode = i.mode || 'dynamic auto'; i.accessVlan = i.accessVlan || 1; i.nativeVlan = i.nativeVlan || 1; delete i.ip; delete i.mask; }
  }
}, { no: true });
cmd('i', 'r', 'encapsulation dot1Q <N1-4094:IEEE 802.1Q VLAN ID> [native]', x => {
  for (const [n, i] of curIfs(x)) {
    if (!n.includes('.')) { x.out('% Configuring IEEE 802.1Q encapsulation on the main interface is not supported'); return false; }
    const other = Object.entries(x.c.interfaces).find(([m, j]) => m !== n && m.split('.')[0] === n.split('.')[0] && j.dot1q === x.v[0]);
    if (other) { x.out(`Configuration of multiple subinterfaces of the same main\ninterface with the same VID (${x.v[0]}) is not permitted.\nThis VID is already configured on ${other[0]}.`); return false; }
    i.dot1q = x.v[0]; i.dot1qNative = x.w.includes('native');
  }
});
cmd('i', 'rsl', 'speed {10|100|1000|auto}', x => { curIfs(x).forEach(([, i]) => { i.speed = x.neg ? '' : x.w[1]; }); }, { no: true });
cmd('i', 'rsl', 'duplex {auto|full|half}', x => { curIfs(x).forEach(([, i]) => { i.duplex = x.neg ? '' : x.w[1]; }); }, { no: true });
cmd('i', 'rsl', 'bandwidth <N1-10000000:Bandwidth in kilobits>', x => { curIfs(x).forEach(([, i]) => { i.bw = x.neg ? 0 : x.v[0]; }); }, { no: true });
cmd('i', 'sl', 'spanning-tree portfast', x => {
  curIfs(x).forEach(([, i]) => { i.portfast = !x.neg; });
  if (!x.neg) x.out('%Warning: portfast should only be enabled on ports connected to a single\n host. Connecting hubs, concentrators, switches, bridges, etc... to this\n interface  when portfast is enabled, can cause temporary bridging loops.\n Use with CAUTION\n\n%Portfast has been configured on ' + x.s.ifs.map(shortIf).join(', ') + ' but will only\n have effect when the interface is in a non-trunking mode.');
}, { no: true });
cmd('i', 'rsl', 'cdp enable', x => { curIfs(x).forEach(([, i]) => { i.noCdp = !!x.neg; }); }, { no: true });

// =====================================================================
// router ospf / line / vlan / dhcp / named ACL
// =====================================================================
cmd('r', 'rl', 'network <IP:Network number> <IP:OSPF wild card bits> area {<N0-4294967295:OSPF area ID as a decimal value>|<IP:OSPF area ID in IP address format>}', x => {
  const [addr, wild, area] = x.v; const o = x.c.ospf;
  o.networks = o.networks.filter(n => !(n.addr === addr && n.wild === wild));
  if (!x.neg) o.networks.push({ addr, wild, area: String(area) });
}, { no: true });
cmd('r', 'rl', 'router-id <IP:OSPF router-id in IP address format>', x => {
  x.c.ospf.routerId = x.neg ? '' : x.v[0];
  if (NL.ospfNbrs(x.d).length) x.out('% OSPF: Reload or use "clear ip ospf process" command, for this to take effect');
}, { no: true });
cmd('r', 'rl', 'router-id', x => { x.c.ospf.routerId = ''; }, { no: true, onlyNo: true });
cmd('r', 'rl', 'passive-interface {default|<IF:Interface name>}', x => {
  const o = x.c.ospf;
  if (x.w[1] === 'default') { o.passiveDefault = !x.neg; o.passive = []; o.noPassive = []; return; }
  const n = x.v[0]; if (!x.c.interfaces[n]) return INV;
  if (o.passiveDefault) o.noPassive = x.neg ? [...new Set([...o.noPassive, n])] : o.noPassive.filter(p => p !== n);
  else o.passive = x.neg ? o.passive.filter(p => p !== n) : [...new Set([...o.passive, n])];
}, { no: true });
cmd('r', 'rl', 'default-information originate', x => { x.c.ospf.defaultOriginate = !x.neg; }, { no: true });
cmd('r', 'rl', 'log-adjacency-changes', () => {}, { no: true });
cmd('r', 'rl', 'auto-cost reference-bandwidth <N1-4294967:The reference bandwidth in terms of Mbits per second>', () => {}, { no: true });
const lineCfg = x => x.c.lines[x.s.line] = x.c.lines[x.s.line] || {};
cmd('l', 'rsl', 'password [0] <LINE:The UNENCRYPTED (cleartext) line password>', x => { lineCfg(x).password = x.v[0]; });
cmd('l', 'rsl', 'password', x => { delete lineCfg(x).password; }, { no: true, onlyNo: true });
cmd('l', 'rsl', 'login [local]', x => {
  const l = lineCfg(x);
  if (x.neg) { l.login = false; l.loginLocal = false; return; }
  if (x.w.includes('local')) { l.loginLocal = true; l.login = false; }
  else { l.login = true; l.loginLocal = false; if (!l.password) x.out('% Login disabled on line ' + (x.s.line === 'con' ? 0 : 1) + ', until \'password\' is set'); }
}, { no: true });
cmd('l', 'rsl', 'transport input {all|none|telnet [ssh]|ssh [telnet]}', x => {
  if (x.s.line !== 'vty') return INV;
  const w = x.w.slice(2); lineCfg(x).transport = w.includes('all') ? 'all' : w.includes('none') ? 'none' : w.join(' ');
});
cmd('l', 'rsl', 'exec-timeout <N0-35791:Timeout in minutes> [<N0-2147483:Timeout in seconds>]', x => { lineCfg(x).execTimeout = x.v.join(' '); });
cmd('l', 'rsl', 'logging synchronous', x => { lineCfg(x).logSync = !x.neg; }, { no: true });
cmd('l', 'rsl', 'privilege level <N0-15:Default privilege level for line>', x => { lineCfg(x).privilege = x.v[0]; });
cmd('v', 'sl', 'name <WORD:The ascii name for the VLAN>', x => { x.s.vlans.forEach(v => { if (x.d.vlans[v]) x.d.vlans[v].name = x.neg ? 'VLAN' + String(v).padStart(4, '0') : x.v[0]; }); }, { no: true });
cmd('v', 'sl', 'name', x => { x.s.vlans.forEach(v => { if (x.d.vlans[v]) x.d.vlans[v].name = 'VLAN' + String(v).padStart(4, '0'); }); }, { no: true, onlyNo: true });
const pool = x => x.c.dhcp.pools[x.s.pool];
cmd('d', 'rl', 'network <IP:Network number in dotted-decimal notation> <IP:Network mask or prefix length>', x => {
  if (!validMask(x.v[1])) { x.out('% Invalid mask'); return false; }
  pool(x).network = netOf(x.v[0], x.v[1]); pool(x).mask = x.v[1];
});
cmd('d', 'rl', 'default-router <IP:Router\'s IP address>', x => { pool(x).defaultRouter = x.neg ? '' : x.v[0]; }, { no: true });
cmd('d', 'rl', 'dns-server <IP:Server\'s IP address>', x => { pool(x).dns = x.neg ? '' : x.v[0]; }, { no: true });
cmd('d', 'rl', 'domain-name <WORD:Domain name>', x => { pool(x).domain = x.neg ? '' : x.v[0]; }, { no: true });
cmd('d', 'rl', 'lease <LINE:days hours minutes | infinite>', x => { pool(x).lease = x.v[0]; });
cmd('se', 'rsl', '{permit|deny} <LINE:Address or protocol>', x => aclAdd(Object.assign(x, { tokOffset: x.posOf(1) }), x.s.acl, x.s.mode === 's' ? 'standard' : 'extended', x.w[0] + ' ' + x.v[0]));
cmd('se', 'rsl', '<N1-2147483647:Sequence Number> {permit|deny} <LINE:Address or protocol>', x => aclAdd(Object.assign(x, { tokOffset: x.posOf(2) }), x.s.acl, x.s.mode === 's' ? 'standard' : 'extended', x.w[1] + ' ' + x.v[1], x.v[0]));
cmd('se', 'rsl', 'remark <LINE:Comment up to 100 characters>', x => aclAdd(x, x.s.acl, x.s.mode === 's' ? 'standard' : 'extended', 'remark ' + x.v[0]));
cmd('se', 'rsl', '<N1-2147483647:Sequence Number>', x => { const a = x.c.acls[x.s.acl]; a.entries = a.entries.filter(e => e.seq !== x.v[0]); }, { no: true, onlyNo: true });

// =====================================================================
// running-config
// =====================================================================
function ifBlock(dev, c, n) {
  const i = c.interfaces[n], k = NL.kind(dev), L = ['interface ' + n];
  const phys = NL.MODELS[dev.model].ports.includes(n);
  if (i.description) L.push(' description ' + i.description);
  const sw = phys && k !== 'router' && i.switchport !== false;
  if (sw) {
    if (i.nativeVlan && i.nativeVlan !== 1) L.push(' switchport trunk native vlan ' + i.nativeVlan);
    if (i.allowed) L.push(' switchport trunk allowed vlan ' + (i.allowed.length ? vlStr(i.allowed) : 'none'));
    if (i.encap) L.push(' switchport trunk encapsulation ' + i.encap);
    if (i.accessVlan && i.accessVlan !== 1) L.push(' switchport access vlan ' + i.accessVlan);
    if (i.mode && i.mode !== 'dynamic auto') L.push(' switchport mode ' + i.mode);
    if (i.nonegotiate) L.push(' switchport nonegotiate');
    if (i.portfast) L.push(' spanning-tree portfast');
  } else {
    if (phys && k !== 'router') L.push(' no switchport');
    if (i.dot1q != null) L.push(' encapsulation dot1Q ' + i.dot1q + (i.dot1qNative ? ' native' : ''));
    if (i.ip) { L.push(` ip address ${i.ip} ${i.mask}`); (i.secondary || []).forEach(s => L.push(` ip address ${s.ip} ${s.mask} secondary`)); }
    else L.push(' no ip address');
    (i.helper || []).forEach(h => L.push(' ip helper-address ' + h));
    if (i.aclIn) L.push(' ip access-group ' + i.aclIn + ' in');
    if (i.aclOut) L.push(' ip access-group ' + i.aclOut + ' out');
    if (i.natInside) L.push(' ip nat inside');
    if (i.natOutside) L.push(' ip nat outside');
    if (i.ospfCost) L.push(' ip ospf cost ' + i.ospfCost);
  }
  if (i.bw) L.push(' bandwidth ' + i.bw);
  if (phys && !n.includes('.')) { L.push(' duplex ' + (i.duplex || 'auto')); L.push(' speed ' + (i.speed || 'auto')); }
  if (i.noCdp) L.push(' no cdp enable');
  if (i.shutdown) L.push(' shutdown');
  return L;
}
function runConf(dev, c) {
  const k = NL.kind(dev), L = [];
  const pw = p => c.pwEnc ? '7 ' + type7(p) : p;
  L.push('!', 'version 15.1', 'no service timestamps log datetime msec', 'no service timestamps debug datetime msec', (c.pwEnc ? '' : 'no ') + 'service password-encryption', '!', 'hostname ' + c.hostname, '!');
  if (c.enableSecret) L.push('enable secret 5 ' + md5ish(c.enableSecret));
  if (c.enablePassword) L.push('enable password ' + pw(c.enablePassword));
  if (c.enableSecret || c.enablePassword) L.push('!');
  const users = Object.entries(c.users);
  users.forEach(([n, u]) => L.push(`username ${n}${u.priv && u.priv !== 1 ? ' privilege ' + u.priv : ''} ${u.secret ? 'secret 5 ' + md5ish(u.pw) : 'password ' + (c.pwEnc ? '7 ' + type7(u.pw) : '0 ' + u.pw)}`));
  if (users.length) L.push('!');
  (c.dhcp.excluded || []).forEach(([a, b]) => L.push('ip dhcp excluded-address ' + a + (b && b !== a ? ' ' + b : '')));
  if ((c.dhcp.excluded || []).length) L.push('!');
  Object.entries(c.dhcp.pools).forEach(([n, p]) => {
    L.push('ip dhcp pool ' + n);
    if (p.network) L.push(` network ${p.network} ${p.mask}`);
    if (p.defaultRouter) L.push(' default-router ' + p.defaultRouter);
    if (p.dns) L.push(' dns-server ' + p.dns);
    if (p.domain) L.push(' domain-name ' + p.domain);
    if (p.lease) L.push(' lease ' + p.lease);
    L.push('!');
  });
  if (k === 'l3switch' && c.ipRouting) L.push('ip routing', '!');
  if (k === 'router' && !c.ipRouting) L.push('no ip routing', '!');
  if (!c.domainLookup) L.push('no ip domain-lookup');
  if (c.domainName) L.push('ip domain-name ' + c.domainName);
  c.nameServers.forEach(n => L.push('ip name-server ' + n));
  if (c.sshVersion) L.push('ip ssh version ' + c.sshVersion);
  L.push('!');
  if (k !== 'router') {
    L.push('spanning-tree mode ' + (c.stpMode || 'pvst'));
    Object.entries(c.stpPrio || {}).forEach(([v, p]) => L.push(`spanning-tree vlan ${v} priority ${p}`));
    L.push('!');
  }
  c.misc.forEach(m => L.push(m));
  if (c.misc.length) L.push('!');
  for (const n of ifOrder({ model: dev.model, cfg: c })) { L.push(...ifBlock(dev, c, n), '!'); }
  if (c.ospf) {
    const o = c.ospf;
    L.push('router ospf ' + o.pid);
    if (o.routerId) L.push(' router-id ' + o.routerId);
    L.push(' log-adjacency-changes');
    if (o.passiveDefault) { L.push(' passive-interface default'); (o.noPassive || []).forEach(p => L.push(' no passive-interface ' + p)); }
    else (o.passive || []).forEach(p => L.push(' passive-interface ' + p));
    o.networks.forEach(n => L.push(` network ${n.addr} ${n.wild} area ${n.area}`));
    if (o.defaultOriginate) L.push(' default-information originate');
    L.push('!');
  }
  Object.entries(c.nat.pools).forEach(([n, p]) => L.push(`ip nat pool ${n} ${p.start} ${p.end} netmask ${p.mask}`));
  c.nat.rules.forEach(r => L.push(r.kind === 'static' ? `ip nat inside source static ${r.local} ${r.global}` : `ip nat inside source list ${r.acl} ${r.iface ? 'interface ' + r.iface : 'pool ' + r.pool}${r.overload ? ' overload' : ''}`));
  if (k !== 'switch') L.push('ip classless');
  if (k !== 'router' && c.defaultGateway) L.push('ip default-gateway ' + c.defaultGateway);
  c.routes.forEach(r => L.push(`ip route ${r.net} ${r.mask} ${[r.iface, r.nh].filter(Boolean).join(' ')}${r.ad && r.ad !== 1 ? ' ' + r.ad : ''}${r.name ? ' name ' + r.name : ''}${r.permanent ? ' permanent' : ''}`));
  L.push('!', 'ip flow-export version 9', '!');
  const acls = Object.entries(c.acls);
  acls.filter(([n]) => /^\d+$/.test(n)).forEach(([n, a]) => a.entries.forEach(e => L.push(`access-list ${n} ${NL.aceText(a.type, e)}`)));
  acls.filter(([n]) => !/^\d+$/.test(n)).forEach(([n, a]) => { L.push(`ip access-list ${a.type} ${n}`); a.entries.forEach(e => L.push(' ' + NL.aceText(a.type, e))); });
  if (acls.length) L.push('!');
  if (c.banner) L.push('banner motd ^C' + c.banner + '^C', '!');
  if (!c.cdp) L.push('no cdp run', '!');
  const lineBlk = (name, l) => {
    L.push(name);
    if (l.execTimeout) L.push(' exec-timeout ' + l.execTimeout);
    if (l.privilege) L.push(' privilege level ' + l.privilege);
    if (l.password) L.push(' password ' + pw(l.password));
    if (l.logSync) L.push(' logging synchronous');
    if (l.loginLocal) L.push(' login local'); else if (l.login) L.push(' login');
    if (l.transport && l.transport !== 'all' && name.startsWith('line vty')) L.push(' transport input ' + l.transport);
  };
  lineBlk('line con 0', c.lines.con || {});
  if (k === 'router') L.push('!', 'line aux 0');
  L.push('!');
  lineBlk('line vty 0 4', c.lines.vty || {});
  if (k !== 'router') { L.push('!'); lineBlk('line vty 5 15', c.lines.vty || {}); }
  L.push('!', '!', 'end');
  return L.join('\n');
}

// =====================================================================
// show output
// =====================================================================
const VER = {
  '2911': ['Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version 15.1(4)M4, RELEASE SOFTWARE (fc2)', 'C2900', 'cisco CISCO2911/K9 (revision 1.0) with 491520K/32768K bytes of memory.', '3 Gigabit Ethernet interfaces'],
  '4331': ['Cisco IOS XE Software, Version 16.09.04\nCisco IOS Software [Fuji], ISR Software (X86_64_LINUX_IOSD-UNIVERSALK9-M), Version 16.9.4, RELEASE SOFTWARE (fc2)', 'ISR4300', 'cisco ISR4331/K9 (1RU) processor with 1795999K/6147K bytes of memory.', '3 Gigabit Ethernet interfaces'],
  '2960': ['Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.0(2)SE4, RELEASE SOFTWARE (fc1)', 'C2960', 'cisco WS-C2960-24TT-L (PowerPC405) processor (revision B0) with 65536K bytes of memory.', '24 FastEthernet interfaces\n2 Gigabit Ethernet interfaces'],
  '3560': ['Cisco IOS Software, C3560 Software (C3560-IPSERVICESK9-M), Version 12.2(37)SE1, RELEASE SOFTWARE (fc1)', 'C3560', 'cisco WS-C3560-24PS (PowerPC405) processor (revision C0) with 122880K/8184K bytes of memory.', '24 FastEthernet interfaces\n2 Gigabit Ethernet interfaces']
};
const platform = d => VER[d.model][1];
function showVersion(d) {
  const v = VER[d.model];
  return `${v[0]}\nTechnical Support: http://www.cisco.com/techsupport\nCopyright (c) 1986-2016 by Cisco Systems, Inc.\n\nROM: System Bootstrap, Version 15.1(4)M4, RELEASE SOFTWARE (fc1)\n\n${d.cfg.hostname} uptime is ${uptime(d)}\nSystem returned to ROM by power-on\n\n${v[2]}\nProcessor board ID FTX1524${d.id.toUpperCase().padStart(4, '0')}\n${v[3]}\n${d.vlans && NL.kind(d) !== 'router' ? '' : 'DRAM configuration is 64 bits wide with parity disabled.\n'}255K bytes of non-volatile configuration memory.\n\nConfiguration register is 0x2102`;
}
function showIpIntBrief(d) {
  const out = ['Interface              IP-Address      OK? Method Status                Protocol '];
  for (const n of ifOrder(d)) {
    const i = d.cfg.interfaces[n], st = NL.ifState(d, n);
    const ip = i.ip || 'unassigned';
    out.push(pad(n, 23) + pad(ip, 16) + pad('YES', 4) + pad(i.ip ? 'manual' : 'unset', 7) + pad(st.status, 22) + st.proto);
  }
  return out.join('\n');
}
function showIpInt(d, n) {
  const names = n ? [n] : ifOrder(d);
  const out = [];
  for (const m of names) {
    const i = d.cfg.interfaces[m]; if (!i) return '% Invalid input detected';
    const st = NL.ifState(d, m);
    out.push(`${m} is ${st.status}, line protocol is ${st.proto}`);
    if (i.ip) {
      out.push(`  Internet address is ${i.ip}/${maskLen(i.mask)}`, `  Broadcast address is 255.255.255.255`);
      (i.secondary || []).forEach(s => out.push(`  Secondary address ${s.ip}/${maskLen(s.mask)}`));
      out.push(`  Helper address is ${(i.helper || []).join(', ') || 'not set'}`);
      out.push(`  Outgoing access list is ${i.aclOut || 'not set'}`, `  Inbound  access list is ${i.aclIn || 'not set'}`);
      out.push(`  Proxy ARP is enabled`, `  Network address translation is ${i.natInside ? 'enabled, interface in domain inside' : i.natOutside ? 'enabled, interface in domain outside' : 'disabled'}`);
    } else out.push('  Internet protocol processing disabled');
  }
  return out.join('\n');
}
function showInterfaces(d, n) {
  const names = n ? [n] : ifOrder(d);
  const out = [];
  for (const m of names) {
    const i = d.cfg.interfaces[m]; if (!i) return '% Invalid input detected';
    const st = NL.ifState(d, m), phys = NL.MODELS[d.model].ports.includes(m.split('.')[0]);
    const mac = phys ? d.macs[m.split('.')[0]] : d.baseMac;
    const hw = m.startsWith('Vlan') ? 'EtherSVI' : m.startsWith('Loopback') ? 'Loopback' : m.startsWith('Fast') ? 'Lance' : 'CN Gigabit Ethernet';
    out.push(`${m} is ${st.status}, line protocol is ${st.proto}${phys && !m.includes('.') && NL.isSwPort(d, m) ? (st.proto === 'up' ? ' (connected)' : ' (notconnect)') : ''}`);
    out.push(`  Hardware is ${hw}, address is ${mac} (bia ${mac})`);
    if (i.description) out.push('  Description: ' + i.description);
    if (i.ip) out.push(`  Internet address is ${i.ip}/${maskLen(i.mask)}`);
    const bw = i.bw || (m.startsWith('Fast') ? 100000 : m.startsWith('Loop') ? 8000000 : 1000000);
    out.push(`  MTU 1500 bytes, BW ${bw} Kbit/sec, DLY 10 usec,`, '     reliability 255/255, txload 1/255, rxload 1/255');
    if (i.dot1q != null) out.push(`  Encapsulation 802.1Q Virtual LAN, Vlan ID  ${i.dot1q}`);
    else out.push('  Encapsulation ARPA, loopback not set');
    if (phys && !m.includes('.')) out.push(`  Full-duplex, ${m.startsWith('Fast') ? '100Mb/s' : '1000Mb/s'}, media type is RJ45`);
    out.push('  ARP type: ARPA, ARP Timeout 04:00:00', '  Last input 00:00:08, output 00:00:05, output hang never', '  5 minute input rate 0 bits/sec, 0 packets/sec', '  5 minute output rate 0 bits/sec, 0 packets/sec');
  }
  return out.join('\n');
}
function showIntStatus(d) {
  const out = ['Port      Name               Status       Vlan       Duplex  Speed Type'];
  for (const p of NL.MODELS[d.model].ports) {
    const i = d.cfg.interfaces[p], st = NL.ifState(d, p);
    const status = i.shutdown ? 'disabled' : st.proto === 'up' ? 'connected' : 'notconnect';
    const vl = !NL.isSwPort(d, p) ? 'routed' : (st.proto === 'up' && NL.effMode(d, p) === 'trunk') ? 'trunk' : String(i.accessVlan || 1);
    const gig = p.startsWith('Gig');
    out.push(pad(shortIf(p), 10) + pad((i.description || '').slice(0, 18), 19) + pad(status, 13) + pad(vl, 11) + pad(st.proto === 'up' ? 'a-full' : 'auto', 8) + pad(st.proto === 'up' ? (gig ? 'a-1000' : 'a-100') : 'auto', 6) + (gig ? '10/100/1000BaseTX' : '10/100BaseTX'));
  }
  return out.join('\n');
}
function showTrunk(d) {
  const ports = NL.MODELS[d.model].ports.filter(p => NL.isSwPort(d, p) && NL.portLinkUp(d, p) && NL.effMode(d, p) === 'trunk');
  if (!ports.length) return '';
  const vlansOn = p => { const i = d.cfg.interfaces[p]; return Object.keys(d.vlans).map(Number).filter(v => NL.trunkAllows(i, v)); };
  const out = ['Port        Mode         Encapsulation  Status        Native vlan'];
  ports.forEach(p => { const i = d.cfg.interfaces[p]; out.push(pad(shortIf(p), 12) + pad(i.mode === 'trunk' ? 'on' : (i.mode || 'auto').replace('dynamic ', ''), 13) + pad('802.1q', 15) + pad('trunking', 14) + (i.nativeVlan || 1)); });
  out.push('', 'Port        Vlans allowed on trunk');
  ports.forEach(p => { const i = d.cfg.interfaces[p]; out.push(pad(shortIf(p), 12) + (i.allowed ? (i.allowed.length ? vlStr(i.allowed) : 'none') : '1-1005')); });
  out.push('', 'Port        Vlans allowed and active in management domain');
  ports.forEach(p => out.push(pad(shortIf(p), 12) + (vlStr(vlansOn(p)) || 'none')));
  out.push('', 'Port        Vlans in spanning tree forwarding state and not pruned');
  ports.forEach(p => out.push(pad(shortIf(p), 12) + (vlStr(vlansOn(p).filter(v => !NL.stpBlocked(d, p, v))) || 'none')));
  return out.join('\n');
}
function classful(net) { const a = +net.split('.')[0]; return a < 128 ? 8 : a < 192 ? 16 : 24; }
function showIpRoute(d, filter) {
  const head = `Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP
       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area
       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2
       E1 - OSPF external type 1, E2 - OSPF external type 2, E - EGP
       i - IS-IS, L1 - IS-IS level-1, L2 - IS-IS level-2, ia - IS-IS inter area
       * - candidate default, U - per-user static route, o - ODR
       P - periodic downloaded static route
`;
  if (!NL.canRoute(d)) {
    return d.cfg.defaultGateway ? `Default gateway is ${d.cfg.defaultGateway}\n\nHost               Gateway           Last Use    Total Uses  Interface\nICMP redirect cache is empty` : 'Default gateway is not set\n\nHost               Gateway           Last Use    Total Uses  Interface\nICMP redirect cache is empty';
  }
  let rs = NL.routes(d).slice();
  const fmap = { static: ['S'], connected: ['C', 'L'], ospf: ['O', 'O*E2'] };
  if (filter) rs = rs.filter(r => fmap[filter].includes(r.code));
  const def = NL.routes(d).find(r => r.len === 0);
  let gw = 'Gateway of last resort is not set';
  if (def) gw = def.nh ? `Gateway of last resort is ${def.nh} to network 0.0.0.0` : `Gateway of last resort is 0.0.0.0 to network 0.0.0.0`;
  rs.sort((a, b) => ip2n(a.net) - ip2n(b.net) || a.len - b.len || (a.code === 'C' ? -1 : 1));
  const line = (r, indent) => {
    let code = r.code;
    if (r.len === 0) code = r.code === 'S' ? 'S*' : r.code;
    const c = pad(code, indent ? 9 : 5);
    const pfx = r.net + '/' + r.len;
    if (r.code === 'C' || r.code === 'L') return c + pfx + ' is directly connected, ' + r.ifn;
    if (r.code === 'S') return c + pfx + (r.nh ? ` [${r.ad}/0] via ${r.nh}` + (r.ifn ? ', ' + r.ifn : '') : ' is directly connected, ' + r.ifn);
    return c + pfx + ` [110/${r.metric}] via ${r.nh}, 00:0${(r.metric % 9)}:1${r.metric % 10}, ${r.ifn}`;
  };
  const out = [head, gw, ''];
  const groups = new Map();
  for (const r of rs) {
    const cl = classful(r.net);
    const key = r.len > cl ? netOf(r.net, n2ip(U.len2mask(cl))) + '/' + cl : '*' + r.net + r.len;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const [key, arr] of groups) {
    if (key[0] === '*') { arr.forEach(r => out.push(line(r, false))); continue; }
    const masks = new Set(arr.map(r => r.len)), nets = new Set(arr.map(r => r.net + '/' + r.len));
    const [major, cl] = key.split('/');
    if (masks.size === 1) out.push(`      ${major}/${[...masks][0]} is subnetted, ${nets.size} subnets`);
    else out.push(`      ${major}/${cl} is variably subnetted, ${nets.size} subnets, ${masks.size} masks`);
    arr.forEach(r => out.push(line(r, true)));
  }
  return out.join('\n');
}
function showArp(d) {
  const out = ['Protocol  Address          Age (min)  Hardware Addr   Type   Interface'];
  const rows = [];
  NL.l3ifs(d).filter(i => i.up && i.t !== 'lo').forEach(i => rows.push([i.ip, '-', i.mac, i.name]));
  Object.entries(NL.rt(d).arp).forEach(([ip, e]) => rows.push([ip, String(Math.floor((Date.now() - e.t) / 60000)), e.mac, e.ifn]));
  rows.sort((a, b) => ip2n(a[0]) - ip2n(b[0]));
  rows.forEach(r => out.push('Internet  ' + pad(r[0], 17) + lpad(r[1], 9) + '   ' + pad(r[2], 16) + 'ARPA   ' + r[3]));
  return out.join('\n');
}
function showNat(d) {
  const out = ['Pro  Inside global         Inside local          Outside local         Outside global'];
  NL.rt(d).nat.forEach(e => {
    const g = `${e.ig}:${e.igp}`, l = `${e.il}:${e.ilp}`, o = `${e.ol}:${e.olp}`;
    out.push(pad(e.proto, 5) + pad(g, 22) + pad(l, 22) + pad(o, 22) + o);
  });
  d.cfg.nat.rules.filter(r => r.kind === 'static').forEach(r => out.push(pad('---', 5) + pad(r.global, 22) + pad(r.local, 22) + pad('---', 22) + '---'));
  return out.join('\n');
}
function showNatStats(d) {
  const c = d.cfg, ins = Object.entries(c.interfaces).filter(([, i]) => i.natInside).map(([n]) => n), outs = Object.entries(c.interfaces).filter(([, i]) => i.natOutside).map(([n]) => n);
  const st = c.nat.rules.filter(r => r.kind === 'static').length, dyn = NL.rt(d).nat.length;
  return `Total translations: ${st + dyn} (${st} static, ${dyn} dynamic, ${dyn} extended)\nOutside Interfaces: ${outs.join(', ')}\nInside Interfaces: ${ins.join(', ')}\nHits: ${NL.rt(d).nat.reduce((s, e) => s + (e.hits || 0), 0)}  Misses: 0\nExpired translations: 0\nDynamic mappings:\n` +
    c.nat.rules.filter(r => r.kind === 'dynamic').map(r => `-- Inside Source\naccess-list ${r.acl} ${r.iface ? 'interface ' + r.iface : 'pool ' + r.pool} refCount ${dyn}`).join('\n');
}
function showAcl(d, name) {
  const out = [];
  const hits = NL.rt(d).aclHits;
  for (const [n, a] of Object.entries(d.cfg.acls)) {
    if (name && String(name) !== n) continue;
    out.push(`${a.type === 'standard' ? 'Standard' : 'Extended'} IP access list ${n}`);
    a.entries.forEach(e => {
      if (e.remark != null) return;
      let t = NL.aceText(a.type, e);
      if (a.type === 'standard' && !e.src.any && e.src.w !== '0.0.0.0') t = `${e.action} ${e.src.a}, wildcard bits ${e.src.w}`;
      const h = (hits[n] || {})[e.seq];
      out.push(`    ${e.seq} ${t}${h ? ` (${h} match(es))` : ''}`);
    });
  }
  return out.join('\n');
}
function showVlan(d, brief) {
  const out = ['', 'VLAN Name                             Status    Ports', '---- -------------------------------- --------- -------------------------------'];
  const vids = Object.keys(d.vlans).map(Number).sort((a, b) => a - b);
  for (const v of vids) {
    const ports = NL.MODELS[d.model].ports.filter(p => NL.isSwPort(d, p) && (d.cfg.interfaces[p].accessVlan || 1) === v && !(NL.portLinkUp(d, p) && NL.effMode(d, p) === 'trunk')).map(shortIf);
    const lines = []; for (let i = 0; i < ports.length; i += 4) lines.push(ports.slice(i, i + 4).join(', '));
    out.push(pad(v, 5) + pad(d.vlans[v].name, 33) + pad('active', 10) + (lines[0] || ''));
    lines.slice(1).forEach(l => out.push(' '.repeat(48) + l));
  }
  out.push('1002 fddi-default                     active    ', '1003 token-ring-default               active    ', '1004 fddinet-default                  active    ', '1005 trnet-default                    active    ');
  if (!brief) {
    out.push('', 'VLAN Type  SAID       MTU   Parent RingNo BridgeNo Stp  BrdgMode Trans1 Trans2', '---- ----- ---------- ----- ------ ------ -------- ---- -------- ------ ------');
    vids.forEach(v => out.push(pad(v, 5) + 'enet  ' + pad(100000 + v, 11) + '1500  -      -      -        -    -        0      0'));
  }
  return out.join('\n');
}
function showMac(d) {
  const out = ['          Mac Address Table', '-------------------------------------------', '', 'Vlan    Mac Address       Type        Ports', '----    -----------       --------    -----'];
  const rows = Object.entries(NL.rt(d).mac).filter(([, p]) => p).map(([k, p]) => { const [v, m] = k.split('|'); return [+v, m, p]; });
  rows.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
  rows.forEach(r => out.push(lpad(r[0], 4) + '    ' + pad(r[1], 18) + pad('DYNAMIC', 12) + shortIf(r[2])));
  return out.join('\n');
}
function showCdp(d, detail) {
  const nb = NL.cdpNeighbors(d);
  const cap = x => NL.kind(x) === 'router' ? 'R' : NL.kind(x) === 'l3switch' ? 'R S I' : 'S';
  const sp = p => shortIf(p).replace(/^Gi/, 'Gig ').replace(/^Fa/, 'Fas ');
  if (detail) return nb.map(n => {
    const li = NL.l3ifs(n.dev).find(i => i.up && i.ip);
    return `-------------------------\nDevice ID: ${n.dev.cfg.hostname}\nEntry address(es): \n${li ? '  IP address: ' + li.ip + '\n' : ''}Platform: cisco ${platform(n.dev)}, Capabilities: ${cap(n.dev) === 'R' ? 'Router' : 'Switch'}\nInterface: ${n.port},  Port ID (outgoing port): ${n.rport}\nHoldtime: 171\n\nVersion :\n${VER[n.dev.model][0]}\n`;
  }).join('\n');
  const out = ['Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge', '                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone', 'Device ID    Local Intrfce   Holdtme    Capability   Platform    Port ID'];
  nb.forEach(n => out.push(pad(n.dev.cfg.hostname, 13) + pad(sp(n.port), 16) + pad('171', 11) + pad(cap(n.dev), 13) + pad(platform(n.dev), 12) + sp(n.rport)));
  return out.join('\n');
}
function showStp(d, onlyV) {
  const st = NL.stp(), out = [];
  const vids = Object.keys(d.vlans).map(Number).sort((a, b) => a - b).filter(v => !onlyV || v === onlyV);
  for (const v of vids) {
    const info = st.info[v]; if (!info || !(d.id in info.root)) continue;
    const ports = NL.MODELS[d.model].ports.filter(p => {
      if (!NL.isSwPort(d, p) || !NL.portLinkUp(d, p)) return false;
      const i = d.cfg.interfaces[p];
      return NL.effMode(d, p) === 'access' ? (i.accessVlan || 1) === v : NL.trunkAllows(i, v);
    });
    if (!ports.length) continue;
    const root = NL.dev(info.root[d.id]); const rb = st.bid(root, v), mb = st.bid(d, v);
    out.push('VLAN' + String(v).padStart(4, '0'), '  Spanning tree enabled protocol ieee', `  Root ID    Priority    ${rb[0]}`, `             Address     ${rb[1]}`);
    if (root === d) out.push('             This bridge is the root');
    else { const rp = ports.find(p => NL.stpRole(d, p, v) === 'Root'); out.push(`             Cost        ${info.cost[d.id]}`, `             Port        ${rp ? NL.MODELS[d.model].ports.indexOf(rp) + 1 + '(' + rp + ')' : '-'}`); }
    out.push('             Hello Time  2 sec  Max Age 20 sec  Forward Delay 15 sec', '', `  Bridge ID  Priority    ${mb[0]}  (priority ${mb[0] - v} sys-id-ext ${v})`, `             Address     ${mb[1]}`, '             Hello Time  2 sec  Max Age 20 sec  Forward Delay 15 sec', '             Aging Time  20', '', 'Interface        Role Sts Cost      Prio.Nbr Type', '---------------- ---- --- --------- -------- --------------------------------');
    ports.forEach(p => {
      const role = NL.stpRole(d, p, v);
      out.push(pad(shortIf(p), 17) + pad(role, 5) + pad(role === 'Altn' ? 'BLK' : 'FWD', 4) + pad(p.startsWith('Gig') ? 4 : 19, 10) + pad('128.' + (NL.MODELS[d.model].ports.indexOf(p) + 1), 9) + 'P2p');
    });
    out.push('');
  }
  return out.join('\n');
}
function drRoles(d) {
  const nbrs = NL.ospfNbrs(d), me = NL.routerId(d), roles = {};
  const byIf = {};
  nbrs.forEach(n => (byIf[n.ifn] = byIf[n.ifn] || []).push(n.rid));
  for (const [ifn, rids] of Object.entries(byIf)) {
    const all = [me, ...rids].sort((a, b) => ip2n(b) - ip2n(a));
    roles[ifn] = { dr: all[0], bdr: all[1] };
  }
  return roles;
}
function showOspfNbr(d) {
  const out = ['', 'Neighbor ID     Pri   State           Dead Time   Address         Interface'];
  const roles = drRoles(d);
  NL.ospfNbrs(d).forEach(n => {
    const r = roles[n.ifn]; const st = n.rid === r.dr ? 'FULL/DR' : n.rid === r.bdr ? 'FULL/BDR' : 'FULL/DROTHER';
    out.push(pad(n.rid, 16) + lpad('1', 3) + '   ' + pad(st, 16) + pad('00:00:3' + (n.rid.length % 10), 12) + pad(n.ip, 16) + n.ifn);
  });
  return out.join('\n');
}
function showOspfIntBrief(d) {
  const out = ['Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C'];
  const roles = drRoles(d), me = NL.routerId(d);
  NL.ospfIfaces(d).forEach(o => {
    const r = roles[o.li.name]; const nb = NL.ospfNbrs(d).filter(n => n.ifn === o.li.name).length;
    const st = o.li.t === 'lo' ? 'LOOP' : !r ? 'DR' : r.dr === me ? 'DR' : r.bdr === me ? 'BDR' : 'DROTH';
    out.push(pad(shortIf(o.li.name), 13) + pad(d.cfg.ospf.pid, 6) + pad(o.area, 16) + pad(o.li.ip + '/' + maskLen(o.li.mask), 19) + pad(o.cost, 6) + pad(st, 6) + nb + '/' + nb);
  });
  return out.join('\n');
}
function showProtocols(d) {
  const o = d.cfg.ospf;
  if (!o) return '';
  const nb = NL.ospfNbrs(d);
  return `Routing Protocol is "ospf ${o.pid}"\n  Outgoing update filter list for all interfaces is not set\n  Incoming update filter list for all interfaces is not set\n  Router ID ${NL.routerId(d)}\n  Number of areas in this router is ${new Set(o.networks.map(n => n.area)).size}. ${new Set(o.networks.map(n => n.area)).size} normal 0 stub 0 nssa\n  Maximum path: 4\n  Routing for Networks:\n${o.networks.map(n => `    ${n.addr} ${n.wild} area ${n.area}`).join('\n')}\n${(o.passiveDefault || o.passive.length) ? '  Passive Interface(s):\n' + (o.passiveDefault ? Object.keys(d.cfg.interfaces).filter(n => !(o.noPassive || []).includes(n)) : o.passive).map(p => '    ' + p).join('\n') + '\n' : ''}  Routing Information Sources:\n    Gateway         Distance      Last Update\n${nb.map(n => '    ' + pad(n.rid, 16) + lpad('110', 8) + '      00:00:12').join('\n')}\n  Distance: (default is 110)`;
}
function showDhcpBinding(d) {
  const out = ['IP address       Client-ID/              Lease expiration        Type', '                 Hardware address'];
  Object.entries(NL.rt(d).dhcpBind).forEach(([ip, b]) => out.push(pad(ip, 17) + pad(b.mac.toUpperCase(), 24) + pad('--', 24) + 'Automatic'));
  return out.join('\n');
}
function showDhcpPool(d) {
  return Object.entries(d.cfg.dhcp.pools).map(([n, p]) => {
    const total = p.mask ? Math.pow(2, 32 - maskLen(p.mask)) - 2 : 0;
    const leased = Object.values(NL.rt(d).dhcpBind).filter(b => b.pool === n).length;
    return `\nPool ${n} :\n Utilization mark (high/low)    : 100 / 0\n Subnet size (first/next)       : 0 / 0 \n Total addresses                : ${total}\n Leased addresses               : ${leased}\n Excluded addresses             : ${(d.cfg.dhcp.excluded || []).length}\n Pending event                  : none\n\n 1 subnet is currently in the pool\n Current index        IP address range                    Leased/Excluded/Total\n ${pad(p.network || '0.0.0.0', 20)} ${p.network || '-'}      - ${p.network ? n2ip((ip2n(p.network) + total) >>> 0) : '-'}    ${leased}    / 0    / ${total}`;
  }).join('\n');
}
function flashList(d) {
  const img = { '2911': 'c2900-universalk9-mz.SPA.151-4.M4.bin', '4331': 'isr4300-universalk9.16.09.04.SPA.bin', '2960': 'c2960-lanbasek9-mz.150-2.SE4.bin', '3560': 'c3560-advipservicesk9-mz.122-37.SE1.bin' }[d.model];
  const vd = NL.kind(d) !== 'router' && !NL.rt(d).vlanDatDeleted ? '\n    2  -rw-         736          <no date>  vlan.dat' : '';
  return `Directory of flash:/\n\n    1  -rw-    33591768          <no date>  ${img}${vd}\n\n64016384 bytes total (30424616 bytes free)`;
}

// =====================================================================
// Session
// =====================================================================
const SESSIONS = new Set();
class Session {
  constructor(dev, opt = {}) {
    this.dev = dev; this.remote = !!opt.remote; this.peerName = opt.peerName || '';
    this.mode = 'u'; this.ifs = []; this.hist = []; this.pending = null; this.closed = false;
    this.w = () => {}; this.onClose = opt.onClose || (() => {});
    this.isIOS = true; this.loginUser = opt.user || null;
    SESSIONS.add(this);
  }
  get c() { return this.dev.cfg; }
  prompt() {
    if (this.pending) return this.pending.prompt;
    if (!this.dev.power) return '';
    if (this.mode === 'i') return this.c.hostname + ({ if: '(config-if)#', subif: '(config-subif)#', range: '(config-if-range)#' }[this.sub] || '(config-if)#');
    return this.c.hostname + PROMPTS[this.mode];
  }
  out(t) { if (t != null && t !== '') this.w(String(t) + '\n'); }
  ask(prompt, cb, secret) { this.pending = { prompt, cb, secret: !!secret }; }
  markErr(col) { this.w(' '.repeat(Math.max(0, this.promptLen + col)) + '^\n% Invalid input detected at \'^\' marker.\n'); }
  boot(first) {
    this.mode = 'u'; this.pending = null;
    if (!this.dev.power) return;
    if (first && !this.remote) {
      this.out(bootText(this.dev));
      if (!this.dev.startup) {
        this.out('\n         --- System Configuration Dialog ---\n');
        this.ask('Would you like to enter the initial configuration dialog? [yes/no]: ', a => {
          if (/^y/i.test(a)) this.out('% このシミュレーターでは初期設定ダイアログは省略します。CLI で設定してください。');
          this.out('\n\nPress RETURN to get started!\n\n');
          this.ask('', () => this.login());
        });
        return;
      }
      this.out('\nPress RETURN to get started!\n');
      this.ask('', () => this.login());
      return;
    }
    this.login();
  }
  login() {
    const c = this.c;
    if (c.banner) this.out('\n' + c.banner + '\n');
    const l = (this.remote ? c.lines.vty : c.lines.con) || {};
    if (l.loginLocal) {
      this.out('\nUser Access Verification\n');
      let tries = 0;
      const ask = () => this.ask('Username: ', u => this.ask('Password: ', p => {
        const usr = c.users[u];
        if (usr && usr.pw === p) { this.loginUser = u; if (usr.priv === 15 || l.privilege === 15) this.mode = 'p'; return; }
        this.out('% Login invalid\n');
        if (++tries >= 3) { this.close('% Bad passwords'); return; }
        ask();
      }, true));
      ask(); return;
    }
    if (l.login !== false && (l.login || this.remote)) {
      if (!l.password) {
        if (this.remote && l.login !== false) { this.close('\nPassword required, but none set\n'); return; }
      } else {
        this.out('\nUser Access Verification\n');
        let tries = 0;
        const ask = () => this.ask('Password: ', p => {
          if (p === l.password) { if (l.privilege === 15) this.mode = 'p'; return; }
          if (++tries >= 3) { this.close('% Bad passwords'); return; }
          ask();
        }, true);
        ask(); return;
      }
    }
    if (l.privilege === 15) this.mode = 'p';
  }
  close(msg) {
    if (msg) this.out(msg);
    if (this.remote) { this.closed = true; SESSIONS.delete(this); this.onClose(); return; }
    this.out(`\n${this.c.hostname} con0 is now available\n\n\n\n\n\nPress RETURN to get started.\n`);
    this.mode = 'u';
    this.ask('', () => this.login());
  }
  logout() { this.close(''); }
  configured() { if (!this.remote) NL.emit('syslog', this.dev, '%SYS-5-CONFIG_I: Configured from console by console'); else NL.emit('syslog', this.dev, `%SYS-5-CONFIG_I: Configured from console by vty0 (${this.peerName})`); }
  doEnable() {
    if (this.mode === 'p') return;
    const sec = this.c.enableSecret, pw = this.c.enablePassword;
    if (!sec && !pw) { if (this.remote) { this.out('% No password set'); return; } this.mode = 'p'; return; }
    let tries = 0;
    const ask = () => this.ask('Password: ', p => {
      if ((sec && p === sec) || (!sec && p === pw)) { this.mode = 'p'; return; }
      if (++tries >= 3) { this.out('% Bad secrets\n'); return; }
      ask();
    }, true);
    ask();
  }
  doReload() {
    this.out('System Bootstrap, Version 15.1(4)M4, RELEASE SOFTWARE (fc1)\n...');
    const vlDel = NL.rt(this.dev).vlanDatDeleted;
    NL.reload(this.dev);
    if (vlDel && NL.kind(this.dev) !== 'router') this.dev.vlans = { 1: { name: 'default' } };
    NL.touch('cfg');
    this.boot(true);
  }
  async doPing(x) {
    const dst = x.v[0]; const o = {};
    const vi = k => { const idx = x.w.indexOf(k); return idx >= 0 ? x.w[idx + 1] : null; };
    if (vi('repeat')) o.count = +vi('repeat');
    if (vi('size')) o.size = +vi('size');
    const src = vi('source');
    if (src) {
      if (isIP(src)) { if (!NL.isMine(this.dev, src)) { this.out(`% Invalid source address- IP address not on any of our up interfaces`); return; } o.src = src; }
      else { const n = normIf(src); const li = n && NL.l3ifs(this.dev).find(i => i.name === n && i.up); if (!li) { this.out('% Invalid source interface - Interface down or not configured'); return; } o.src = li.ip; }
    }
    const count = o.count || 5, size = o.size || 100;
    this.out('Type escape sequence to abort.');
    this.out(`Sending ${count}, ${size}-byte ICMP Echos to ${dst}, timeout is 2 seconds:`);
    if (o.src) this.out('Packet sent with a source address of ' + o.src);
    const res = NL.ping(this.dev, dst, Object.assign({ count }, o));
    let ok = 0;
    for (const r of res) {
      const ch = r.r === 'ok' ? '!' : r.r === 'unreach' ? 'U' : r.r === 'ttl' ? '&' : '.';
      if (ch === '!') ok++;
      await sleep(ch === '.' ? 350 : 70);
      this.w(ch);
    }
    this.w('\n');
    this.out(`Success rate is ${Math.round(ok * 100 / count)} percent (${ok}/${count})${ok ? ', round-trip min/avg/max = 0/1/4 ms' : ''}`);
  }
  async doTrace(dst) {
    this.out('Type escape sequence to abort.');
    this.out(`Tracing the route to ${dst}\n`);
    const hops = NL.trace(this.dev, dst);
    for (const h of hops) {
      await sleep(h.from ? 120 : 500);
      if (!h.from) { this.out(lpad(h.ttl, 3) + '   *    *    *'); continue; }
      const marks = h.tries.map(t => !t ? '*' : t.r === 'unreach' ? '!H' : '0 msec').map(s => pad(s, 9)).join(' ');
      this.out(lpad(h.ttl, 3) + '   ' + pad(h.from, 16) + marks);
    }
  }
  remote(proto, ip, user) {
    return NL.ios.openRemote(this, proto, ip, user);
  }
  // terminal entry points
  input(line) {
    if (this.pending) { const p = this.pending; this.pending = null; return p.cb(line); }
    return this.exec(line);
  }
  exec(line, opts = {}) {
    this.promptLen = this.prompt().length;
    const raw = line;
    line = line.replace(/\s+$/, '');
    if (!line.trim() || line.trim()[0] === '!') return;
    if (!opts.silent) { this.hist.push(line); if (this.hist.length > 50) this.hist.shift(); }
    // output filters: show ... | include / exclude / begin / section <regex>
    const pm = /^(.*?)\s*\|\s*(\S+)\s+(.+)$/.exec(line);
    if (pm && /^(do\s+)?sh/i.test(pm[1].trim())) {
      const kind = ['include', 'exclude', 'begin', 'section'].find(k => k.startsWith(pm[2].toLowerCase()));
      if (!kind) { this.markErr(line.indexOf(pm[2])); return; }
      let re; try { re = new RegExp(pm[3]); } catch (e) { re = { test: s => s.includes(pm[3]) }; }
      const w0 = this.w; let buf = '';
      this.w = t => { buf += t; };
      try { this.exec(pm[1], { silent: true }); } finally { this.w = w0; }
      let lines = buf.replace(/\n$/, '').split('\n');
      if (kind === 'include') lines = lines.filter(l => re.test(l));
      else if (kind === 'exclude') lines = lines.filter(l => !re.test(l));
      else if (kind === 'begin') { const i = lines.findIndex(l => re.test(l)); lines = i < 0 ? [] : lines.slice(i); }
      else { const out = []; let on = false; for (const l of lines) { if (/^\S/.test(l)) on = re.test(l); if (on) out.push(l); } lines = out; }
      if (lines.length) this.w(lines.join('\n') + '\n');
      return;
    }
    let toks = tokenize(line);
    const kc = kindChar(this.dev);
    const cfgMode = this.mode !== 'u' && this.mode !== 'p';
    // do <exec>
    if (cfgMode && 'do'.startsWith(toks[0].v.toLowerCase()) && toks[0].v.toLowerCase() === 'do' && toks.length > 1) {
      const sub = line.slice(toks[1].p);
      const m0 = this.mode; this.mode = 'p'; this.promptLen += toks[1].p;
      const r = this.run(sub, 'p', kc, false);
      if (this.mode === 'p') this.mode = m0;
      return r;
    }
    let neg = false;
    if (toks.length && toks[0].v.toLowerCase() === 'no' && this.mode !== 'u') {
      neg = true; this.promptLen += toks[1] ? toks[1].p : 3; line = line.slice(toks[1] ? toks[1].p : line.length);
      if (!line) { this.out('% Incomplete command.'); return; }
    }
    const r = this.run(line, this.mode, kc, neg);
    return r;
  }
  run(line, mode, kc, neg) {
    const toks = tokenize(line);
    let res = walk(trie(mode, kc, neg), toks, line);
    let useMode = mode;
    if (res.err && ['i', 'r', 'l', 'v', 'd', 's', 'e'].includes(mode)) {
      const alt = walk(trie('c', kc, neg), toks, line);
      if (!alt.err) { res = alt; useMode = 'c'; }
    }
    if (res.err) {
      if (res.err === 'inc') { this.out('% Incomplete command.\n'); return; }
      if (res.err === 'amb') { this.out(`% Ambiguous command:  "${line.trim()}"`); return; }
      if ((mode === 'u' || mode === 'p') && res.at === 0 && toks.length === 1 && this.c.domainLookup && !neg) {
        return (async () => { this.out(`Translating "${toks[0].v}"...domain server (255.255.255.255)`); await sleep(900); this.out('% Unknown command or computer name, or unable to find computer address'); })();
      }
      this.markErr(toks[res.at] ? toks[res.at].p : line.length);
      return;
    }
    if (useMode !== mode) this.mode = 'c';
    const x = { s: this, d: this.dev, c: this.dev.cfg, v: res.vals, w: res.words, neg, out: t => this.out(t), posOf: k => (toks[k] ? toks[k].p : 0) };
    const spec = res.spec;
    const r = spec.f(x);
    if (r === INV) { this.markErr(toks[toks.length - 1].p); return; }
    if (r && typeof r.then === 'function') return r;
    if (spec.cfg && r !== false) NL.touch('cfg');
    return r;
  }
  help(line) {
    if (this.pending) return null;
    const toks = tokenize(line);
    const endsSpace = /\s$/.test(line) || line === '';
    const partial = endsSpace ? null : (toks.length ? toks.pop().v : '');
    let mode = this.mode, neg = false, start = 0;
    const kc = kindChar(this.dev);
    const sub0 = ['i', 'r', 'l', 'v', 'd', 's', 'e'].includes(mode);
    if (toks[start] && toks[start].v.toLowerCase() === 'do' && mode !== 'u' && mode !== 'p') { mode = 'p'; start++; }
    if (toks[start] && toks[start].v.toLowerCase() === 'no' && mode !== 'u') { neg = true; start++; }
    const body = toks.slice(start);
    const sub = body.length ? line.slice(body[0].p, body[body.length - 1].p + body[body.length - 1].v.length) : '';
    const roots = [trie(mode, kc, neg)];
    if (sub0 && mode !== 'p') roots.push(trie('c', kc, neg));
    const ent = [];
    let node = null;
    for (const root of roots) {
      let n = root;
      if (sub) {
        const r = walk(root, tokenize(sub), sub);
        if (r.err && r.err !== 'inc') continue;
        n = r.node;
      }
      if (root !== roots[0] && !sub && partial == null) continue;
      node = node || n;
      const ctx = (root === roots[0] ? mode : 'c') + ':';
      for (const [w, nn] of Object.entries(n.lits)) ent.push({ w: nn.disp || w, h: H[ctx + w] || H[w] || '', lit: true });
      for (const a of n.args) ent.push({ w: a.arg.t === 'IF' ? 'IF' : argName(a.arg), h: a.help, arg: a.arg });
      if (n.end) ent.push({ w: '<cr>', h: '' });
      if (!body.length && !neg && mode !== 'u') {
        if (root === roots[0] && mode !== 'p') ent.push({ w: 'do', h: H.do, lit: true });
        if (root === roots[0]) ent.push({ w: 'no', h: H.no, lit: true });
      }
    }
    if (!node) return '% Unrecognized command';
    const seen = new Set(); const uniq = ent.filter(e => { const k = e.w + e.h; if (seen.has(k)) return false; seen.add(k); return true; });
    if (partial != null) {
      const m = uniq.filter(e => e.lit && e.w.toLowerCase().startsWith(partial.toLowerCase())).map(e => e.w);
      if (!m.length) {
        const ifA = uniq.find(e => e.arg && e.arg.t === 'IF');
        if (ifA) return ifTypes(this.dev).filter(t => t.toLowerCase().startsWith(partial.toLowerCase())).join('  ') || '% Unrecognized command';
        return '% Unrecognized command';
      }
      return [...new Set(m)].sort().join('  ');
    }
    const rows = [];
    for (const e of uniq) {
      if (e.w === 'IF') { ifTypes(this.dev).forEach(t => rows.push({ w: t, h: { GigabitEthernet: 'GigabitEthernet IEEE 802.3z', FastEthernet: 'FastEthernet IEEE 802.3', Vlan: 'Catalyst Vlans', Loopback: 'Loopback interface' }[t] || '' })); continue; }
      rows.push(e);
    }
    const lits = rows.filter(r => !r.arg && r.w !== '<cr>').sort((a, b) => a.w.localeCompare(b.w));
    const args = rows.filter(r => r.arg);
    const cr = rows.filter(r => r.w === '<cr>');
    const all = [...args, ...lits, ...cr];
    const wmax = Math.max(...all.map(r => r.w.length), 4);
    return all.map(r => '  ' + pad(r.w, wmax + 2) + r.h).join('\n');
  }
  complete(line) {
    if (this.pending) return line;
    const toks = tokenize(line);
    if (!toks.length || /\s$/.test(line)) return line;
    const last = toks[toks.length - 1];
    let prefix = toks.slice(0, -1);
    let mode = this.mode, neg = false;
    const kc = kindChar(this.dev);
    let pre = prefix;
    if (pre.length && pre[0].v.toLowerCase() === 'do' && mode !== 'u' && mode !== 'p') { pre = pre.slice(1); mode = 'p'; }
    if (pre.length && pre[0].v.toLowerCase() === 'no' && mode !== 'u') { pre = pre.slice(1); neg = true; }
    const tryRoot = root => {
      const sub = pre.length ? line.slice(pre[0].p, last.p) : '';
      const r = sub ? walk(root, tokenize(sub), sub) : { node: root };
      if (r.err && r.err !== 'inc') return null;
      const n = r.node;
      const c = Object.keys(n.lits).filter(w => w.startsWith(last.v.toLowerCase()));
      if (c.length === 1) return (n.lits[c[0]].disp || c[0]);
      if (n.args.some(a => a.arg.t === 'IF')) {
        const m = /^([a-zA-Z-]+)(.*)$/.exec(last.v);
        if (m) { const t = ifType(m[1]); if (t) return t + m[2]; }
      }
      return null;
    };
    let rep = tryRoot(trie(mode, kc, neg));
    if (!rep && !pre.length && ['i', 'r', 'l', 'v', 'd', 's', 'e'].includes(mode)) rep = tryRoot(trie('c', kc, neg));
    if (!rep) return line;
    return line.slice(0, last.p) + rep + (/^[A-Za-z-]+$/.test(rep) && !/\d$/.test(rep) && !ifTypes(this.dev).includes(rep) ? ' ' : '');
  }
  ctrlZ() { if (this.mode !== 'u' && this.mode !== 'p') { this.w(this.prompt() + '^Z\n'); this.mode = 'p'; this.configured(); } }
  ctrlC() { this.pending = null; this.w('^C\n'); if (this.mode !== 'u' && this.mode !== 'p') { this.mode = 'p'; } }
}
const ifTypes = d => NL.kind(d) === 'router' ? (d.model === '4331' ? ['GigabitEthernet', 'Loopback'] : ['GigabitEthernet', 'Loopback']) : ['FastEthernet', 'GigabitEthernet', 'Loopback', 'Vlan'];
const sleep = ms => new Promise(r => setTimeout(r, NL.ios && NL.ios.fast ? 0 : ms));
function bootText(d) {
  const v = VER[d.model];
  return `System Bootstrap, Version 15.1(4)M4, RELEASE SOFTWARE (fc1)\nCopyright (c) 2010 by cisco Systems, Inc.\n\nReadonly ROMMON initialized\n\nSelf decompressing the image : ########################################## [OK]\n\n${v[0]}\nCopyright (c) 1986-2016 by Cisco Systems, Inc.\n\n${v[2]}\n${v[3]}\n255K bytes of non-volatile configuration memory.`;
}

NL.on('syslog', (dev, msg) => {
  for (const s of SESSIONS) if (s.dev === dev && !s.remote && s.onAsync) s.onAsync('\n' + msg + '\n');
});

NL.ios = {
  Session, runConf, ifOrder, tokenize, H,
  sessions: SESSIONS,
  // used by the Config tab: runs commands as if typed and returns the transcript
  batch(dev, lines) {
    const s = new Session(dev); s.mode = 'p'; let buf = '';
    s.w = t => { buf += t; };
    for (const l of lines) { buf += s.prompt() + l + '\n'; s.exec(l, { silent: true }); }
    SESSIONS.delete(s);
    return buf;
  },
  openRemote(from, proto, ip, user) {
    const fromDev = from.dev || from;
    const port = proto === 'ssh' ? 22 : 23;
    const write = t => from.out ? from.out(t) : null;
    write(proto === 'telnet' ? `Trying ${ip} ...` : '');
    const r = NL.tcp(fromDev, ip, port);
    if (r.r !== 'ok') {
      write(r.r === 'rst' ? `% Connection refused by remote host` : `% Connection timed out; remote host not responding`);
      return;
    }
    const target = NL.ipToDev(ip);
    if (!target || !NL.isCisco(target)) { write('% Connection refused by remote host'); return; }
    if (proto === 'telnet') write('Open');
    const vty = target.cfg.lines.vty || {};
    const rs = new Session(target, { remote: true, peerName: (NL.l3ifs(fromDev).find(i => i.up) || {}).ip || '' });
    if (proto === 'ssh') {
      if (!vty.loginLocal) { write('% Connection refused by remote host'); SESSIONS.delete(rs); return; }
      if (!from.host) return;
      from.host.push(rs, `[Connection to ${ip} closed by foreign host]`);
      rs.ask('Password: ', p => {
        const u = target.cfg.users[user];
        if (!u || u.pw !== p) { rs.close('% Authentication failed.'); return; }
        rs.loginUser = user; if (u.priv === 15) rs.mode = 'p';
        if (target.cfg.banner) rs.out('\n' + target.cfg.banner + '\n');
      }, true);
      return;
    }
    if (from.host) { from.host.push(rs, `\n[Connection to ${ip} closed by foreign host]`); rs.boot(false); }
  }
};
})(typeof window !== 'undefined' ? window : globalThis);
