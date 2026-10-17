"use strict";
/* ================================================================== *
 *  i18n —— 中 / 英 / 俄 / 德
 * ================================================================== */
const LANGS = [
  { code:'zh', name:'中文',   loc:'zh-CN' },
  { code:'en', name:'English', loc:'en-US' },
  { code:'ru', name:'Русский', loc:'ru-RU' },
  { code:'de', name:'Deutsch', loc:'de-DE' }
];

/* 字典已按语言拆到独立文件：构建产物只加载用户实际需要的那一种 */

let LANG = 'zh';
/* 源目录里 I18N 含 4 种语言；按语言分发的构建产物（build.py）里只含当前这一种，
   所以「回落到中文」这一层必须写成防御式 —— I18N.zh 可能压根不存在。 */
const FALLBACK_LANG = 'zh';
function t(key, vars){
  const d = I18N[LANG] || I18N[FALLBACK_LANG] || {};
  const f = I18N[FALLBACK_LANG] || d;
  let s = (d[key] !== undefined) ? d[key] : (f[key] !== undefined ? f[key] : key);
  if(vars) for(const k in vars) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}
function loc(){ return (LANGS.find(l => l.code === LANG) || LANGS[0]).loc; }

"use strict";
/* ------------------------------------------------------------------ *
 *  协议定义（对应固件 User/Comm/Comm.h）
 * ------------------------------------------------------------------ */
const CMD = {
  WHO_AM_I:0x01, OUTPUT_DATA:0x02, OUTPUT_DATA_MAX:0x03, MAH_MWH:0x04, UPTIME:0x05,
  OUTPUT_DATA_MAX_RESET:0x06, INPUT_TYPE:0x07,
  PD_PDO_FIX:0x08, PD_PDO_PPS:0x09, PD_PDO:0x0A, PD_PDO_AVS:0x0B, PD_PDO_NUM:0x0C, PD_PDO2:0x0D,
  OUTPUT_ENABLE:0x0E,
  SYSTEM_RESET:0x40, SYSTEM_UPGRADE:0x41, SYSTEM_VERSION:0x42, SYSTEM_SERIAL_NUM:0x43,
  SYSTEM_FACTORY_RESET:0x45, SYSTEM_LCD_PANEL_TYPE:0x46, SYSTEM_CURRENT_RSHUNT:0x47,
  SYSTEM_CURRENT_OFFSET:0x48, SYSTEM_INA226_CONFIG:0x49
};
const READ = 0x80, FRAME_END = 0x0A;
/* 变长帧（0x88/0x89/0x8B）的长度上限：7 个档位 × 6 字节 + 帧头 + 帧尾。 */
const MAX_VAR_FRAME = 3 + 7 * 6;
const OUT_TYPE = {1:'PD', 2:'QC', 3:'DC', 4:'NONE'};

/* 定长应答长度表；变长（0x88/0x89/0x8B）用 3 + count */
function frameLen(buf, avail){
  switch(buf[0]){
    case 0x81: return 29;
    case 0x82: return 14;
    case 0x83: return 14;
    case 0x84: return 10;
    case 0x85: return 6;
    case 0x87: return 3;
    /* 变长帧（PD 源能力表）：长度字节来自设备。接收一旦错位，这个字节可能被读成一个
       垃圾大数，解析器就会去等一个"永远凑不齐"的帧，后面几十条完整应答全堵在缓冲里
       （要等攒够 3+buf[1] 字节才肯 shift 重同步）。合法上限很窄 —— 一帧最多 7 个档位
       × 6 字节 + 头尾 = 45 —— 所以超过就判非法帧、立刻 shift 重同步。
       下界不设：count=0 是合法的（设备可以报"没有 PPS / AVS 档"）。 */
    case 0x88: case 0x89: case 0x8B: {
      if(avail < 2) return 0;
      const n = buf[1];
      return (3 + n <= MAX_VAR_FRAME) ? 3 + n : -1;
    }
    case 0x8A: return 5;
    case 0x8C: return 5;
    case 0x8D: return 7;
    case 0x8E: return 3;
    case 0xC2: return 20;
    case 0xC3: return 15;
    case 0xC6: return 3;
    case 0xC7: return 3;
    case 0xC8: return 22;
    case 0xC9: return 5;
    default: return -1;
  }
}

"use strict";
/* ------------------------------------------------------------------ *
 *  小工具
 * ------------------------------------------------------------------ */
const $ = id => document.getElementById(id);
const u16 = (b,o) => b[o] | (b[o+1] << 8);
const i32 = (b,o) => (b[o] | (b[o+1]<<8) | (b[o+2]<<16) | (b[o+3]<<24)) | 0;
const u32 = (b,o) => (b[o] | (b[o+1]<<8) | (b[o+2]<<16) | (b[o+3]<<24)) >>> 0;
const hex = a => Array.from(a).map(v => v.toString(16).padStart(2,'0')).join(' ');
const ascii = a => Array.from(a).map(v => (v>=32 && v<127) ? String.fromCharCode(v) : '.').join('');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v,a,b) => Math.min(b, Math.max(a, v));

let toastTimer = null, toastBarTimer = null;
const TOAST_ICON = { ok:'\u2713', bad:'!', info:'i' };
function toast(msg, kind){
  kind = (kind === 'ok' || kind === 'bad') ? kind : 'info';
  const el = $('toast'), bar = $('toastBar');
  const ms = kind === 'bad' ? 6000 : 3200;

  el.className = 'toast show ' + kind;          /* 先置类，再有内容 */
  $('toastIco').textContent = TOAST_ICON[kind];
  $('toastMsg').textContent = msg;

  /* 进度条：按剩余时间线性收缩 */
  clearTimeout(toastTimer); clearTimeout(toastBarTimer);
  bar.style.transition = 'none';
  bar.style.transform = 'scaleX(1)';
  toastBarTimer = setTimeout(() => {
    bar.style.transition = 'transform ' + ms + 'ms linear';
    bar.style.transform = 'scaleX(0)';
  }, 30);

  /* 重放入场动画（连续弹窗也能看到“跳一下”） */
  el.style.transition = 'none';
  el.style.opacity = '0';
  el.style.transform = 'translate(-50%,16px) scale(.97)';
  void el.offsetWidth;
  el.style.transition = '';
  el.style.opacity = '';
  el.style.transform = '';

  toastTimer = setTimeout(() => { el.className = 'toast ' + kind; }, ms);
}

function logLine(kind, text){
  if(!$('logChk').checked) return;
  const box = $('log');
  const div = document.createElement('div');
  div.className = kind;
  let ts = '';
  try{ ts = new Date().toLocaleTimeString(loc(), {hour12:false}); }catch(e){ ts = new Date().toLocaleTimeString(); }
  div.textContent = ts + '  ' + text;
  box.appendChild(div);
  while(box.childNodes.length > 400) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

"use strict";
/* ------------------------------------------------------------------ *
 *  主题 / 语言 / 周期 持久化
 * ------------------------------------------------------------------ */
const LS = {
  get(k, d){ try{ const v = localStorage.getItem('pdtrig.' + k); return v === null ? d : v; }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem('pdtrig.' + k, v); }catch(e){} }
};
const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

/* 默认值全部跟随系统，只有用户手动选过（本地有存档）才以存档为准：
   主题默认 'auto'（跟着系统深浅色走，系统变了自动跟；选项里也能手动钉死 dark / light）；
   语言默认取浏览器首选语言里第一个我们支持的，都不支持才回落中文。 */
function sysLang(){
  const list = (navigator.languages && navigator.languages.length)
    ? navigator.languages : [navigator.language || ''];
  for(const raw of list){
    const base = String(raw || '').toLowerCase().split('-')[0];
    if(base && I18N[base]) return base;
  }
  return 'zh';
}
const DEFAULT_THEME = 'auto';

function resolvedTheme(){
  const m = LS.get('theme', DEFAULT_THEME);
  if(m === 'auto') return (mq && mq.matches) ? 'light' : 'dark';
  return m === 'light' ? 'light' : 'dark';
}
function applyTheme(){
  document.documentElement.setAttribute('data-theme', resolvedTheme());
  const m = LS.get('theme', DEFAULT_THEME);
  $('themeSel').value = m;
  drawChart();
}
if(mq && mq.addEventListener) mq.addEventListener('change', () => { if(LS.get('theme', DEFAULT_THEME) === 'auto') applyTheme(); });

function applyStaticI18n(){
  document.documentElement.lang = (LANG === 'zh') ? 'zh-CN' : LANG;
  document.title = t('appTitle');
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  /* data-i18n-title → title。图标按钮（「返回工具集」这种 <a>）没有可见文字，
     无障碍名称只能靠 aria-label —— 别漏掉 <a>，否则读屏永远停在源码里的中文兜底。 */
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const s = t(el.dataset.i18nTitle);
    el.title = s;
    if(el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button'){
      el.setAttribute('aria-label', s);
    }
  });
  $('qCurr').title = t('thCurrTip');    /* 表头「电流 / 功率」为什么写成斜杠：AVS 行给的是功率 */
  $('qPoll').title = t('pollQ');
  $('qInfo').title = t('infoQ');
  $('btnInstall').title = t('installQ');
  $('qDyn').title = t('dynEnableQ');
  /* 两个精确输入框：title 讲用法，aria-label 供读屏（标签文字是 .lb 里的 span，关联不上） */
  $('dynVNum').title = t('dynNumQ');
  $('dynVNum').setAttribute('aria-label', t('dynVolt'));
  $('dynINum').title = t('dynNumQ');
  $('dynINum').setAttribute('aria-label', t('dynCurr'));
  $('qFollow').title = t('followQ');
  $('chartScroll').title = t('scrollQ');
  $('btnConn').textContent = connected ? t('btnDisconnect') : t('btnConnect');
  renderStatus();                /* 已连接时也要重渲染：否则切语言会残留旧语言的「已连接」 */
  updateConnTip();               /* 语言换了，提示里的字段名也要跟着换 */
  $('ctlHint').textContent = t('ctlHint');
  /* 点数上限直接插当前常量，免得文案里的数字和 MAXPTS 悄悄跑偏 */
  $('chartHint').innerHTML = t('chartHint') + t('chartMaxPts', { n:MAXPTS });
  $('pdoHint').textContent = t('pdoHint');
  $('devHint').textContent = t('devHint');
  $('inaHint').textContent = t('inaHint');
  $('calHint').innerHTML = t('calHint');
  $('calWarn').textContent = t('calWarn');
  renderCalConfirm();
  const b = $('banner');
  if(b.classList.contains('show') && !FEATURES_OK) showBanner();
  buildPollSelects();
  buildCfgSelects();
  buildThemeSelect();
  updateLiveHint();
  renderAllDynamic();
}

function updateLiveHint(){
  const pv = $('pollSel').selectedOptions[0] ? $('pollSel').selectedOptions[0].text : $('pollSel').value + ' ms';
  const iv = $('infoSel').selectedOptions[0] ? $('infoSel').selectedOptions[0].text : $('infoSel').value;
  $('liveHint').innerHTML = t('liveHintText', { v:pv, i:iv });
}

function renderAllDynamic(){
  applyInType(null, true);
  applyOutEnable(null, true);
  applyUptime(null, true);
  applyRshunt(null, true);
  applyLcd(null, true);
  applyOffset(null, true);
  applyInaCfg(null, true);
  applyPdoNum(null, true);
  applyCurPdo2(null, true);
  renderPdo();
  drawChart();
}

"use strict";
/* ------------------------------------------------------------------ *
 *  串口链路
 * ------------------------------------------------------------------ */
let port = null, reader = null, readTask = null;
let connected = false, gen = 0, myGen = 0;
let rxBuf = [];
/* 本次连接的 USB VID:PID 文本（形如 1a86:fe0c）。Web Serial 只肯给这两个数，
   设备名与 SN 得连上后问固件要，所以它是悬停提示里唯一"立刻就有"的一项。 */
let portIdText = '';
let rxBytes = 0;              /* 累计收到的字节数：连接后"排空残留"靠它判断还有没有东西在流 */
let pending = null;
let writeChain = Promise.resolve();

/* 串行写链：所有对设备的写（含"写后等应答"）都排在这一条链上，天然互斥、不会交叉。
   关键：每个链节都先 writeChain.catch(() => {}) 把上游的错误吞掉再挂新链节。
   否则一旦有一环 reject（最典型的就是断开竞态里 request 抛出的 'disconnected'），
   Promise 链会永久保持"已拒绝"状态 —— 后续 .then 的回调再也不会执行，链上排的
   写请求全部作废：表现为「重连后所有读写全哑、按钮点了没反应也没提示」，只能刷新页面。 */
function chainWrite(fn){
  const prev = writeChain.catch(() => {});
  writeChain = prev.then(fn);
  return writeChain;
}

const FEATURES_OK = ('serial' in navigator);

function setDot(cls, txt){
  $('dot').className = 'dot' + (cls ? ' ' + cls : '');
  $('stTxt').textContent = txt;
}

/* 状态行的唯一渲染出口：连接态要带上本次连接的 USB VID:PID（形如 1a86:fe0c）。
   ★ 换语言时也必须重渲染 —— 之前只有在「未连接」时才刷 stTxt，于是已连接状态下
     切语言会残留上一语言的「已连接」，看起来像没翻译。
   注意：这是设备离线（statusDevGone）之外唯一写 stTxt 的地方，别在别处再拼一遍。 */
function renderStatus(){
  const on = connected;
  setDot(on ? 'on' : '', t(on ? 'statusConnected' : 'statusDisconnected') +
         (on && portIdText ? ' (' + portIdText + ')' : ''));
}

/* 连接状态那行的悬停提示：设备名 / SN / 固件版本 / USB ID。
   Web Serial 不暴露 USB 描述符里的产品名与 SN（getInfo 只给 VID:PID），
   设备名与 SN 必须连上后问固件要（WHO_AM_I / SYSTEM_SERIAL_NUM）。
   因此每读到一项就刷新一次 —— 刚连上的那一瞬提示里只有 USB ID，
   几秒后变成四项齐全。断开时整条提示撤掉，免得留下上一台设备的信息。 */
function updateConnTip(){
  const el = $('statusBox');
  if(!el) return;
  if(!connected){ el.removeAttribute('title'); return; }
  const rows = [];
  if(S.who)     rows.push(t('devModel') + ': ' + S.who);
  if(S.serial)  rows.push(t('devSn')    + ': ' + S.serial);
  if(S.version) rows.push(t('devVer')   + ': ' + S.version);
  if(portIdText) rows.push(t('devUsb')  + ': ' + portIdText);
  el.title = rows.length ? rows.join('\n') : t('statusConnected');
}

function setEnabled(on){
  /* 注意：缩放按钮 / 趋势滚动条 / 导出 CSV / 清空曲线 都不在这里 —— 它们只跟
     "有没有采样"有关，由 syncChartControls() 管，设备断开后仍然可用。 */
  document.querySelectorAll(
    'button[data-act], #btnOut, #btnOutRefresh, #btnDynApply, #btnCfgApply, #btnCfgRead, #btnReset, #btnFactory, ' +
    '#btnFixApply, #btnFixCancel, #btnCalGo, #btnCalCancel, ' +
    '#btnCalApply, #btnCalRead, ' +
    '#selAvg, #selVbusct, #selVshct, #selLsb, #dynV, #dynI, #dynVNum, #dynINum, #chkDyn, ' +
    '#calD0, #calA0, #calD1, #calA1, #calZero'
  ).forEach(el => { el.disabled = !on; });
}

