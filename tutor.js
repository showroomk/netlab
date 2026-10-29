/* NetLab guide drawer: guided labs with automatic checks, manual, AI instructor. */
(function () {
'use strict';
const NL = window.NL, U = NL.util, ui = NL.ui, h = ui.h;
const D = n => NL.byName(n);
const I = (d, n) => (d && d.cfg.interfaces && d.cfg.interfaces[n]) || {};
const ipIs = (d, n, ip, mask) => { const i = I(d, n); return i.ip === ip && i.mask === mask; };
const upAdmin = (d, n) => d && !I(d, n).shutdown;
const pc = (d, ip, mask, gw) => !!d && d.cfg.ip === ip && d.cfg.mask === mask && (!gw || d.cfg.gw === gw);
const ok = new Set();       // "devId>dst" for successful pings
const cli = {};             // devId -> list of lines typed
NL.on('ping', (dev, dst, res) => { if (res.some(r => r.r === 'ok')) ok.add(dev.id + '>' + dst); });
NL.on('cli', (dev, line) => { if (dev) (cli[dev.id] = cli[dev.id] || []).push(line.trim().toLowerCase()); });
NL.on('change', w => { if (w === 'load') { ok.clear(); Object.keys(cli).forEach(k => delete cli[k]); } });
const pinged = (name, dst) => { const d = D(name); return !!d && ok.has(d.id + '>' + dst); };
const typed = (name, re) => { const d = D(name); return !!d && (cli[d.id] || []).some(l => re.test(l)); };
const sessIn = (name, modes) => { const d = D(name); return !!d && [...NL.ios.sessions].some(s => s.dev === d && !s.pending && modes.includes(s.mode)); };
const natOk = (d, wan) => d && I(d, 'GigabitEthernet0/0').natInside && I(d, 'GigabitEthernet0/1').natInside && I(d, 'GigabitEthernet0/2').natOutside &&
  d.cfg.nat.rules.some(r => r.kind === 'dynamic' && r.iface === 'GigabitEthernet0/2' && r.overload) && Object.values(d.cfg.acls).some(a => a.entries.some(e => e.action === 'permit' && e.src && (e.src.any || (e.src.a === '192.168.0.0' && e.src.w === '0.0.255.255'))));
const site = n => NL.lab.cato.sites.find(s => s.name === n);
const wanIs = (n, w, ip, gw) => { const d = D(n); return !!d && d.cfg.wan[w].mode === 'static' && d.cfg.wan[w].ip === ip && d.cfg.wan[w].gw === gw; };
const tun = n => { const d = D(n); return !!d && ['WAN1', 'WAN2'].some(w => NL.cato.tunUp(d, w)); };

const LABS = [
  {
    id: 'cisco', title: 'Cisco IOS はじめの一歩', scenario: 'cisco-basic', level: '入門',
    desc: 'CLI のモード、インターフェース設定、疎通確認、保存までをひと通り体験します。',
    steps: [
      { t: 'ルーターの CLI を開く', b: '<p>ワークスペースの <b>Router0</b> をクリックし、「CLI」タブを開きます。初回は起動メッセージのあと <code>initial configuration dialog?</code> と聞かれるので <code>no</code> と入力し、Enter をもう一度押します。</p><p>プロンプトが <code>Router&gt;</code> になればユーザー EXEC モードです。</p>', hint: 'no\n(Enter)', c: () => sessIn('Router0', ['u', 'p', 'c', 'i', 'r', 'l']) },
      { t: '特権 EXEC モードに入る', b: '<p><code>enable</code> で特権 EXEC モード（<code>Router#</code>）に入ります。<code>en</code> のように省略しても通ります。<code>?</code> を押すと、今使えるコマンドの一覧が出ます。</p>', hint: 'enable', c: () => sessIn('Router0', ['p', 'c', 'i', 'r', 'l']) || D('Router0').cfg.hostname !== 'Router' },
      { t: 'グローバル設定モードに入る', b: '<p><code>configure terminal</code>（省略形 <code>conf t</code>）で設定モード <code>Router(config)#</code> に入ります。ここから下の変更は即座に動作中の設定（running-config）に反映されます。</p>', hint: 'configure terminal', c: () => sessIn('Router0', ['c', 'i', 'r', 'l']) || D('Router0').cfg.hostname !== 'Router' },
      { t: 'ホスト名を R1 にする', b: '<p><code>hostname R1</code> と入力すると、プロンプトがすぐ <code>R1(config)#</code> に変わります。</p>', hint: 'hostname R1', c: () => D('Router0').cfg.hostname === 'R1' },
      { t: 'Gi0/0 に IP を付けて有効にする', b: '<p>ルーターのポートは初期状態で <b>shutdown</b>（無効）です。IP を付けて <code>no shutdown</code> しないと通信できません。</p><p>有効にすると <code>%LINK-5-CHANGED</code> などのログが出ます。</p>', hint: 'interface gigabitEthernet 0/0\nip address 192.168.1.1 255.255.255.0\nno shutdown\nexit', c: () => ipIs(D('Router0'), 'GigabitEthernet0/0', '192.168.1.1', '255.255.255.0') && upAdmin(D('Router0'), 'GigabitEthernet0/0') },
      { t: 'PC に IP を設定する', b: '<p>PC0 をクリック →「デスクトップ」→「IP 設定」で次のように入れます。PC1 も同じ要領です。</p><table><tr><th></th><th>IP</th><th>マスク</th><th>GW</th></tr><tr><td>PC0</td><td>192.168.1.10</td><td>255.255.255.0</td><td>192.168.1.1</td></tr><tr><td>PC1</td><td>192.168.1.11</td><td>255.255.255.0</td><td>192.168.1.1</td></tr></table>', c: () => pc(D('PC0'), '192.168.1.10', '255.255.255.0', '192.168.1.1') && pc(D('PC1'), '192.168.1.11', '255.255.255.0', '192.168.1.1') },
      { t: 'PC0 からルーターへ ping', b: '<p>PC0 の「コマンドプロンプト」で <code>ping 192.168.1.1</code>。最初の 1 回がタイムアウトするのは ARP 解決のためで、実機でもよくある動きです。</p><p>上の「シミュレーション」に切り替えてから ping すると、ARP と ICMP がどう流れるかを 1 コマずつ見られます。</p>', hint: 'ping 192.168.1.1', c: () => pinged('PC0', '192.168.1.1') },
      { t: '状態を確認する show コマンド', b: '<p>ルーターで <code>show ip interface brief</code> と <code>show running-config</code> を実行して、設定と状態を確認します。設定モードの中からは <code>do show ip int br</code> のように <code>do</code> を付けます。</p>', hint: 'show ip interface brief\nshow running-config', c: () => typed('Router0', /^(do )?sh(o|ow)? (ip int|run)/) },
      { t: 'パスワードを設定する', b: '<p>特権モード用に <code>enable secret</code>、コンソールにパスワードを設定します。<code>exit</code> でログアウトして、パスワードを聞かれることを確かめましょう。</p>', hint: 'configure terminal\nenable secret class\nline console 0\npassword cisco\nlogin\nend', c: () => { const c = D('Router0').cfg; return !!c.enableSecret && !!(c.lines.con || {}).password && !!(c.lines.con || {}).login; } },
      { t: '設定を保存する', b: '<p>running-config は電源を切ると消えます。<code>copy running-config startup-config</code>（または <code>write memory</code>）で NVRAM の startup-config に保存します。</p><p>保存後に「物理」タブで電源を入れ直すと、設定が残っていることを確認できます。</p>', hint: 'copy running-config startup-config\n(Enter)', c: () => { const s = D('Router0').startup; return !!s && s.hostname === 'R1' && !!(s.interfaces['GigabitEthernet0/0'] || {}).ip; } }
    ]
  },
  {
    id: 'diagram-cisco', title: '構成図ラボ ①  Cisco 部分', scenario: 'diagram', level: '実践',
    desc: '構成図の GW・RT1・RT2・L2SW を CLI で設定します。RT は 192.168.0.0/16 を WAN 側に PAT します。',
    steps: [
      { t: 'GW の基本設定', b: '<p>GW は L3 スイッチ（Catalyst 3560）です。VLAN 1 の SVI に GW 側セグメントのアドレスを付け、ルーティングを有効にします。</p>', hint: 'enable\nconfigure terminal\nhostname GW\nip routing\ninterface vlan 1\nip address 203.0.113.193 255.255.255.192\nno shutdown\nend', c: () => { const d = D('GW'); return d.cfg.hostname === 'GW' && d.cfg.ipRouting && ipIs(d, 'Vlan1', '203.0.113.193', '255.255.255.192') && upAdmin(d, 'Vlan1'); } },
      { t: 'RT1 のインターフェース', b: '<p>Gi0/0 は Socket M の WAN1、Gi0/1 は Socket B の WAN1、Gi0/2 は GW 側です。3 つとも <code>no shutdown</code> を忘れずに。</p>', hint: 'enable\nconf t\nhostname RT1\ninterface g0/0\nip address 192.168.11.1 255.255.255.252\nno shutdown\ninterface g0/1\nip address 192.168.13.1 255.255.255.252\nno shutdown\ninterface g0/2\nip address 203.0.113.194 255.255.255.192\nno shutdown\nend', c: () => { const d = D('RT1'); return ipIs(d, 'GigabitEthernet0/0', '192.168.11.1', '255.255.255.252') && ipIs(d, 'GigabitEthernet0/1', '192.168.13.1', '255.255.255.252') && ipIs(d, 'GigabitEthernet0/2', '203.0.113.194', '255.255.255.192') && ['GigabitEthernet0/0', 'GigabitEthernet0/1', 'GigabitEthernet0/2'].every(n => upAdmin(d, n)); } },
      { t: 'RT1 の NAT（PAT）', b: '<p>Socket の WAN（192.168.x.x）を GW 側のアドレスに変換します。inside / outside の向きと、ACL で対象を決めるのがポイントです。</p>', hint: 'conf t\ninterface g0/0\nip nat inside\ninterface g0/1\nip nat inside\ninterface g0/2\nip nat outside\nexit\naccess-list 1 permit 192.168.0.0 0.0.255.255\nip nat inside source list 1 interface g0/2 overload\nend', c: () => natOk(D('RT1')) },
      { t: 'RT2 のインターフェースと NAT', b: '<p>RT2 は Gi0/0 = 192.168.12.1（Socket M の WAN2）、Gi0/1 = 192.168.14.1（Socket B の WAN2）、Gi0/2 = 203.0.113.195 です。NAT は RT1 と同じ考え方です。</p>', hint: 'enable\nconf t\nhostname RT2\ninterface g0/0\nip address 192.168.12.1 255.255.255.252\nip nat inside\nno shutdown\ninterface g0/1\nip address 192.168.14.1 255.255.255.252\nip nat inside\nno shutdown\ninterface g0/2\nip address 203.0.113.195 255.255.255.192\nip nat outside\nno shutdown\nexit\naccess-list 1 permit 192.168.0.0 0.0.255.255\nip nat inside source list 1 interface g0/2 overload\nend', c: () => { const d = D('RT2'); return ipIs(d, 'GigabitEthernet0/0', '192.168.12.1', '255.255.255.252') && ipIs(d, 'GigabitEthernet0/1', '192.168.14.1', '255.255.255.252') && ipIs(d, 'GigabitEthernet0/2', '203.0.113.195', '255.255.255.192') && natOk(d); } },
      { t: 'RT1・RT2 から GW へ ping', b: '<p>それぞれの CLI で <code>ping 203.0.113.193</code>。最初の 1 つが <code>.</code> になるのは ARP のためです。</p>', hint: 'ping 203.0.113.193', c: () => pinged('RT1', '203.0.113.193') && pinged('RT2', '203.0.113.193') },
      { t: 'L2SW の VLAN と SVI', b: '<p>Socket がつながる Gi0/1-2 を VLAN 10、テスト用 PC#2 の Fa0/1 を VLAN 20 にします。VLAN 20 は L2SW の SVI でルーティングし、それ以外の宛先は Socket の VIP（10.0.0.3）へ向けます。</p>', hint: 'enable\nconf t\nhostname L2SW\nvlan 10\nname SOCKET-LAN\nvlan 20\nname USERS\nexit\ninterface range g0/1 - 2\nswitchport mode access\nswitchport access vlan 10\ninterface fa0/1\nswitchport mode access\nswitchport access vlan 20\ninterface vlan 10\nip address 10.0.0.4 255.255.255.240\nno shutdown\ninterface vlan 20\nip address 10.0.1.1 255.255.255.0\nno shutdown\nexit\nip routing\nip route 0.0.0.0 0.0.0.0 10.0.0.3\nend', c: () => { const d = D('L2SW'); return !!d.vlans[10] && !!d.vlans[20] && I(d, 'GigabitEthernet0/1').accessVlan === 10 && I(d, 'GigabitEthernet0/2').accessVlan === 10 && I(d, 'FastEthernet0/1').accessVlan === 20 && ipIs(d, 'Vlan10', '10.0.0.4', '255.255.255.240') && ipIs(d, 'Vlan20', '10.0.1.1', '255.255.255.0') && d.cfg.ipRouting && d.cfg.routes.some(r => r.net === '0.0.0.0' && r.nh === '10.0.0.3'); } },
      { t: 'PC#2 の設定と ping', b: '<p>PC#2 を 10.0.1.10/24、ゲートウェイ 10.0.1.1 にして、<code>ping 10.0.1.1</code> と <code>ping 10.0.0.4</code> を試します。</p>', hint: 'ping 10.0.1.1', c: () => pc(D('PC#2'), '10.0.1.10', '255.255.255.0', '10.0.1.1') && pinged('PC#2', '10.0.1.1') },
      { t: '構成図のスタティックルートを入れる', b: '<p>構成図の表のとおり、RT1・RT2・GW にスタティックルートを入れます。予備側は AD（管理距離）を大きくしたフローティングスタティックにします。</p><div class="callout">Cato の拠点間通信はトンネルの中を通るので、実はこのルートは使われません（Socket は WAN 側からの平文の通信を LAN に転送しない）。構成図に書かれている設計として練習します。</div>', hint: 'RT1:\nip route 10.0.0.0 255.255.255.240 192.168.11.2\nip route 10.0.0.0 255.255.255.240 192.168.13.2 250\nip route 10.0.1.0 255.255.255.0 192.168.11.2\nip route 10.0.1.0 255.255.255.0 192.168.13.2 250\nip route 10.0.2.0 255.255.255.0 203.0.113.196\nip route 10.0.3.0 255.255.255.0 203.0.113.197', c: () => D('RT1').cfg.routes.some(r => r.net === '10.0.0.0' && r.nh === '192.168.11.2') && D('RT1').cfg.routes.some(r => r.net === '10.0.0.0' && r.ad > 1) },
      { t: '設定を保存する', b: '<p>GW・RT1・RT2・L2SW で <code>write memory</code>。</p>', hint: 'write memory', c: () => ['GW', 'RT1', 'RT2', 'L2SW'].every(n => !!D(n).startup && D(n).startup.hostname === n) }
    ]
  },
  {
    id: 'cato', title: '構成図ラボ ②  はじめての Cato', scenario: 'diagram-cisco', level: '実践',
    desc: 'Cisco 側は設定済みの状態から始めます。Socket の WAN 設定 → トンネル確立 → サイト作成 → HA → SDP → Firewall → フェイルオーバー試験の順に進めます。',
    steps: [
      { t: 'Cato の全体像をつかむ', b: '<p>Socket は拠点に置く小さな装置で、WAN からインターネット上の <b>PoP</b>（Cato Cloud の入口）へ暗号化トンネルを張ります。拠点間の通信もインターネット向けの通信も、いったん PoP を通ります。設定の大半はクラウドの<b>管理コンソール</b>で行い、Socket 本体ではほぼ WAN の設定だけをします。</p><p>このラボでは右上の「Cato Cloud」ノードが PoP の役です。ガイドのマニュアルタブ「Cato の全体像」も参照してください。</p>', c: () => true },
      { t: 'Socket M の WAN を静的 IP にする', b: '<p>Socket M をクリック →「ローカル WebUI」→「ネットワーク設定」。WAN は初期値が DHCP ですが、RT1/RT2 には DHCP サーバーがないので静的 IP を入れます。</p><table><tr><th></th><th>IP / マスク</th><th>GW</th></tr><tr><td>WAN1</td><td>192.168.11.2 / 255.255.255.252</td><td>192.168.11.1</td></tr><tr><td>WAN2</td><td>192.168.12.2 / 255.255.255.252</td><td>192.168.12.1</td></tr></table>', c: () => wanIs('Socket M', 'WAN1', '192.168.11.2', '192.168.11.1') && wanIs('Socket M', 'WAN2', '192.168.12.2', '192.168.12.1') },
      { t: 'Socket B と拠点B の Socket も同様に', b: '<table><tr><th>Socket</th><th>WAN1</th><th>WAN2</th></tr><tr><td>Socket B</td><td>192.168.13.2/30 gw .13.1</td><td>192.168.14.2/30 gw .14.1</td></tr><tr><td>Socket 拠点B</td><td>203.0.113.196/26 gw .193</td><td>（未使用）</td></tr></table>', c: () => wanIs('Socket B', 'WAN1', '192.168.13.2', '192.168.13.1') && wanIs('Socket B', 'WAN2', '192.168.14.2', '192.168.14.1') && wanIs('Socket 拠点B', 'WAN1', '203.0.113.196', '203.0.113.193') },
      { t: 'トンネル確立を確認する', b: '<p>数秒待つと、Socket と Cato Cloud の間にトンネルが張られます。上部の「Cato 管理コンソール」→「Socket インベントリ」で 3 台が <b>接続済み</b> になれば OK です。</p><p>RT1 で <code>show ip nat translations</code> を見ると、Socket の UDP 通信が 203.0.113.194 に変換されているのが分かります。</p>', hint: 'RT1# show ip nat translations', c: () => tun('Socket M') && tun('Socket B') && tun('Socket 拠点B') },
      { t: 'サイト「拠点A」を作る', b: '<p>管理コンソール →「サイト」→「サイトを追加」。ネイティブ範囲は Socket の LAN 側セグメント、ローカル IP は LAN 側機器から見たゲートウェイ（HA なので VIP）です。</p><table><tr><th>サイト名</th><td>拠点A</td></tr><tr><th>ネイティブ範囲</th><td>10.0.0.0/28</td></tr><tr><th>ローカル IP</th><td>10.0.0.3</td></tr></table>', c: () => { const s = site('拠点A'); return !!s && s.nativeRange === '10.0.0.0/28' && s.localIp === '10.0.0.3'; } },
      { t: 'Socket を割り当てて HA を組む', b: '<p>拠点A の「Socket」タブでプライマリに Socket M、セカンダリに Socket B のシリアルを選びます。次に「高可用性 (HA)」タブで各 Socket 自身の LAN IP を入れます。</p><table><tr><th>プライマリ LAN IP</th><td>10.0.0.1</td></tr><tr><th>セカンダリ LAN IP</th><td>10.0.0.2</td></tr></table><p>HA 状態が <b>Ready</b> になれば完了です。L2SW で <code>show mac address-table</code> を見ると、VIP 用の仮想 MAC（0000.5e00.01xx）が学習されます。</p>', c: () => { const s = site('拠点A'); return !!s && s.primarySerial === (D('Socket M') || {}).serial && s.secondarySerial === (D('Socket B') || {}).serial && s.ha && s.ha.primaryIp === '10.0.0.1' && s.ha.secondaryIp === '10.0.0.2'; } },
      { t: 'VLAN20 をネットワーク範囲に登録', b: '<p>10.0.1.0/24 は L2SW の裏にあるので、Cato はそのままでは知りません。拠点A の「ネットワーク範囲」で Routed 範囲として登録し、ゲートウェイを L2SW の VLAN10 の IP（10.0.0.4）にします。</p>', c: () => { const s = site('拠点A'); return !!s && (s.ranges || []).some(r => r.cidr === '10.0.1.0/24' && r.gw === '10.0.0.4'); } },
      { t: 'サイト「拠点B」を作って Socket を割り当て', b: '<table><tr><th>ネイティブ範囲</th><td>10.0.2.0/24</td></tr><tr><th>ローカル IP</th><td>10.0.2.1</td></tr><tr><th>プライマリ Socket</th><td>Socket 拠点B</td></tr></table>', c: () => { const s = site('拠点B'); return !!s && s.nativeRange === '10.0.2.0/24' && s.localIp === '10.0.2.1' && s.primarySerial === (D('Socket 拠点B') || {}).serial; } },
      { t: '拠点間の疎通を確認', b: '<p>PC#1（拠点B）のコマンドプロンプトで <code>ping 10.0.0.4</code>（L2SW）と <code>ping 10.0.1.10</code>（PC#2）。<code>tracert 10.0.1.10</code> では Socket を経由しているのが分かります。シミュレーションモードで見ると、Cato のトンネルにパケットが包まれて PoP を通る様子が見えます。</p>', hint: 'ping 10.0.0.4\nping 10.0.1.10\ntracert 10.0.1.10', c: () => pinged('PC#1', '10.0.0.4') || pinged('PC#1', '10.0.1.10') },
      { t: 'SDP ユーザーで PC#0 をつなぐ', b: '<p>管理コンソールの「IP 割り当て（SDP）」を 10.0.3.0/24 にし、「ユーザー」に <code>user01@lab.local</code> を追加します。PC#0 の「デスクトップ」→「Cato Client」でそのメールアドレスで接続すると、Client IP 10.0.3.1 が付きます。</p><p>接続後、PC#0 から <code>ping 10.0.2.2</code>（PC#1）を試します。</p>', c: () => { const c = NL.rt(D('PC#0')).cato; return !!c && c.state === 'connected'; } },
      { t: 'WAN Firewall で通信を絞る', b: '<p>WAN Firewall は「許可したものだけ通す」方式です。初期ルール「Allow all」を<b>無効</b>にして、「送信元 = サイト: 拠点B、宛先 = サイト: 拠点A、サービス = ICMP、許可」のルールを追加します。</p><p>PC#1 → PC#2 の ping は通り、PC#2 → PC#1 の ping は止まる（イベントにブロックが記録される）ことを確かめます。</p>', c: () => { const r = NL.lab.cato.wanFw.rules; const A = site('拠点A'), B = site('拠点B'); return !!A && !!B && !r.some(x => x.enabled && x.src === 'any' && x.dst === 'any' && x.action === 'allow') && r.some(x => x.enabled && x.src === 'site:' + B.id && x.dst === 'site:' + A.id && (x.svc === 'icmp' || x.svc === 'any') && x.action === 'allow'); } },
      { t: 'HA のフェイルオーバー試験', b: '<p>Socket M の「物理」タブで電源を OFF にします。数秒で Socket B が Active になり、VIP 10.0.0.3 を引き継ぎます（管理コンソールのイベントに記録されます）。PC#1 から <code>ping 10.0.1.10</code> が引き続き通ることを確認しましょう。</p>', c: () => { const A = site('拠点A'); const m = D('Socket M'), b = D('Socket B'); return !!A && !!m && !!b && !m.power && NL.cato.activeSerial(A) === b.serial; } }
    ]
  },
  {
    id: 'vlan', title: 'VLAN とルーター・オン・ア・スティック', scenario: 'vlan', level: '基礎',
    desc: 'スイッチで VLAN を分け、ルーターのサブインターフェースで VLAN 間をルーティングします。',
    steps: [
      { t: 'VLAN を作ってポートを割り当てる', b: '<p>Switch0 で VLAN 10 と 20 を作り、Fa0/1-2 を VLAN 10、Fa0/3-4 を VLAN 20 にします。</p>', hint: 'enable\nconf t\nvlan 10\nvlan 20\nexit\ninterface range fa0/1 - 2\nswitchport mode access\nswitchport access vlan 10\ninterface range fa0/3 - 4\nswitchport mode access\nswitchport access vlan 20\nend', c: () => { const d = D('Switch0'); return !!d.vlans[10] && !!d.vlans[20] && [1, 2].every(i => I(d, 'FastEthernet0/' + i).accessVlan === 10) && [3, 4].every(i => I(d, 'FastEthernet0/' + i).accessVlan === 20); } },
      { t: 'ルーター側をトランクにする', b: '<p>Switch0 の Gi0/1 をトランクにします。<code>show interfaces trunk</code> で確認できます。</p>', hint: 'interface g0/1\nswitchport mode trunk', c: () => I(D('Switch0'), 'GigabitEthernet0/1').mode === 'trunk' },
      { t: 'サブインターフェースを作る', b: '<p>Router0 で Gi0/0 を有効にし、VLAN ごとのサブインターフェースを作ります。</p>', hint: 'enable\nconf t\ninterface g0/0\nno shutdown\ninterface g0/0.10\nencapsulation dot1Q 10\nip address 192.168.10.1 255.255.255.0\ninterface g0/0.20\nencapsulation dot1Q 20\nip address 192.168.20.1 255.255.255.0\nend', c: () => { const d = D('Router0'); return upAdmin(d, 'GigabitEthernet0/0') && I(d, 'GigabitEthernet0/0.10').dot1q === 10 && I(d, 'GigabitEthernet0/0.20').dot1q === 20 && ipIs(d, 'GigabitEthernet0/0.10', '192.168.10.1', '255.255.255.0') && ipIs(d, 'GigabitEthernet0/0.20', '192.168.20.1', '255.255.255.0'); } },
      { t: 'PC に IP を設定して VLAN 間 ping', b: '<p>PC-A 192.168.10.11、PC-B 192.168.10.12（GW .10.1）、PC-C 192.168.20.11、PC-D 192.168.20.12（GW .20.1）。PC-A から <code>ping 192.168.20.11</code>。</p>', c: () => pinged('PC-A', '192.168.20.11') }
    ]
  },
  {
    id: 'ospf', title: 'OSPF で経路を交換する', scenario: 'ospf', level: '基礎',
    desc: '3 台のルーターで OSPF エリア 0 を組み、経路の自動交換と障害時の迂回を確認します。',
    steps: [
      { t: 'インターフェースに IP を付ける', b: '<table><tr><th></th><th>Gi0/0</th><th>Gi0/1</th><th>Gi0/2</th></tr><tr><td>R1</td><td>10.1.12.1/30</td><td>10.1.13.1/30</td><td>192.168.1.1/24</td></tr><tr><td>R2</td><td>10.1.12.2/30</td><td>10.1.23.1/30</td><td>192.168.2.1/24</td></tr><tr><td>R3</td><td>10.1.13.2/30</td><td>10.1.23.2/30</td><td>—</td></tr></table><p>PC1 は 192.168.1.10（GW .1.1）、PC2 は 192.168.2.10（GW .2.1）。</p>', c: () => ipIs(D('R1'), 'GigabitEthernet0/0', '10.1.12.1', '255.255.255.252') && ipIs(D('R2'), 'GigabitEthernet0/1', '10.1.23.1', '255.255.255.252') && ipIs(D('R3'), 'GigabitEthernet0/1', '10.1.23.2', '255.255.255.252') },
      { t: 'OSPF を有効にする', b: '<p>3 台とも <code>router ospf 1</code> で、つながっているネットワークを area 0 で宣言します。ワイルドカードマスクはサブネットマスクの反転です。</p>', hint: 'router ospf 1\nnetwork 10.1.0.0 0.0.255.255 area 0\nnetwork 192.168.1.0 0.0.0.255 area 0', c: () => ['R1', 'R2', 'R3'].every(n => NL.ospfNbrs(D(n)).length >= 2) },
      { t: 'ルーティングテーブルを確認', b: '<p><code>show ip ospf neighbor</code> で FULL になっていること、<code>show ip route</code> に <code>O</code> の経路があることを確認します。</p>', hint: 'show ip ospf neighbor\nshow ip route ospf', c: () => typed('R1', /^(do )?sh(o|ow)? ip (ospf|route)/) || typed('R2', /^(do )?sh(o|ow)? ip (ospf|route)/) },
      { t: 'PC1 から PC2 へ ping', b: '', hint: 'ping 192.168.2.10', c: () => pinged('PC1', '192.168.2.10') },
      { t: '障害時の迂回を確認', b: '<p>R1 の Gi0/0 を <code>shutdown</code> して、もう一度 PC1 から ping します。R3 経由に切り替わって通ります。<code>tracert</code> で経路の変化も見てみましょう。</p>', c: () => !!I(D('R1'), 'GigabitEthernet0/0').shutdown && pinged('PC1', '192.168.2.10') }
    ]
  }
];

// ---------- manual
const MANUAL = [
  ['app', 'このアプリの使い方', `
<p>Packet Tracer のように、機器を置いて配線し、機器をクリックして CLI や設定画面で操作します。</p>
<table>
<tr><th>機器を置く</th><td>下のパレットから機器をクリックし、ワークスペースをクリック（ドラッグ＆ドロップも可）</td></tr>
<tr><th>配線する</th><td>下の「ケーブル」で種類を選ぶ → 機器 A をクリックしてポートを選ぶ → 機器 B をクリックしてポートを選ぶ</td></tr>
<tr><th>開く</th><td>選択ツールで機器をクリック。Cisco 機器は CLI、PC はデスクトップ、Socket はローカル WebUI が開きます</td></tr>
<tr><th>移動・表示</th><td>機器をドラッグで移動。空いている所をドラッグでスクロール、ホイールで拡大縮小</td></tr>
<tr><th>削除・元に戻す</th><td>削除ツールで機器やケーブルをクリック。Ctrl+Z（ワークスペース上）で元に戻せます</td></tr>
<tr><th>PDU</th><td>封筒ツールで送信元 → 宛先の順にクリックすると ping を 1 発送り、結果を右下の一覧に記録します</td></tr>
<tr><th>検査</th><td>虫眼鏡ツールで機器をクリックすると ARP・MAC・ルーティング・NAT の表をその場で見られます</td></tr>
</table>
<h4>リアルタイムとシミュレーション</h4>
<p>リアルタイムでは 2 秒ごとに Cato のキープアライブや DHCP の再試行などが自動で動きます。シミュレーションに切り替えると時間が止まり、以後に発生したパケットがイベント一覧に記録されます。再生・1 コマ送りでパケットの移動を見たり、イベントをクリックして各レイヤーの中身を確かめたりできます。</p>
<h4>ケーブルの種類</h4>
<p>「自動」はどの組み合わせでもつながります。「ストレート」は PC・ルーターとスイッチの間、「クロス」は同種どうし（スイッチどうし、ルーターどうし、PC とルーター）で使います。種類を間違えるとリンクが赤のままになります。「コンソール」は PC の RS232 と Cisco 機器の Console をつなぎ、PC の「ターミナル」から CLI を操作できます。</p>
<h4>保存</h4>
<p>作業中のラボはブラウザに自動保存されます。別の端末でも続けたいときは「ファイル」→「クラウドに保存」、ファイルに残すときは「JSON をエクスポート」を使います。</p>`],
  ['ios', 'Cisco IOS の基本', `
<h4>モード</h4>
<table>
<tr><th>プロンプト</th><th>モード</th><th>入り方 / 抜け方</th></tr>
<tr><td><code>Router&gt;</code></td><td>ユーザー EXEC</td><td>ログイン直後。<code>enable</code> で次へ</td></tr>
<tr><td><code>Router#</code></td><td>特権 EXEC</td><td><code>configure terminal</code> で設定へ。<code>disable</code> で戻る</td></tr>
<tr><td><code>Router(config)#</code></td><td>グローバル設定</td><td><code>end</code> / Ctrl+Z で特権へ</td></tr>
<tr><td><code>Router(config-if)#</code></td><td>インターフェース設定</td><td><code>interface g0/0</code> など。<code>exit</code> で 1 つ戻る</td></tr>
<tr><td><code>Router(config-router)#</code></td><td>ルーティング設定</td><td><code>router ospf 1</code></td></tr>
<tr><td><code>Router(config-line)#</code></td><td>ライン設定</td><td><code>line console 0</code> / <code>line vty 0 4</code></td></tr>
</table>
<h4>入力のコツ</h4>
<ul><li><code>?</code> で使えるコマンドや次に入れる値が出ます（<code>sh?</code> は sh で始まるコマンド、<code>show ?</code> は show の次）。</li>
<li>Tab でコマンドを補完。<code>conf t</code>、<code>int g0/0</code>、<code>sh ip int br</code> のような省略形も通ります。</li>
<li>先頭に <code>no</code> を付けると設定を取り消せます。設定モードから show を打つときは <code>do show …</code>。</li>
<li>誤ったコマンドを EXEC モードで入れると、ホスト名として名前解決しようとして数秒待たされます。防ぐには <code>no ip domain-lookup</code>。</li></ul>
<h4>running-config と startup-config</h4>
<p>設定は即座に running-config（メモリ）に反映されます。電源を切ると消えるので、<code>copy running-config startup-config</code> で startup-config（NVRAM）に保存します。<code>show startup-config</code> で保存内容、<code>erase startup-config</code> と <code>reload</code> で初期化です。</p>
<h4>よく使う確認コマンド</h4>
<table>
<tr><td><code>show ip interface brief</code></td><td>IF の IP と up/down を一覧</td></tr>
<tr><td><code>show running-config</code></td><td>現在の設定</td></tr>
<tr><td><code>show ip route</code></td><td>ルーティングテーブル</td></tr>
<tr><td><code>show vlan brief</code></td><td>VLAN とポート</td></tr>
<tr><td><code>show interfaces trunk</code></td><td>トランクと許可 VLAN</td></tr>
<tr><td><code>show mac address-table</code></td><td>学習した MAC</td></tr>
<tr><td><code>show ip nat translations</code></td><td>NAT 変換表</td></tr>
<tr><td><code>show access-lists</code></td><td>ACL とヒット数</td></tr>
<tr><td><code>show cdp neighbors</code></td><td>隣接する Cisco 機器</td></tr>
<tr><td><code>show spanning-tree</code></td><td>STP のルートとポートの役割</td></tr>
<tr><td><code>show ip ospf neighbor</code></td><td>OSPF の隣接関係</td></tr>
</table>`],
  ['ios2', 'Cisco 設定レシピ', `
<h4>インターフェース</h4><pre>interface g0/0
 description to-RT1
 ip address 192.168.1.1 255.255.255.0
 no shutdown</pre>
<h4>VLAN とトランク（スイッチ）</h4><pre>vlan 10
 name SALES
interface range fa0/1 - 12
 switchport mode access
 switchport access vlan 10
interface g0/1
 switchport mode trunk
 switchport trunk allowed vlan 10,20</pre>
<p>3560 ではトランクの前に <code>switchport trunk encapsulation dot1q</code> が必要です。</p>
<h4>スタティックルート</h4><pre>ip route 10.0.0.0 255.255.255.0 192.168.1.2
ip route 10.0.0.0 255.255.255.0 192.168.2.2 250   ! フローティング（予備）
ip route 0.0.0.0 0.0.0.0 203.0.113.1              ! デフォルト</pre>
<h4>NAT（PAT）</h4><pre>interface g0/0
 ip nat inside
interface g0/2
 ip nat outside
access-list 1 permit 192.168.0.0 0.0.255.255
ip nat inside source list 1 interface g0/2 overload</pre>
<h4>DHCP サーバー</h4><pre>ip dhcp excluded-address 192.168.1.1 192.168.1.9
ip dhcp pool LAN
 network 192.168.1.0 255.255.255.0
 default-router 192.168.1.1
 dns-server 8.8.8.8</pre>
<p>別セグメントのクライアントには、ゲートウェイ側 IF に <code>ip helper-address &lt;DHCP サーバー&gt;</code>。</p>
<h4>ACL</h4><pre>access-list 100 permit icmp 192.168.1.0 0.0.0.255 any
access-list 100 deny ip any any
interface g0/0
 ip access-group 100 in</pre>
<h4>SSH</h4><pre>hostname R1
ip domain-name lab.local
crypto key generate rsa modulus 1024
username admin privilege 15 secret cisco
ip ssh version 2
line vty 0 4
 login local
 transport input ssh</pre>
<p>PC のコマンドプロンプトから <code>ssh -l admin 192.168.1.1</code>。</p>
<h4>OSPF</h4><pre>router ospf 1
 router-id 1.1.1.1
 network 10.1.0.0 0.0.255.255 area 0
 passive-interface g0/2</pre>`],
  ['cato', 'Cato の全体像', `
<p>Cato は SASE（ネットワークとセキュリティをクラウドで提供する仕組み）のサービスです。拠点やユーザーはそれぞれ最寄りの <b>PoP</b>（Cato Cloud の入口）へトンネルでつながり、拠点間の通信もインターネット向けの通信も PoP を経由します。</p>
<table>
<tr><th>Socket</th><td>拠点に置くアプライアンス。WAN から PoP へトンネルを張り、LAN 側のゲートウェイになる。本体の設定はほぼ WAN だけ</td></tr>
<tr><th>管理コンソール</th><td>クラウド側の設定画面。サイト、ネットワーク範囲、HA、ユーザー、Firewall などを設定する</td></tr>
<tr><th>サイト</th><td>拠点の単位。Socket をシリアル番号で割り当てる</td></tr>
<tr><th>ネイティブ範囲</th><td>Socket の LAN がつながるセグメント。ローカル IP が LAN 機器のゲートウェイ</td></tr>
<tr><th>ネットワーク範囲（Routed）</th><td>ネイティブ範囲の先にある別セグメント。ゲートウェイ（L3 スイッチ等）を指定して登録する</td></tr>
<tr><th>SDP（Cato Client）</th><td>リモートの PC 用クライアント。ユーザー登録と IP 割り当て範囲が必要</td></tr>
<tr><th>WAN Firewall</th><td>サイト・ユーザー間の通信。許可したものだけ通す</td></tr>
<tr><th>Internet Firewall</th><td>インターネット向けの通信。禁止したものだけ止める</td></tr>
</table>
<h4>導入の流れ（このラボ）</h4>
<ol><li>Socket の WAN を設定する（DHCP が無い環境ではローカル WebUI で静的 IP）</li>
<li>Socket が PoP に到達し、トンネルが張られる（インベントリに表示）</li>
<li>管理コンソールでサイトを作り、Socket をシリアルで割り当てる</li>
<li>ネイティブ範囲・ローカル IP、必要ならネットワーク範囲や HA を設定する</li>
<li>Firewall のルールを整え、疎通を確認する</li></ol>
<div class="callout">このアプリの管理コンソールと Socket WebUI は、考え方を練習するための簡略版です。本物のメニュー名や既定値と違う部分があります。実機作業の前には <a href="https://support.catonetworks.com/" target="_blank" rel="noopener">Cato Knowledge Base</a> で確認してください。</div>`],
  ['cato-ha', 'Cato: HA と回線冗長', `
<p>構成図の拠点Aは、Socket 2 台（M = プライマリ、B = セカンダリ）を同じ LAN に並べた HA 構成です。さらに各 Socket の WAN1/WAN2 を RT1・RT2 にたすき掛けでつないで、回線とルーターの故障にも備えています。</p>
<table>
<tr><th>VIP 10.0.0.3</th><td>LAN 側機器のゲートウェイ。アクティブ側の Socket が持つ（仮想 MAC 0000.5e00.01xx）</td></tr>
<tr><th>10.0.0.1 / 10.0.0.2</th><td>各 Socket 自身の LAN アドレス（HA 設定で指定）</td></tr>
<tr><th>WAN の優先度</th><td>Active / Passive / Last-resort。Active が生きていればそれを使う</td></tr>
</table>
<h4>切り替わる条件（このシミュレーター）</h4>
<p>アクティブ側の Socket が電源断、またはすべての WAN トンネルが落ちた状態が 3 回のキープアライブ（約 6 秒）続くと、スタンバイ側がアクティブになり、Gratuitous ARP で VIP の場所を LAN に知らせます。戻りは自動では行いません。</p>
<h4>試してみること</h4>
<ul><li>RT1 を電源 OFF → Socket M は WAN2（RT2 経由）だけで生き残り、切り替わらない</li>
<li>Socket M を電源 OFF → Socket B がアクティブに</li>
<li>L2SW で <code>show mac address-table</code> → VIP の MAC がどのポートで学習されているか</li></ul>`],
  ['cato-flow', '構成図ラボのパケットの流れ', `
<p>PC#1（拠点B, 10.0.2.2）から PC#2（拠点A の VLAN20, 10.0.1.10）へ ping したとき：</p>
<ol><li>PC#1 → ゲートウェイ 10.0.2.1（拠点B の Socket）</li>
<li>Socket が宛先を見て「自サイトではない」と判断し、トンネル（UDP 443）に包んで PoP 203.0.113.254 へ送る</li>
<li>PoP が宛先 10.0.1.10 を拠点A の Routed 範囲と判定し、WAN Firewall を評価</li>
<li>PoP → 拠点A のアクティブ Socket のトンネル宛て。宛先は RT1 の NAT 後のアドレス 203.0.113.194:ポート</li>
<li>RT1 が NAT を戻して 192.168.11.2（Socket M の WAN1）へ</li>
<li>Socket M が中身を取り出し、Routed 範囲のゲートウェイ 10.0.0.4（L2SW）へ転送</li>
<li>L2SW が VLAN20 へルーティングして PC#2 に届く。戻りは L2SW のデフォルトルート → VIP 10.0.0.3 → 同じ道を逆向きに</li></ol>
<p>RT1/RT2 が NAT するのは、Socket の WAN が 192.168.x.x のプライベートアドレスだからです。PoP から見える送信元は RT の WAN アドレスになります（<code>show ip nat translations</code> で確認できます）。</p>
<p>シミュレーションモードで ping を送ると、この流れをイベント一覧で 1 つずつ追えます。Cato の行をクリックすると、トンネルの中身（元の ICMP）も表示されます。</p>`],
  ['limits', 'できること・できないこと', `
<h4>Cisco で再現しているもの</h4>
<p>モードとプロンプト、? ヘルプ、Tab 補完、省略形、<code>no</code>・<code>do</code>、エラー表示（^ マーカー）、running/startup-config と reload、インターフェース・サブインターフェース・SVI・ループバック、VLAN・トランク（DTP の auto/desirable）・ネイティブ VLAN、STP（PVST の役割計算）、スタティックルート（フローティング含む）、OSPF（単一プロセス）、NAT（PAT・プール・スタティック）、標準/拡張/名前付き ACL、DHCP サーバーとリレー、CDP、Telnet/SSH（vty ログイン）、コンソール/enable パスワード、バナー、ping/traceroute と主な show コマンド。</p>
<h4>まだ対応していないもの</h4>
<p>EIGRP・RIP・BGP、IPv6、EtherChannel、HSRP/VRRP、VTP の同期、ポートセキュリティ、QoS、debug、IOS の全コマンド。対応していないコマンドは実機と同じく <code>% Invalid input detected</code> になります。</p>
<h4>Cato で再現しているもの</h4>
<p>Socket の WAN 設定（DHCP / 静的）、PoP へのトンネル（NAT 越え）、サイト・ネイティブ範囲・Routed 範囲、Socket の割り当て、HA（VIP・フェイルオーバー）、WAN の優先度、SDP ユーザーと Cato Client、WAN / Internet Firewall、イベント。</p>
<p>実際の Cato のアプリケーション識別、IPS、DNS、帯域制御、複数 PoP 間の経路などは扱いません。</p>`]
];

// ---------- state & render
const gst = { tab: 'labs', lab: null, chat: [], busy: null };
try { const s = JSON.parse(localStorage.getItem('netlab.guide') || '{}'); if (s.lab) gst.lab = s.lab; } catch (e) { /* storage unavailable */ }
const saveG = () => { try { localStorage.setItem('netlab.guide', JSON.stringify({ lab: gst.lab })); } catch (e) { /* ignore */ } };
let body, tabsEl;
function mount(el) {
  el.innerHTML = '';
  tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  body = h('div', { class: 'gbody' });
  el.append(h('header', {}, h('h3', {}, 'ガイド'), h('button', { class: 'xbtn', 'aria-label': '閉じる', onclick: () => { el.hidden = true; NL.emit('guide', false); } }, '×')), tabsEl, body);
  render();
}
function render() {
  if (!body) return;
  tabsEl.innerHTML = '';
  [['labs', 'ガイド付きラボ'], ['manual', 'マニュアル'], ['ai', 'AI 講師']].forEach(([id, l]) => tabsEl.append(h('button', { role: 'tab', 'aria-selected': String(gst.tab === id), onclick: () => { gst.tab = id; render(); } }, l)));
  const keep = body.scrollTop;
  body.innerHTML = '';
  body.style.display = gst.tab === 'ai' ? 'grid' : '';
  ({ labs: rLabs, manual: rManual, ai: rAI })[gst.tab](body);
  if (gst.tab === 'labs') body.scrollTop = keep;
}
function rLabs(b) {
  const lab = LABS.find(l => l.id === gst.lab);
  if (!lab) {
    b.append(h('p', { style: 'color:var(--muted)' }, 'ラボを選ぶと手順と自動チェックが表示されます。サンプルを読み込むと作業中のラボは置き換わります（自動保存は上書きされます）。'));
    LABS.forEach(l => b.append(h('div', { class: 'labcard' }, h('h5', {}, l.title, ' ', h('span', { class: 'pill' }, l.level)), h('p', {}, l.desc), h('p', {}, l.steps.length + ' ステップ'),
      h('div', { class: 'row' }, h('button', { class: 'hbtn primary', onclick: () => { NL.app.loadScenario(l.scenario); gst.lab = l.id; saveG(); render(); } }, 'サンプルを読み込んで開始'),
        h('button', { class: 'hbtn', onclick: () => { gst.lab = l.id; saveG(); render(); } }, '今のラボで続ける')))));
    return;
  }
  const res = lab.steps.map(s => { try { return !!s.c(); } catch (e) { return false; } });
  const cur = res.indexOf(false);
  const done = res.filter(Boolean).length;
  b.append(h('div', { class: 'rowbtns' }, h('button', { class: 'linkbtn', onclick: () => { gst.lab = null; saveG(); render(); } }, '← ラボ一覧'), h('span', { style: 'color:var(--muted);font-size:12px' }, `${done} / ${lab.steps.length} 完了`)),
    h('h4', {}, lab.title), h('div', { class: 'progress' }, h('i', { style: `width:${Math.round(done * 100 / lab.steps.length)}%` })));
  const ol = h('ol', { class: 'steps' });
  lab.steps.forEach((s, i) => {
    const det = h('details', { class: 'step' + (res[i] ? ' done' : '') + (i === cur ? ' cur' : ''), open: i === cur ? true : null },
      h('summary', {}, h('span', { class: 'chk', 'aria-label': res[i] ? '完了' : '未完了' }, '✓'), h('span', {}, h('b', {}, (i + 1) + '. '), s.t)),
      h('div', { class: 'sbody' }, h('div', { html: s.b }),
        s.hint ? h('details', {}, h('summary', { style: 'color:var(--accent);cursor:pointer' }, 'コマンド例を見る'), h('pre', {}, s.hint)) : null,
        h('div', { class: 'rowbtns', style: 'margin-top:6px' }, NL.app.sampleOK() ? h('button', { class: 'linkbtn', onclick: () => { gst.tab = 'ai'; render(); ask(`ガイド「${lab.title}」のステップ ${i + 1}「${s.t}」について、今のラボの状態を見て、何をすればよいか・なぜそうするのかを教えてください。うまくいかない場合は原因も指摘してください。`); } }, 'AI 講師に聞く') : null)));
    ol.append(h('li', {}, det));
  });
  b.append(ol);
  if (cur === -1) b.append(h('div', { class: 'callout c', style: 'margin-top:10px' }, 'すべてのステップを完了しました。'));
}
function rManual(b) {
  const toc = h('div', { class: 'toc' });
  const secs = MANUAL.map(([id, t, html]) => { const sec = h('section', { id: 'man-' + id }, h('h4', {}, t), h('div', { html })); toc.append(h('button', { onclick: () => sec.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, t)); return sec; });
  b.append(toc, ...secs);
}
function rAI(b) {
  const msgs = h('div', { class: 'msgs', 'aria-live': 'polite' });
  if (!gst.chat.length) msgs.append(h('div', { class: 'msg a' }, 'Cisco と Cato の操作について何でも聞いてください。今のラボの機器・設定・ログを見たうえで答えます。たとえば「拠点B から PC#2 に ping が通らない」「HA の VIP はどう決まる？」など。'));
  gst.chat.forEach(m => msgs.append(h('div', { class: 'msg ' + (m.role === 'user' ? 'u' : 'a') }, m.content)));
  if (gst.busy) msgs.append(gst.busy.el);
  const ta = h('textarea', { id: 'aiInput', placeholder: '質問を入力（Ctrl+Enter で送信）', 'aria-label': 'AI 講師への質問' });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
  const send = () => { const q = ta.value.trim(); if (!q) return; ta.value = ''; ask(q); };
  const quick = ['今のラボを診断して、問題点を教えて', '次に何をすればいい？', '直近の ping が失敗した理由は？', 'このラボの設定を解説して'];
  const avail = NL.app.sampleOK();
  b.append(h('div', { class: 'chat' }, msgs, h('div', { class: 'compose' },
    avail ? h('div', { class: 'quick' }, quick.map(q => h('button', { onclick: () => ask(q) }, q))) : h('p', { class: 'err-msg' }, 'この表示では AI 講師を使えません（claude.ai 上で開くと使えます）。マニュアルとガイド付きラボは使えます。'),
    ta, h('div', { class: 'rowbtns' }, h('button', { class: 'hbtn primary', disabled: !avail || gst.busy ? true : null, onclick: send }, '送信'),
      gst.busy ? h('button', { class: 'hbtn', onclick: () => gst.busy && gst.busy.ctl.abort() }, '停止') : null,
      gst.chat.length ? h('button', { class: 'linkbtn', onclick: () => { gst.chat = []; render(); } }, '会話をリセット') : null))));
  setTimeout(() => { msgs.scrollTop = msgs.scrollHeight; }, 0);
}
const RULES = `あなたは Cisco IOS と Cato Networks（SASE）を教える日本語の講師です。受講者はブラウザ上のネットワーク実機トレーナー「NetLab」で練習しています。
NetLab の仕様:
- Cisco 機器（2911 / ISR4331 ルーター、2960 / 3560 スイッチ）は IOS 風 CLI。対応: モード、? ヘルプ、VLAN、トランク、STP、スタティック、OSPF、NAT/PAT、ACL、DHCP、Telnet/SSH、show 各種。未対応: EIGRP/RIP/BGP、IPv6、HSRP、EtherChannel、debug。
- Cato: Socket X1500（WAN1/WAN2/LAN1/MGMT）、ローカル WebUI で WAN の DHCP/静的設定。「Cato Cloud」ノードが PoP の代わりで、Socket と Cato Client はその IP に UDP 443 で到達できるとトンネルを張る。管理コンソール（簡略版）でサイト、ネイティブ範囲とローカル IP、Routed 範囲、Socket 割り当て（シリアル）、HA（VIP = ローカル IP、プライマリ/セカンダリの LAN IP）、WAN 優先度、SDP ユーザーと IP 割り当て、WAN Firewall（暗黙ブロック）、Internet Firewall（暗黙許可）、イベント。
- Socket は WAN 側から受けた平文の通信を LAN に転送しない。拠点間通信はすべてトンネル経由。
回答の方針:
- 受講者のラボ状態（下に添付）を根拠に、具体的な機器名・コマンド・画面の操作手順で答える。推測は推測と書く。
- まず結論、次に手順、最後に「なぜそうするか」を短く。コマンドは行ごとに書く。
- NetLab の管理コンソールは本物の Cato 管理コンソールを簡略化したもの。本物と違う可能性がある点は「実機では公式ドキュメントで確認を」と添える。
- 長くても 400 字程度＋コマンド例に収める。`;
function labContext() {
  const L = [`# ラボ「${NL.lab.name}」の現在の状態`, `モード: ${NL.app.simMode() ? 'シミュレーション' : 'リアルタイム'}`];
  for (const d of NL.lab.devices) {
    const k = NL.kind(d);
    if (NL.isCisco(d)) {
      const rc = NL.ios.runConf(d, d.cfg).split('\n');
      const blocks = []; let cur = null;
      for (const l of rc) {
        if (l === '!' || /^(version|no service timestamps|ip flow-export|ip classless|end$)/.test(l) || /^ (duplex|speed) auto$/.test(l)) continue;
        if (/^\S/.test(l)) { cur = [l]; blocks.push(cur); } else if (cur) cur.push(l);
      }
      const txt = blocks.filter(b => !(b.length === 1 && /^interface /.test(b[0]))).map(b => b.join('\n')).join('\n');
      const up = Object.keys(d.cfg.interfaces).map(n => [n, NL.ifState(d, n)]).filter(([, s]) => s.proto === 'up').map(([n]) => U.shortIf(n));
      L.push(`\n## ${d.name}（${NL.MODELS[d.model].label}）電源 ${d.power ? 'ON' : 'OFF'}${d.startup ? '' : '、startup-config 未保存'}\n${txt}\n[up の IF] ${up.join(', ') || 'なし'}`);
      const nb = NL.ospfNbrs(d); if (nb.length) L.push('[OSPF 隣接] ' + nb.map(n => n.rid + '@' + n.ifn).join(', '));
    } else if (k === 'pc' || k === 'server') {
      const a = NL.hostAddr(d), c = NL.rt(d).cato;
      L.push(`\n## ${d.name}（${k}）IP ${a.ip || '未設定'}/${a.mask ? U.maskLen(a.mask) : '-'} GW ${a.gw || '-'}${d.cfg.dhcp ? '（DHCP）' : ''}${c ? ` / Cato Client ${c.state}${c.clientIp ? ' ' + c.clientIp : ''}${c.err ? '（' + c.err + '）' : ''}` : ''}`);
    } else if (k === 'socket') {
      const s = NL.cato.siteOf(d);
      L.push(`\n## ${d.name}（Socket, シリアル ${d.serial}）電源 ${d.power ? 'ON' : 'OFF'} / サイト ${s ? s.site.name + ' ' + s.role : '未割当'}${s && s.site.secondarySerial ? (NL.cato.isActive(d) ? ' Active' : ' Standby') : ''}\n` +
        ['WAN1', 'WAN2'].map(w => { const c = d.cfg.wan[w], a = NL.socketWan(d, w); return `${w}: ${c.mode} ${a.ip || '-'}/${a.mask ? U.maskLen(a.mask) : '-'} gw ${a.gw || '-'} トンネル ${NL.cato.tunUp(d, w) ? 'UP' : 'DOWN'}`; }).join('\n'));
    } else if (k === 'pop') L.push(`\n## ${d.name}（Cato Cloud PoP）IP ${d.cfg.ip}/${d.cfg.mask ? U.maskLen(d.cfg.mask) : '-'} GW ${d.cfg.gw}`);
  }
  L.push('\n## 配線');
  NL.lab.links.forEach(l => { const a = NL.dev(l.a.d), b = NL.dev(l.b.d); L.push(`${a.name} ${l.a.p} <-> ${b.name} ${l.b.p}（${l.cable}${l.cable !== 'console' ? ', ' + (NL.portLinkUp(a, l.a.p) ? 'up' : 'down') : ''}）`); });
  const c = NL.lab.cato;
  L.push('\n## Cato 管理コンソール設定', JSON.stringify({ sites: c.sites.map(s => ({ name: s.name, nativeRange: s.nativeRange, localIp: s.localIp, primary: (NL.devBySerial(s.primarySerial) || {}).name || s.primarySerial, secondary: (NL.devBySerial(s.secondarySerial) || {}).name || s.secondarySerial, ha: s.ha, ranges: s.ranges, haStatus: s.secondarySerial ? NL.cato.haStatus(s).reason : undefined })), users: c.users.map(u => u.email), sdpRange: c.sdpRange, wanFw: c.wanFw.rules, inetFw: c.inetFw.rules }));
  L.push('\n## 直近のパケット破棄（新しい順）', NL.sim.drops.slice(0, 10).map(d => `${d.at}: ${d.reason}`).join('\n') || 'なし');
  L.push('\n## Cato イベント（新しい順）', NL.cato.events().slice(0, 8).map(e => `${e.time} ${e.type} ${e.site} ${e.msg}`).join('\n') || 'なし');
  const lab = LABS.find(l => l.id === gst.lab);
  if (lab) { const i = lab.steps.findIndex(s => { try { return !s.c(); } catch (e) { return true; } }); L.push(`\n## 進行中のガイド: ${lab.title} / 次のステップ: ${i < 0 ? '完了' : (i + 1) + '. ' + lab.steps[i].t}`); }
  return L.join('\n').slice(0, 90000);
}
async function ask(q) {
  if (gst.busy) return;
  const sample = await NL.app.sample();
  if (!sample) { ui.toast('この表示では AI 講師を使えません', true); return; }
  gst.tab = 'ai';
  gst.chat.push({ role: 'user', content: q });
  const el = h('div', { class: 'msg a' }, '考えています…');
  const ctl = new AbortController();
  gst.busy = { el, ctl };
  render();
  const turns = [{ role: 'user', content: RULES + '\n\n' + labContext() }, { role: 'assistant', content: 'ラボの状態を確認しました。質問をどうぞ。' }, ...gst.chat.slice(-12)];
  try {
    const r = await sample(turns, { cache: false, signal: ctl.signal, onText: ({ text }) => { el.textContent = text; const m = el.parentNode; if (m) m.scrollTop = m.scrollHeight; } });
    gst.chat.push({ role: 'assistant', content: r.text + (r.truncated ? '\n（途中で切れました。続きは「続けて」と送ってください）' : '') });
  } catch (e) {
    const msg = { not_granted: 'AI 講師の利用が許可されませんでした。', rate_limited: '混み合っています。少し待ってからもう一度送ってください。', cancelled: '（停止しました）', prompt_too_large: 'ラボが大きすぎて送れませんでした。機器を減らすか質問を短くしてください。' }[e && e.code] || '回答を取得できませんでした（' + ((e && e.code) || 'error') + '）。';
    gst.chat.push({ role: 'assistant', content: (e && e.text ? e.text + '\n\n' : '') + msg });
  } finally { gst.busy = null; render(); }
}
let t;
NL.on('change', () => { if (gst.tab !== 'labs' || !gst.lab) return; clearTimeout(t); t = setTimeout(() => { if (!document.querySelector('#guide').contains(document.activeElement)) render(); }, 600); });
NL.on('ping', () => { if (gst.tab === 'labs' && gst.lab) { clearTimeout(t); t = setTimeout(render, 300); } });
NL.on('cli', () => { if (gst.tab === 'labs' && gst.lab) { clearTimeout(t); t = setTimeout(render, 300); } });
NL.tutor = { mount, render, ask, labs: LABS, setLab: id => { gst.lab = id; saveG(); render(); }, openTab: tab => { gst.tab = tab; render(); } };
})();
