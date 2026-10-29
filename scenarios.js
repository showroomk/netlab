/* NetLab preset labs. Each build() starts from an empty lab, places devices, cables them, and optionally configures them. */
(function (G) {
'use strict';
const NL = G.NL;
const add = (model, x, y, name) => NL.addDevice(model, x, y, { name });
const link = (a, ap, b, bp, cable) => { const r = NL.connect(a, ap, b, bp, cable || 'auto'); if (typeof r === 'string') console.warn(r, a.name, ap, b.name, bp); return r; };
const ios = (dev, lines) => { NL.ios.batch(dev, ['configure terminal', ...lines, 'end']); dev.startup = NL.util.clone(dev.cfg); };
const host = (dev, ip, mask, gw) => { Object.assign(dev.cfg, { ip, mask, gw }); };

function diagramTopology() {
  const L = {};
  L.gw = add('3560', 640, 110, 'GW');
  L.pop = add('pop', 1010, 90, 'Cato Cloud');
  L.pc0 = add('pc', 230, 250, 'PC#0');
  L.rt1 = add('2911', 470, 290, 'RT1');
  L.rt2 = add('2911', 810, 290, 'RT2');
  L.sm = add('x1500', 470, 500, 'Socket M');
  L.sb = add('x1500', 810, 500, 'Socket B');
  L.sw = add('3560', 640, 680, 'L2SW');
  L.pc2 = add('pc', 640, 840, 'PC#2');
  L.sc = add('x1500', 1150, 330, 'Socket 拠点B');
  L.pc1 = add('pc', 1150, 540, 'PC#1');
  link(L.gw, 'FastEthernet0/1', L.rt1, 'GigabitEthernet0/2');
  link(L.gw, 'FastEthernet0/2', L.rt2, 'GigabitEthernet0/2');
  link(L.gw, 'FastEthernet0/3', L.sc, 'WAN1');
  link(L.gw, 'FastEthernet0/4', L.pc0, 'FastEthernet0');
  link(L.gw, 'FastEthernet0/5', L.pop, 'eth0');
  link(L.rt1, 'GigabitEthernet0/0', L.sm, 'WAN1');
  link(L.rt2, 'GigabitEthernet0/0', L.sm, 'WAN2');
  link(L.rt1, 'GigabitEthernet0/1', L.sb, 'WAN1');
  link(L.rt2, 'GigabitEthernet0/1', L.sb, 'WAN2');
  link(L.sm, 'LAN1', L.sw, 'GigabitEthernet0/1');
  link(L.sb, 'LAN1', L.sw, 'GigabitEthernet0/2');
  link(L.sw, 'FastEthernet0/1', L.pc2, 'FastEthernet0');
  link(L.sc, 'LAN1', L.pc1, 'FastEthernet0');
  // the cloud side is infrastructure, so it comes pre-addressed
  Object.assign(L.pop.cfg, { ip: '203.0.113.254', mask: '255.255.255.192', gw: '203.0.113.193' });
  NL.lab.notes.push(
    { id: 'n1', x: 470, y: 400, text: '拠点A（Socket HA 構成）' },
    { id: 'n2', x: 1150, y: 430, text: '拠点B' },
    { id: 'n3', x: 230, y: 330, text: 'リモート（Cato Client）' },
    { id: 'n4', x: 1010, y: 160, text: 'GW 側セグメント 203.0.113.192/26' }
  );
  return L;
}

function configureDiagram(L) {
  ios(L.gw, ['hostname GW', 'ip routing', 'interface vlan 1', 'ip address 203.0.113.193 255.255.255.192', 'no shutdown', 'exit',
    'ip route 10.0.0.0 255.255.255.240 203.0.113.194', 'ip route 10.0.0.0 255.255.255.240 203.0.113.195 250',
    'ip route 10.0.1.0 255.255.255.0 203.0.113.194', 'ip route 10.0.1.0 255.255.255.0 203.0.113.195 250',
    'ip route 10.0.2.0 255.255.255.0 203.0.113.196', 'ip route 10.0.3.0 255.255.255.0 203.0.113.197']);
  const rt = (d, name, a, b, wan, socketM, socketB) => ios(d, ['hostname ' + name,
    'interface g0/0', `ip address ${a} 255.255.255.252`, 'ip nat inside', 'no shutdown', 'exit',
    'interface g0/1', `ip address ${b} 255.255.255.252`, 'ip nat inside', 'no shutdown', 'exit',
    'interface g0/2', `ip address ${wan} 255.255.255.192`, 'ip nat outside', 'no shutdown', 'exit',
    'access-list 1 permit 192.168.0.0 0.0.255.255', 'ip nat inside source list 1 interface g0/2 overload',
    `ip route 10.0.0.0 255.255.255.240 ${socketM}`, `ip route 10.0.0.0 255.255.255.240 ${socketB} 250`,
    `ip route 10.0.1.0 255.255.255.0 ${socketM}`, `ip route 10.0.1.0 255.255.255.0 ${socketB} 250`,
    'ip route 10.0.2.0 255.255.255.0 203.0.113.196', 'ip route 10.0.3.0 255.255.255.0 203.0.113.197']);
  rt(L.rt1, 'RT1', '192.168.11.1', '192.168.13.1', '203.0.113.194', '192.168.11.2', '192.168.13.2');
  rt(L.rt2, 'RT2', '192.168.12.1', '192.168.14.1', '203.0.113.195', '192.168.12.2', '192.168.14.2');
  ios(L.sw, ['hostname L2SW', 'vlan 10', 'name SOCKET-LAN', 'exit', 'vlan 20', 'name USERS', 'exit',
    'interface range g0/1 - 2', 'switchport mode access', 'switchport access vlan 10', 'exit',
    'interface fa0/1', 'switchport mode access', 'switchport access vlan 20', 'exit',
    'interface vlan 10', 'ip address 10.0.0.4 255.255.255.240', 'no shutdown', 'exit',
    'interface vlan 20', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'ip routing', 'ip route 0.0.0.0 0.0.0.0 10.0.0.3']);
  host(L.pc0, '203.0.113.197', '255.255.255.192', '203.0.113.193');
  host(L.pc1, '10.0.2.2', '255.255.255.0', '10.0.2.1');
  host(L.pc2, '10.0.1.10', '255.255.255.0', '10.0.1.1');
  NL.touch('cfg');
}
function configureCato(L) {
  const wan = (d, w, ip, mask, gw) => Object.assign(d.cfg.wan[w], { mode: 'static', ip, mask, gw, dns: '' });
  wan(L.sm, 'WAN1', '192.168.11.2', '255.255.255.252', '192.168.11.1');
  wan(L.sm, 'WAN2', '192.168.12.2', '255.255.255.252', '192.168.12.1');
  wan(L.sb, 'WAN1', '192.168.13.2', '255.255.255.252', '192.168.13.1');
  wan(L.sb, 'WAN2', '192.168.14.2', '255.255.255.252', '192.168.14.1');
  wan(L.sc, 'WAN1', '203.0.113.196', '255.255.255.192', '203.0.113.193');
  L.pc0.cfg.catoEmail = 'user01@lab.local';
  const wanPol = () => ({ WAN1: { precedence: 'active', up: 100, down: 100 }, WAN2: { precedence: 'active', up: 100, down: 100 } });
  NL.lab.cato.sites.push(
    { id: 'sA', name: '拠点A', type: 'Branch', conn: 'X1500', country: 'Japan', bw: 100, nativeRange: '10.0.0.0/28', localIp: '10.0.0.3',
      primarySerial: L.sm.serial, secondarySerial: L.sb.serial, ha: { primaryIp: '10.0.0.1', secondaryIp: '10.0.0.2' }, wan: wanPol(),
      ranges: [{ id: 'r1', name: 'VLAN20-USERS', type: 'routed', cidr: '10.0.1.0/24', gw: '10.0.0.4' }] },
    { id: 'sB', name: '拠点B', type: 'Branch', conn: 'X1500', country: 'Japan', bw: 100, nativeRange: '10.0.2.0/24', localIp: '10.0.2.1',
      primarySerial: L.sc.serial, secondarySerial: '', ha: null, wan: wanPol(), ranges: [] }
  );
  NL.lab.cato.users.push({ id: 'u1', name: 'User 01', email: 'user01@lab.local' });
  NL.lab.cato.sdpRange = '10.0.3.0/24';
  NL.touch('cfg');
}

NL.scenarios = [
  {
    id: 'diagram', name: '構成図ラボ（配線済み・未設定）', desc: '前回の構成図どおりに機器を置いて配線だけ済ませた状態です。GW・RT・L2SW・Socket・PC を自分で設定して完成させます。Cato Cloud ノードだけは設定済みです。',
    build() { NL.loadLab(NL.newLab('構成図ラボ')); diagramTopology(); NL.touch('topo'); }
  },
  {
    id: 'diagram-done', name: '構成図ラボ（完成形）', desc: '構成図の設定をすべて投入した答え合わせ用のラボです。数秒でトンネルが張られ、PC#1 から 10.0.0.4 や 10.0.1.10 へ ping が通ります。',
    build() { NL.loadLab(NL.newLab('構成図ラボ（完成形）')); const L = diagramTopology(); configureDiagram(L); configureCato(L); }
  },
  {
    id: 'diagram-cisco', name: '構成図ラボ（Cisco 設定済み・Cato 未設定）', desc: 'GW・RT1・RT2・L2SW と PC の設定まで済んだ状態です。Socket の WAN 設定と管理コンソールでの作業から始められます。',
    build() { NL.loadLab(NL.newLab('構成図ラボ（Cato 練習）')); configureDiagram(diagramTopology()); }
  },
  {
    id: 'cisco-basic', name: 'Cisco 入門ラボ', desc: 'ルーター 1 台・スイッチ 1 台・PC 2 台の小さな構成です。PC0 からはコンソールケーブルでルーターにつながっています。',
    build() {
      NL.loadLab(NL.newLab('Cisco 入門ラボ'));
      const r = add('2911', 520, 180, 'Router0');
      const s = add('2960', 520, 380, 'Switch0');
      const p0 = add('pc', 340, 560, 'PC0');
      const p1 = add('pc', 700, 560, 'PC1');
      link(r, 'GigabitEthernet0/0', s, 'GigabitEthernet0/1');
      link(p0, 'FastEthernet0', s, 'FastEthernet0/1');
      link(p1, 'FastEthernet0', s, 'FastEthernet0/2');
      link(p0, 'RS232', r, 'Console', 'console');
      NL.touch('topo');
    }
  },
  {
    id: 'vlan', name: 'VLAN とルーター・オン・ア・スティック', desc: 'スイッチ 1 台に VLAN 10 と VLAN 20 の PC を 2 台ずつ。ルーターのサブインターフェースで VLAN 間ルーティングを練習します。',
    build() {
      NL.loadLab(NL.newLab('VLAN ラボ'));
      const r = add('2911', 560, 160, 'Router0');
      const s = add('2960', 560, 360, 'Switch0');
      const pcs = [['PC-A', 300], ['PC-B', 480], ['PC-C', 660], ['PC-D', 840]].map(([n, x]) => add('pc', x, 560, n));
      link(r, 'GigabitEthernet0/0', s, 'GigabitEthernet0/1');
      pcs.forEach((p, i) => link(p, 'FastEthernet0', s, 'FastEthernet0/' + (i + 1)));
      NL.lab.notes.push({ id: 'n1', x: 390, y: 640, text: 'VLAN 10: 192.168.10.0/24' }, { id: 'n2', x: 750, y: 640, text: 'VLAN 20: 192.168.20.0/24' });
      NL.touch('topo');
    }
  },
  {
    id: 'ospf', name: 'OSPF 練習（ルーター 3 台）', desc: '3 台のルーターを三角形に接続し、両端に PC を置いた構成です。OSPF で経路を交換させてみましょう。',
    build() {
      NL.loadLab(NL.newLab('OSPF ラボ'));
      const a = add('2911', 400, 220, 'R1'), b = add('2911', 760, 220, 'R2'), c = add('2911', 580, 460, 'R3');
      const p1 = add('pc', 220, 420, 'PC1'), p2 = add('pc', 940, 420, 'PC2');
      link(a, 'GigabitEthernet0/0', b, 'GigabitEthernet0/0');
      link(a, 'GigabitEthernet0/1', c, 'GigabitEthernet0/0');
      link(b, 'GigabitEthernet0/1', c, 'GigabitEthernet0/1');
      link(a, 'GigabitEthernet0/2', p1, 'FastEthernet0');
      link(b, 'GigabitEthernet0/2', p2, 'FastEthernet0');
      NL.lab.notes.push({ id: 'n1', x: 580, y: 150, text: 'R1-R2 10.1.12.0/30・R1-R3 10.1.13.0/30・R2-R3 10.1.23.0/30' });
      NL.touch('topo');
    }
  },
  {
    id: 'blank', name: '空のラボ', desc: '何も置かれていないワークスペースです。下のパレットから機器を置いて自由に組み立てます。',
    build() { NL.loadLab(NL.newLab('新しいラボ')); }
  }
];
NL.scenario = id => NL.scenarios.find(s => s.id === id);
})(typeof window !== 'undefined' ? window : globalThis);