function showBanner(){
  const b = $('banner');
  b.innerHTML = '<b>' + t('tNeedFeatures') + '</b><br>' +
    (LANG === 'zh'
      ? '请使用桌面版 <b>Chrome</b> 或 <b>Edge</b>（89+）。直接用浏览器打开本文件（<code>file://</code>）即可使用 —— 全程离线、无需安装依赖、无需本地服务。'
      : 'Use desktop <b>Chrome</b> or <b>Edge</b> (89+). Just open this file in your browser (<code>file://</code>) — fully offline, no install and no local server needed.') ;
  b.className = 'banner show';
}
if(!FEATURES_OK){ showBanner(); $('btnConn').disabled = true; }

"use strict";
/* ------------------------------------------------------------------ *
 *  安装为应用（PWA）—— 取代原来的「保存到桌面」生成 .url 快捷方式
 *
 *  以前的做法是造一个 Windows 网上快捷方式（.url）让用户手动另存到桌面：
 *  双击仍然只是在浏览器里开一个标签页，图标还得靠 IconFile 指向真实文件。
 *  现在走浏览器自带的「安装」：
 *    · 桌面 / 开始菜单出现真正的应用图标（用 manifest 里的图标）
 *    · 打开是独立窗口 —— 没有地址栏、没有页签，跟原生程序一样
 *    · 装完之后离线也能用（Service Worker 兜底）
 *
 *  能不能装由浏览器说了算。Chrome 的三条硬性条件：
 *    · 有 manifest：name + 192/512 图标 + start_url + display  —— manifest.json
 *    · 注册了带 fetch 处理器的 Service Worker                  —— sw.js
 *    · 页面走 HTTPS（或 localhost）                            —— 服务器的事
 *  三条齐全浏览器才 fire beforeinstallprompt。缺一条也不报错，只是没弹窗，
 *  所以点不到弹窗时不能干瞪眼 —— 直接指路到浏览器菜单。
 * ------------------------------------------------------------------ */

const SW_FILE = 'sw.js';

/* 由 pathname 推本应用的目录；返回 null 表示"这个 URL 形态判不准，别注册"。
 *
 *   /PDTriggerMonitor/   ->  /PDTriggerMonitor/   目录形式，直接用
 *   /index.html          ->  /                     去掉末段文件名
 *   /PDTriggerMonitor    ->  null                  自相矛盾：末尾没有点、又没有斜杠
 *
 * 最后一种必须返回 null：那种地址下相对路径会被解析到站点根（页面的资源本来
 * 就全 404 了），若照常注册，sw.js 会落到 /sw.js，作用域变成**整站**，
 * 把同域下的别的应用一并接管。宁可不注册。 */
function appDirFromPath(pathname){
  const p = String(pathname || '');
  if(!p || p[0] !== '/') return null;
  if(p.slice(-1) === '/') return p;
  const cut = p.lastIndexOf('/');
  if(p.slice(cut + 1).indexOf('.') >= 0) return p.slice(0, cut + 1);
  return null;
}

/* 本浏览器能不能装。桌面版 Firefox / Safari 都没有"把网站装成应用"这回事。
   userAgentData 是 Chromium 独有的，比扒 UA 字符串可靠；window.chrome 兜底老版本。 */
function canInstallHere(){
  /* file:// 下没有 service worker，也就没有"安装" */
  if(location.protocol !== 'http:' && location.protocol !== 'https:') return false;
  if(!('serviceWorker' in navigator)) return false;
  if(!(navigator.userAgentData || window.chrome)) return false;
  /* 已经以应用方式在跑了（从桌面图标启动的），没什么可装的 */
  if(window.matchMedia && matchMedia('(display-mode: standalone)').matches) return false;
  return true;
}

function registerSW(){
  /* 只有 http/https 才谈得上 Service Worker —— file:// 不是安全上下文，
     连 navigator.serviceWorker.register() 都会直接抛。先挡住，别白试。 */
  if(location.protocol !== 'http:' && location.protocol !== 'https:') return;
  if(!('serviceWorker' in navigator)) return;
  const dir = appDirFromPath(location.pathname);
  if(!dir) return;
  navigator.serviceWorker.register(dir + SW_FILE, { scope: dir })
    .catch(e => { try{ logLine('er', 'SW REGISTER FAIL ' + e); }catch(_){ } });
}

function initInstall(){
  registerSW();

  const btn = $('btnInstall');
  if(!btn) return;

  /* 装不了的地方（Firefox / Safari / 已经是应用窗口）干脆别摆这个按钮 */
  if(!canInstallHere()){ btn.hidden = true; return; }

  let deferred = null;

  window.addEventListener('beforeinstallprompt', e => {
    /* 拦掉浏览器自己那条迷你信息栏，改由本按钮触发 —— 时机可控，也不会
       在用户刚打开页面还没搞清状况时就弹出来 */
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    btn.hidden = true;
    toast(t('tInstallOk'), 'ok');
    try{ logLine('no', 'APP INSTALLED'); }catch(_){ }
  });

  /* 按钮常驻（能装的环境里）。Chrome 的 beforeinstallprompt 带"用户与站点
     交互过一段时间"的启发式，不保证触发；只有等事件才显示按钮的话，
     用户很可能永远看不到它。点不到系统弹窗就指路菜单，比什么都不干强。 */
  btn.addEventListener('click', async () => {
    if(deferred){
      deferred.prompt();
      let choice = null;
      try{ choice = await deferred.userChoice; }catch(_){ }
      deferred = null;
      /* 接受的话紧接着会 fire appinstalled，成功提示统一由那边给 */
      if(choice && choice.outcome === 'accepted') return;
      toast(t('tInstallBad'), 'bad');
      return;
    }
    toast(t('tInstallMenu'), '');
  });
}
"use strict";
async function connect(){
  if(connected) return disconnect();
  try{
    port = await navigator.serial.requestPort({
      filters: [{ usbVendorId: 0x1A86, usbProductId: 0xFE0C }]
    }).catch(() => navigator.serial.requestPort());
    await port.open({ baudRate:115200, dataBits:8, stopBits:1, parity:'none', flowControl:'none', bufferSize:4096 });
  }catch(e){
    toast(t('tConnFail') + (e && e.message ? e.message : e), 'bad');
    logLine('er', 'OPEN FAIL ' + e);
    port = null;
    return;
  }
  connected = true; gen++; myGen = gen;
  rxBuf = [];
  portIdText = '';
  try{
    const info = port.getInfo ? port.getInfo() : {};
    if(info && (info.usbVendorId || info.usbProductId)){
      portIdText = (info.usbVendorId||0).toString(16).padStart(4,'0') + ':' +
                   (info.usbProductId||0).toString(16).padStart(4,'0');
    }
  }catch(e){}
  renderStatus();
  updateConnTip();               /* 此时只有 USB ID，设备名/SN 要等 readAllInfo 回来 */
  $('btnConn').textContent = t('btnDisconnect');
  $('btnConn').className = 'off';
  setEnabled(true);
  logLine('no', t('tPortOpen'));
  readTask = readLoop(myGen);
  /* 先只读、不发命令，把上一会话残留在设备 / 驱动缓冲里的半截帧吸干净再清缓冲。
     否则这些字节会混进新会话的协议流 —— 用户反复怀疑的“一开始设备还有数据没发完”
     就是这条路径。判据用“还有没有字节进来”：残留是现成的，几乎立刻就到，
     安静 120 ms 就算清完（最多等 800 ms，防设备真的在持续吐数据时卡住）。 */
  {
    let seen = rxBytes, quiet = 0;
    for(let spent = 0; spent < 800; spent += 40){
      await delay(40);
      if(rxBytes !== seen){ seen = rxBytes; quiet = 0; }
      else if(++quiet >= 3) break;
    }
  }
  rxBuf = []; pending = null;
  startPolling(myGen);
  startInfoLoop(myGen);
  await delay(300);
  await readAllInfo();
  /* 信息周期默认是「关闭」，后台不会再重读。为保证「当前档位 / PD 源能力」这类
     只在连接后才有意义的值一定被填上，这里补一轮带重试的档位读取 ——
     刚上电时设备往往还没做完 PD 协商，第一遍会读到空值或 0。 */
  readPdoOnConnect(myGen);
}

/* 连接后补读档位：PD 源拿到有效档位即停；QC/DC 源没有档位概念，也直接停。 */
async function readPdoOnConnect(g){
  for(let k = 0; k < 4; k++){
    if(!(connected && g === gen)) return;
    if(S.outType === 1 && S.curId) return;      /* 已经拿到有效档位 */
    if(S.outType === 2 || S.outType === 3) return; /* QC / DC：没有 PD 档位 */
    await delay(700);
    if(!(connected && g === gen)) return;
    try{ await readPdo(); }catch(e){ return; }
  }
}

async function disconnect(){
  connected = false; gen++;
  ticker.stop();                    /* 先停采样节拍（Worker 或降级的定时器） */
  setEnabled(false);
  portIdText = '';
  renderStatus();
  updateConnTip();               /* 设备已不在，撤掉悬停提示里的设备名/SN */
  $('btnConn').textContent = t('btnConnect');
  $('btnConn').className = 'primary';
  $('liveTag').innerHTML = '';
  /* 断开后设备已不可达，任何"待确认"操作都失去意义，一并撤销；
     动态调压的待发定时器也必须取消，否则会在断开后凭空发一次写命令 */
  cancelDynAuto();
  S.dynDirty = false;
  S.inaDirty = false;              /* 换设备了，未写入的 INA226 选择不再有意义 */
  /* 断开时可能正有一条请求挂在串行链上等应答。不清掉的话：它的超时定时器稍后照常触发，
     会打出一条“设备不理人”的 TIMEOUT —— 其实是我们自己放弃了，日志会把两种情形混淆。 */
  if(pending){ pending.resolve(null); clearTimeout(pending.timer); pending = null; }
  rxBuf = [];
  /* 换了设备，之前的档位与设定值都不再适用：目标归零、上次值清空，
     下次连上按「首次」取初值（设备实际值 → 兜底最小电压 / 最大电流）。
     selId 也要清 —— 否则换设备后调节区还会指着上一台的档位。 */
  S.dynTgt = 0; S.lastDynV = null; S.lastDynI = null; S.selId = 0;
  if(S.pendPdo || S.pendCal){
    S.pendPdo = null; S.pendCal = null;
    renderPdo(); renderCalConfirm();
  }
  try{ if(reader){ await reader.cancel(); } }catch(e){}
  try{ if(readTask){ await readTask; } }catch(e){}
  reader = null; readTask = null;
  try{ if(port){ await port.close(); } }catch(e){}
  port = null;
  logLine('no', t('tPortClosed'));
}

function delay(ms){ return new Promise(r => setTimeout(r, ms)); }

async function readLoop(g){
  while(connected && g === gen){
    try{
      reader = port.readable.getReader();
      while(connected && g === gen){
        const r = await reader.read();
        if(r.done) break;
        if(r.value && r.value.length){
          rxBytes += r.value.length;
          for(const b of r.value) rxBuf.push(b);
          parseRx();
        }
      }
    }catch(e){
      if(g === gen) logLine('er', 'READ ERR ' + e);
    }finally{
      try{ reader.releaseLock(); }catch(e){}
    }
    if(!(connected && g === gen)) break;
    await delay(60);
  }
}

function parseRx(){
  let guard = 0;
  while(rxBuf.length && guard++ < 4096){
    const len = frameLen(rxBuf, rxBuf.length);
    if(len === -1){ rxBuf.shift(); continue; }
    if(len === 0) return;
    if(rxBuf.length < len) return;
    const frame = rxBuf.slice(0, len);
    if(frame[len-1] !== FRAME_END){ rxBuf.shift(); continue; }
    rxBuf.splice(0, len);
    dispatch(frame);
  }
}

function dispatch(frame){
  const id = frame[0];
  logLine('rx', 'RX ' + hex(frame) + (frame.length >= 3 ? '   | ' + ascii(frame.slice(1, frame.length-1)) : ''));
  if(pending && pending.id === id){
    const p = pending; pending = null;
    clearTimeout(p.timer);
    p.resolve(frame);
  }
}

function writeBytes(arr){
  const w = port.writable.getWriter();
  return w.write(new Uint8Array(arr)).then(() => w.releaseLock())
    .catch(e => { try{ w.releaseLock(); }catch(_){} throw e; });
}

function request(cmd, payload, timeout){
  payload = payload || [];
  timeout = timeout || 500;
  return chainWrite(async () => {
    if(!connected) throw new Error('disconnected');
    if(pending){ pending.resolve(null); clearTimeout(pending.timer); pending = null; }
    const out = [cmd | READ].concat(payload, [FRAME_END]);
    logLine('tx', 'TX ' + hex(out));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if(pending && pending.id === (cmd | READ)){
          pending = null;
          /* 超时 = 这条命令的应答不会来了。缓冲里若还留着它被切碎的残片，不清掉就会
             和下一帧拼在一起、把下一条命令也带偏 —— 从干净边界重新开始。 */
          if(rxBuf.length) rxBuf = [];
          logLine('er', 'TIMEOUT cmd 0x' + (cmd|READ).toString(16));
        }
        resolve(null);
      }, timeout);
      pending = { id: cmd | READ, resolve, timer };
      writeBytes(out).catch(e => {
        clearTimeout(timer); pending = null; resolve(null);
        logLine('er', 'WRITE ERR ' + e);
      });
    });
  });
}

function writeOnly(cmd, payload){
  payload = payload || [];
  return chainWrite(async () => {
    if(!connected) throw new Error('disconnected');
    const out = [cmd].concat(payload, [FRAME_END]);
    logLine('tx', 'TX ' + hex(out));
    await writeBytes(out);
    return true;
  });
}

/* 写入 → 延迟落盘 → 轮询回读到期望值（固件 Config 约 500 ms 才写 Flash） */
async function writeAndConfirm(writeCmd, payload, readCmd, match, tries){
  await writeOnly(writeCmd, payload);
  tries = tries || 8;
  let last = null;
  for(let i = 0; i < tries; i++){
    await delay(400);
    last = await request(readCmd, [], 700);
    if(last && match(last)) return last;
  }
  return last;   /* 返回最后一帧（可能仍是旧值） */
}

"use strict";
/* ------------------------------------------------------------------ *
 *  设备状态
 * ------------------------------------------------------------------ */
const S = {
  outType:0, outEnable:null, uptime:0, mah:0, mwh:0,
  live:{v:0,i:0,p:0}, max:{v:0,i:0,p:0},
  fixedN:0, ppsN:0, avsN:0, fixed:[], pps:[], avs:[],
  curId:0, curV:0, curI:0, pendPdo:null, pendCal:null,
  /* selId   —— 正在编辑的动态档（PPS/AVS）行号，只影响下方调节区，绝不写进 curId。
               它只在「用户确认进入某个动态档、且设备真的切过去了」之后才被设上；
               设备回读变成固定档时清掉 —— 这样它永远指向设备当前所在的动态档。
     dynDirty —— 用户手动动过滑块；为真时信息周期的自动刷新不得覆盖滑块的值
     两者分开，是为了让「当前档位」只由设备回读（applyCurPdo / applyCurPdo2）决定 */
  selId:0, dynDirty:false,
  /* dynTgt    —— 上一次渲染时调节区指向的档位。它一变就说明「换组」了，此时才按换组规则
                 重设滑块；同一档内绝不重设，否则信息周期一刷新就把用户手里的值冲掉。
     lastDynV/I —— 上一次设定过的电压/电流（mV/mA），跨「调节区隐藏」保留：
                 中途切到 Fixed 再切回 PPS 时值还在，不会平白回到最小电压。 */
  dynTgt:0, lastDynV:null, lastDynI:null,
  rshunt:null, inaCfg:null, lcd:null, offset:null,
  /* inaDirty —— 用户动过 INA226 下拉框、但还没写入：为真时信息周期的回读不得覆盖表单，
                  否则刚选好的值会被弹回设备值。写入成功或点「读取配置」后清掉。 */
  inaDirty:false,
  version:'', serial:'', who:''
};

const samples = [];
/* 趋势最多显示/保留的数据点数。超出后从最早的一个开始丢（环形裁剪），
   丢弃的总数记在 dropped 里，逻辑下标 = 数组下标 + dropped。
   这个值同时决定滑块的最大行程 —— syncChartControls() 里按"当前点数"实时算，
   所以改这里不需要动别处。 */
const MAXPTS = 2000;

/* ---- 各命令应用（f 为 null 时表示按当前状态重渲染） ---- */
function applyLive(f){
  if(!f) return;
  const v = u32(f,1), i = i32(f,5), p = u32(f,9);
  S.live = { v, i, p };
  $('mV').textContent = (v/1000).toFixed(3);
  $('mI').textContent = (i/10000).toFixed(4);
  $('mP').textContent = (p/1000).toFixed(3);
  samples.push({ t:Date.now(), v:v/1000, i:i/10000, p:p/1000 });
  /* 环形裁剪：dropped 记录累计被裁掉的历史样本数，
     逻辑下标 = 数组下标 + dropped。定格窗口用它换算，裁剪时才不会整体前移。 */
  while(samples.length > MAXPTS){ samples.shift(); dropped++; }
  /* 环形裁剪可能把整段定格窗口挤出去（窗里一个样本都不剩 = 只剩光秃秃的网格）。
     定格已无内容可看，与其留一条空白曲线，不如自动回到滚动刷新，并说明原因。 */
  if(frozen && frozen.end <= dropped) resumeFollow(t('tFrozenExpired'));
  drawChart();
}

function applyMax(f){
  if(!f) return;
  S.max = { v:u32(f,1), i:i32(f,5), p:u32(f,9) };
  $('maxV').textContent = (S.max.v/1000).toFixed(3);
  $('maxI').textContent = (S.max.i/10000).toFixed(4);
  $('maxP').textContent = (S.max.p/1000).toFixed(3);
}

function applyMah(f){
  if(!f) return;
  S.mah = u32(f,1); S.mwh = u32(f,5);
  $('mah').textContent = S.mah;
  $('mwh').textContent = S.mwh;
}

function applyUptime(f){
  if(f) S.uptime = u32(f,1);
  if(!connected && !S.uptime){ $('uptime').textContent = '--'; return; }
  const s = S.uptime;
  const d = Math.floor(s/86400), h = Math.floor(s%86400/3600), m = Math.floor(s%3600/60);
  $('uptime').textContent = (d ? d+'d ' : '') + String(h).padStart(2,'0') + ':' +
    String(m).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
}

function inTypePill(extra){
  const code = OUT_TYPE[S.outType];
  if(!code) return '<span class="pill none">--</span>';
  const cls = (code === 'PD' || code === 'QC') ? ('pill ' + code.toLowerCase() + (extra ? ' big' : '')) : ('pill ' + code.toLowerCase());
  return '<span class="' + cls + '">' + code + '</span>';
}

function applyInType(f){
  if(f) S.outType = f[1];
  $('inType').innerHTML = inTypePill(true);
  $('liveTag').innerHTML = (OUT_TYPE[S.outType] ? inTypePill(false) : '');
}

function applyPdoNum(f){
  if(f){ S.fixedN = f[1]; S.ppsN = f[2]; S.avsN = f[3]; }
}

function applyPdoFix(f){
  if(!f) return;
  const total = f[1], n = Math.floor(total/4);
  S.fixed = [];
  for(let k=0;k<n;k++) S.fixed.push({ v:u16(f, 2+k*4), i:u16(f, 4+k*4) });
  renderPdo();
}

function applyPdoPps(f){
  if(!f) return;
  const total = f[1], n = Math.floor(total/6);
  S.pps = [];
  for(let k=0;k<n;k++) S.pps.push({ min:u16(f,2+k*6), max:u16(f,4+k*6), i:u16(f,6+k*6) });
  renderPdo();
}

function applyPdoAvs(f){
  if(!f) return;
  const total = f[1], n = Math.floor(total/6);
  S.avs = [];
  /* 每项 6 字节：[2]=最小电压(mV) [4]=最大电压(mV) [6]=功率。
     注意第三项单位是 **W**（固件有符号数按 1 W 递增，见 usbpd.h 的 MaxPowerIn1Wincrements），
     不是 mW —— 渲染成"W"时要直接输出，不要再除 1000。 */
  for(let k=0;k<n;k++) S.avs.push({ min:u16(f,2+k*6), max:u16(f,4+k*6), p:u16(f,6+k*6) });
  renderPdo();
}

/* 当前档位（固定档）回读。
   注意末尾必须重画表格：行高亮（.sel）、下方调节区的"目标档位"判据都看 S.curId，
   只刷"当前档位"那行字的话，表里会一直挂着旧高亮 —— 信息周期默认是关闭的
   （不会再周期性重读档位），这个错就永远修不掉。 */
function applyCurPdo(f){
  if(!f) return;
  S.curId = f[1]; S.curV = u16(f,2);
  /* 设备已经切回固定档 → 之前在动态档上的编辑意图作废，调节区随之收起。
     否则 selId 会留着一个"设备根本不在"的档位，把调节区一直挂在那儿。 */
  if(S.curId && S.curId <= S.fixedN) S.selId = 0;
  renderCurPdo();
  renderPdo();
}

/* 当前档位（PPS/AVS 动态档）回读，带上电流上限。同上：curId 变了就得重画表格。 */
function applyCurPdo2(f){
  if(f){ S.curId = f[1]; S.curV = u16(f,2); S.curI = u16(f,4); }
  /* 让 selId 跟着设备走：设备在动态档就指向它，切回固定档就清掉。
     这样「调节区显示什么」永远等于「设备当前在哪一档」。 */
  if(S.curId > S.fixedN && dynKindOf(S.curId)) S.selId = S.curId;
  else S.selId = 0;
  renderCurPdo();
  renderPdo();
}

function renderCurPdo(){
  if(!S.curId){ $('curPdo').textContent = '--'; return; }
  let s = '#' + S.curId + ' @ ' + (S.curV/1000).toFixed(3) + ' V';
  if(S.curI) s += ' / ' + (S.curI/1000).toFixed(3) + ' A';
  $('curPdo').textContent = s;
}

function applyOutEnable(f){
  if(f) S.outEnable = f[1] ? 1 : 0;
  const b = $('btnOut');
  if(S.outEnable === null){ b.textContent = t('outUnknown'); b.className = 'off'; return; }
  b.textContent = S.outEnable ? t('outOn') : t('outOff');
  b.className = S.outEnable ? 'on' : 'off';
}

/* 采样电阻 / LCD 面板：只读展示。
   写入接口已从本页移除（属产线/出厂参数，误改会直接改变电流量程与显示驱动）。 */
function applyRshunt(f){
  if(f) S.rshunt = f[1];
  $('dvRsh').textContent = (S.rshunt === null ? '--' : S.rshunt);
}

"use strict";
const AVG_TAB = [1,4,16,64,128,256,512,1024];
const VBUS_US = [140,204,332,588,1100,2116,4156,8244];
const VBUSCT_TAB = ['140uS','204uS','332uS','588uS','1.1mS','2.116mS','4.156mS','8.244mS'];
const VSHCT_TAB  = ['140uS','204uS','332uS','588uS','1.1mS','2.116mS','4.156mS','8.244mS'];
const MODE_TEXT = {
  zh:['掉电','分流单次','母线单次','分流+母线单次','掉电','分流连续','母线连续','分流+母线连续'],
  en:['Power-down','Shunt once','Bus once','Shunt+Bus once','Power-down','Shunt cont.','Bus cont.','Shunt+Bus cont.'],
  ru:['Отключено','Шунт однократно','Шина однократно','Шунт+шина однократно','Отключено','Шунт непр.','Шина непр.','Шунт+шина непр.'],
  de:['Aus','Shunt einmal','Bus einmal','Shunt+Bus einmal','Aus','Shunt fortl.','Bus fortl.','Shunt+Bus fortl.']
};
function modeName(i){ return (MODE_TEXT[LANG] || MODE_TEXT.zh)[i] || ('#' + i); }
function lsbText(n){ return (n/10).toFixed(1); }

function decodeCfg(val){
  return { avg:(val>>9)&7, vbusct:(val>>6)&7, vshct:(val>>3)&7, mode:val&7, rst:(val>>15)&1 };
}

/* 单次转换耗时（µs）= 平均次数 ×（母线采样 + 分流采样） */
function cfgCycleUs(avg, vbusct, vshct){
  return AVG_TAB[avg] * (VBUS_US[vbusct] + VBUS_US[vshct]);
}

/* 下拉框里当前选中的值（读表单，与设备无关） */
function inaPick(){
  return { avg:parseInt($('selAvg').value, 10), vbusct:parseInt($('selVbusct').value, 10),
           vshct:parseInt($('selVshct').value, 10), lsb:parseInt($('selLsb').value, 10) };
}

/* 换算耗时提示：按【下拉框当前选择】实时算 —— 改一下立刻能看到结果，不必先写入。
   它只是预览；设备真正按这组参数运行，仍要等点过「写入配置」。
   所以当选择跟设备实际配置不一致时，补一句"未写入"，免得把预览值当成设备当前状态。 */
function renderCfgCalc(){
  const el = $('cfgCalc');
  const p = inaPick();
  if(!S.inaCfg || !(p.avg >= 0 && p.vbusct >= 0 && p.vshct >= 0)){ el.textContent = '--'; return; }
  const d = decodeCfg(S.inaCfg.val);
  const pend = (d.avg !== p.avg || d.vbusct !== p.vbusct || d.vshct !== p.vshct);
  el.textContent = t('avg') + ' ' + AVG_TAB[p.avg] + ' × (' + VBUSCT_TAB[p.vbusct] + ' + ' +
    VSHCT_TAB[p.vshct] + ') ≈ ' + (cfgCycleUs(p.avg, p.vbusct, p.vshct)/1000).toFixed(2) + ' ms' +
    (pend ? ' · ' + t('cfgPend') : '');
}

function applyInaCfg(f){
  if(f){ S.inaCfg = { lsb:f[1], val:u16(f,2) }; }
  if(!S.inaCfg) return;
  const lsb = S.inaCfg.lsb, val = S.inaCfg.val;
  const d = decodeCfg(val);
  $('dvCfg').textContent = '0x' + val.toString(16).toUpperCase().padStart(4,'0') + ' · ' + lsbText(lsb) + ' ' + t('lsbUnit');
  $('modeTxt').textContent = modeName(d.mode) + ' (' + d.mode + ')';
  buildCfgSelects();
  /* "未写入"就是"表单里有跟设备不一致的改动"。设备这一读正好跟表单一致了（写入已生效），
     就没有待写入的东西了 —— 直接由"表单 vs 设备"判定，不另存一份可能过期的标志。 */
  const p = inaPick();
  if(S.inaDirty && p.avg === d.avg && p.vbusct === d.vbusct && p.vshct === d.vshct && p.lsb === lsb){
    S.inaDirty = false;
  }
  /* 还有没写入的改动时，别拿回读值把表单盖掉 ——
     否则信息周期每刷一轮，用户刚选的值就被弹回设备值（同 dynDirty 的处理）。
     彻底回退到设备值要走「读取配置」。 */
  if(!S.inaDirty){
    $('selAvg').value = d.avg; $('selVbusct').value = d.vbusct;
    $('selVshct').value = d.vshct; $('selLsb').value = lsb;
  }
  renderCfgCalc();
}

function buildCfgSelects(){
  const a = $('selAvg'), b = $('selVbusct'), c = $('selVshct'), l = $('selLsb');
  const keep = { a:a.value, b:b.value, c:c.value, l:l.value };
  if(!a.options.length){
    AVG_TAB.forEach((n,i) => a.add(new Option('', i)));
    VBUSCT_TAB.forEach((n,i) => b.add(new Option(n, i)));
    VSHCT_TAB.forEach((n,i) => c.add(new Option(n, i)));
    for(let n=1;n<=10;n++) l.add(new Option('', n));
  }
  for(let i=0;i<AVG_TAB.length;i++) a.options[i].text = AVG_TAB[i] + ' ' + t('avgUnit');
  for(let n=1;n<=10;n++) l.options[n-1].text = lsbText(n) + ' ' + t('lsbUnit');
  if(keep.a) a.value = keep.a; if(keep.b) b.value = keep.b;
  if(keep.c) c.value = keep.c; if(keep.l) l.value = keep.l;
}

function buildThemeSelect(){
  const s = $('themeSel');
  const keep = s.value || LS.get('theme', DEFAULT_THEME);
  const items = [['dark','themeDark'],['light','themeLight'],['auto','themeAuto']];
  if(!s.options.length) items.forEach(it => s.add(new Option('', it[0])));
  items.forEach((it, i) => { s.options[i].text = t(it[1]); });
  s.value = keep;
}
function lcdText(v){
  if(v === 0) return t('lcdHan');
  if(v === 1) return t('lcdBoe');
  return t('lcdUnknown', { v:v });
}

function applyLcd(f){
  if(f) S.lcd = f[1];
  $('dvLcd').textContent = (S.lcd === null ? '--' : lcdText(S.lcd));
}

/* 电流校准：结构体 5 × int32，单位一律 0.1 mA（含零点偏移，固件侧同口径） */
function applyOffset(f){
  if(f) S.offset = f.slice(1, 21);
  /* 待确认期间冻结表单：轮询刷新不能覆盖用户已确认的那组数值，
     否则会出现「摘要里显示的是 A、实际写下去的是 B」。 */
  if(S.pendCal) return;
  if(!S.offset) return;
  const d0 = i32(S.offset,0), a0 = i32(S.offset,4), d1 = i32(S.offset,8), a1 = i32(S.offset,12), z = i32(S.offset,16);
  const set = (id, raw) => { const el = $(id); if(document.activeElement !== el) el.value = (raw/10).toFixed(1); };
  set('calD0', d0); set('calA0', a0); set('calD1', d1); set('calA1', a1);
  const zEl = $('calZero'); if(document.activeElement !== zEl) zEl.value = (z/10).toFixed(1);
}

function applyText(f, setter){
  /* 帧格式：[cmd, 字符数, ...字符, END] —— 必须跳过长度字节，否则会渲染出前导 '.' */
  const n = f[1];
  const s = ascii(f.slice(2, 2 + n)).replace(/[\s\x00.]+$/,'');
  setter(s);
}

"use strict";
/* ---- PD 表渲染 ---- */

/* 整表编号 1..fixedN+ppsN+avsN，动态档 = PPS 与 AVS */
function dynKindOf(id){
  if(id > S.fixedN && id <= S.fixedN + S.ppsN) return 'pps';
  if(id > S.fixedN + S.ppsN && id <= S.fixedN + S.ppsN + S.avsN) return 'avs';
  return '';
}
function dynTotal(){ return S.fixedN + S.ppsN + S.avsN; }

/* 动态档的电压/电流可调范围（mV / mA）。
   PPS：直接取能力表。AVS：能力表只给功率，固件按 Power/SetVoltage 反推电流并夹到 5 A，
   所以这里给固件的硬上限，实际值由写入后的回读纠偏。 */
function dynRangeOf(id){
  const k = dynKindOf(id);
  if(k === 'pps'){
    const p = S.pps[id - S.fixedN - 1];
    return p ? { min:p.min, max:p.max, imax:p.i } : null;
  }
  if(k === 'avs'){
    const p = S.avs[id - S.fixedN - S.ppsN - 1];
    return p ? { min:p.min, max:p.max, imax:5000 } : null;
  }
  return null;
}

/* 「上一次设定过的值」——换组沿用时的比较基准。
   调节区正显示着 → 用户手里的值就是上一次的值；已收起 → 用收起时记下的；
   从没设过才退回「设备当前这一档的实际输出」（仅当目标正好是当前档）。 */
function dynPrevVals(tgt){
  if(S.dynTgt) return { v:+$('dynV').value, i:+$('dynI').value };
  let lv = S.lastDynV, li = S.lastDynI;
  if(lv === null && tgt === S.curId && S.curV) lv = S.curV;
  if(li === null && tgt === S.curId && S.curI) li = S.curI;
  return { v:lv, i:li };
}

/* 进入 tgt 这一档时该带哪组值：上一次的设定值**落在这一档范围内就沿用**，
   否则电压取该档最小值、电流取该档上限（电流没有「0 上限」的用法，下限按 1 mA 计）。
   这是"进入某档"的唯一定义 —— 点行二次确认时申请的值、以及调节区刚展开时
   滑块停的位置，都走这里，两处不会各说各话。 */
function dynInitVals(tgt){
  const r = dynRangeOf(tgt);
  if(!r) return null;
  const vmin = r.min, vmax = Math.max(r.min, r.max), imax = Math.max(1, r.imax);
  const pv = dynPrevVals(tgt);
  return {
    v: clamp(pv.v !== null && pv.v >= vmin && pv.v <= vmax ? pv.v : vmin, vmin, vmax),
    i: clamp(pv.i !== null && pv.i > 0 && pv.i <= imax ? pv.i : imax, 0, imax)
  };
}

/* 下方调节区当前指向哪个动态档：用户显式点过 PPS/AVS 行的优先，否则跟随设备当前所在的档位。
   返回 0 = 没有可调目标 —— 此时整块调节区（调节档位 / 动态调压 / 电压与电流滑块及输入框 /
   应用设定）一律不显示。刻意不再兜底到「第一个动态档」：那个兜底会让设备明明停在 Fixed 档时，
   下方凭空冒出一个 PPS 调节区（设备在 Fixed，滑块却在调 PPS，看着像已经生效）。 */
function dynTargetId(){
  const total = dynTotal();
  if(S.selId > 0 && S.selId <= total && dynKindOf(S.selId)) return S.selId;
  if(S.curId > S.fixedN && S.curId <= total && dynKindOf(S.curId)) return S.curId;
  return 0;
}

function renderPdo(){
  const tb = $('pdoBody');
  if(!S.fixed.length && !S.pps.length && !S.avs.length){
    tb.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--fg3)">' +
      (connected ? t('noPdoData') : t('notConnected')) + '</td></tr>';
    $('dynCtl').style.display = 'none';
    renderDynCtl(0);          /* 无档位 → 收起调节区（顺带记下上次值、目标归零） */
    return;
  }
  const tgt = dynTargetId();
  /* 行装饰共三种，互不重叠：
     .sel  = 设备当前档位（只由回读决定）；
     .pend = 已点、正在等二次确认的那一行（Fixed 与 PPS/AVS 共用）；
     .edit = 用户确认进入的动态档（正常流程下就等于 .sel，留着做兜底标记）。
     .edit 刻意不能用 tgt 来标：tgt 是"下方调节区在编辑谁"，它会兜底退回设备当前档，
     拿它冒充"用户选了这一行"，就会出现刚连上设备、什么都没点却冒出虚线框（用户报过的障）。 */
  const sel = (S.selId > 0 && S.selId <= dynTotal() && dynKindOf(S.selId)) ? S.selId : 0;
  let idx = 0, html = '';
  S.fixed.forEach(p => {
    idx++;
    const cls = (idx === S.curId) ? 'sel' : ((S.pendPdo && S.pendPdo.id === idx) ? 'pend' : '');
    html += '<tr data-id="' + idx + '" data-kind="fix" data-v="' + p.v + '" class="' + cls + '">' +
      '<td>' + idx + '</td><td><span class="pill pd">Fixed</span></td>' +
      '<td>' + (p.v/1000).toFixed(2) + ' V</td><td>' + (p.i/1000).toFixed(3) + ' A</td></tr>';
  });
  S.pps.forEach(p => {
    idx++;
    const range = (p.min/1000).toFixed(2) + ' - ' + (p.max/1000).toFixed(2) + ' V';
    /* .sel = 设备当前档位（回读得到）；.pend = 待二次确认的那一行；.edit = 确认进入的动态档 */
    const cls = (idx === S.curId) ? 'sel' : ((S.pendPdo && S.pendPdo.id === idx) ? 'pend' : ((idx === sel) ? 'edit' : ''));
    html += '<tr data-id="' + idx + '" data-kind="pps" data-min="' + p.min + '" data-max="' + p.max + '" data-i="' + p.i + '" class="' + cls + '">' +
      '<td>' + idx + '</td><td><span class="pill qc">PPS</span></td>' +
      '<td>' + range + '</td><td>' + (p.i/1000).toFixed(3) + ' A</td></tr>';
  });
  S.avs.forEach(p => {
    idx++;
    const range = (p.min/1000).toFixed(2) + ' - ' + (p.max/1000).toFixed(2) + ' V';
    const cls = (idx === S.curId) ? 'sel' : ((S.pendPdo && S.pendPdo.id === idx) ? 'pend' : ((idx === sel) ? 'edit' : ''));
    /* AVS 能力表的第四个字段是**功率、单位就是 W**（固件字段 MaxPowerIn1Wincrements，1 W 递增），
       和 Fixed/PPS 那两列的 mV/mA 不同，这里不能再除 1000（除出来会把 140 W 显示成 0.140 W）。 */
    html += '<tr data-id="' + idx + '" data-kind="avs" data-min="' + p.min + '" data-max="' + p.max + '" class="' + cls + '">' +
      '<td>' + idx + '</td><td><span class="pill dc">AVS</span></td>' +
      '<td>' + range + '</td><td>' + p.p.toFixed(0) + ' W</td></tr>';
  });
  tb.innerHTML = html;

  $('pdoTag').textContent = t('pdoTagFmt', { f:S.fixedN, p:S.ppsN, a:S.avsN });

  renderPdoConfirm();
  renderDynCtl(tgt);
}

/* 下方 PPS / AVS 调节区。
   关键点：信息周期会周期性调用 renderPdo()，但只有当用户没有手动拖动过滑块时
   （S.dynDirty 为假）才用设备值重置滑块 —— 否则用户永远调不动。 */
function renderDynCtl(tgt){
  const box = $('dynCtl');
  const r = tgt ? dynRangeOf(tgt) : null;
  /* 目标档不存在（没连设备 / 设备停在 Fixed 档 / 用户没点过动态档）→ 整块收起。
     收起前把这一档最后的设定值记下来：下次再展开（哪怕中间切到 Fixed）还能沿用。 */
  if(!r){
    box.style.display = 'none';
    if(S.dynTgt){ S.lastDynV = +$('dynV').value; S.lastDynI = +$('dynI').value; }
    S.dynTgt = 0;
    return;
  }
  box.style.display = 'block';

  const kind = dynKindOf(tgt).toUpperCase();
  $('dynTargetLbl').textContent = '#' + tgt + ' · ' + kind;

  const v = $('dynV'), i = $('dynI');
  const vmin = r.min, vmax = Math.max(r.min, r.max), imax = Math.max(1, r.imax);
  /* 顺序要紧：先改 min/max/step，浏览器会顺带夹一次 value，再写 value 才是最终值 */
  v.min = vmin; v.max = vmax; v.step = DYN_STEP.v;
  i.min = 0;    i.max = imax; i.step = DYN_STEP.i;
  /* 输入框与滑块必须共用同一套量程/步进，否则一个夹 11.00、另一个放到 20.00，各说各话 */
  const vn = $('dynVNum'), iN = $('dynINum');
  vn.min = (vmin/1000).toFixed(2); vn.max = (vmax/1000).toFixed(2);
  vn.step = (DYN_STEP.v/1000).toFixed(2);
  iN.min = '0'; iN.max = (imax/1000).toFixed(2);
  iN.step = (DYN_STEP.i/1000).toFixed(2);

  /* 只有「调节目标换了」的那一刻才重设滑块初值；同一档内不动，否则信息周期一刷新就把
     用户手里的值冲掉。初值规则见 dynInitVals：沿用上一档的值，越界才回最小电压 / 最大电流。 */
  if(S.dynTgt !== tgt){
    const iv = dynInitVals(tgt);
    v.value = iv.v;
    i.value = iv.i;
    S.dynTgt = tgt;
    S.dynDirty = false;
    cancelDynAuto();            /* 换了目标档，上一档的「待发自动下发」必须作废 */
  }
  else if(!S.dynDirty && tgt === S.curId && S.curV){
    /* 设备正好就在这一档、用户也没动过滑块 → 让它反映设备的真实输出 */
    v.value = clamp(S.curV, vmin, vmax);
    i.value = clamp(S.curI || imax, 0, imax);
  }
  v.value = clamp(+v.value, vmin, vmax);
  i.value = clamp(+i.value, 0, imax);

  syncDynLabels();
  $('dynHint').textContent = t('dynRange', {
    k:kind, id:tgt, min:(vmin/1000).toFixed(2), max:(vmax/1000).toFixed(2), imax:(imax/1000).toFixed(2)
  }) + '　·　' + t('dynTypeTip') + (dynEnabled() ? '　·　' + t('dynEnable') + ' ✓' : '');
}

"use strict";
/* ---- 动态档位的两个"精确输入"框 --------------------------------------
   滑块负责快速扫、输入框负责给准数 —— 同一个值的两种表达，任何时候都保持一致。
   步进就是协议粒度（PPS/AVS 的电压 20 mV、电流 50 mA），所以键入 9.15 V 会当场
   对齐到 20 mV 网格上（→ 9.16 V）：与其让设备自己量化成"看着不像我填的数"，
   不如在这里就对好，输入框、滑块、发出去的字节三者始终是同一个值。 */
const DYN_STEP = { v:20, i:50 };   /* mV / mA，与 range 的 step 一致 */
const DYN_DP   = { v:2,  i:3  };   /* 显示精度，2 位 = 20 mV，3 位 = 1 mA */

function dynSliderEl(k){ return $(k === 'v' ? 'dynV' : 'dynI'); }
function dynNumEl(k){ return $(k === 'v' ? 'dynVNum' : 'dynINum'); }

/* 当前调节目标的量程；没有可调动态档时返回 null */
function dynRangeNow(){
  const id = dynTargetId();
  const r = id ? dynRangeOf(id) : null;
  return r ? { id:id, vmin:r.min, vmax:Math.max(r.min, r.max), imax:Math.max(1, r.imax) } : null;
}
function dynLoHi(k, L){ return (k === 'v') ? [L.vmin, L.vmax] : [0, L.imax]; }

/* 对齐到"下限 + n×步进"的网格。下限取 range 的 min，两边可取的值集合便完全相同 */
function snapStep(k, val, L){
  const lo = dynLoHi(k, L)[0];
  return lo + Math.round((val - lo) / DYN_STEP[k]) * DYN_STEP[k];
}
/* 输入框文本 → 数值：空串/非法返回 NaN；顺手把逗号小数（俄/德键盘习惯）当小数点收下 */
function parseNum(el){
  const s = String(el.value).replace(',', '.').trim();
  if(!s) return NaN;
  const n = parseFloat(s);
  return isFinite(n) ? n : NaN;
}

/* 滑块 → 输入框。正在输入的框不覆盖，否则光标会被顶掉、打一半的字被吃掉 */
function syncDynLabels(){
  if(!dynRangeNow()) return;
  ['v','i'].forEach(k => {
    const out = dynNumEl(k);
    if(document.activeElement === out) return;
    out.value = (+dynSliderEl(k).value / 1000).toFixed(DYN_DP[k]);
  });
}
/* 输入框 → 滑块：键入时同步，保证「应用设定」读到的就是用户眼前看到的 */
function pushNumToSlider(k){
  const L = dynRangeNow(); if(!L) return;
  const val = parseNum(dynNumEl(k));
  if(!isFinite(val)) return;              /* 空框/半成品：先不动滑块，等 commitNum 收拾 */
  const lo = dynLoHi(k, L)[0], hi = dynLoHi(k, L)[1];
  dynSliderEl(k).value = clamp(snapStep(k, val * 1000, L), lo, hi);
}
/* 输入框定稿（回车 / 失焦 / 上下箭头）：把文字归一化成滑块真值的样子 */
function commitNum(k){
  pushNumToSlider(k);
  if(!dynRangeNow()) return;
  dynNumEl(k).value = (+dynSliderEl(k).value / 1000).toFixed(DYN_DP[k]);
}

/* 「动态调压」使能：打开后不需要二次确认，停手 0.1 s 自动下发 */
function dynEnabled(){ return $('chkDyn').checked; }

let dynTimer = 0;
function cancelDynAuto(){
  if(dynTimer){ clearTimeout(dynTimer); dynTimer = 0; }
}
/* 「动态调压」勾选后，滑块停手多久自动下发。0.1 s 既滤得掉拖拽途中的抖动，
   又让手感接近实时 —— 曾是 0.5 s，用户反馈"松手了还得等一下才动"。 */
const DYN_AUTO_MS = 100;

function armDynAuto(){
  cancelDynAuto();
  if(!dynEnabled()) return;
  if(!connected) return;
  /* 只有目标是可调动态档、且确实是"这一档"时才自动下发 */
  const id = dynTargetId();
  if(!id || !dynRangeOf(id)) return;
  dynTimer = setTimeout(() => {
    dynTimer = 0;
    if(!connected || !dynEnabled()) return;
    applyDyn(true);
  }, DYN_AUTO_MS);
}

/* 档位切换的二次确认条 —— Fixed 与 PPS / AVS 共用同一条：
   Fixed 点行后是「切到该固定档」；PPS / AVS 点行后是「带着初值进入该可调档」
   （初值 = 上一次设定值，越界则电压最小 / 电流最大，见 dynInitVals）。
   两种都是会触发 PD 重新协商的切换，所以都要先确认，共用一套视觉与按钮。
   摘要只认快照 S.pendPdo，不读界面 —— 显示的一定等于会写下去的那组值。 */
function renderPdoConfirm(){
  const box = $('fixConfirm');
  if(!S.pendPdo){ box.style.display = 'none'; return; }
  const p = S.pendPdo;
  box.style.display = 'block';
  const head = (p.kind === 'fix') ? ('#' + p.id) : ('#' + p.id + ' · ' + p.kind.toUpperCase());
  $('fixTarget').textContent = head + ' @ ' + (p.v / 1000).toFixed(2) + ' V / ' +
    (p.i / 1000).toFixed(3) + ' A';
  $('fixWarn').textContent = (p.kind === 'fix')
    ? t('fixWarn')
    : t('dynEnterWarn', { v:(p.v/1000).toFixed(2), i:(p.i/1000).toFixed(3) });
}

/* 电流校准的二次确认条：把「将要写下去的那组值」原样列出来，
   摘要以快照（S.pendCal）为准，而不是读输入框——这样显示的一定等于会写的。 */
function renderCalConfirm(){
  const box = $('calConfirm'), card = $('calCard');
  if(!S.pendCal){
    box.style.display = 'none';
    if(card) card.classList.remove('pend');
    return;
  }
  box.style.display = 'block';
  if(card) card.classList.add('pend');
  const p = S.pendCal;
  const row = (label, val) => '<div class="k">' + label + '</div><div class="v">' + val + '</div>';
  const mA = r => (r / 10).toFixed(1) + ' mA';
  $('calCfGrid').innerHTML =
    row(t('calD0'), mA(p.raw[0])) + row(t('calA0'), mA(p.raw[1])) +
    row(t('calD1'), mA(p.raw[2])) + row(t('calA1'), mA(p.raw[3])) +
    row(t('calZero'), mA(p.z));
  $('calCfHint').textContent = t('calCfHint');
  $('btnCalGo').disabled = !connected;
  $('btnCalCancel').disabled = !connected;
}

/* 「读取配置」是显式动作，先撤销待确认态，避免快照与新读到的值打架 */
function clearPendCal(){ if(S.pendCal){ S.pendCal = null; renderCalConfirm(); } }

"use strict";
/* ---- 轮询 ----
   节拍必须由 Worker 来打：主线程的定时器一旦页面被最小化 / 切到后台，就会被
   Chrome 节流 —— 先压到最小 1s 间隔，隐藏超过 5 分钟后再压到 1 分钟一次，
   采样等于停摆，趋势上留下一大片空洞（"最小化回来发现曲线断了"）。
   Worker 里的定时器被 HTML 规范明确排除在节流之外（Chrome 只节流主线程），
   所以把"打拍子"挪进去，主线程只负责收到拍子后发命令。
   file:// 下用普通脚本 URL 建 Worker 会被跨源拦掉，但 Blob URL 可以（已实测）；
   万一浏览器仍拒绝，就退回主线程定时器：功能照旧，只是后台会被节流。 */
const ticker = (() => {
  let w = null, cb = null, iv = 0, fb = 0;
  try{
    const src = 'let t=null;onmessage=e=>{const d=e.data;'
      + 'if(d.cmd==="stop"){if(t){clearInterval(t);t=null;}return;}'
      + 'if(t){clearInterval(t);t=null;}'
      + 'if(d.iv>0){t=setInterval(()=>postMessage(0),d.iv);}}';
    w = new Worker(URL.createObjectURL(new Blob([src], { type:'text/javascript' })));
    w.onmessage = () => { if(cb) cb(); };
  }catch(e){ w = null; }
  const fire = () => { if(cb) cb(); };
  function armFb(){ clearInterval(fb); fb = (cb && iv > 0) ? setInterval(fire, iv) : 0; }
  return {
    get worker(){ return w; },                 /* 供自检观察是否真的用上了 Worker */
    get running(){ return !!cb; },             /* 节拍是否挂着一个回调（断开后应为 false） */
    start(interval, fn){
      cb = fn; iv = interval;
      if(w) w.postMessage({ cmd:'start', iv: iv }); else armFb();
    },
    setIv(interval){
      if(interval === iv) return;
      iv = interval;
      if(w) w.postMessage({ cmd:'start', iv: iv }); else if(cb) armFb();
    },
    /* 立刻补一拍：页面重新可见时用，省得刚好卡在两拍之间，看到的是旧值 */
    kick(){ fire(); },
    stop(){
      cb = null;
      if(w) w.postMessage({ cmd:'stop' }); else clearInterval(fb);
      fb = 0;
    }
  };
})();

let tickCount = 0;

/* 采样周期（ms）：下拉没选或值非法时退回 200，别让节拍变成 0 / NaN。 */
function pollIv(){
  const v = parseInt($('pollSel').value, 10);
  return (v > 0) ? v : 200;
}

/* 一轮采样：读实时数据，并按"每秒几次"的节奏顺带刷新峰值 / 电量 / 输出使能。 */
async function pollOnce(iv){
  applyLive(await request(CMD.OUTPUT_DATA, [], Math.max(120, iv)));
  tickCount++;
  const perSec = Math.max(1, Math.round(1000 / iv));
  if(tickCount % perSec === 0){
    applyMax(await request(CMD.OUTPUT_DATA_MAX, [], 400));
    applyMah(await request(CMD.MAH_MWH, [], 400));
    if(S.outEnable === null || tickCount % (perSec * 5) === 0){
      applyOutEnable(await request(CMD.OUTPUT_ENABLE, [], 400));
    }
  }
}

/* 一拍只跑一轮；上一轮还没结束就跳过这一拍 ——
   设备偶发慢响应时不会把命令堆起来（原实现靠"睡够剩余间隔"隐式做到这点）。 */
function startPolling(g){
  let busy = false;
  ticker.start(pollIv(), async () => {
    if(busy || !connected || g !== gen) return;
    busy = true;
    try{ await pollOnce(pollIv()); }
    catch(e){ if(g === gen) logLine('er', 'POLL ERR ' + e); }
    finally{ busy = false; }
  });
}

/* 页面重新可见时补一拍：最小化期间节拍照常（Worker 不受节流），
   但切回来的瞬间若正好落在两拍之间，会先看到一帧旧值再跳变。 */
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible' && connected) ticker.kick();
});

async function startInfoLoop(g){
  while(connected && g === gen){
    const iv = parseInt($('infoSel').value, 10);
    if(!iv){ await delay(500); continue; }
    await delay(iv);
    if(!(connected && g === gen)) break;
    applyUptime(await request(CMD.UPTIME, [], 500));
    applyRshunt(await request(CMD.SYSTEM_CURRENT_RSHUNT, [], 500));
    applyInaCfg(await request(CMD.SYSTEM_INA226_CONFIG, [], 500));
    applyLcd(await request(CMD.SYSTEM_LCD_PANEL_TYPE, [], 500));
    applyOffset(await request(CMD.SYSTEM_CURRENT_OFFSET, [], 500));
    applyInType(await request(CMD.INPUT_TYPE, [], 500));
    if(S.outType === 1) await readPdo();
  }
}

/* ---- 一次性读取全部信息 ---- */
async function readAllInfo(){
  const w = await request(CMD.WHO_AM_I, [], 600);
  if(w) applyText(w, s => { S.who = s; $('dvWho').textContent = s; updateConnTip(); });
  const v = await request(CMD.SYSTEM_VERSION, [], 600);
  if(v) applyText(v, s => { S.version = s; $('dvVer').textContent = s; updateConnTip(); });
  const sn = await request(CMD.SYSTEM_SERIAL_NUM, [], 600);
  if(sn) applyText(sn, s => { S.serial = s; $('dvSn').textContent = s; updateConnTip(); });
  applyInType(await request(CMD.INPUT_TYPE, [], 600));
  applyRshunt(await request(CMD.SYSTEM_CURRENT_RSHUNT, [], 600));
  applyInaCfg(await request(CMD.SYSTEM_INA226_CONFIG, [], 600));
  applyLcd(await request(CMD.SYSTEM_LCD_PANEL_TYPE, [], 600));
  applyOffset(await request(CMD.SYSTEM_CURRENT_OFFSET, [], 600));
  applyOutEnable(await request(CMD.OUTPUT_ENABLE, [], 600));
  applyUptime(await request(CMD.UPTIME, [], 600));
  applyMax(await request(CMD.OUTPUT_DATA_MAX, [], 600));
  applyMah(await request(CMD.MAH_MWH, [], 600));
  await readPdo();
}

async function readPdo(){
  if(S.outType === 0) applyInType(await request(CMD.INPUT_TYPE, [], 500));
  if(S.outType !== 1){
    S.fixed = []; S.pps = []; S.avs = []; S.curId = 0;
    renderPdo(); renderCurPdo();
    $('pdoTag').textContent = t('pdoTagNonPd');
    return;
  }
  applyPdoNum(await request(CMD.PD_PDO_NUM, [], 600));
  applyPdoFix(await request(CMD.PD_PDO_FIX, [], 700));
  applyPdoPps(await request(CMD.PD_PDO_PPS, [], 700));
  applyPdoAvs(await request(CMD.PD_PDO_AVS, [], 700));
  applyCurPdo2(await request(CMD.PD_PDO2, [], 700));
}

"use strict";
/* ---- 操作 ---- */
async function setFixed(id, v){
  await new Promise(res => {
    chainWrite(async () => {
      if(!connected) return;
      const out = [CMD.PD_PDO].concat([id & 0xff, v & 0xff, (v>>8) & 0xff], [FRAME_END]);
      logLine('tx', 'TX ' + hex(out));
      await writeBytes(out);
    }).then(() => res(), e => { logLine('er', 'WRITE ERR ' + e); res(); });
  });
  if(!connected) return;
  await delay(500);
  /* 链路中途掉了就安静收工：这是"设备没了"，不是"档位没切成功"，
     报一个失败提示反而误导；更不能让异常冒到按钮回调变成未处理拒绝。 */
  let f = null;
  try{ f = await request(CMD.PD_PDO, [], 900); }catch(e){ return; }
  if(f && f[1] === id){ applyCurPdo(f); toast(t('tPdoSet', { id:id, v:(v/1000).toFixed(2) }), 'ok'); }
  else toast(t('tPdoSetFail'), 'bad');
}

/* 动态档（PPS / AVS）写入。auto=true 表示由「动态调压」自动触发。
   成功后「当前档位」由设备回读更新 —— 界面不自己乐观改值。 */
async function setDyn(id, v, i, auto){
  await new Promise(res => {
    chainWrite(async () => {
      if(!connected) return;
      const out = [CMD.PD_PDO2].concat([id & 0xff, v & 0xff, (v>>8)&0xff, i & 0xff, (i>>8)&0xff], [FRAME_END]);
      logLine('tx', 'TX ' + hex(out));
      await writeBytes(out);
    }).then(() => res(), e => { logLine('er', 'WRITE ERR ' + e); res(); });
  });
  if(!connected) return;
  await delay(500);
  let f = null;
  try{ f = await request(CMD.PD_PDO2, [], 900); }catch(e){ return; }
  const vs = (v/1000).toFixed(2), is = (i/1000).toFixed(3);
  /* 无论成败都让滑块重新跟随设备真值，避免界面停在"假成功"上 */
  S.dynDirty = false;
  if(f && f[1] === id){
    applyCurPdo2(f);
    renderPdo();
    toast(t(auto ? 'tDynAuto' : 'tDynSet', { id:id, v:vs, i:is }), 'ok');
  }else{
    renderPdo();
    toast(t('tDynSetFail'), 'bad');
  }
}

/* 从界面读当前滑块值并下发（手动点「应用设定」与自动下发共用） */
async function applyDyn(auto){
  const id = dynTargetId();
  const r = id ? dynRangeOf(id) : null;
  if(!id || !r){ toast(t('tNeedPickDyn'), 'bad'); return; }
  if(!connected){ toast(t('notConnected'), 'bad'); return; }
  const v = clamp(+$('dynV').value, r.min, Math.max(r.min, r.max));
  const i = clamp(+$('dynI').value, 0, Math.max(1, r.imax));
  await setDyn(id, v, i, auto);
}

async function setOutput(on){
  await writeOnly(CMD.OUTPUT_ENABLE, [on ? 1 : 0]);
  await delay(350);
  applyOutEnable(await request(CMD.OUTPUT_ENABLE, [], 600));
  toast(on ? t('tOutOn') : t('tOutOff'), 'ok');
}

"use strict";
/* ================================================================== *
 *  趋势图：3 条独立量程泳道 + 缩放/平移
 * ================================================================== */
const lanes = [
  { key:'v', label:'V' },
  { key:'i', label:'A' },
  { key:'p', label:'W' }
];
let zoom = 1;        /* 1 = 全览。跟随模式下只由它决定窗口宽度 */
let hoverIdx = -1;   /* 鼠标处最近的样本绝对下标；-1 = 不画数据光标 */
let hoverPx = -1;    /* 鼠标在画布内的连续 x；光标的竖线画在这里（不再吸附到样本） */
let chartDrag = null;/* 拖拽平移状态；非空时不画数据光标（避免与拖动打架） */
let geo = { i0:0, i1:0, n:0, padL:8, padR:62, padT:10, padB:18, w:0, h:0 };

/* ---- 趋势"滚动刷新"开关 ----
   follow = true  ：窗口右端恒等于最新样本，新数据进来就往前推（默认）。
                    窗口宽度只由 zoom 决定 —— 跟随模式下没有"平移"这个自由度，
                    所以不存在"勾了滚动却停在中间"的中间态。
   frozen != null ：窗口定格（取消勾选，或用户主动拖动滚动条 / 画布）。
                    为了在环形裁剪（samples.shift）后窗口内容不被带偏，
                    这里记的是"逻辑下标"——逻辑下标 = 数组下标 + dropped。
                    span = 当前窗口宽度（缩放改它，范围 2..全部缓存）
                    end  = 窗口右端的逻辑下标（拖动 / 滚动条改它）
   两者互斥：follow 为真时 frozen 必为 null，反之亦然。
   窗口能不能操作只取决于"有没有数据"，与串口连接状态无关 —— 断开后照样能翻看。 */
let dropped = 0;
let follow = true;
let frozen = null;
/* 定格窗口里的数据被环形裁剪吃掉了一部分（窗口"残缺"）→ 供 zoomInfo 提示用 */
let winStale = false;

function visRange(){
  const nArr = samples.length;
  winStale = false;
  if(nArr < 2) return { i0:0, i1:Math.max(0, nArr-1) };
  const total = dropped + nArr;               /* 逻辑样本总数 */

  /* 启动时就从存档里读到"不跟随"，或刚取消勾选时还没有数据：
     等真有数据的第一帧再把窗口钉住，免得把空窗口定死。 */
  if(!follow && !frozen){
    frozen = { span: nArr, end: dropped + nArr - 1 };
  }

  if(frozen){                                 /* 定格：右端钉死，新样本不进视图 */
    const span = clamp(frozen.span, 2, total);
    /* 右端下限必须是 dropped（而不是 0）：环形裁剪会把老样本一路挤出去，
       等 dropped 超过 frozen.end 时，i1 = frozen.end - dropped 就成了负数，
       绘制循环一次都不执行 —— 趋势整片空白，而且 frozen.end 会被写回，
       不手动动一下就一直白着。夹进"还有数据"的区间即可彻底杜绝。 */
    let L1 = clamp(frozen.end, dropped, total - 1);
    let L0 = L1 - span + 1;
    if(L0 < dropped){                         /* 左端的数据已被裁掉：只损失左边，右端不动 */
      L0 = dropped;
      /* 只有"窗口被裁得比设定宽度还窄"才算数据在流失。
         「全览」会把 span 设成实际可用宽度，到这里不该被误报成流失。 */
      winStale = (span > L1 - L0 + 1);
    }
    frozen.span = span; frozen.end = L1;
    return { i0: L0 - dropped, i1: L1 - dropped };
  }

  /* 跟随：右端恒为最新样本，窗口宽度只由 zoom 定。
     以前这里还有一个"距最新样本的偏移量"（带偏移的跟随），它跟"滚动条滑块恒在右端"
     是互相矛盾的 —— 缩放不是整数倍、窗口宽度还要取整，放大一次偏移就非 0，
     右端从最新样本滑开、滑块跟着偏左，看着就是"勾了滚动却没跟在最新数据上"。
     偏移这个自由度整个去掉了：想往回看就取消勾选（定格），而不是"跟着但偏一点"。 */
  if(zoom <= 1.0001) return { i0:0, i1:nArr-1 };
  const span = Math.min(nArr, Math.max(2, Math.round(nArr / zoom)));
  return { i0: nArr - span, i1: nArr - 1 };
}

/* 定格 / 恢复跟随。定格时把"此刻看到的窗口"整体锁下来
   （包括用户当前的缩放与平移位置，而不是简单地退回全览）。 */
function setFollow(on){
  if(on === follow) return;
  if(on){
    /* 重新跟随：清掉定格，视口直接对回最新数据（跟随窗口只由 zoom 描述） */
    follow = true; frozen = null;
  }
  else if(samples.length >= 2){
    const cur = visRange();                   /* 此刻 follow 仍为 true，取到的是实时窗口 */
    follow = false;
    frozen = { span: Math.max(2, cur.i1 - cur.i0 + 1), end: cur.i1 + dropped };
  }else{
    follow = false; frozen = null;            /* 还没数据：等第一帧绘制时再钉 */
  }
  drawChart();
}

/* 定格窗口已"失效"（窗里的样本全被新数据挤出缓冲区）时回到滚动刷新。
   只改视图状态：不动采样、不发命令。顺手把复选框与存档同步好，
   免得刷新页面又回到一个没有内容的定格。 */
function resumeFollow(msg){
  frozen = null; follow = true;
  const cb = $('chkFollow');
  if(cb && !cb.checked) cb.checked = true;
  LS.set('follow', '1');
  if(msg) toast(msg, 'ok');
}

/* 用户在"跟随"状态下主动平移视图（拖滚动条 / 拖画布）= 想往回看，
   自动切到定格，否则窗口会被"跟随最新数据"一直拽回右端，拖了等于白拖。
   复选框与存档一起同步好，免得刷新页面又回到跟随。 */
function unfollowByUser(){
  if(!follow) return;
  const cb = $('chkFollow');
  if(cb && cb.checked) cb.checked = false;
  LS.set('follow', '0');
  setFollow(false);
  toast(t('tFollowOff'), 'ok');
}

function cssVar(name){ return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

/* 画布内 x -> 连续的样本序号（0..cnt-1，可带小数）。纯函数。
   光标位置用这个连续值，读数才不会再"一格一格跳"。 */
function hoverFracAt(px, g){
  g = g || geo;
  const cnt = g.i1 - g.i0 + 1;
  if(samples.length < 2 || cnt < 2 || g.w <= 0) return -1;
  return clamp(((px - g.padL) / g.w) * (cnt - 1), 0, cnt - 1);
}

/* 画布内 x -> 最近的样本绝对下标。数据不足返回 -1。 */
function hoverIndexAt(px, g){
  g = g || geo;
  const cnt = g.i1 - g.i0 + 1;
  const f = hoverFracAt(px, g);
  if(f < 0) return -1;
  return g.i0 + clamp(Math.round(f), 0, cnt - 1);
}

/* 趋势视图控件（缩放按钮 / 横向滚动条）的可用性只看"有没有数据"，
   与串口连接状态无关 —— 断开之后照样能翻看、缩放已采集的波形。
   （以前这几个按钮挂在 setEnabled 里，一断开就变灰，等于把已抓到的数据锁住了。） */
let chartCtlState = '';

/* 右侧刻度的三条读数（纯函数，便于单测）：
     上 = 窗口最大值、下 = 窗口最小值、跟着右端圆点 = 最新点值。
   上/下钉在车道两端不动；最新点值要贴在圆点的 y 上，位置随数据浮动，会和它们
   打架 —— 先把它挪开一小段（14px，看去还贴着圆点），车道太矮实在挪不开，才轮到
   极值读数让位。三条读数都尽量留着：让位是最后手段，不是默认行为。
   lastY 是圆点的 y；返回的 y 已夹进车道内（上下各留出半个字号）。 */
function rightScale(lastY, y0, laneH, gap){
  gap = gap || 14;
  const topY = y0 + 7, botY = y0 + laneH - 6;
  const lo = y0 + 8, hi = y0 + laneH - 6;
  const raw = clamp(lastY, lo, hi);
  let y = raw;
  if(Math.abs(y - topY) <= gap) y = Math.min(hi, topY + gap);
  if(Math.abs(y - botY) <= gap) y = Math.max(lo, botY - gap);
  y = clamp(y, lo, hi);
  /* 挪开之后只要不粘在一起就算过关（判定阈值比挪动距离小 3px） */
  const clear = gap - 3;
  return { y:y, raw:raw, shifted:(y !== raw),
           showMax: Math.abs(y - topY) > clear,
           showMin: Math.abs(y - botY) > clear };
}

/* 滑块头（thumb）宽度 = "当前窗口 / 当前点数" × 轨道宽，两头只夹上下限。
   这条轨道本身就是按 canvas 绘图区对齐的（左右各留 padL/padR），所以比例 1 时
   滑块正好和波形窗口一样长 —— 全览就该是这样：滑块占满整条，一眼看出"全在屏上"。
   两点注意：
   ① 不能按"有没有行程"另开分支。曾经写成"窗口=全部点数时返回最小宽度（免得摊满
      整条像进度条）"，结果缩到全览那一步会从最长猛地缩成最小 —— 就是用户实测报的
      "滑块越拉越长，最后突然变成最小"的跳变。比例式天然连续，不会跳。
   ② 上限就是轨道宽（不再留 92% 余量）：全览时行程本来就是 0（没得滚），滑块铺满
      不会丢功能；而 ratio<1 时 width<轨道宽，拖拽行程自然存在。 */
function thumbPx(span, nArr, trackW){
  const MIN = 26;
  const W = trackW || 600;
  if(nArr < 2) return MIN + 'px';
  return Math.min(W, Math.max(MIN, Math.round(W * (span / nArr)))) + 'px';
}

function syncChartControls(){
  const nArr = samples.length;
  const zoomOk = nArr >= 8;                    /* 与 zoomAt 的门槛保持一致 */
  const dataOk = nArr > 0;                     /* 有采样就能导出 / 清空，与连接状态无关 */
  const r = (nArr >= 2) ? visRange() : { i0:0, i1:0 };
  const span = nArr >= 2 ? Math.max(1, r.i1 - r.i0 + 1) : 0;
  /* 滚动条只覆盖"当前还在缓冲里的点数"：max = 当前点数 − 窗口宽度。
     以前拿 dropped + nArr 当总长，环形裁剪一旦开始溢出，左边一大段早已被丢掉的
     历史也照样占着行程 —— 拖到最左是死的，点数越多越不跟手。改成跟点数走之后，
     行程全部有效，而且点数一多行程自然变长（就是"随点数自适应"）。
     滑块位置＝窗口左端在数组里的下标（visRange 返回的 i0），不再掺 dropped。 */
  /* nArr < 2 时没有可平移的余地，maxV 必须是 0：否则会走 maxV>0 那条分支拿到
     max=1/value=0，滑块被画在最左端 —— 只有 1 个点时看着像"卡在起点"。 */
  const maxV = (nArr >= 2) ? Math.max(0, nArr - span) : 0;
  const val = (nArr >= 2) ? clamp(r.i0, 0, maxV) : 0;
  const el = $('chartScroll');
  const tw = thumbPx(span, nArr, el ? el.clientWidth : 0);
  const st = zoomOk + ',' + dataOk + ',' + (nArr >= 2) + ',' + maxV + ',' + val + ',' + tw;
  if(st === chartCtlState) return;             /* 每帧写 DOM 没必要，状态没变就跳过 */
  chartCtlState = st;

  $('btnZoomIn').disabled = !zoomOk;
  $('btnZoomOut').disabled = !zoomOk;
  $('btnZoomReset').disabled = !zoomOk;
  $('btnExport').disabled = !dataOk;
  $('btnClearChart').disabled = !dataOk;
  if(el){
    el.disabled = (nArr < 2);
    /* 注意：max=0 时原生 range 会把滑块画在最左端，看着像"停在起点"，
       实际是"没有可滚动的范围"。这里退化成 max=1/value=1，
       让滑块停在最右端 —— 与"窗口已在最新数据/已装下全部"的语义一致。 */
    if(maxV > 0){
      el.max = String(maxV);
      if(Number(el.value) !== val) el.value = String(val);
    }else{
      el.max = '1';
      if(Number(el.value) !== 1) el.value = '1';
    }
    if(el.style && el.style.setProperty) el.style.setProperty('--thumbW', tw);
  }
}

"use strict";
function drawChart(){
  const cv = $('cv');
  if(!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth || 600, cssH = cv.clientHeight || 250;
  if(cv.width !== Math.round(cssW*dpr) || cv.height !== Math.round(cssH*dpr)){
    cv.width = Math.round(cssW*dpr); cv.height = Math.round(cssH*dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,cssW,cssH);

  const padL = 8, padR = 62, padT = 10, padB = 18;
  const w = cssW - padL - padR, h = cssH - padT - padB;
  const laneH = h / lanes.length;
  const cbg = cssVar('--chartbg'), cgrid = cssVar('--grid'), cgrid2 = cssVar('--grid2');
  const cV = cssVar('--cy'), cI = cssVar('--am'), cP = cssVar('--gr');
  const colors = [cV, cI, cP], cFg3 = cssVar('--fg3');
  geo = { i0:0, i1:0, n:samples.length, padL:padL, padR:padR, padT:padT, padB:padB, w:w, h:h };

  ctx.fillStyle = cbg;
  ctx.fillRect(padL, padT, w, h);

  const { i0, i1 } = visRange();
  geo.i0 = i0; geo.i1 = i1;
  const n = i1 - i0 + 1;
  const win = (n >= 2) ? samples.slice(i0, i1 + 1) : samples.slice(i0, i1 + 1);

  lanes.forEach((ln, li) => {
    const y0 = padT + li*laneH;
    const col = colors[li];
    ln.y0 = y0; ln.mn = undefined; ln.mx = undefined;   /* 供数据光标复用 */
    if(li){ ctx.beginPath(); ctx.moveTo(padL, y0); ctx.lineTo(padL+w, y0); ctx.strokeStyle = cgrid; ctx.lineWidth = 1; ctx.stroke(); }
    ctx.strokeStyle = cgrid2;
    ctx.beginPath(); ctx.moveTo(padL, y0 + laneH/2); ctx.lineTo(padL+w, y0 + laneH/2); ctx.stroke();
    ctx.strokeStyle = cgrid;

    if(n < 2) return;
    let mn = Infinity, mx = -Infinity, last = 0;
    for(const s of win){ const v = s[ln.key]; if(v<mn) mn=v; if(v>mx) mx=v; last = v; }
    if(mx - mn < 1e-9){ mx = mn + Math.max(1e-6, Math.abs(mn)*0.02 + 1e-6); }
    const pad = (mx-mn)*0.12;
    ln.mn = mn; ln.mx = mx;

    const xOf = k => padL + (n===1 ? 0 : (k/(n-1))*w);
    const yOf = v => y0 + laneH - ((v - mn + pad) / (mx - mn + pad*2)) * laneH;

    ctx.beginPath();
    ctx.moveTo(xOf(0), y0 + laneH);
    for(let k=0;k<n;k++) ctx.lineTo(xOf(k), yOf(win[k][ln.key]));
    ctx.lineTo(xOf(n-1), y0 + laneH);
    ctx.closePath();
    ctx.globalAlpha = 0.14; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;

    ctx.beginPath();
    for(let k=0;k<n;k++){
      const x = xOf(k), y = yOf(win[k][ln.key]);
      if(k===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.stroke();

    ctx.beginPath();
    ctx.arc(xOf(n-1), yOf(last), 2.6, 0, Math.PI*2);
    ctx.fillStyle = col; ctx.fill();

    /* 右侧刻度三条读数：上 = 窗口最大值、下 = 窗口最小值、跟着右端圆点的 = 最新点值。
       最新点值的位置随数据浮动，会和上/下打架 —— 先把它挪开 14px，实在挪不开才轮到
       极值读数让位（见 rightScale）。 */
    const rs = rightScale(yOf(last), y0, laneH);
    ctx.font = '600 11px ui-monospace,Menlo,Consolas,monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    if(rs.showMax){
      ctx.fillStyle = col;
      ctx.fillText(fmtVal(ln.key, mx), padL+w+6, y0+11);
    }
    if(rs.showMin){
      ctx.fillStyle = cFg3;
      ctx.textBaseline = 'bottom';
      ctx.fillText(fmtVal(ln.key, mn), padL+w+6, y0+laneH-2);
    }
    /* 最新点值：底衬 + 前置色条，压在曲线/圆点上也能一眼读出来 */
    const ltxt = fmtVal(ln.key, last);
    const ltw = ctx.measureText(ltxt).width;
    const cw = ltw + 9;
    const cx = Math.min(padL + w + 3, Math.max(padL + 3, cssW - cw - 2));
    ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = .95; ctx.fillStyle = cbg;
    ctx.fillRect(cx, rs.y - 8, cw, 13);
    ctx.globalAlpha = 1;
    ctx.fillStyle = col;
    ctx.fillRect(cx, rs.y - 8, 2, 13);
    ctx.fillText(ltxt, cx + 5, rs.y + 2);
    ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = col;
    ctx.fillText(ln.label, padL+w-4, y0+12);
  });

  /* ---- 数据光标：跟随鼠标的连续像素位置，读数按相邻样本线性插值 ----
     早期实现把光标画在"取整后的样本 x"上，采样点稀疏时会一格一格跳；
     现在竖线跟着鼠标走，点/读数取相邻两点插值，与画出来的折线严格吻合。 */
  const hf = (chartDrag || hoverPx < 0) ? -1 : hoverFracAt(hoverPx, geo);
  const hx = (hf >= 0 && n >= 2) ? (padL + (hf / (n - 1)) * w) : 0;
  let k0 = 0, k1 = 0, fr = 0;
  if(hf >= 0 && n >= 2){
    k0 = Math.floor(hf); k1 = Math.min(n - 1, k0 + 1); fr = hf - k0;
    if(win[k0]){
      const dot = (ln, li, val) => {
        const lp = (ln.mx - ln.mn) * 0.12;
        const y = ln.y0 + laneH - ((val - ln.mn + lp) / (ln.mx - ln.mn + lp*2)) * laneH;
        ctx.beginPath(); ctx.arc(hx, y, 3.4, 0, Math.PI*2);
        ctx.fillStyle = colors[li]; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = cbg; ctx.stroke();

        const txt = fmtVal(ln.key, val);
        ctx.font = '600 11px ui-monospace,Menlo,Consolas,monospace';
        const tw = ctx.measureText(txt).width;
        const flip = (hx + 9 + tw + 4 > padL + w);        /* 贴近右边界时翻到左侧 */
        const tx = flip ? (hx - 9 - tw) : (hx + 9);
        const ty = clamp(y - 7, ln.y0 + 11, ln.y0 + laneH - 3);
        ctx.globalAlpha = .9; ctx.fillStyle = cbg;        /* 底衬，免得压在曲线上看不清 */
        ctx.fillRect(tx - 4, ty - 10, tw + 8, 13);
        ctx.globalAlpha = 1;
        ctx.fillStyle = colors[li];
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(txt, tx, ty);
      };

      ctx.save();
      ctx.setLineDash([3,3]); ctx.lineWidth = 1;
      ctx.strokeStyle = cFg3; ctx.globalAlpha = .75;
      ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, padT + h); ctx.stroke();
      ctx.restore();

      lanes.forEach((ln, li) => {
        if(ln.mn === undefined) return;
        const a = win[k0][ln.key], b = win[k1][ln.key];
        dot(ln, li, a + (b - a) * fr);
      });
    }
  }

  ctx.fillStyle = cFg3;
  ctx.font = '10px ui-monospace,Menlo,Consolas,monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  /* 横轴一律用"距最新样本多久"来表达（"45.6 s 前"），不用裸负号：
     负号很容易被当成"时间是负的"，定格之后尤其明显 —— 右端会从「现在」
     突然变成 -45.6 s。另外这里统一走 Math.max(0, ...) 夹一下，
     万一时间戳乱序（系统对时回拨等）也只会显示 0，不会冒出个天文数字的负数。
     注意 samples 可能为空（初始化、清空曲线的重绘都会走到这里），要防一手。 */
  const latestT = samples.length ? samples[samples.length-1].t : 0;
  const agoOf = ms => (ms < 50) ? t('nowLabel')
                                : t('agoLabel', { v: (Math.max(0, ms)/1000).toFixed(1) });
  if(n >= 2 && hf >= 0 && win[k0] && win[k1]){
    /* 有光标时横轴只显示光标处的相对时刻（同样插值），避免与两端标签重叠 */
    const ta = win[k0].t, tb = win[k1].t;
    ctx.textAlign = 'center';
    ctx.fillText(agoOf(latestT - (ta + (tb - ta) * fr)),
                 clamp(hx, padL + 24, padL + w - 24), padT + h + 4);
  }else if(n >= 2){
    /* 两端都按"距最新多久"算：定格时右端不再是最新，左端也就不再等于窗口宽度，
       直接用各自的样本时间戳，两端才是同一把尺子。 */
    ctx.fillText(agoOf(latestT - win[0].t), padL, padT+h+4);
    ctx.textAlign = 'right';
    ctx.fillText(agoOf(latestT - win[n-1].t), padL+w, padT+h+4);
  }

  const zi = $('zoomInfo');
  if(zi){
    if(frozen) zi.textContent = t('zoomInfoFrozen', { n:n, c:samples.length }) + (winStale ? t('frozenStale') : '');
    else if(zoom <= 1.0001) zi.textContent = t('zoomInfoAll', { n:samples.length });
    else zi.textContent = (n + ' / ' + samples.length + '  ×' + zoom.toFixed(1));
  }
  syncChartControls();
}

/* 趋势里的读数格式：与主界面读数（mV / mI / mP）统一精度 ——
   电压 3 位、电流 4 位、功率 3 位。位数少了，相邻采样点会被抹成同一个数，
   细微变化在数据光标和刻度上就看不出来了。 */
function fmtVal(k, v){
  if(k === 'v') return v.toFixed(3) + 'V';
  if(k === 'i') return v.toFixed(4) + 'A';
  return v.toFixed(3) + 'W';
}

/* 「全览」和画布双击共用：把视图恢复到"能看多少看多少"。
   定格时 = 窗口扩到盖住整段缓存（左端到最早还留着的样本、右端一直到最新）。
   早先的写法是"只把左端扩到最早、右端不动"，可窗口本来就贴着最老数据时
   （滚动条滑到最左、或刚被裁剪夹回来）左端已经无处可扩，按下去毫无变化 ——
   看起来就是「全览」失灵。非定格时 = zoom 归 1、窗口贴右端。 */
function resetView(){
  if(frozen){
    const total = dropped + samples.length;
    frozen.span = Math.max(2, total);
    frozen.end = total - 1;
  }
  else zoom = 1;
  drawChart();
}

/* 缩放。两种模式都以右端为锚（定格锚 frozen.end，跟随锚最新样本）——
   曾经跟随模式是"按光标位置定锚点"，结果放大一次窗口右端就离开最新数据、
   滚动条滑块跟着偏左，与「滚动」这个开关的语义相悖。现在没有第二种锚法了。 */
function zoomAt(factor){
  const n = samples.length;
  if(n < 8) return;

  /* 定格状态下缩放：右端（frozen.end）不许动，只把窗口左边收放。
     否则一缩放窗口就"漂"到别处，定格就失去意义了。
     宽度上限是"全部缓存"，所以想往回看更早的数据随时可以放大窗口。 */
  if(frozen){
    const total = dropped + n;
    frozen.span = clamp(Math.round(frozen.span / factor), 2, total);
    /* 把定格窗口的宽度折算成"跟随模式下的缩放倍数"，取消定格时才会回到同一视距。
       必须夹到 >=1：否则会留下 zoom<1 这种非法状态，
       下一次点「+」只到 1.0 就被当成"全览"直接跳回，等于按了没反应。 */
    zoom = clamp(n / Math.max(1, frozen.span), 1, 60);
    drawChart();
    return;
  }

  /* 跟随：只改窗口宽度，右端永远是最新样本（visRange 按 zoom 反算窗口） */
  const nz = clamp(zoom * factor, 1, 60);
  zoom = (nz <= 1.02) ? 1 : nz;
  drawChart();
}

"use strict";
let rafPending = false;
const origDraw = drawChart;
drawChart = function(){
  if(rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; origDraw(); });
};

(function bindChartInteraction(){
  const cv = $('cv');
  cv.addEventListener('wheel', ev => {
    if(!samples.length) return;
    ev.preventDefault();
    /* 两种模式下缩放都以右端为锚，与光标在画布上的位置无关 */
    zoomAt(ev.deltaY < 0 ? 1.25 : 1/1.25);
  }, { passive:false });

  cv.addEventListener('pointerdown', ev => {
    if(zoom <= 1.0001 && !frozen) return;        /* 定格下即使没放大也允许拖动查看 */
    chartDrag = { x:ev.clientX, w:Math.max(1, geo.w),
                  span: Math.max(1, geo.i1 - geo.i0 + 1), n:samples.length,
                  end: frozen ? frozen.end : 0, moved:false };
    cv.style.cursor = 'grabbing';
    drawChart();                                   /* 拖动期间收起数据光标 */
    try{ cv.setPointerCapture(ev.pointerId); }catch(e){}
  });
  cv.addEventListener('pointermove', ev => {
    if(chartDrag){
      const dx = ev.clientX - chartDrag.x;
      /* 跟随状态下真的开始拖（超过 3px）= 想往回看：先转定格，再把拖动基准重取到
         此刻的视口。3px 阈值用来区分"拖动"和"只是点一下"—— 点一下不该关掉滚动。
         不转定格的话窗口右端会被"跟随最新"一直拽回去，拖了等于白拖
         （这和拖动滚动条会自动切定格是同一套规矩，见 unfollowByUser）。 */
      if(!chartDrag.moved && Math.abs(dx) >= 3){
        chartDrag.moved = true;
        /* 已经定格就没什么可转的，直接往下平移（这一步不消耗位移） */
        if(follow){
          unfollowByUser();
          chartDrag.x = ev.clientX;
          chartDrag.end = frozen ? frozen.end : 0;
          chartDrag.span = Math.max(1, geo.i1 - geo.i0 + 1);
          chartDrag.n = samples.length;
          drawChart();
          return;
        }
      }
      if(frozen){
        /* 拖动 = 沿逻辑下标平移窗口右端；向右拖看更早的数据。
           下限保证窗口宽度不被压扁，上限不越过最新样本。
           下限还贴着"最老样本"（dropped + span - 1）：再往左拖就是已被裁掉的空白区，
           拖过去只会得到一个空窗口。 */
        const dIdx = (dx / chartDrag.w) * chartDrag.span;
        const total = dropped + samples.length;
        frozen.end = clamp(Math.round(chartDrag.end - dIdx),
                           Math.min(dropped + frozen.span - 1, total - 1), total - 1);
        drawChart();
      }
      return;
    }
    const px = ev.clientX - cv.getBoundingClientRect().left;
    const idx = hoverIndexAt(px);
    if(idx !== hoverIdx || px !== hoverPx){ hoverIdx = idx; hoverPx = px; drawChart(); }
  });
  const endDrag = ev => {
    if(!chartDrag) return;
    chartDrag = null;
    cv.style.cursor = 'crosshair';
    if(ev && typeof ev.clientX === 'number'){
      hoverPx = ev.clientX - cv.getBoundingClientRect().left;
      hoverIdx = hoverIndexAt(hoverPx);
    }
    drawChart();
  };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);
  cv.addEventListener('pointerleave', () => {
    if(hoverIdx === -1 && hoverPx === -1) return;
    hoverIdx = -1; hoverPx = -1;
    drawChart();
  });
  cv.addEventListener('dblclick', resetView);

  $('btnZoomIn').addEventListener('click', () => zoomAt(1.6));
  $('btnZoomOut').addEventListener('click', () => zoomAt(1/1.6));
  $('btnZoomReset').addEventListener('click', resetView);
})();

window.addEventListener('resize', () => drawChart());

/* 卡片等高后 canvas 会被 flex 拉伸，而布局尺寸变化不会触发 window resize，
   这里用 ResizeObserver 补一次重绘。canvas 是 flex-basis 定高、位图尺寸不参与布局，
   所以不会形成"改高度→又触发观察"的反馈回路。 */
if(window.ResizeObserver){
  let lastW = 0, lastH = 0;
  new ResizeObserver(() => {
    const cv = $('cv');
    if(!cv) return;
    if(cv.clientWidth === lastW && cv.clientHeight === lastH) return;
    lastW = cv.clientWidth; lastH = cv.clientHeight;
    drawChart();
  }).observe($('cv'));
}

"use strict";
/* ------------------------------------------------------------------ *
 *  CSV 导出
 * ------------------------------------------------------------------ */
function exportCsv(){
  if(!samples.length){ toast(t('tExportEmpty'), 'bad'); return; }
  const t0 = samples[0].t;
  let csv = 'time_s,voltage_V,current_A,power_W\n';
  for(const s of samples){
    csv += ((s.t - t0)/1000).toFixed(3) + ',' + s.v.toFixed(3) + ',' + s.i.toFixed(4) + ',' + s.p.toFixed(3) + '\n';
  }
  const blob = new Blob(['\ufeff' + csv], { type:'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'pdtrigger_' + (S.serial || 'log') + '_' + new Date().toISOString().replace(/[:.]/g,'-').slice(0,19) + '.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast(t('tExported', { n:samples.length }), 'ok');
}

"use strict";
/* ------------------------------------------------------------------ *
 *  周期选择器
 * ------------------------------------------------------------------ */
function buildPollSelects(){
  const p = $('pollSel'), i = $('infoSel');
  const kp = p.value || LS.get('poll', '200');
  const ki = i.value || LS.get('info', '0');
  if(!p.options.length){
    [25,50,100,200,500,1000].forEach(v => p.add(new Option(t('opt' + v), v)));
    i.add(new Option(t('optOff'), 0));
    [1000,2000,5000,10000].forEach(v => i.add(new Option(t('opt' + (v/1000) + 's'), v)));
  }else{
    [25,50,100,200,500,1000].forEach((v,idx) => p.options[idx].text = t('opt' + v));
    i.options[0].text = t('optOff');
    [1000,2000,5000,10000].forEach((v,idx) => i.options[idx+1].text = t('opt' + (v/1000) + 's'));
  }
  p.value = kp; i.value = ki;
}

"use strict";
/* ------------------------------------------------------------------ *
 *  UI 事件
 * ------------------------------------------------------------------ */
/* 「安装到桌面」按钮的接线在 js/06-install.js 的 initInstall() 里 ——
   它要同时管 SW 注册、beforeinstallprompt 与 appinstalled，放在一处更清楚。 */
$('btnConn').addEventListener('click', connect);
$('logChk').addEventListener('change', () => { if(!$('logChk').checked) $('log').innerHTML = ''; });
$('btnClearLog').addEventListener('click', () => $('log').innerHTML = '');

$('btnOut').addEventListener('click', async () => {
  if(S.outEnable === null) return;
  await setOutput(S.outEnable ? 0 : 1);
});
$('btnOutRefresh').addEventListener('click', async () => {
  applyOutEnable(await request(CMD.OUTPUT_ENABLE, [], 600));
  toast(t('tOutRefresh'));
});

document.querySelectorAll('button[data-act]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const a = btn.dataset.act;
    try{
      if(a === 'reset-max'){
        await writeOnly(CMD.OUTPUT_DATA_MAX_RESET, []);
        await delay(300);
        applyMax(await request(CMD.OUTPUT_DATA_MAX, [], 600));
        applyMah(await request(CMD.MAH_MWH, [], 600));
        toast(t('tReset'), 'ok');
      }
      else if(a === 'readall'){ await readAllInfo(); toast(t('tReadAll'), 'ok'); }
      else if(a === 'output-on'){ await setOutput(1); }
      else if(a === 'output-off'){ await setOutput(0); }
    }catch(e){ toast(String(e), 'bad'); }
  });
});

/* ---- 趋势卡里的"导出 CSV / 清空曲线" ----
   这两颗按钮**故意不挂 data-act**：那一套按钮由 setEnabled() 按连接态统一开关，
   而导出 / 清空只跟"缓冲区里有没有采样"有关 —— 设备断开后曲线还在屏幕上，
   用户一样应该能把它导出来或清掉。所以禁用与否交给 syncChartControls()（看点数），
   这里只留各自的点击行为。 */
function clearChartData(){
  samples.length = 0; dropped = 0; frozen = null;   /* 数据清空 → 定格窗口已无意义 */
  zoom = 1; hoverIdx = -1; hoverPx = -1;
  drawChart();
}
$('btnExport').addEventListener('click', () => {
  /* 导出要碰 Blob / createObjectURL / a.click()，任何一个被浏览器策略挡下都不该裸抛 */
  try{ exportCsv(); }catch(e){ toast(String(e), 'bad'); }
});
$('btnClearChart').addEventListener('click', () => {
  if(!samples.length) return;                       /* 按钮本该是禁用的，这里再兜一层 */
  clearChartData();
  toast(t('tCleared'), 'ok');
});

$('pdoBody').addEventListener('click', async ev => {
  const tr = ev.target.closest('tr[data-id]');
  if(!tr) return;
  const id = parseInt(tr.dataset.id, 10);
  const kind = tr.dataset.kind;
  if(kind === 'fix'){
    if(id === S.curId){ toast(t('tFixAlready', { id:id })); return; }
    S.pendPdo = { kind:'fix', id:id, v:parseInt(tr.dataset.v, 10),
                  i:parseInt((tr.children[3] ? tr.children[3].textContent : '0'), 10) * 1000 || 0 };
    renderPdo();
    toast(t('tFixPicked', { id:id, v:(S.pendPdo.v/1000).toFixed(2) }));
    return;
  }
  /* PPS / AVS：和 Fixed 一样必须先过二次确认。点行只是「申请」，
     进待确认态（行标 .pend、下方弹出同一条确认条），**绝不碰设备、也绝不先把调节区打开** ——
     调节区只在设备真的停在该动态档时才出现。
     申请用的值 = dynInitVals：上一次的设定值在这档范围内就沿用，越界才回电压最小 / 电流最大。 */
  const r = dynRangeOf(id);
  if(!r) return;
  if(id === S.curId){ toast(t('tDynPick', { id:id, k:kind.toUpperCase() })); return; }
  const iv = dynInitVals(id);
  S.pendPdo = { kind:kind, id:id, v:iv.v, i:iv.i };
  renderPdo();
  toast(t('tDynEnter', { id:id, k:kind.toUpperCase() }));
});

$('btnFixApply').addEventListener('click', async () => {
  if(!S.pendPdo) return;
  const p = S.pendPdo;
  S.pendPdo = null;
  renderPdo();
  if(p.kind === 'fix'){ await setFixed(p.id, p.v); return; }
  /* 动态档：带着申请时那组值进入。只有设备回读确认它真的切到了这一档
     （S.curId 只由回读更新，这里不乐观改值），调节区才会随之出现。
     lastDynV/I 记成这次实际申请的值 —— 否则调节区一显示就会按「换组」跳回上一次记住的
     旧值（现在两者规则相同，仍显式记一遍，免得将来改规则时悄悄分叉）。
     dynTgt 归零强制按「换组」重算一次。 */
  cancelDynAuto();
  S.lastDynV = p.v; S.lastDynI = p.i; S.dynTgt = 0;
  await setDyn(p.id, p.v, p.i, false);
  if(S.curId === p.id){ S.selId = p.id; renderPdo(); }
});
$('btnFixCancel').addEventListener('click', () => {
  S.pendPdo = null;
  renderPdo();
  toast(t('tFixCancel'));
});

"use strict";
/* 滑块：一旦用户动过就置 dynDirty，信息周期的自动刷新便不再覆盖它 */
$('dynV').addEventListener('input', () => { S.dynDirty = true; syncDynLabels(); armDynAuto(); });
$('dynI').addEventListener('input', () => { S.dynDirty = true; syncDynLabels(); armDynAuto(); });

/* 精确输入框：键入时只同步滑块、不做任何下发 —— 输入过程中的 "9." / "1" 都是半成品，
   等定稿后才归一化并按需下发。
   回车 = 立即下发这一笔值（与「应用设定」同一条路）。以前只有勾了「动态调压」才会在
   0.5 s 后自动发，于是提示写着"回车生效"、实际按回车什么也不发生。
   点到别处（blur）仍然只做数值对齐、不下发：那是误触，不该顺手改电压。 */
let dynEnterSent = false;                 /* 回车已下发过 → 抑制紧随其后的 change 再排一次自动下发 */
[['v','dynVNum'], ['i','dynINum']].forEach(pair => {
  const k = pair[0], el = $(pair[1]);
  el.addEventListener('input', () => {
    S.dynDirty = true;
    dynEnterSent = false;     /* 又动键了，上一笔回车的"已下发"标记作废 */
    cancelDynAuto();          /* 打字期间撤掉上一笔待发的自动下发 */
    pushNumToSlider(k);
  });
  el.addEventListener('keydown', ev => {
    if(ev.key !== 'Enter') return;
    ev.preventDefault();
    commitNum(k);             /* 先归一化，再按归一化后的值下发 */
    dynEnterSent = true;
    applyDyn(false);
  });
  el.addEventListener('change', () => {
    commitNum(k);
    if(dynEnterSent){ dynEnterSent = false; return; }   /* 回车那一下已经发过了，别重复 */
    armDynAuto();
  });
  el.addEventListener('blur',   () => { commitNum(k); });   /* 值没变时 change 不触发，兜一手 */
});

$('btnDynApply').addEventListener('click', () => applyDyn(false));

/* 「动态调压」使能：开 → 免二次确认，滑块停手 0.1 s 自动下发；关 → 撤掉待发的自动下发。
   注意：开关本身不下发任何写命令（只在用户动滑块后才计时），避免"一勾选就把电压改了"。 */
$('chkDyn').addEventListener('change', () => {
  LS.set('dyn', dynEnabled() ? '1' : '0');
  cancelDynAuto();
  renderPdo();
});

/* 「滚动」开关：勾选=窗口跟随最新数据；取消=窗口定格，方便对着波形读数、分析。
   只改视图，不动采样，也不发任何命令。 */
$('chkFollow').addEventListener('change', () => {
  const on = $('chkFollow').checked;
  LS.set('follow', on ? '1' : '0');
  setFollow(on);
  toast(t(on ? 'tFollowOn' : 'tFollowOff'), 'ok');
});

/* 拖动趋势下方的横向滚动条 = 在整段缓冲里平移窗口。
   如果此刻还在"滚动跟随"，先切到定格 —— 否则新数据一来窗口又被拽回右端，拖了等于白拖。 */
$('chartScroll').addEventListener('input', () => {
  const el = $('chartScroll');
  const cur = visRange();
  const span = Math.max(2, cur.i1 - cur.i0 + 1);
  const nArr = samples.length;
  /* 窗口已经装下全部点数 → 没有可平移的余地。
     这一步是必须的：max=0 时会退化成 max=1，用户还能把滑块拖到 0，
     不挡住的话会把「滚动」莫名其妙地关掉。 */
  if(span >= nArr) return;
  const v = parseInt(el.value, 10) || 0;
  /* 滑块位置是"窗口左端的数组下标"（syncChartControls 就是这么写的值），
     而 frozen.end 记的是逻辑下标 —— 换算时要把被裁掉的历史 dropped 加回去。
     因为行程只覆盖现存的点（v ≤ nArr - span），换算结果必然落在合法区间里。 */
  const end = v + dropped + span - 1;
  if(follow){
    unfollowByUser();                          /* 先按当前视口钉住，下面再按滑块位置钉一次 */
    frozen = { span: span, end: end };
  }else if(frozen){
    frozen.end = end;
  }else{
    frozen = { span: span, end: end };
  }
  drawChart();
});

/* INA226 四个下拉框：只刷新下方"换算耗时"的预览，既不写设备也不发命令 ——
   真正写下去只发生在点「写入配置」那一刻。顺带置 inaDirty，
   让信息周期的回读别把这份还没写入的选择盖掉。 */
['selAvg','selVbusct','selVshct','selLsb'].forEach(id => $(id).addEventListener('change', () => {
  S.inaDirty = true;
  renderCfgCalc();
}));

$('btnCfgRead').addEventListener('click', async () => {
  /* 读取 = 以设备为准，放弃表单里还没写入的改动 */
  S.inaDirty = false;
  applyInaCfg(await request(CMD.SYSTEM_INA226_CONFIG, [], 700));
  toast(t('tCfgRead'), 'ok');
});

$('btnCfgApply').addEventListener('click', async () => {
  const p = inaPick();
  const avg = p.avg, vbusct = p.vbusct, vshct = p.vshct, lsb = p.lsb;
  let val = (S.inaCfg ? S.inaCfg.val : 0x43FF) & 0xFFFF;
  val &= ~(7 << 9); val |= (avg & 7) << 9;
  val &= ~(7 << 6); val |= (vbusct & 7) << 6;
  val &= ~(7 << 3); val |= (vshct & 7) << 3;
  const payload = [lsb & 0xff, val & 0xff, (val >> 8) & 0xff];
  /* 固件的 Config 是「写 RAM 缓存 + 约 500 ms 防抖后才落 Flash」，而读命令读的是 Flash。
     写完立刻回读必然拿到旧值（界面就"变回上一次的值"），必须轮询到新值出现才算成功。 */
  const match = f => {
    if(!f || f.length < 5) return false;
    const d = decodeCfg(u16(f, 2));
    return f[1] === (lsb & 0xff) && d.avg === avg && d.vbusct === vbusct && d.vshct === vshct;
  };
  const f = await writeAndConfirm(CMD.SYSTEM_INA226_CONFIG, payload, CMD.SYSTEM_INA226_CONFIG, match);
  /* 回读到新值 = 表单与设备一致了，applyInaCfg 会自己撤掉"未写入"标记；
     没读到就把这组选择留在表单上等重试，别让回读的旧值盖掉它。 */
  if(f) applyInaCfg(f);
  if(f && match(f)) toast(t('tCfgOk'), 'ok');
  else toast(t('tCfgPending'), 'bad');
});

"use strict";
/* ---- 电流校准 ----
   写入是二次确认：点「写入校准」只做校验 + 快照 + 展开确认条，不碰设备；
   点「确认写入」才真正下发。快照（S.pendCal）就是摘要里显示的那组值。 */
function armCal(){
  const vals = ['calD0','calA0','calD1','calA1'].map(id => parseFloat($(id).value));
  const z = Math.round(parseFloat($('calZero').value) * 10);   /* 输入是 mA，固件用 0.1 mA */
  if(vals.some(v => !isFinite(v)) || !isFinite(z)){ toast(t('tCalBad'), 'bad'); return; }
  S.pendCal = { raw: vals.map(v => Math.round(v * 10)), z: clamp(z, -15, 15) };
  renderCalConfirm();
  toast(t('tCalPicked'));
}
$('btnCalApply').addEventListener('click', armCal);
$('btnCalCancel').addEventListener('click', () => {
  S.pendCal = null;
  renderCalConfirm();
  toast(t('tCalCancel'));
});
/* 待确认期间若改动了任何一个输入框，快照即失效——强制重新确认一次 */
['calD0','calA0','calD1','calA1','calZero'].forEach(id => $(id).addEventListener('input', () => {
  if(!S.pendCal) return;
  S.pendCal = null;
  renderCalConfirm();
  toast(t('tCalEdit'));
}));
$('btnCalGo').addEventListener('click', async () => {
  if(!S.pendCal) return;
  const p = S.pendCal;
  S.pendCal = null;                 /* 先清态：随后的回读要能刷新表单 */
  renderCalConfirm();
  const payload = [];
  const put = v => { payload.push(v & 0xff, (v>>8)&0xff, (v>>16)&0xff, (v>>>24)&0xff); };
  p.raw.forEach(put); put(p.z);
  const match = x => i32(x.slice(1,21),0) === p.raw[0] && i32(x.slice(1,21),16) === p.z;
  const f = await writeAndConfirm(CMD.SYSTEM_CURRENT_OFFSET, payload, CMD.SYSTEM_CURRENT_OFFSET, match);
  applyOffset(f);
  if(f && i32(f.slice(1,21),0) === p.raw[0] && i32(f.slice(1,21),16) === p.z) toast(t('tCalOk'), 'ok');
  else toast(t('tCalPending'), 'bad');
});

$('btnCalRead').addEventListener('click', async () => {
  clearPendCal();
  applyOffset(await request(CMD.SYSTEM_CURRENT_OFFSET, [], 800));
  toast(t('tCalRead'), 'ok');
});

$('btnReset').addEventListener('click', async () => {
  const msg = LANG === 'zh' ? '将软复位设备（输出会中断），确定？' : 'Soft-reset the device (output will drop)?';
  if(!confirm(msg)) return;
  await writeOnly(CMD.SYSTEM_RESET, []);
  toast(t('tResetSent'), 'ok');
});

$('btnFactory').addEventListener('click', async () => {
  const m1 = LANG === 'zh' ? '恢复出厂设置会清除所有配置，确定？' : 'Factory reset clears all configuration. Continue?';
  const m2 = LANG === 'zh' ? '再次确认：恢复出厂设置？' : 'Confirm again: factory reset?';
  if(!confirm(m1)) return;
  if(!confirm(m2)) return;
  await writeOnly(CMD.SYSTEM_FACTORY_RESET, []);
  toast(t('tFactorySent'), 'ok');
});

$('pollSel').addEventListener('change', () => {
  LS.set('poll', $('pollSel').value);
  updateLiveHint();
  ticker.setIv(pollIv());           /* 节拍周期跟着下拉立刻改掉，不用重连 */
  toast(t('tPollChg', { v:$('pollSel').selectedOptions[0].text }));
});
$('infoSel').addEventListener('change', () => {
  LS.set('info', $('infoSel').value);
  updateLiveHint();
  toast(t('tInfoChg', { v:$('infoSel').selectedOptions[0].text }));
});
$('themeSel').addEventListener('change', () => { LS.set('theme', $('themeSel').value); applyTheme(); });
$('langSel').addEventListener('change', () => {
  LANG = $('langSel').value;
  LS.set('lang', LANG);
  /* 按语言分发的构建产物只带了当前语言的字典：切到没加载的语言就重载页面，
     由首屏脚本按新存档挑一份。源目录含全部语言，永远走不到这一支。 */
  if(!I18N[LANG]) location.reload(); else applyStaticI18n();
});

if(navigator.serial && navigator.serial.addEventListener){
  navigator.serial.addEventListener('disconnect', e => {
    if(port && e.target === port){
      setDot('err', t('statusDevGone'));
      logLine('er', 'DEVICE DISCONNECT');
      disconnect();
    }
  });
}

window.addEventListener('beforeunload', e => {
  if(connected){ e.preventDefault(); e.returnValue = ''; }
});

"use strict";
/* ---- 初始化 ----
   语言与主题都是「本地有存档就用存档，没有才问系统」——用户手动选过的一定优先。 */
LANG = LS.get('lang', sysLang());
/* 构建产物里 I18N 只有一种语言，落到 'zh' 可能落到不存在的键上 —— 落到实际加载的那一种。 */
if(!I18N[LANG]) LANG = Object.keys(I18N)[0] || 'zh';
LANGS.forEach(l => $('langSel').add(new Option(l.name, l.code)));
$('langSel').value = LANG;
buildThemeSelect();
applyTheme();
$('chkDyn').checked = (LS.get('dyn', '0') === '1');
/* 趋势"滚动"开关，默认开。关掉时 follow=false、frozen 留空，
   等第一帧有数据时再按当时的窗口钉住（见 visRange）。 */
$('chkFollow').checked = (LS.get('follow', '1') !== '0');
follow = $('chkFollow').checked;
buildCfgSelects();
applyStaticI18n();
/* 注册 Service Worker 并接线「安装到桌面」按钮。放在这儿是有意的：
   initInstall() 里要读 t() 的文案，得等语言定下来、字典也加载完。 */
initInstall();
/* 不支持 Web Serial 时主界面已被 .noserial 隐藏：既不需要禁用控件，
   也不能画图 —— canvas 在 display:none 的容器里宽度为 0，画了反而会报错。 */
if(FEATURES_OK){ setEnabled(false); drawChart(); }
