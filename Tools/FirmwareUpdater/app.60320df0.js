"use strict";
/* ================================================================== *
 *  i18n —— 中 / 英 / 俄 / 德
 *
 *  与 PDTriggerMonitor 同一套写法：LANGS + I18N 字典 + t(key, vars)。
 *  构建脚本（build.py）会把 I18N 字典块整个抠出来拆成 4 个文件，
 *  首访只下发用户实际需要的那一种 —— 所以字典块的写法必须保持
 *  "const I18N = {" 起头、"\n};" 收尾（build.py 用正则锚这段）。
 * ================================================================== */
const LANGS = [
  { code:'zh', name:'中文',    loc:'zh-CN' },
  { code:'en', name:'English', loc:'en-US' },
  { code:'ru', name:'Русский', loc:'ru-RU' },
  { code:'de', name:'Deutsch', loc:'de-DE' }
];
const FALLBACK_LANG = 'en';

/* 当前语言。由 js/12-init.js 在启动时按「本地存档 → 系统语言」定下来。
   声明必须放在这里：12-init.js 带 "use strict"，直接给未声明的变量赋值会抛
   ReferenceError（隐式全局只在非严格模式下才成立）。
   构建产物里字典被拆成单语言文件，取值可能不在字典里，12-init 会兜底改判。 */
let LANG = FALLBACK_LANG;

/* 字典已按语言拆到独立文件：构建产物只加载用户实际需要的那一种 */

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
 *  协议定义
 *
 *  只保留升级流程真正用得到的几条命令（对应固件 User/Comm/Comm.h）。
 *  值 / 帧长 / 帧尾与 PDTriggerMonitor 的 js/02-protocol.js 同源 —— 两站
 *  说的是同一套协议，改一处要一起改。
 * ------------------------------------------------------------------ */
const CMD = {
  WHO_AM_I:0x01,
  SYSTEM_UPGRADE:0x41,          /* 写：41 A5 AA 0A 让设备重启进 bootloader */
  SYSTEM_VERSION:0x42,
  SYSTEM_SERIAL_NUM:0x43
};
const READ = 0x80, FRAME_END = 0x0A;

/* ------------------------------------------------------------------ *
 *  设备端 'C' 定时器的周期
 *
 *  bootloader 用 mOTA 的 BSP 定时器周期性往主机发 'C'（Ymodem 的握手邀请）：
 *      BSP_Timer_Init(&_timer_send_c, _Timeout_Handler, 1000, TIMER_RUN_FOREVER, …);
 *  第 3 个参数就是周期（bsp_timer.h 注明「需要计时的时间，单位为 ms」）。
 *  现存各产品的 bootloader（PDTrigger / PDPowerMini / PowerMonitorMini /
 *  Keyboard3Mini / Display 系列 / USB2CAN …共 16 份源码）**一律 1000**，
 *  也就是 **1 s 一个 'C'**。早先注释里"200 ms 一发"的说法在固件源码里对不上。
 *
 *  ★ 但别把它当固定契约：这是各产品自己配的，将来完全可能改成别的值。
 *    凡是「等 C」「容忍 C」的超时都按它的若干倍（整数个周期）来定，
 *    不要按亚秒级节拍去估 —— 节拍慢一倍，按旧估算定的窗口就只剩一半余量。
 * ------------------------------------------------------------------ */
const DEV_C_TICK_MS = 1000;

/* 应答帧长度。帧格式统一是 [cmd, …文本…, 帧尾]，长度 = 到第一个帧尾字节为止。

   ★ 为什么不能按「第 2 字节 = 文本长度」算：各产品固件的写法**两种都在出货**：
       "\x81\x1AWeAct Studio PD Trigger V1\n"          cmd + 长度字节 + 文本
       "\x81\x22WeAct Studio Power Monitor Mini V1\n"  同上
       "\x81WeAct Studio Keyboard 3 Mini\n"            ★ 没有长度字节
       "\x81WeAct Studio Display V1 FS (…)\n"          ★ 也没有
     也就是说 frame[1] 有时是长度、有时是正文首字符（'W'=0x57=87）。
     真正稳定的锚只有帧尾 0x0A —— 按它切，两种写法都对。

   返回值：>0 帧总长；0 = 帧尾还没到（继续等）；-1 = 不是已知帧头（前移重同步）。 */
const VARLEN_CMDS = { 0x81:1, 0xC2:1, 0xC3:1 };
const FRAME_MAX = 96;                  /* 型号名最长约 50 字符，留一倍余量 */
function frameLen(buf, have){
  if(have === undefined) have = buf.length;   /* 不传就按缓冲区现有字节数算 */
  if(!(buf[0] in VARLEN_CMDS)) return -1;
  const lim = Math.min(have, FRAME_MAX);
  for(let i = 1; i < lim; i++){
    if(buf[i] === FRAME_END) return i + 1;
  }
  if(have >= FRAME_MAX) return -1;     /* 这么长还没见帧尾：当噪声，重同步 */
  return 0;                            /* 帧尾还没到，继续等 */
}

/* ------------------------------------------------------------------ *
 *  设备表 —— 抄自官方 WeActStudio_Upgrade_Tool/device_info.h
 *
 *  · userString 是 fpk 包头里的水印，也是设备端 bootloader 校验的字段
 *    （FIRMWARE_USER_STRING_CHECK）。刷入前用它判断「这份固件是不是给这台设备的」。
 *  · id 是 USB 序列号前缀（芯片 ID 派生），用于在同一 VID:PID 下区分不同产品 —— 
 *    Web Serial 拿不到序列号，所以本页只把它当参考资料展示，不参与判断。
 *  · cmd 是进入升级模式的字节序列。
 * ------------------------------------------------------------------ */
const DEVICE_TABLE = [
  { userString:'USB2CANV1',      id:'AA', vid:0x0483, pid:0x5740, cmd:[0x58, 0x0D],             name:'USB2CAN FD V1' },
  { userString:'DISPLAYV1FS',    id:'AB', vid:0x1A86, pid:0xFE0C, cmd:[0x41,0xA5,0xAA,0x0A],  name:'Display V1 FS' },
  { userString:'PDPOWERMINIV1',  id:'AC', vid:0x1A86, pid:0xFE0C, cmd:[0x41,0xA5,0xAA,0x0A],  name:'PD Power Mini V1' },
  { userString:'DISPLAY096FS',   id:'AD', vid:0x1A86, pid:0xFE0C, cmd:[0x41,0xA5,0xAA,0x0A],  name:'Display 0.96 FS' },
  { userString:'KEYBOARD2LCD',   id:'AF', vid:0x1A86, pid:0xFE0C, cmd:[0x41,0xA5,0xAA,0x0A],  name:'Keyboard 2 LCD' },
  { userString:'KEYBOARD3MINI',  id:'B0', vid:0x1A86, pid:0xFE0C, cmd:[0x41,0xA5,0xAA,0x0A],  name:'Keyboard 3 Mini' },
  { userString:'POWERMONITORMV1',id:'B1', vid:0x1A86, pid:0xFE0C, cmd:[0x41,0xA5,0xAA,0x0A],  name:'Power Monitor Mini V1' },
  { userString:'PDPOWERMINIV11', id:'B3', vid:0x1A86, pid:0xFE0C, cmd:[0x41,0xA5,0xAA,0x0A],  name:'PD Power Mini V1.1' },
  { userString:'PDTRIGGERV1',    id:'B4', vid:0x1A86, pid:0xFE0C, cmd:[0x41,0xA5,0xAA,0x0A],  name:'PD Trigger V1' }
];

/* 连接过滤器：只列已知的 VID:PID，用户就不会在串口列表里选错别的串口。
   万一以后出了新 VID:PID 的产品，requestPort 的 catch 分支会退回"不过滤"。 */
const PORT_FILTERS = [{ usbVendorId:0x1A86, usbProductId:0xFE0C },
                      { usbVendorId:0x0483, usbProductId:0x5740 }];

function deviceByUserString(us){
  return DEVICE_TABLE.find(d => d.userString === us) || null;
}
function deviceByVid(vid, pid){
  return DEVICE_TABLE.find(d => d.vid === vid && d.pid === pid) || null;
}
/* 进入升级模式指令：优先用「由目录条目定出的 user_string」查表；
   查不到就退回这台设备的 VID:PID 对应产品（同 VID:PID 下指令一致，够用）。 */
function enterCmdFor(userString, vid, pid){
  const d = deviceByUserString(userString) || deviceByVid(vid, pid);
  return (d && d.cmd) ? d.cmd.slice() : [0x41, 0xA5, 0xAA, 0x0A];
}
"use strict";
/* ------------------------------------------------------------------ *
 *  小工具
 * ------------------------------------------------------------------ */
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = a => Array.from(a).map(v => v.toString(16).padStart(2,'0')).join(' ');
const u32le = (b,o) => (b[o] | (b[o+1]<<8) | (b[o+2]<<16) | (b[o+3]<<24)) >>> 0;
const esc = s => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

/* C 风格字符串（到第一个 \0 为止），非法 UTF-8 字节丢弃。 */
function cstr(bytes){
  const cut = bytes.indexOf(0);
  const arr = (cut >= 0) ? bytes.slice(0, cut) : bytes;
  try{ return new TextDecoder('utf-8').decode(new Uint8Array(arr)).trim(); }
  catch(e){ return ''; }
}
/* 协议帧里的文本字段。
   帧格式是 [cmd, …文本…, 帧尾] —— 有的设备在文本前插一个「字符数」字节
   （如 PD Trigger：\x81\x1A"…"；0x1A=26 正好是型号名长度），有的**不插**
   （如 Keyboard 3 Mini：\x81"…"）。两种都在出货，所以不能无条件从 index 2 切。

   判定规则：只有当长度字节**严丝合缝**对得上整帧（2 + n + 1 === frame.length
   且末字节是帧尾）时才认它；否则 frame[1] 就是正文首字符（'W'=87），
   按去掉首尾字节宽松解析。从前无条件认长度字节的写法，一旦碰上不带该字节的
   固件就会把整段文本切没 —— 型号/版本全变空。 */
function frameText(frame){
  const len = frame.length;
  const n = frame[1];
  const hasLenByte = (typeof n === 'number' && n > 0 &&
                      2 + n + 1 === len && frame[len - 1] === FRAME_END);
  const body = hasLenByte
    ? Array.from(frame).slice(2, 2 + n)
    : Array.from(frame).slice(1, Math.max(1, len - 1));
  const cut = body.indexOf(0);
  return cstr(cut >= 0 ? body.slice(0, cut) : body);
}

/* ---------- CRC32（IEEE 802.3，与 zlib / fpk.exe 一致） ---------- *
 * 用来校验 fpk 包头与包体。表按需生成：一个包最多算几十万字节，
 * 表法比逐位快一个数量级，而表本身只占 1 KB。 */
let _crc32Tab = null;
function crc32(bytes, start, end){
  if(!_crc32Tab){
    _crc32Tab = new Uint32Array(256);
    for(let n = 0; n < 256; n++){
      let c = n;
      for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crc32Tab[n] = c >>> 0;
    }
  }
  const e = (end === undefined) ? bytes.length : end;
  let c = 0xFFFFFFFF;
  for(let i = (start | 0); i < e; i++) c = _crc32Tab[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const hex8 = v => (v >>> 0).toString(16).padStart(8,'0');

/* ---------- CRC16-CCITT / XMODEM（Ymodem 逐包校验，poly 0x1021 init 0） ---------- */
function crc16x(data, len){
  let crc = 0;
  for(let i = 0; i < len; i++){
    crc ^= data[i] << 8;
    for(let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc & 0xFFFF;
}

/* ---------- 格式化 ---------- */
function fmtBytes(n){
  if(n == null) return '--';
  if(n < 1024) return n + ' B';
  if(n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 2 : 1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
function fmtDur(sec){
  sec = Math.max(0, Math.round(sec));
  if(sec < 60) return sec + ' s';
  const m = Math.floor(sec / 60);
  return m + ':' + String(sec % 60).padStart(2,'0');
}

/* ---------- 提示条 ---------- */
let toastTimer = null, toastBarTimer = null;
const TOAST_ICON = { ok:'\u2713', bad:'!', info:'i' };
function toast(msg, kind){
  kind = (kind === 'ok' || kind === 'bad') ? kind : 'info';
  const el = $('toast'), bar = $('toastBar');
  const ms = kind === 'bad' ? 6000 : 3200;
  el.className = 'toast show ' + kind;
  $('toastIco').textContent = TOAST_ICON[kind];
  $('toastMsg').textContent = msg;
  clearTimeout(toastTimer); clearTimeout(toastBarTimer);
  bar.style.transition = 'none';
  bar.style.transform = 'scaleX(1)';
  toastBarTimer = setTimeout(() => {
    bar.style.transition = 'transform ' + ms + 'ms linear';
    bar.style.transform = 'scaleX(0)';
  }, 30);
  el.style.transition = 'none';
  el.style.opacity = '0';
  el.style.transform = 'translate(-50%,16px) scale(.97)';
  void el.offsetWidth;
  el.style.transition = '';
  el.style.opacity = '';
  el.style.transform = '';
  toastTimer = setTimeout(() => { el.className = 'toast ' + kind; }, ms);
}

/* ---------- 通信日志 ---------- */
function logLine(kind, text){
  const chk = $('logChk');
  if(chk && !chk.checked) return;
  const box = $('log');
  if(!box) return;
  const div = document.createElement('div');
  div.className = kind;
  let ts = '';
  try{ ts = new Date().toLocaleTimeString(loc(), { hour12:false }); }catch(e){ ts = new Date().toLocaleTimeString(); }
  div.textContent = ts + '  ' + text;
  box.appendChild(div);
  while(box.childNodes.length > 600) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}
"use strict";
/* ------------------------------------------------------------------ *
 *  主题 / 语言 持久化
 *
 *  前缀刻意与 PDTriggerMonitor（pdtrig.）区分开：两站同域，
 *  共用键名会互相覆盖（比如语言存档）。
 * ------------------------------------------------------------------ */
const LS = {
  get(k, d){ try{ const v = localStorage.getItem('weactupd.' + k); return v === null ? d : v; }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem('weactupd.' + k, v); }catch(e){} }
};
const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
const DEFAULT_THEME = 'auto';

function sysLang(){
  const list = (navigator.languages && navigator.languages.length)
    ? navigator.languages : [navigator.language || ''];
  for(const raw of list){
    const base = String(raw || '').toLowerCase().split('-')[0];
    if(base && I18N[base]) return base;
  }
  return 'zh';
}
function resolvedTheme(){
  const m = LS.get('theme', DEFAULT_THEME);
  if(m === 'auto') return (mq && mq.matches) ? 'light' : 'dark';
  return m === 'light' ? 'light' : 'dark';
}
function applyTheme(){
  document.documentElement.setAttribute('data-theme', resolvedTheme());
  if($('themeSel')) $('themeSel').value = LS.get('theme', DEFAULT_THEME);
}
function buildThemeSelect(){
  const sel = $('themeSel');
  if(!sel) return;
  sel.innerHTML = '';
  [['auto','themeAuto'], ['dark','themeDark'], ['light','themeLight']]
    .forEach(([v,k]) => sel.add(new Option(t(k), v)));
  sel.value = LS.get('theme', DEFAULT_THEME);
}
if(mq && mq.addEventListener) mq.addEventListener('change', () => { if(LS.get('theme', DEFAULT_THEME) === 'auto') applyTheme(); });

/* 静态文案替换。两种属性：
     data-i18n      → textContent（纯文本）
     data-i18n-html → innerHTML（文案里带 <code>/<b> 这种标记的走这条） */
function applyStaticI18n(){
  document.documentElement.lang = (LANG === 'zh') ? 'zh-CN' : LANG;
  document.title = t('appTitle');
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const s = t(el.dataset.i18nTitle);
    el.title = s;
    /* 图标按钮（<button> 或 <a>）没有可见文字，无障碍名称只能靠 aria-label ——
       别漏掉 <a>，否则「返回工具集」会永远停在源码里那份中文兜底。 */
    if(el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button'){
      el.setAttribute('aria-label', s);
    }
  });
}
"use strict";
/* ------------------------------------------------------------------ *
 *  串口链路
 *
 *  两种消费字节的方式，共用同一个读循环：
 *    · frame —— 协议帧（读型号 / 版本 / 序列号）：按 02-protocol 的长度表切帧
 *    · raw   —— 原始字节（Ymodem 传输）：所有字节交给 ByteChan，由发送状态机按
 *               "等某个字节 / 超时" 的方式自己取
 *  切模式只改 mode 一个变量，读循环本身不动 —— 这样断开/重连的竞态只有一处。
 * ------------------------------------------------------------------ */
let port = null, reader = null, readTask = null;
let connected = false, gen = 0;
let rxBuf = [];
let pending = null;
let writeChain = Promise.resolve();
let portIdText = '';
let mode = 'frame';
let chan = null;

/* 设备信息（连上后逐条问回来） */
const S = { who:'', version:'', serial:'', vid:0, pid:0, devGone:false, bootMode:false };

/* 判值不判"属性在不在"：'serial' in navigator 为真、但 navigator.serial 是
   undefined 的环境确实存在（例如被策略/权限挡掉时），那一用就炸。 */
const FEATURES_OK = !!navigator.serial;

/* 不支持 Web Serial 时的兜底提示卡（#fallback 由 html.noserial 显示）。 */
function showBanner(){
  const b = $('banner');
  if(!b) return;
  b.innerHTML = '<b>' + t('unSupTitle') + '</b><br>' + t('unSupLead');
  b.className = 'banner show';
}

/* ------------------------------------------------------------------ *
 *  ByteChan —— 带超时的字节通道
 *
 *  reader 每读到一批就 push；Ymodem 那边按 read(timeout)/waitFor(byte) 取。
 *  read 返回 null 表示超时（不是错误）—— 协议里"没等到 ACK"就是一种正常结果，
 *  由上层决定重发还是放弃。
 * ------------------------------------------------------------------ */
function newChan(){
  return {
    q: [], waiters: [], closed: false,
    push(bytes){
      for(const b of bytes){
        if(this.waiters.length) this.waiters.shift()(b);
        else this.q.push(b);
      }
    },
    /* 丢弃缓冲里已有的字节（换阶段时用，避免上一阶段的残留污染握手） */
    drain(){ this.q.length = 0; },
    reset(){ this.q.length = 0; while(this.waiters.length) this.waiters.shift()(null); },
    close(){ this.closed = true; this.reset(); },
    read(timeout){
      if(this.q.length) return Promise.resolve(this.q.shift());
      if(this.closed) return Promise.resolve(null);
      return new Promise(res => {
        const w = { res, timer:null };
        w.timer = setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if(i >= 0) this.waiters.splice(i, 1);
          res(null);
        }, timeout);
        this.waiters.push(b => { clearTimeout(w.timer); res(b); });
      });
    },
    /* 一直读到 byte 或超时。期间收到的其它字节丢弃 —— 设备在等数据时
       会周期性插进来多余的 'C'（周期见 DEV_C_TICK_MS，各产品固件是 1 s，
       不是亚秒级），必须容忍。 */
    async waitFor(byte, timeout){
      const t0 = Date.now();
      while(true){
        const left = timeout - (Date.now() - t0);
        if(left <= 0) return false;
        const b = await this.read(left);
        if(b === null) return false;
        if(b === byte) return true;
      }
    }
  };
}

/* ------------------------------------------------------------------ *
 *  状态行 / 悬停提示
 * ------------------------------------------------------------------ */
function setDot(cls, txt){
  $('dot').className = 'dot' + (cls ? ' ' + cls : '');
  $('stTxt').textContent = txt;
}
function renderStatus(){
  const on = connected;
  setDot(on ? 'on' : (S.devGone ? 'err' : ''), t(on ? 'statusConnected' : (S.devGone ? 'statusDevGone' : 'statusDisconnected')) +
         (on && portIdText ? ' (' + portIdText + ')' : ''));
}
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

/* ------------------------------------------------------------------ *
 *  连接 / 断开
 * ------------------------------------------------------------------ */
async function connect(){
  if(connected) return disconnect();
  try{
    port = await navigator.serial.requestPort({ filters: PORT_FILTERS })
             .catch(() => navigator.serial.requestPort());
    await port.open({ baudRate:115200, dataBits:8, stopBits:1, parity:'none',
                      flowControl:'none', bufferSize:8192 });
  }catch(e){
    if(e && /No port selected|user cancel|cancelled/i.test(String(e.message || e))) return; /* 用户自己取消，不必报错 */
    toast(t('tConnFail') + (e && e.message ? e.message : e), 'bad');
    logLine('er', 'OPEN FAIL ' + e);
    port = null;
    return;
  }
  gen++;
  S.who = ''; S.version = ''; S.serial = ''; S.devGone = false;
  portIdText = '';
  try{
    const info = port.getInfo ? port.getInfo() : {};
    S.vid = info.usbVendorId || 0;
    S.pid = info.usbProductId || 0;
    if(S.vid || S.pid){
      portIdText = S.vid.toString(16).padStart(4,'0') + ':' + S.pid.toString(16).padStart(4,'0');
    }
  }catch(e){}
  connected = true;
  rxBuf = [];
  mode = 'frame';
  chan = newChan();
  logLine('no', t('tPortOpen'));
  beginRead(gen);
  await sleep(250);
  renderStatus(); updateConnTip();
  await readDeviceInfo();
  /* 读不到版本号 = 设备没在跑应用（多半停在 bootloader 等固件）。
     把它标出来：界面要提示"可直接刷"，而不是显示一串 -- 让人不知所措。 */
  S.bootMode = !S.version;
  if(S.bootMode) logLine('no', t('lgNoVer'));
  renderAll();
}

async function disconnect(silent){
  if(!connected && !port) return;
  connected = false; gen++;
  if(chan){ chan.close(); chan = null; }
  if(pending){ pending.resolve(null); clearTimeout(pending.timer); pending = null; }
  rxBuf = [];
  try{ if(reader){ await reader.cancel(); } }catch(e){}
  try{ if(readTask){ await readTask; } }catch(e){}
  reader = null; readTask = null;
  try{ if(port){ await port.close(); } }catch(e){}
  port = null;
  renderStatus(); updateConnTip();
  renderAll();
  if(!silent) logLine('no', t('tPortClosed'));
}

function delay(ms){ return new Promise(r => setTimeout(r, ms)); }

/* ------------------------------------------------------------------ *
 *  读循环（两种模式共用）
 * ------------------------------------------------------------------ */
async function beginRead(g){
  readTask = (async () => {
    /* 同一个读循环里读错误只报一次。设备重启时 read() 会连续抛（先 NetworkError
       "device has been lost"，随后 readable 变 null），早先每 60 ms 打一行，
       一次升级实测刷出 100+ 行「READ ERR」红字把日志冲垮。 */
    let reported = false;
    while(connected && g === gen && port){
      /* ★ readable 变 null = 设备侧已经把端口断开了（重启 / 拔线 / 重新枚举）。
         必须在这里退出：早期版本硬着头皮再 getReader()，于是
             TypeError: Cannot read properties of null (reading 'getReader')
         每 60 ms 抛一次，一直空转到有人 bump gen 为止 —— 而这恰恰是升级流程里
         最要紧的那几秒（设备重启等着回来）。 */
      const rd = port.readable;
      if(!rd) break;
      try{
        reader = rd.getReader();
        reported = false;
        while(connected && g === gen){
          const r = await reader.read();
          if(r.done) break;
          if(r.value && r.value.length) onBytes(r.value, g);
        }
      }catch(e){
        if(g === gen && connected && !reported){ reported = true; logLine('er', 'READ ERR ' + e); }
      }finally{
        try{ reader.releaseLock(); }catch(e){}
      }
      if(!(connected && g === gen)) break;
      await delay(60);
    }
  })();
}

function onBytes(bytes, g){
  if(g !== gen) return;
  if(mode === 'raw'){
    if(chan) chan.push(bytes);
    return;
  }
  for(const b of bytes) rxBuf.push(b);
  parseRx();
}

function parseRx(){
  let guard = 0;
  while(rxBuf.length && guard++ < 4096){
    const len = frameLen(rxBuf, rxBuf.length);
    if(len === -1){ rxBuf.shift(); continue; }   /* 不是已知帧头：前移重同步 */
    if(len === 0) return;                        /* 变长帧还没拿到长度 */
    if(rxBuf.length < len) return;               /* 帧没到齐 */
    const frame = rxBuf.slice(0, len);
    if(frame[len-1] !== FRAME_END){ rxBuf.shift(); continue; }
    rxBuf.splice(0, len);
    dispatch(frame);
  }
}

function dispatch(frame){
  const id = frame[0];
  logLine('rx', 'RX ' + hex(frame) + '   | ' + frameText(frame));
  if(pending && pending.id === id){
    const p = pending; pending = null;
    clearTimeout(p.timer);
    p.resolve(frame);
  }
}

function writeBytes(arr){
  /* 设备重启窗口里 port.writable 会是 null —— 直接 getWriter() 会抛
     TypeError，把"端口暂时不在"伪装成代码错误。这里给一个说得清的 rejection。 */
  if(!port || !port.writable) return Promise.reject(new Error('port-not-open'));
  const w = port.writable.getWriter();
  return w.write(new Uint8Array(arr)).then(() => w.releaseLock())
    .catch(e => { try{ w.releaseLock(); }catch(_){} throw e; });
}

/* 帧请求。与应用监控页同构：串行写链保证互斥，超时即认定"这条应答不会来了"，
   并清空接收缓冲 —— 免得半截残帧把下一条命令的应答拼歪。 */
function request(cmd, timeout){
  timeout = timeout || 700;
  return chainWrite(async () => {
    if(!connected) throw new Error('disconnected');
    if(pending){ pending.resolve(null); clearTimeout(pending.timer); pending = null; }
    const out = [cmd | READ, FRAME_END];
    logLine('tx', 'TX ' + hex(out));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if(pending && pending.id === (cmd | READ)){
          pending = null;
          if(rxBuf.length) rxBuf = [];
          logLine('er', 'TIMEOUT cmd 0x' + (cmd | READ).toString(16));
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
function chainWrite(fn){
  const prev = writeChain.catch(() => {});
  writeChain = prev.then(fn);
  return writeChain;
}

/* ------------------------------------------------------------------ *
 *  读设备信息：型号 / 版本 / 序列号
 *
 *  这三条就是"认设备"的全部依据：型号决定该刷哪份固件，版本决定要不要刷。
 *  版本串形如 V1.0.0.0_b39b242f —— 与 fpk 包头的 fw_new_ver 是同一个字符串，
 *  所以可以直接和固件包里的版本做等值比较（见 07-fpk.js）。
 * ------------------------------------------------------------------ */
async function readDeviceInfo(){
  const w = await request(CMD.WHO_AM_I, 600);
  if(w) applyText(w, s => { S.who = s; });
  const v = await request(CMD.SYSTEM_VERSION, 600);
  if(v) applyText(v, s => { S.version = s; });
  const sn = await request(CMD.SYSTEM_SERIAL_NUM, 600);
  if(sn) applyText(sn, s => { S.serial = s; });
  updateConnTip();
  logLine('no', 'DEVICE ' + (S.who || '-') + ' / ' + (S.version || '-') + ' / ' + (S.serial || '-'));
}
function applyText(frame, fn){
  const s = frameText(frame);
  if(s) fn(s);
}

/* ------------------------------------------------------------------ *
 *  为升级做准备：停读循环并放掉端口
 *
 *  必须真的把端口关掉 —— 否则设备重启后我们手里还攥着一个已经失效的
 *  SerialPort，重枚举回来的那个对象反而打不开（Windows 上 COM 号也可能变）。
 * ------------------------------------------------------------------ */
async function releaseForUpgrade(){
  connected = false;          /* 让读循环自然退出（不触发 UI 的"未连接"渲染） */
  gen++;
  if(pending){ pending.resolve(null); clearTimeout(pending.timer); pending = null; }
  try{ if(reader){ await reader.cancel(); } }catch(e){}
  try{ if(readTask){ await readTask; } }catch(e){}
  reader = null; readTask = null;
  try{ if(port){ await port.close(); } }catch(e){}
  logLine('no', 'PORT RELEASED');
}

/* 切到原始字节模式（端口已经开着、读循环已经在跑）。
   升级流程里两处会用到：① 设备本来就在 bootloader（不用重开端口）；
   ② 重新枚举后刚 open 完。此时只剩chan 一个消费者，帧解析静默。 */
function attachRaw(){
  mode = 'raw';
  rxBuf = [];
  pending = null;
  chan = newChan();
}
/* 切回帧模式（升级后回读版本用）。 */
function attachFrame(){
  mode = 'frame';
  rxBuf = [];
  if(chan){ chan.close(); chan = null; }
}

/* 打开一个已经授权过的端口并接手读循环。reopenDevice 成功后调用。 */
function adoptPort(p){
  port = p;
  connected = true;
  gen++;
  beginRead(gen);
  attachRaw();
}

/* ------------------------------------------------------------------ *
 *  等待设备重新枚举
 *
 *  设备重启后（app → bootloader，或升级完成 bootloader → app）USB 会重新枚举。
 *  VID:PID 与 USB 序列号都没变（两侧 usb_desc.c 同源：0x1A86:0xFE0C + 芯片 ID
 *  派生的同一个序列号串），所以 Windows 上设备实例 ID 一模一样，Chrome 里
 *  之前授权过的那台设备仍然"有权限"，可以直接 open —— 不需要（也没法）
 *  再弹一次授权框。
 *
 *  逐个尝试 getPorts() 里 VID:PID 匹配的端口：已经打开的会抛错，跳过试下一个；
 *  全部失败就等下一轮。整个过程封顶 timeoutMs，失败抛 port-not-back。
 * ------------------------------------------------------------------ */
async function reopenDevice(timeoutMs){
  const t0 = Date.now();
  let lastErr = null;
  while(Date.now() - t0 < timeoutMs){
    await delay(220);
    let list = [];
    try{ list = await navigator.serial.getPorts(); }catch(e){ list = []; }
    const match = list.filter(p => {
      try{
        const i = p.getInfo ? p.getInfo() : {};
        return (i.usbVendorId === S.vid && i.usbProductId === S.pid);
      }catch(e){ return false; }
    });
    const pool = match.length ? match : list;
    for(const p of pool){
      try{
        await p.open({ baudRate:115200, dataBits:8, stopBits:1, parity:'none',
                       flowControl:'none', bufferSize:8192 });
        /* open() 会"成功"，即便设备还在重新枚举 —— 此时 readable 仍是 null。
           不检查就把这个死端口交给升级流程，结果是白等一轮请求超时（实测日志里
           那条 TIMEOUT cmd 0xc2 就是这么来的）。关掉，等下一轮重试。 */
        if(!p.readable){
          try{ await p.close(); }catch(_){}
          await delay(150);
          continue;
        }
        adoptPort(p);
        return p;
      }catch(e){ lastErr = e; }
    }
  }
  throw new Error('port-not-back' + (lastErr ? ': ' + (lastErr.message || lastErr) : ''));
}

/* ------------------------------------------------------------------ *
 *  串口事件：拔出/插入时更新 UI（并让升级流程知道设备掉线了）
 * ------------------------------------------------------------------ */
if(FEATURES_OK){
  navigator.serial.addEventListener('connect', () => { logLine('no', 'USB CONNECT'); });
  navigator.serial.addEventListener('disconnect', (e) => {
    let same = false;
    try{ same = (e.target === port); }catch(_){}
    logLine('no', 'USB DISCONNECT' + (same ? ' (our port)' : ''));
    if(!same) return;
    if(mode === 'frame'){
      S.devGone = true;
      connected = false;
      if(chan){ chan.close(); }
      renderStatus();
      renderAll();
    }else{
      /* raw 模式 = 正在升级。此刻掉线是**预期**的：设备收到进入指令后自己复位，
         USB 走一遍重新枚举。这里刻意什么都不拆：
          · 读循环会因 readable 变 null 自行退出（见 beginRead）；
          · connected 必须保持 true —— 升级流程正是靠它把设备重新 open 回来，
            置 false 会让随后的 request() 立刻判 'disconnected'。 */
      logLine('no', t('lgUsbGone'));
    }
  });
}
"use strict";
/* ------------------------------------------------------------------ *
 *  安装为应用（PWA）+ Service Worker 注册
 *
 *  整段与 PDTriggerMonitor/js/06-install.js 同源：能不能装由浏览器说了算
 *  （manifest + 带 fetch 处理器的 SW + HTTPS 三条齐全），缺一条就只是没弹窗。
 *  这里多一句说明：SW 是本页「省流量 / 可离线」的一半，另一半是构建脚本里
 *  那套带内容 hash 的文件名 + 一年强缓存。
 * ------------------------------------------------------------------ */
const SW_FILE = 'sw.js';

/* 由 pathname 推本应用的目录；返回 null 表示"这个 URL 形态判不准，别注册"。
 *
 *   /FirmwareUpdater/   ->  /FirmwareUpdater/  目录形式，直接用
 *   /index.html         ->  /                 去掉末段文件名
 *   /FirmwareUpdater    ->  null              末尾没有点又没有斜杠
 *
 * 最后一种必须返回 null：那种地址下相对路径会被解析到站点根，若照常注册，
 * sw.js 会落到 /sw.js，作用域变成**整站**，把同域下的别的应用一并接管。
 * 宁可不注册 —— 本站与 PDTriggerMonitor、WeActTools 同域。 */
function appDirFromPath(pathname){
  const p = String(pathname || '');
  if(!p || p[0] !== '/') return null;
  if(p.slice(-1) === '/') return p;
  const cut = p.lastIndexOf('/');
  if(p.slice(cut + 1).indexOf('.') >= 0) return p.slice(0, cut + 1);
  return null;
}

function canInstallHere(){
  if(location.protocol !== 'http:' && location.protocol !== 'https:') return false;  /* file:// 下没有 SW */
  if(!('serviceWorker' in navigator)) return false;
  if(!(navigator.userAgentData || window.chrome)) return false;
  if(window.matchMedia && matchMedia('(display-mode: standalone)').matches) return false;
  return true;
}

function registerSW(){
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
  if(!canInstallHere()){ btn.hidden = true; return; }

  let deferred = null;

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();          /* 拦掉浏览器自带那条迷你信息栏，改由按钮触发 */
    deferred = e;
    btn.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    btn.hidden = true;
    toast(t('tInstallOk'), 'ok');
    try{ logLine('no', 'APP INSTALLED'); }catch(_){ }
  });

  /* 按钮常驻：Chrome 的安装事件带"用户与站点交互过一段时间"的启发式，不保证触发；
     只等事件才显示按钮，用户很可能永远看不到它。点不到系统弹窗就指路菜单。 */
  btn.addEventListener('click', async () => {
    if(deferred){
      deferred.prompt();
      let choice = null;
      try{ choice = await deferred.userChoice; }catch(_){ }
      deferred = null;
      if(choice && choice.outcome === 'accepted') return;   /* 成功提示统一由 appinstalled 给 */
      toast(t('tInstallBad'), 'bad');
      return;
    }
    toast(t('tInstallMenu'), '');
  });
}
"use strict";
/* ------------------------------------------------------------------ *
 *  fpk 固件包解析与校验
 *
 *  包头是 96 字节（小端），与官方工具 FPK_HeaderReader.FPK_HEAD_FORMAT
 *  以及固件端 struct FPK_HEAD 三方一致：
 *
 *    偏移  长度  字段            说明
 *      0    4   head_name       "fpk"
 *      4    4   config_info     固件端只看 [1]：== 0x01 即为加密包（唯一被接受的值）
 *      8   16   fw_old_ver      "V0.0.0.0_00000000"
 *     24   16   fw_new_ver      "V1.0.0.0_b39b242f"  ← 设备回读的版本就是这一串
 *     40   16   user_string     "PDTRIGGERV1"        ← 设备端 FIRMWARE_USER_STRING_CHECK
 *     56   16   part_name       "app"
 *     72    4   raw_size        .bin 原始长度
 *     76    4   pkg_size        = raw_size + 8（本工程实测 == raw_size）
 *     80    4   timestamp       unix 秒
 *     84    4   raw_crc32       原始 .bin 的 CRC32
 *     88    4   pkg_crc32       == fw_new_ver 里那 4 字节
 *     92    4   head_crc32      == CRC32(前 92 字节) —— 即"除自己以外"的包头
 *
 *  版本字段的编码方式（固件端 util_u32_to_dec / hex_pad 逆推）：
 *    前 4 字节是 v0.v1.v2.v3；后 4 字节是 CRC32 的小端，按 b7b6b5b4 顺序
 *    打印成 8 位十六进制 —— 所以 "V1.0.0.0_b39b242f" 里的 b39b242f
 *    就是 pkg_crc32 = 0xB39B242F。
 * ------------------------------------------------------------------ */
const FPK_HEAD_STRUCT = 96;
const FPK_HEAD_SIZES = [96, 128, 256, 512, 1024, 2048];

function fpkVersionStr(b, off){
  const v = b[off] + '.' + b[off+1] + '.' + b[off+2] + '.' + b[off+3];
  const crc = u32le(b, off + 4);
  return 'V' + v + '_' + hex8(crc);
}
/* 把 "V1.2.3.4_deadbeef" 拆成 { num:[1,2,3,4], crc:'deadbeef', raw:'…' }；
   认不出来的返回 null（设备版本串理论上永远是这个形状，但别假设）。 */
function parseVersion(s){
  const m = /^V(\d+)\.(\d+)\.(\d+)\.(\d+)(?:_([0-9a-fA-F]{8}))?$/.exec(String(s || '').trim());
  if(!m) return null;
  return { num:[+m[1], +m[2], +m[3], +m[4]], crc:(m[5] || '').toLowerCase(), raw:s };
}
/* 只看版本号四段的大小；相等返回 0。带 CRC 的"完全相等"另有 verEqual()。 */
function cmpVersion(a, b){
  const x = parseVersion(a), y = parseVersion(b);
  if(!x || !y) return null;
  for(let i = 0; i < 4; i++){
    if(x.num[i] !== y.num[i]) return x.num[i] < y.num[i] ? -1 : 1;
  }
  return 0;
}
/* 完整比较（含 CRC）。设备回读的版本串与包内 fw_new_ver 同一编码，
   所以字符串相等 == 固件字节相同 == 无需升级。 */
function verEqual(a, b){ return String(a || '') === String(b || ''); }

/* ------------------------------------------------------------------ *
 *  parseFpk(buf, name) → 解析结果
 *
 *  errors   —— 硬错：设备必然拒收（或根本传不过去），不该让用户点下去
 *  warnings —— 轻微可疑：官方 GUI 会拦（比如包头不是 1024），但设备能吃
 *
 *  ★ pkg_crc32 的校验范围是"包头之后到文件末尾"，也就是整分包体。
 *    这是**不需要密钥**就能做的完整性校验：包体是 AES 密文，
 *    但 CRC32 本来就是按密文算的，所以浏览器能原样复算。
 * ------------------------------------------------------------------ */
function parseFpk(buf, name){
  const bytes = new Uint8Array(buf);
  const errors = [], warnings = [];
  if(bytes.length < FPK_HEAD_STRUCT + 1) return { ok:false, errors:['too-small'], warnings };

  const h = {};
  h.fileName = name || '';
  h.fileSize = bytes.length;
  h.headName = cstr(Array.from(bytes.slice(0, 4)));
  h.config = Array.from(bytes.slice(4, 8));
  h.oldVersion = fpkVersionStr(bytes, 8);
  h.version = fpkVersionStr(bytes, 24);
  h.userString = cstr(Array.from(bytes.slice(40, 56)));
  h.partName = cstr(Array.from(bytes.slice(56, 72)));
  h.rawSize = u32le(bytes, 72);
  h.pkgSize = u32le(bytes, 76);
  h.timestamp = u32le(bytes, 80);
  h.rawCrc32 = u32le(bytes, 84);
  h.pkgCrc32 = u32le(bytes, 88);
  h.headCrc32 = u32le(bytes, 92);
  h.encrypted = (h.config[1] === 0x01);

  if(h.headName !== 'fpk') errors.push('bad-magic');
  if(h.config[1] !== 0x01) errors.push('not-encrypted');   /* 固件端只认 0x01 */

  h.headSize = h.fileSize - h.pkgSize;
  if(!FPK_HEAD_SIZES.includes(h.headSize)) errors.push('bad-head-size');
  else if(h.headSize !== 1024) warnings.push('head-size-not-1024');  /* 官方 GUI 只肯发 1024 */
  if(h.pkgSize <= 0 || h.pkgSize > h.fileSize) errors.push('bad-pkg-size');
  if(h.rawSize > h.pkgSize) errors.push('raw-gt-pkg');
  if(h.partName && h.partName !== 'app') warnings.push('part-not-app');

  /* 包头自校验：头 92 字节的 CRC32 */
  h.headCrcOk = (crc32(bytes, 0, 92) === h.headCrc32);
  if(!h.headCrcOk) errors.push('head-crc');

  /* 包体完整性：CRC32(包头之后到文件末尾) 必须等于 pkg_crc32 */
  if(h.pkgSize > 0 && h.pkgSize <= h.fileSize){
    h.bodyCrcOk = (crc32(bytes, h.headSize, h.headSize + h.pkgSize) === h.pkgCrc32);
    if(!h.bodyCrcOk) errors.push('body-crc');
  }else{
    h.bodyCrcOk = false;
  }

  /* 版本串里嵌的 CRC 与 pkg_crc32 必须一致 —— 不一致说明包头被改过 */
  const pv = parseVersion(h.version);
  h.versionCrcOk = !!(pv && pv.crc === hex8(h.pkgCrc32));
  if(!h.versionCrcOk) warnings.push('version-crc-mismatch');

  h.bytes = bytes;
  h.ok = (errors.length === 0);
  /* ★ 必须挂回去：调用方（选本地固件 / 下载目录固件）靠 h.errors 把
     "为什么不行"讲给用户听 —— 少了这两行，坏包只会换来一个 TypeError。 */
  h.errors = errors;
  h.warnings = warnings;
  return h;
}

/* 解析错误码 → 界面语言的人话。code 认不出来就原样返回（别把未知码吞掉）。 */
function fpkErrText(code){
  const M = {
    'too-small':'fpkTooSmall',
    'bad-magic':'fpkBadMagic',
    'not-encrypted':'fpkNotEncrypted',
    'bad-head-size':'fpkBadHeadSize',
    'bad-pkg-size':'fpkBadPkgSize',
    'raw-gt-pkg':'fpkRawGtPkg',
    'head-crc':'fpkHeadCrc',
    'body-crc':'fpkBodyCrc'
  };
  return M[code] ? t(M[code]) : code;
}
"use strict";
/* ------------------------------------------------------------------ *
 *  Ymodem 发送端（Ymodem-1K，CRC16-XMODEM）
 *
 *  这是官方 WeActStudio_Upgrade_Tool（Qt 版 ymodem.cpp）的等价移植，
 *  连"容错点"都照抄 —— 它们不是随手写的，每一条都对得上设备端
 *  mOTA 的状态机（user/mOTA/Core/Module/protocol_parser.c）：
 *
 *  ① 第一帧（文件名+大小）**不等 'C' 直接发**。设备侧要按"帧0 = 文件信息、
 *     帧1 = 固件包头、之后 = 固件包体"的顺序认，等 'C' 是把节奏交给对方：
 *     那个 'C' 定时器在 PP_Init 里就起来了、只有收到数据帧才暂停，它跟
 *     "设备已经把文件信息收下了"没有任何关系。周期多长（见 DEV_C_TICK_MS，
 *     现存产品固件一律 1 s）都不改变这个结论。
 *  ② 帧 0 的 ACK 之后要等 'C' 才发第一包数据 —— 设备此刻正在准备新一轮握手。
 *     收到 ACK 也认（Qt 版的兼容分支），因为两者可能同时压在一起。
 *  ③ 数据帧一定要 STX(1024)。设备按帧头取长度（SOH=128 / STX=1024），
 *     用 128 传等于把每个包里 896 字节的内容丢掉。
 *  ④ 末包用 0xFF 补齐（YMODEM_FILL_BYTE）。补齐部分超出 pkg_size，
 *     设备只按 pkg_size 写与校验，所以补什么值都不影响正确性；用 0xFF 是
 *     跟官方 GUI 保持一致（CLI 版补 0x00，两者都能刷成功，可见确实无关）。
 *  ⑤ EOT 发两次：第一次设备回 NAK，第二次回 ACK —— 这是 mOTA 状态机的
 *     显式设计（EXE_FLOW 的 FIRST_EOT / SECOND_EOT）。
 *  ⑥ 第二个 EOT 的 ACK 之后，设备重启 'C' 定时器来"邀请"那个收尾空包，
 *     所以要等 'C' 再发一个空的 SOH#0，收到它的 ACK 才算真正完成。
 *
 *  握手/应答一律"多收的字节直接丢"：设备在正式收数据前会往主机方向插 'C'，
 *  插进状态机就会被误判成无效应答，进而触发重发甚至死锁。
 *  但"丢"必须配墙钟上限（见 waitReply）—— 否则丢的字节序列要是无限长，
 *  等待就变成永不返回的空转。
 * ------------------------------------------------------------------ */
const PP = {
  SOH:0x01, STX:0x02, EOT:0x04, ACK:0x06, NAK:0x15, CAN:0x18, C:0x43
};
const FILL = 0xFF;
const RETRY_MAX = 5;        /* 单个阶段最多重发几次（官方 GUI 是 5） */
/* 单次 read 的上限。至少盖过几个 'C' 周期 —— 否则某台节拍偏慢的设备
   会让我们在"它其实还在、只是还没轮到发 C"的时候先判超时。 */
const STEP_TIMEOUT = 6 * DEV_C_TICK_MS;
/* 单个阶段的墙钟上限；超了按"这一轮没成"处理并重发。
   两个"等 C"的阶段（wait-C / wait-C2）就靠它兜底，所以取周期的整数倍：
   给 15 个周期，既留足重发余量，又不会在设备真死了的时候白等太久。 */
const PHASE_MS = 15 * DEV_C_TICK_MS;

/* 一个数据帧：头 3 字节 + 数据 + CRC16(2)。返回 Uint8Array。
 *
 * ★ CRC16 只覆盖**数据段**（偏移 3 起 dataLen 字节），不含头字节与包号取反。
 *   照抄官方两处实现：
 *     Qt   版  CRC::crc16_xmodem(&_send_buff[3], data_len)
 *     Python版  self._crc16(data)
 *   设备端也是 crc16_xmodem(pkg.data, data_len)（protocol_parser.c）。
 *   多算头 3 字节虽然也能算出个 CRC，但与设备端对不上 —— 表现为每一包都被 NAK，
 *   重试到超时，升级卡在第一个数据包。 */
function buildFrame(header, pktNum, data, dataLen){
  const len = 3 + dataLen + 2;
  const f = new Uint8Array(len);
  f[0] = header;
  f[1] = pktNum & 0xFF;
  f[2] = (~pktNum) & 0xFF;
  if(data) f.set(data.subarray ? data.subarray(0, dataLen) : data.slice(0, dataLen), 3);
  const crc = crc16x(f.subarray(3), dataLen);
  f[len - 2] = (crc >> 8) & 0xFF;
  f[len - 1] = crc & 0xFF;
  return f;
}

/* 单控制字节（EOT / CAN） */
function ctrlFrame(b){ return new Uint8Array([b]); }

/* 文件名+大小的 128 字节信息块。名字太长就让位给长度字段 ——
   官方 GUI 也是这么截的（YMODEM_FILE_NAME_MAX_LEN - len(size) - 1）。
   设备端只用它打日志（"file name: …"），不参与任何判断。 */
function infoBlock(name, size){
  const b = new Uint8Array(128);           /* 默认全 0 */
  const keep = String(name || 'firmware.fpk').replace(/[^\x20-\x7E]/g, '_');
  const sizeStr = String(size);
  const maxName = Math.max(0, 128 - sizeStr.length - 1 - 1);
  const nm = keep.slice(0, maxName);
  for(let i = 0; i < nm.length; i++) b[i] = nm.charCodeAt(i);
  const off = nm.length + 1;
  for(let i = 0; i < sizeStr.length; i++) b[off + i] = sizeStr.charCodeAt(i);
  return b;
}

/* ------------------------------------------------------------------ *
 *  ymodemSend(bytes, fileName, ctx)
 *    ctx = { chan, write, log, onProgress(p), aborted(), alive() }
 *  · write(Uint8Array)  写串口
 *  · log(kind, text)    日志
 *  · alive()            可选：链路是否还在。掉线时立刻判失败（link-lost），
 *                       不再把 RETRY_MAX 次重试的墙钟白白耗光。
 *  · onProgress({sent, total, bytes, bytesTotal, rate, eta})  0..1
 *  返回 { ok:true } 或抛出 Error（message 带原因码）。
 * ------------------------------------------------------------------ */
async function ymodemSend(bytes, fileName, ctx){
  const chan = ctx.chan;
  const totalPackets = Math.max(1, Math.ceil(bytes.length / 1024));
  let pkt = 0;
  let sent = 0;                     /* 已确认的数据包数 */
  let errCount = 0;
  const t0 = Date.now();

  const abortIf = () => { if(ctx.aborted && ctx.aborted()) throw new Error('aborted'); };

  /* 等一个"可接受"的应答字节，期间其它字节一律丢弃。
   *
   * ★ 必须带墙钟上限（PHASE_MS），而且理由跟 'C' 的节拍无关：
   *   设备在等主机发数据时每隔一个周期就发一个 'C'（周期见 DEV_C_TICK_MS，
   *   现存产品固件一律 1 s），于是 read() 永远能在周期内拿到字节、永远不超时。
   *   若某个阶段只认 ACK 而把 'C' 当噪声丢掉，就会陷入"丢一个、再读一个"的
   *   无限空转 —— 既不重发也不记日志，表现为点下升级后界面永远卡在第一步。
   *   墙钟上限把这种空转收敛成一次可重试的失败。节拍是 200 ms 还是 1 s 都
   *   不改变这一点，所以上限只按墙钟定，不要按"几拍"去反推成亚秒级窗口。
   *
   * 返回：{b:byte} 收到可接受字节 | {timeout:true} 该阶段超时
   */
  async function waitReply(accept, tag){
    const t0p = Date.now();
    for(;;){
      abortIf();
      /* 设备掉线时（port.readable 变 null）这条链路上什么都不会再来了。
         与其把 RETRY_MAX × PHASE_MS（实测能空转一分多钟）耗光，不如立刻认输，
         让上层早点走"关串口 + 明确告诉用户"那条路。 */
      if(ctx.alive && !ctx.alive()) throw new Error('link-lost');
      const left = PHASE_MS - (Date.now() - t0p);
      if(left <= 0) return { timeout:true };
      const b = await chan.read(Math.min(left, STEP_TIMEOUT));
      if(b === null){
        if(ctx.alive && !ctx.alive()) throw new Error('link-lost');
        return { timeout:true };
      }
      if(accept(b)) return { b };
      ctx.log('no', 'YM << 0x' + b.toString(16) + t('ymIgnore', { tag:tag }));
    }
  }
  /* 重发计数：连续失败太多就放弃 */
  function bump(msg){
    if(++errCount >= RETRY_MAX) throw new Error('no-reply: ' + msg);
  }

  /* ---------- ① 文件信息帧（SOH #0） ---------- */
  const info = buildFrame(PP.SOH, 0, infoBlock(fileName, bytes.length), 128);
  ctx.log('tx', 'YM >> SOH#0  ' + fileName + ' (' + bytes.length + ' B)');
  await ctx.write(info);

  for(;;){
    abortIf();
    const r = await waitReply(b => b === PP.ACK || b === PP.NAK, 'info');
    if(r.b === PP.ACK){ errCount = 0; break; }
    if(r.timeout) ctx.log('er', t('ymRetryInfo'));
    else          ctx.log('er', t('ymNakInfo'));
    bump('info');
    await ctx.write(info);
  }
  ctx.log('rx', 'YM << ACK (info)');

  /* ---------- ② 等 'C'（或 ACK）后开始发数据 ---------- */
  for(;;){
    abortIf();
    const r = await waitReply(b => b === PP.C || b === PP.ACK || b === PP.CAN, 'wait-C');
    if(r.b === PP.CAN) throw new Error('cancelled-by-device');
    if(r.b === PP.C || r.b === PP.ACK){ errCount = 0; break; }
    ctx.log('er', t('ymRetryWaitC'));
    bump('wait-C');
  }
  ctx.log('rx', t('ymReady'));

  /* ---------- ③ 数据帧（STX 1K） ---------- */
  const block = new Uint8Array(1024);
  while(sent < totalPackets){
    abortIf();
    const off = sent * 1024;
    const n = Math.min(1024, bytes.length - off);
    block.fill(FILL);
    block.set(bytes.subarray(off, off + n), 0);
    const frame = buildFrame(PP.STX, pkt + 1, block, 1024);

    for(;;){
      abortIf();
      await ctx.write(frame);              /* 首次发送与重发走同一条路径 */
      const r = await waitReply(b => b === PP.ACK || b === PP.NAK || b === PP.CAN,
                                'pkt ' + (pkt + 1));
      if(r.b === PP.ACK){ errCount = 0; break; }
      if(r.b === PP.CAN) throw new Error('cancelled-by-device');
      if(r.timeout) ctx.log('er', t('ymRetryPkt', { n:pkt + 1 }));
      else          ctx.log('er', t('ymNakPkt',   { n:pkt + 1 }));
      bump('pkt ' + (pkt + 1));
    }

    pkt = (pkt + 1) & 0xFF;
    sent++;
    const done = sent * 1024;
    const dt = Math.max(0.001, (Date.now() - t0) / 1000);
    ctx.onProgress({
      sent, total: totalPackets,
      bytes: Math.min(done, bytes.length), bytesTotal: bytes.length,
      rate: done / dt,
      eta: (bytes.length - done) / Math.max(1, done / dt)
    });
    if(sent % 8 === 0 || sent === totalPackets){
      ctx.log('tx', t('ymSent', { a:sent, b:totalPackets,
        c:Math.min(done, bytes.length), d:bytes.length }));
    }
  }

  /* ---------- ④ EOT ×2 ---------- */
  ctx.log('tx', 'YM >> EOT #1');
  for(;;){
    abortIf();
    await ctx.write(ctrlFrame(PP.EOT));
    const r = await waitReply(b => b === PP.NAK || b === PP.ACK, 'EOT1');
    if(r.b === PP.NAK || r.b === PP.ACK){ errCount = 0; break; }
    ctx.log('er', t('ymRetryEot1'));
    bump('EOT1');
  }
  pkt = 0;
  ctx.log('tx', 'YM >> EOT #2');
  for(;;){
    abortIf();
    await ctx.write(ctrlFrame(PP.EOT));
    const r = await waitReply(b => b === PP.ACK, 'EOT2');
    if(r.b === PP.ACK){ errCount = 0; break; }
    ctx.log('er', t('ymRetryEot2'));
    bump('EOT2');
  }
  ctx.log('rx', 'YM << ACK (EOT)');

  /* ---------- ⑤ 收尾空包：等设备重新发 'C' 邀请 ---------- */
  for(;;){
    abortIf();
    const r = await waitReply(b => b === PP.C || b === PP.ACK, 'wait-C2');
    if(r.b === PP.C || r.b === PP.ACK){ errCount = 0; break; }  /* 有些实现 ACK 与 'C' 一起来 */
    ctx.log('er', t('ymRetryWaitC2'));
    bump('wait-C2');
  }
  const zero = new Uint8Array(128);
  const fin = buildFrame(PP.SOH, 0, zero, 128);
  ctx.log('tx', t('ymTxZero'));
  await ctx.write(fin);
  for(;;){
    abortIf();
    const r = await waitReply(b => b === PP.ACK, 'final');
    if(r.b === PP.ACK){ ctx.log('rx', t('ymAckZero')); return { ok:true }; }
    bump('final');
    await ctx.write(fin);
  }
}
"use strict";
/* ------------------------------------------------------------------ *
 *  升级流程编排
 *
 *  与官方 WeActStudio_Upgrade_Tool 的步骤一一对应：
 *
 *    ① 发进入升级模式指令（设备随即 NVIC_SystemReset，USB 掉线重新枚举）
 *    ② 等设备重新枚举，重新 open（VID:PID 与序列号都没变，授权仍然有效）
 *    ③ 等 bootloader 的 'C' 握手
 *    ④ Ymodem-1K 把整包 fpk 传过去（见 08-ymodem.js）
 *    ⑤ 设备自己解包 → 校验 → 写应用分区 → 跳转（USB 再枚举一次）
 *    ⑥ 回读版本，与包里的版本比对 —— 这是"真的刷进去了"的唯一证据
 *
 *  ②⑤ 这两次重新枚举是本流程与传统桌面工具最大的差别：桌面工具靠轮询 COM
 *  列表（甚至靠 COM 号不变），Web Serial 只能靠 getPorts() + open 重试。
 *  好在设备两侧（app / bootloader）的 usb_desc.c 同源，VID:PID 与序列号串
 *  都不变，所以 Chrome 的持久授权一直对得上。
 * ------------------------------------------------------------------ */
const UP = {
  running:false, aborted:false, t0:0,
  file:null,          /* { name, header } —— header 来自 parseFpk */
  entry:null,         /* 目录里对应的设备条目（可为空 = 本地固件/未知型号） */
  step:'',            /* 当前步骤 key（对应 i18n 的 st*） */
  steps:{},           /* key → 'idle' | 'active' | 'done' | 'fail' */
  progress:null,
  lastMsg:''
};

const UP_STEPS = ['stEnter', 'stReopen', 'stHandshake', 'stSend', 'stVerify', 'stDone'];

/* 升级中"等设备回来"的墙钟上限。设备重启会走一遍 USB 重新枚举，掉线重连也发生在
   同一个窗口里 —— 超过这个时间就认定它回不来了：关串口、明确告诉用户，
   而不是留一个死句柄在那儿假装还连着。 */
const LINK_WAIT_MS = 25000;

/* 等 bootloader 第一个 'C' 的墙钟上限。bootloader 的 'C' 是**周期**发的
   （周期见 DEV_C_TICK_MS：各产品固件一律 1 s），所以这个窗口必须按整数个
   周期给 —— 给 12 个。按亚秒节拍估出来的窗口，碰上节拍 1 s 的设备就只剩
   零头，会被误判成"设备没进升级模式"。 */
const BOOT_C_WAIT_MS = 12 * DEV_C_TICK_MS;

function upReset(){
  UP.aborted = false;
  UP.step = '';
  UP.steps = {};
  UP_STEPS.forEach(k => { UP.steps[k] = 'idle'; });
  UP.progress = null;
}

/* ------------------------------------------------------------------ *
 *  收起升级流程（弹层）
 *
 *  升级成功后必须调。renderGoCard() 的显示条件是
 *      UP.file || cardGo.dataset.open === '1'
 *  这两个都只进不退：UP.file 由 askUpgrade() 设定、dataset.open 由
 *  openUpgradeDialog() 置 '1'，跑完没人清 —— 于是 renderAll() 又把
 *  「确认升级」连同勾选框原样摆回来，看上去像"刚刷完又要你再确认一次"。
 * ------------------------------------------------------------------ */
function upClose(){
  UP.running = false;
  UP.aborted = false;
  UP.file = null;
  UP.entry = null;
  UP.errors = [];
  upReset();
  $('cardGo').dataset.open = '0';
  /* ★ 不要在这里碰 $('cardGo').hidden —— 面板的显隐归 #ovl 管，
     单独把面板藏掉会留下"遮罩还在、里面空了"的状态（还锁着页面滚动）。
     dataset.open 置 '0' 之后，调用方的 renderAll() 会把整个弹层收掉。 */
  /* 把内部两块面板复位成"下次打开就是干净的确认面板" */
  $('confirmBox').hidden = false;
  $('progBox').hidden = true;
  $('chkAck').checked = false;
  $('cfSummary').innerHTML = '';
  syncConfirmBtn();
}

/* 用户主动关掉升级弹层（取消键 / Esc / 点遮罩）。
   升级途中一律不关 —— 传到一半把弹层收掉会让用户以为可以走开，
   而设备还停在 bootloader 里等着。 */
function closeUpgradeDialog(){
  if(UP.running) return;
  UP.file = null;
  $('cardGo').dataset.open = '0';
  renderAll();
}

/* 升级成功后重算结论。设备刚重启，S.version 已由 waitAppVersion() 更新，
   这里只重算，不再多发帧请求 —— 否则 onCheck() 的"检查完成"toast 会把
   "升级成功"那条顶掉，用户根本看不到结果。 */
function refreshVerdictAfterUpgrade(){
  S.bootMode = false;
  S.devGone = false;
  const entry = CHK.entry || entryForModel(S.who);
  CHK.entry = entry;
  CHK.fw = entry ? latestFw(entry) : null;
  if(CHK.local)      CHK.verdict = deviceVerdictAgainst(CHK.local.header.version);
  else if(!entry)    CHK.verdict = 'nomodel';
  else               CHK.verdict = verdictOf(S.version, CHK.fw && CHK.fw.version);
  updateConnTip();
}
function stepSet(key, state){
  UP.steps[key] = state;
  UP.step = key;
  renderSteps();
}
function stepNote(key, text){
  UP.lastMsg = text || '';
  renderSteps();
}

/* 升级链路是否还活着。
   设备重启 / 掉线时 Web Serial 会把 port.readable 置 null（端口对象本身还在），
   此刻再往对端塞数据已经没有意义 —— Ymodem 会一路重试到墙钟耗尽，白等一分多钟。
   早一步认出来，早一步收场。 */
function linkAlive(){
  return !!(port && port.readable);
}

/* 升级中止后的统一收尾：把可能还挂着的串口关掉，并明确告诉用户。
   设备半路掉线时端口未必会自己关（readable 变 null，句柄还攥在手里），
   留着一个"看着连着、其实已经死了"的端口，用户再点「连接设备」只会得到
   "打不开 / 被占用"。 */
async function closePortAfterFail(){
  if(!port && !connected) return false;
  try{ await disconnect(true); }catch(e){}
  logLine('no', t('lgPortClosed'));
  return true;
}

/* ------------------------------------------------------------------ *
 *  runUpgrade() —— 唯一的升级入口
 * ------------------------------------------------------------------ */
async function runUpgrade(){
  if(UP.running || !UP.file) return;
  const hdr = UP.file.header;
  UP.running = true;
  UP.aborted = false;
  UP.t0 = Date.now();
  upReset();
  UP.progress = { sent:0, total:Math.ceil(hdr.fileSize / 1024), bytes:0,
                  bytesTotal:hdr.fileSize, rate:0, eta:0 };
  /* ★ 必须自己重画一次：升级全程没人再调 renderAll()，而
       · confirmBox / progBox 的显隐是由 renderGoCard() 决定的 —— 不画就是
         「确认框杵着不动、进度条从头到尾看不见」；
       · 各按钮的"升级中"禁用态是由 syncButtons() 决定的 —— 不画则取消键还亮着。
     一个 renderAll() 把这两件事一起办了，所以这里不必再逐个按钮去 disable。 */
  renderAll();
  logLine('no', t('lgUpStart', { f:UP.file.name, v:(hdr.version || '?') }));

  try{
    /* ---------- ① 进入升级模式 ---------- */
    stepSet('stEnter', 'active');
    const inBoot = !S.version;        /* 没版本 = 已经在 bootloader，不必再发指令 */
    if(inBoot){
      logLine('no', t('lgInBoot'));
      attachRaw();                    /* 端口还开着，直接切原始字节模式 */
      stepSet('stEnter', 'done');
      stepSet('stReopen', 'done');    /* 没有"重启等枚举"这一步，标成已完成免得看起来卡住 */
      UP.steps.stReopen = 'done';
    }else{
      const cmd = enterCmdFor(UP.entry && UP.entry.userString, S.vid, S.pid);
      /* 先切 raw 再发指令：设备收到后立刻复位，紧接着就是"USB 掉线"事件。
         若此时还是 frame 模式，disconnect 处理器会把它当成"用户拔线"——
         置 devGone、刷 UI、还去 close(chan)。raw 模式下它只记一行日志。 */
      attachRaw();
      logLine('tx', t('lgTxEnter', { c:hex(cmd) }));
      await writeBytes(cmd);
      stepSet('stEnter', 'done');

      /* 放掉端口 —— 设备马上要重启，攥着一个已失效的句柄反而打不开新枚举的它 */
      stepSet('stReopen', 'active');
      await releaseForUpgrade();
      await sleep(1500);              /* 复位 + USB 重新枚举大约 1 s 出头 */
      try{
        await reopenDevice(LINK_WAIT_MS);
      }catch(e){
        throw new Error('reopen-fail');
      }
    }

    /* ---------- ③ 等 bootloader 的 'C' ---------- */
    stepSet('stReopen', 'done');
    stepSet('stHandshake', 'active');
    if(!chan) attachRaw();
    if(!await chan.waitFor(0x43 /* 'C' */, BOOT_C_WAIT_MS)){
      throw new Error('no-handshake');
    }
    logLine('rx', t('lgCHandshake'));
    stepSet('stHandshake', 'done');

    /* ---------- ④ 传输 ---------- */
    stepSet('stSend', 'active');
    const base = String(UP.file.name || 'firmware.fpk').split(/[\\/]/).pop();
    await ymodemSend(hdr.bytes, base, {
      chan,
      write: writeBytes,
      log: logLine,
      onProgress: p => { UP.progress = p; renderProgress(); },
      aborted: () => UP.aborted,
      alive: linkAlive
    });
    logLine('no', t('lgTxDone', { n:hdr.fileSize }));
    stepSet('stSend', 'done');

    /* ---------- ⑤ 设备校验 + 跳转 ---------- */
    stepSet('stVerify', 'active');
    /* 设备此时在解包、验 CRC32、写应用分区、然后跳转。给它一点时间，
       别在它还没跳转时就去 open —— 那会打开到 bootloader 上。 */
    await sleep(2600);
    stepSet('stVerify', 'done');

    /* ---------- ⑥ 回读版本 ---------- */
    stepSet('stDone', 'active');
    const got = await waitAppVersion(30000);
    if(!got){
      stepSet('stDone', 'fail');
      throw new Error('verify-timeout');
    }
    if(verEqual(got, hdr.version)){
      stepSet('stDone', 'done');
      logLine('no', t('lgUpOk', { v:got }));
      $('btnUpCancel').disabled = true;
      upClose();                        /* 收起确认卡 */
      refreshVerdictAfterUpgrade();     /* 结论刷成「已是最新版本」 */
      renderAll();
      toast(t('upDone', { v:got }), 'ok');
      return;
    }
    stepSet('stDone', 'fail');
    UP.running = false;
    $('btnUpCancel').disabled = true;
    renderAll();
    toast(t('upDoneSame', { g:got, e:hdr.version }), 'bad');
    return;

  }catch(e){
    const msg = (e && e.message) || String(e);
    logLine('er', t('lgUpAbort', { e:msg }));
    if(msg === 'aborted'){
      try{ await writeBytes(new Uint8Array([PP.CAN, PP.CAN])); }catch(_){}
      if(UP.step) stepSet(UP.step, 'fail');
      toast(t('tUpCancel'), '');
    }else{
      if(UP.step) stepSet(UP.step, 'fail');
      toast(t('upFail', { e:upErrText(msg) }), 'bad');
    }
    UP.running = false;
    UP.aborted = false;
    $('btnUpCancel').disabled = true;
    /* 链路真的断了才关串口（掉线 / 重启没回来 / 端口失效）。握手失败这类
       "设备还在"的失败留着端口，用户可以直接重试，不必再走一遍连接。 */
    if(!linkAlive() || S.devGone) await closePortAfterFail();
    renderAll();
  }
}

/* 升级过程中的错误码 → 界面语言的人话（认不出来的就原样带出去）。 */
function upErrText(msg){
  const M = {
    'reopen-fail':'upErrReopen',
    'no-handshake':'upErrHandshake',
    'port-not-back':'upErrPortBack',
    'link-lost':'upErrLinkLost',
    'port-not-open':'upErrPortOpen',
    'verify-timeout':'upErrVerify',
    'cancelled-by-device':'upErrCancelByDev'
  };
  const key = String(msg).split(':')[0];
  return (M[key] ? t(M[key]) : msg) + '  [' + msg + ']';
}

/* ------------------------------------------------------------------ *
 *  升级后回读版本
 *
 *  设备跳转回应用后 USB 会再枚举一次，所以我们反复"开端口 → 发帧请求 →
 *  读不到就关掉重来"。中间会存在"打到了 bootloader 上"的短暂窗口 ——
 *  那几次请求它不会回，属于预期损耗，不是错误。
 * ------------------------------------------------------------------ */
async function waitAppVersion(totalMs){
  const t0 = Date.now();
  let first = true;
  while(Date.now() - t0 < totalMs){
    if(UP.aborted) return null;
    await sleep(first ? 2600 : 500); first = false;
    try{
      await reopenDevice(1800);
      attachFrame();
      await sleep(250);
      const f = await request(CMD.SYSTEM_VERSION, 900);
      if(f){
        const v = frameText(f);
        if(v){
          S.version = v;
          S.bootMode = false;
          updateConnTip();
          return v;
        }
      }
    }catch(e){ /* 端口还没回来 / 还被占着：下一轮再试 */ }
    await releaseForUpgrade();
  }
  return null;
}

/* ------------------------------------------------------------------ *
 *  升级二次确认：先只弹确认区，用户勾选后才真正开跑
 * ------------------------------------------------------------------ */
function askUpgrade(file, entry){
  UP.file = file;
  UP.entry = entry || null;
  upReset();
  $('confirmBox').hidden = false;
  $('progBox').hidden = true;
  $('btnUpConfirm').disabled = true;
  $('chkAck').checked = false;
  renderAll();
  /* 弹层里不需要 scrollIntoView（它本来就铺在视口中间），改成把焦点搬进来 ——
     键盘用户 Tab 一下就能到勾选框，读屏也会念出对话框标题。 */
  const panel = $('cardGo');
  if(panel && panel.focus) panel.focus();
}
"use strict";
/* ------------------------------------------------------------------ *
 *  固件目录（catalog）
 *
 *  设计目标：复访几乎不耗流量。
 *   · index.json           —— 走 HTTP 协商缓存：没变就是一个 304（几百字节）。
 *                             断网时由 Service Worker 回落到 Cache API 副本。
 *   · firmware/<name>.fpk  —— URL 里带版本（?v=…），内容一变 URL 就变；
 *                             一旦缓存，同版本永远不会再下载第二次。
 *   · 页面自己再存一份 index.json 到 localStorage —— 连 Cache API 都拿不到时
 *     （比如直接在 file:// 打开、或者 SW 还没接管页面）还能显示"上次已知的最新版"。
 *
 *  目录结构（firmware/index.json）：
 *  {
 *    "schema": 1,
 *    "updated": "2026-10-12",
 *    "devices": [{
 *      "model": "WeAct Studio PD Trigger V1",     // 设备回读的 WHO_AM_I，认设备的唯一依据
 *      "modelAlt": ["…"],                         // 同型号的其它写法（可选）
 *      "userString": "PDTRIGGERV1",               // fpk 包头水印，刷前校验用
 *      "name": { "zh": "…", "en": "…" },          // 展示名（可选）
 *      "maxRaw": 47088,                           // 可选：固件 raw_size 上限（分区容量）
 *      "firmware": [ { "file":"PDTrigger/x_V1.0.0.0_b39b242f.fpk",
 *                      "version":"V1.0.0.0_b39b242f",
 *                      "size":41216, "pkgCrc32":"B39B242F",
 *                      "released":"2026-10-12",
 *                      "notes": { "zh":"…", "en":"…" },
 *                      "latest": true } ]        // 省略时「数组第一项」即最新
 *    }]
 *  }
 * ------------------------------------------------------------------ */
const CAT_URL = 'firmware/index.json';
const CAT_LS_KEY = 'catalog';
/* 与 sw.js 里的 CACHE 必须一致 —— 页面手动预热时写的是同一个桶。 */
const SW_CACHE = 'weact-updater-v1';

const CAT = {
  doc:null,
  devices:[],
  source:'none',      /* net | cache | none */
  error:'',
  updated:'',
  local:null          /* { name, header } —— 用户手选的本地固件 */
};

/* 目录里的多语言字段：字符串 → 各语言通用；对象 → 按当前语言取，回落 en/zh。 */
function pickLang(v){
  if(v == null) return '';
  if(typeof v === 'string') return v;
  if(v[LANG] !== undefined) return v[LANG];
  if(v.en !== undefined) return v.en;
  if(v.zh !== undefined) return v.zh;
  const ks = Object.keys(v);
  return ks.length ? v[ks[0]] : '';
}

function normCatalog(raw){
  const out = [];
  const list = (raw && raw.devices) || [];
  for(const d of list){
    if(!d || !d.model) continue;
    const fw = Array.isArray(d.firmware) ? d.firmware.filter(f => f && f.file) : [];
    out.push({
      model:d.model,
      modelAlt:Array.isArray(d.modelAlt) ? d.modelAlt : [],
      userString:d.userString || '',
      name:d.name || null,
      maxRaw:(typeof d.maxRaw === 'number') ? d.maxRaw : 0,
      firmware:fw
    });
  }
  return out;
}

/* 取某个设备的"最新"固件：显式 latest:true 优先，否则数组第一项。 */
function latestFw(entry){
  if(!entry || !entry.firmware.length) return null;
  return entry.firmware.find(f => f.latest) || entry.firmware[0];
}
/* 固件条目的下载地址（相对本页目录）。带 ?v= 版本做缓存键 —— 版本一变 URL 就变，
   所以"文件名不许改、内容却换了"这种维护失误也不会让用户吃到旧固件。 */
function fwUrl(f){
  const v = f.version || f.pkgCrc32 || '';
  const base = 'firmware/' + String(f.file).replace(/^\/+/, '');
  return v ? (base + '?v=' + encodeURIComponent(v)) : base;
}

/* 按设备型号找目录条目（精确匹配；再退一步匹配 modelAlt）。 */
function entryForModel(model){
  if(!model) return null;
  return CAT.devices.find(d => d.model === model)
      || CAT.devices.find(d => d.modelAlt.includes(model))
      || null;
}

/* ------------------------------------------------------------------ *
 *  取目录
 *
 *  · 先请求网络（HTTP 协商，未变即 304）—— 成功就顺手存两份：Cache API 与
 *    localStorage。页面若尚未被 SW 接管，Cache API 那份就是唯一的离线兜底。
 *  · 网络失败（离线 / file:// 下 fetch 直接被拦）→ 依次回落到 Cache API、
 *    localStorage，并在界面上标明"这是缓存的旧清单"。
 *
 *  ★ 并发去重：初始化时已经在取，用户此时点「检查更新」又会调一次。
 *    若两次各发一份请求，`await loadCatalog()` 就只等了"第二次"，
 *    而第二次可能与第一次同时失败（或先后覆盖 CAT），于是 onCheck 在
 *    目录其实马上就到的情况下，抢先按"目录为空"判成 nomodel，
 *    界面上表现为"目录里没有登记这台设备"。共享同一次请求即可根治。
 * ------------------------------------------------------------------ */
let _catLoad = null;
async function loadCatalog(){
  if(_catLoad) return _catLoad;
  _catLoad = fetchCatalog();
  try{ return await _catLoad; }
  finally{ _catLoad = null; }
}

async function fetchCatalog(){
  let doc = null, source = 'none', err = '';

  const usable = (o) => o && Array.isArray(o.devices);

  try{
    const res = await fetch(CAT_URL, { cache:'default' });
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const txt = await res.text();
    const parsed = JSON.parse(txt);
    if(!usable(parsed)) throw new Error('bad-schema');
    doc = parsed; source = 'net';
    try{ LS.set(CAT_LS_KEY, JSON.stringify(parsed)); }catch(e){}
    /* 自己也往 Cache API 塞一份：SW 还没接管页面时，离线就靠它了。 */
    try{
      const c = await caches.open(SW_CACHE);
      await c.put(new Request(new URL(CAT_URL, location.href).href),
                  new Response(txt, { headers:{ 'Content-Type':'application/json' } }));
    }catch(e){}
  }catch(e){
    err = (e && e.message) || String(e);
  }

  if(!doc){
    try{
      const c = await caches.open(SW_CACHE);
      const hit = await c.match(new Request(new URL(CAT_URL, location.href).href));
      if(hit){
        const parsed = await hit.json();
        if(usable(parsed)){ doc = parsed; source = 'cache'; }
      }
    }catch(e){}
  }
  if(!doc){
    try{
      const raw = LS.get(CAT_LS_KEY, '');
      if(raw){
        const parsed = JSON.parse(raw);
        if(usable(parsed)){ doc = parsed; source = 'cache'; }
      }
    }catch(e){}
  }

  CAT.doc = doc;
  CAT.devices = doc ? normCatalog(doc) : [];
  CAT.source = source;
  CAT.error = err;
  CAT.updated = (doc && doc.updated) || '';
  renderAll();
  if(source === 'net') logLine('no', t('lgCatOk', { n:CAT.devices.length }));
  else if(source === 'cache') logLine('er', 'CATALOG FROM CACHE (' + err + ')');
  else logLine('er', 'CATALOG FAIL ' + err);
  return source;
}

"use strict";
/* ------------------------------------------------------------------ *
 *  界面渲染与事件
 *
 *  一条原则：所有 DOM 写操作都从这几个 render* 出来，事件回调只改状态再调
 *  renderAll()。这样"切语言/换设备/开始升级"三种时机下界面不会各写一套。
 * ------------------------------------------------------------------ */
const CHK = {
  verdict:'idle',     /* idle | checking | noconn | nocomp | nomodel | nover | unknown | latest | newer | diff | older */
  entry:null,         /* 目录里对应的设备条目 */
  fw:null,            /* 目录里的"最新固件"条目 */
  local:null,         /* { name, header } 用户手选的本地固件（优先于目录） */
  cache:null          /* 已下载解析过的固件，避免重复抓取 */
};

/* ------------------------------------------------------------------ *
 *  设备型号 → 固件水印的"猜法"
 *
 *  WHO_AM_I 给的是产品名（"WeAct Studio PD Trigger V1"），而 fpk 里要的是
 *  紧凑水印（PDTRIGGERV1）。目录里登记过的型号以目录为准；没登记时用这条
 *  规则猜一个，只用来做**提示与警告**，绝不当作硬判据 ——
 *  例："Display 0.96 FS" → DISPLAY096FS ✓、"Power Monitor Mini V1" → POWERMONITORMINIV1 ✗（真值 POWERMONITORMV1），
 *  所以猜错的代价必须只是"多一句提醒"，不能是"拦住不让你刷"。
 * ------------------------------------------------------------------ */
function guessUserString(model){
  const s = String(model || '').replace(/^WeAct\s+Studio\s+/i, '');
  if(!s) return '';
  const toks = s.split(/[^0-9A-Za-z.]+/).filter(Boolean).map(x => x.replace(/\./g, ''));
  const joined = toks.join('').toUpperCase();
  return DEVICE_TABLE.some(d => d.userString === joined) ? joined : '';
}

/* ------------------------------------------------------------------ *
 *  render*
 * ------------------------------------------------------------------ */
function renderAll(){
  renderStatus();
  renderDevice();
  renderCatalog();
  renderUpdate();
  renderGoCard();
  renderSteps();
  renderProgress();
  syncButtons();
}

function renderDevice(){
  const on = connected;
  $('dvModel').textContent = (on && S.who) ? S.who : '--';
  $('dvSn').textContent    = (on && S.serial) ? S.serial : '--';
  $('dvVer').textContent   = (on && S.version) ? S.version : (on && S.bootMode ? t('upNoVer') : '--');
  $('dvUsb').textContent   = (on && portIdText) ? portIdText : '--';
  $('devTag').textContent  = on ? (S.bootMode ? t('statusBootMode') : '') : t('noDevice');

  let match = '--';
  if(on){
    const e = entryForModel(S.who);
    if(e) match = e.userString + (e.name ? '  ·  ' + pickLang(e.name) : '');
    else {
      const g = guessUserString(S.who);
      match = g ? (g + '  ?') : (CHK.local ? CHK.local.header.userString : '--');
    }
  }
  $('dvMatch').textContent = match;
}

/* 取目录失败时的短标签。这里原先还挂着一长段"为什么 file:// 读不到本地 JSON"的
   说明（标题标签的 title + 空列表下方的 hint），用户反馈那是在给使用者讲原理，
   已删掉 —— 只留一个状态标签，不再解释成因。 */
function catErrInfo(e){
  if(!e) return { short:'', long:'' };
  const s = String(e);
  const proto = (location.protocol === 'file:');
  if(proto || /failed to fetch|networkerror|load failed|err_failed/i.test(s)){
    return { short:t('catErrProtoShort'), long:'' };
  }
  return { short:s, long:s };
}

function renderCatalog(){
  const src = { net:t('srcNet'), cache:t('srcCache'), none:t('srcNone') }[CAT.source] || t('srcNone');
  $('catSrc').textContent = CAT.local ? (t('srcLocal') + '  (' + src + ')') : src;
  $('catUpd').textContent = CAT.updated || '--';
  let n = 0;
  CAT.devices.forEach(d => { n += d.firmware.length; });
  $('catCnt').textContent = CAT.devices.length + ' / ' + n;
  const err = catErrInfo(CAT.error);
  $('catTag').textContent = err.short;
  $('catTag').title = err.long;
  renderCatList();
}

/* 收录明细：清单里有哪些设备、各自登记了什么固件。
   全部来自已经在本机的那份 index.json —— 不产生任何请求。
   当前插着的设备会高亮，维护方据此确认"我刚放的那份进来了没有"。 */
function renderCatList(){
  const box = $('catList');
  if(!box) return;

  if(!CAT.devices.length){
    const err = catErrInfo(CAT.error);
    box.innerHTML = '<div class="empty">' + esc(t('catNone')) + '</div>' +
      (err.long ? '<div class="hint">' + esc(err.long) + '</div>' : '');
    return;
  }

  const cur = (connected && S.who) ? entryForModel(S.who) : null;
  let s = '';
  for(const d of CAT.devices){
    const isCur = cur === d;
    s += '<div class="cit' + (isCur ? ' cur' : '') + '">';
    s += '<div class="ciname">' + esc(pickLang(d.name) || d.model);
    if(d.userString) s += '<span class="cu">' + esc(d.userString) + '</span>';
    if(isCur) s += '<span class="badge cur">' + esc(t('catBadgeCur')) + '</span>';
    s += '</div>';

    if(!d.firmware.length){
      s += '<div class="fwr"><span class="fmeta">' + esc(t('catNoFw')) + '</span></div>';
    }else{
      const last = latestFw(d);
      for(const f of d.firmware){
        const isLast = (f === last);
        const meta = [f.size ? fmtBytes(f.size) : '', f.released || ''].filter(Boolean).join('  ·  ');
        s += '<div class="fwr' + (isLast ? ' last' : '') + '">';
        if(isLast) s += '<span class="badge latest">' + esc(t('catBadgeLatest')) + '</span>';
        s += '<span class="fv">' + esc(f.version || '--') + '</span>';
        if(meta) s += '<span class="fmeta">' + esc(meta) + '</span>';
        s += '</div>';
      }
    }
    s += '</div>';
  }
  box.innerHTML = s;
}

/* 结论语义以**目标固件**为准（"目录里那份"相对"设备正跑着的"）：
 *   c < 0 —— 设备比目标旧 → 发现新版本（newer）
 *   c > 0 —— 设备比目标新 → 目录那份是回退（older）
 * 反过来写会让"设备旧、目录新"显示成"目录里的固件比设备更旧"，
 * 也就是明明该升级却告诉用户不用升，且升级按钮的语义全跟着反。 */
function verdictOf(deviceVer, targetVer){
  if(!deviceVer) return 'nover';
  if(!targetVer) return 'unknown';
  if(verEqual(deviceVer, targetVer)) return 'latest';
  const c = cmpVersion(deviceVer, targetVer);
  if(c === null) return 'unknown';
  return c < 0 ? 'newer' : (c > 0 ? 'older' : 'diff');
}

/* 当前生效的结论（本地固件优先，与 renderUpdate 同一套算法）。
   给按钮文案用 —— 必须在 renderUpdate 之外也能算，因为按钮状态在
   syncButtons 里统一收口，而那里不该依赖"upBody 刚被重画过"。 */
function curVerdict(){
  if(CHK.local) return verdictOf(S.version, CHK.local.header.version || '');
  return CHK.verdict;
}

function renderUpdate(){
  const box = $('upBody');
  const tag = $('upTag');
  tag.textContent = '';
  tag.className = 'tag';
  let html = '';

  /* 「重新刷入」只在**结论为「已是最新」**时露出来。
     其余情况要么会自动弹层（确实该刷），要么压根没有目标可刷。 */
  $('btnReflash').hidden = !(curVerdict() === 'latest' && !!(CHK.fw || CHK.local));

  if(CHK.verdict === 'checking'){
    box.innerHTML = '<div class="hint">' + esc(t('upChecking')) + '</div>';
    return;
  }
  if(!connected && CHK.verdict === 'idle'){
    box.innerHTML = '<div class="hint">' + t('upIdle') + '</div>';
    return;
  }

  /* 本地固件优先展示：用户手选的那一份就是"要刷的东西" */
  if(CHK.local){
    const h = CHK.local.header;
    html += localBlockHtml(h);
    renderVerdictInto(html, deviceVerdictAgainst(h.version));
    box.innerHTML = html;
    return;
  }
  if(CHK.verdict === 'nocomp' || CHK.verdict === 'nomodel'){
    box.innerHTML = '<div class="hint">' + t('upNoCatalog', { m:esc(S.who || '?') }) +
      '<br>' + t('btnLocal') + '</div>';
    return;
  }
  if(!CHK.fw){
    box.innerHTML = '<div class="hint">' + t('upIdle') + '</div>';
    return;
  }

  const h = CHK.fw;
  const v = verdictOf(S.version, h.version || '');
  /* 只有"已是最新"给安全色，其余（新版本/回退/同号异构建/读不到版本）一律警示色。
     之前按分支逐个赋值，漏掉了 nover / unknown —— 它们会退回无颜色的 'tag'。 */
  tag.className = (v === 'latest') ? 'tag ok' : 'tag warn';
  const head = {
    latest:['upLatest', 'upLatestSub', 'ok'],
    newer:['upNewer', 'upNewerSub', 'warn'],
    diff:['upDiff', 'upDiffSub', 'warn'],
    older:['upDowngrade', 'upDowngradeSub', 'warn'],
    nover:['upNoVer', '', 'warn'],
    unknown:['upDiff', '', 'warn']
  }[v] || ['upDiff', '', 'warn'];

  tag.textContent = t(head[0]);
  html += '<div class="verdict concl ' + head[2] + '">' + esc(t(head[0])) + '</div>';
  if(head[1]) html += '<div class="hint" style="margin-top:6px">' + esc(t(head[1])) + '</div>';
  html += '<div class="sep"></div>';
  html += kvRows([
    [t('upCur'), S.version || t('upNoVer'), true],
    [t('upNew'), h.version || '--', true],
    [t('upSize'), h.size ? fmtBytes(h.size) : '--', false],
    [t('upDate'), h.released || '--', false],
    [t('upNotes'), pickLang(h.notes) || '--', false]
  ]);
  box.innerHTML = html;
}

/* 目标版本与设备当前版本的对比结论（本地固件走这条） */
function deviceVerdictAgainst(targetVer){
  return verdictOf(S.version, targetVer || '');
}
function renderVerdictInto(html, v){
  const head = {
    latest:['upLatest', 'upLatestSub', 'ok'],
    newer:['upNewer', 'upNewerSub', 'warn'],
    diff:['upDiff', 'upDiffSub', 'warn'],
    older:['upDowngrade', 'upDowngradeSub', 'warn'],
    nover:['upNoVer', '', 'warn'],
    unknown:['upDiff', '', 'warn']
  }[v] || ['upNewer', '', 'warn'];
  $('upTag').textContent = t(head[0]);
  $('upTag').className = 'tag ' + (head[2] === 'ok' ? 'ok' : 'warn');
  $('upBody').innerHTML = html + '<div class="sep"></div><div class="verdict concl ' + head[2] + '">' +
    esc(t(head[0])) + '</div>' + (head[1] ? '<div class="hint" style="margin-top:6px">' + esc(t(head[1])) + '</div>' : '');
}

function localBlockHtml(h){
  const rows = [
    [t('upNew'), h.version || '--', true],
    [t('upSize'), fmtBytes(h.fileSize), false],
    ['fpk CRCs', 'pkg=' + hex8(h.pkgCrc32) + '  raw=' + hex8(h.rawCrc32), true],
    ['user_string', h.userString, true]
  ];
  return '<div class="verdict">' + esc(t('srcLocal')) + ': ' + esc(h.fileName) + '</div>' +
         '<div class="sep"></div>' + kvRows(rows);
}

function kvRows(rows){
  let s = '<div class="kv">';
  for(const [k, v, mono] of rows){
    s += '<div class="k">' + esc(k) + '</div><div class="v"' +
         (mono ? ' style="font-family:var(--mono)"' : '') + '>' + esc(v) + '</div>';
  }
  return s + '</div>';
}

/* ------------------------------------------------------------------ *
 *  升级弹层（确认 / 进度）
 * ------------------------------------------------------------------ */
function renderGoCard(){
  /* 显隐的真相在 #ovl 上，开合节拍仍由 cardGo.dataset.open / UP.file 决定 ——
     这样 09-upgrade.js 里那些置 dataset.open 的地方一个字都不用改。 */
  const open = !!(UP.file || $('cardGo').dataset.open === '1');
  $('ovl').hidden = !open;
  document.body.classList.toggle('ovl-open', open);
  if(!open) return;
  $('goTitle').textContent = UP.running ? t('stepTitle') : t('upConfirmTitle');
  $('confirmBox').hidden = !!UP.running;
  $('progBox').hidden = !UP.running;

  if(UP.running || !UP.file) return;

  const h = UP.file.header;
  const val = validateTarget(h);
  const rows = [
    [t('devModel'), S.who || '(?)', false],
    [t('devSn'), S.serial || '--', true],
    [t('upCur'), S.version || t('upNoVer'), true],
    [t('upNew'), h.version || '--', true],
    ['File', h.fileName + '  (' + fmtBytes(h.fileSize) + ')', true],
    ['pkg CRC32', hex8(h.pkgCrc32), true],
    ['raw CRC32', hex8(h.rawCrc32) + '  ·  raw ' + fmtBytes(h.rawSize), true],
    ['user_string', h.userString, true],
    ['part / head', h.partName + ' / ' + h.headSize + ' B', true]
  ];
  /* ★ 弹层把页面上的结论区盖住了，所以这里得自己把"这次是升级 / 回刷 / 降级"
     再说一遍 —— 只丢一堆键值让人自己比版本号，是很容易点错「开始升级」的。
     复用 upBody 那套 verdict 文案，不新增键。 */
  const vhead = {
    latest:['upLatest', 'ok'], newer:['upNewer', 'warn'], diff:['upDiff', 'warn'],
    older:['upDowngrade', 'warn'], nover:['upNoVer', 'warn'], unknown:['upDiff', 'warn']
  }[curVerdict()];
  let html = vhead
    ? '<div class="verdict concl ' + vhead[1] + '">' + esc(t(vhead[0])) + '</div>' +
      '<div class="sep"></div>'
    : '';
  html += kvRows(rows);
  for(const w of val.warnings) html += '<div class="vt-msg warn">⚠ ' + esc(w) + '</div>';
  for(const e of val.errors)   html += '<div class="vt-msg err">✕ ' + esc(e) + '</div>';
  $('cfSummary').innerHTML = html;
  UP.errors = val.errors;
  syncConfirmBtn();
}

/* 刷入前的目标校验。errors 会直接禁用"开始升级"按钮。 */
function validateTarget(h){
  const errors = [], warnings = [];
  const entry = CHK.entry;
  const expected = (entry && entry.userString) || guessUserString(S.who);

  if(expected && h.userString !== expected){
    if(entry) errors.push(t('valBadUser', { a:h.userString, b:expected }));
    else warnings.push(t('valWarnUser', { a:h.userString, b:expected }));
  }else if(!expected){
    warnings.push(t('valNoExpect'));
  }
  if(entry && entry.maxRaw && h.rawSize > entry.maxRaw){
    errors.push(t('valTooBig', { a:h.rawSize, b:entry.maxRaw }));
  }
  if(!parseVersion(h.version)) warnings.push(t('valBadVer'));
  if(!h.partName || h.partName !== 'app') warnings.push(t('valPartApp'));
  return { errors, warnings };
}
/* 校验文案见 i18n 的 valXxx —— 跟着界面语言走，别再往这儿塞中文常量。 */

/* ------------------------------------------------------------------ *
 *  步骤 / 进度
 * ------------------------------------------------------------------ */
function renderSteps(){
  const ol = $('stepList');
  if(!ol) return;
  let s = '';
  for(const k of UP_STEPS){
    const st = UP.steps[k] || 'idle';
    const ico = st === 'done' ? '✓' : (st === 'active' ? '⋯' : (st === 'fail' ? '✕' : '·'));
    s += '<li class="' + st + '"><span class="si">' + ico + '</span>' +
         '<span class="sl">' + esc(t(k)) + '</span></li>';
  }
  ol.innerHTML = s;
}

function renderProgress(){
  const p = UP.progress;
  const pct = p ? Math.min(100, Math.round(p.bytes / Math.max(1, p.bytesTotal) * 100)) : 0;
  $('progFill').style.width = pct + '%';
  $('progPct').textContent = pct + '%';
  if(p){
    const parts = [fmtBytes(p.bytes) + ' / ' + fmtBytes(p.bytesTotal)];
    if(p.total) parts.push(t('pktFmt', { n:p.sent, t:p.total }));
    if(p.rate) parts.push(t('speedFmt', { v:fmtBytes(Math.round(p.rate)) }));
    if(p.eta) parts.push(t('etaFmt', { t:fmtDur(p.eta) }));
    $('progInfo').textContent = parts.join('   ·   ');
  }else{
    $('progInfo').textContent = '';
  }
}

/* ------------------------------------------------------------------ *
 *  按钮可用性
 * ------------------------------------------------------------------ */
function syncButtons(){
  const busy = UP.running;
  const b = $('btnConn');
  b.textContent = connected ? t('btnDisconnect') : t('btnConnect');
  b.className = connected ? 'off' : 'primary';
  b.disabled = busy;

  const hasTarget = !!(CHK.fw || CHK.local);
  $('btnCheck').disabled = !connected || busy;
  /* 页面上只剩「检查更新」一个动作键（还有"已是最新"时那个「重新刷入」）。
     它的显示与否归 renderUpdate 管，这里只管可用性。 */
  $('btnReflash').disabled = !connected || busy || !hasTarget;
  $('btnRefresh').disabled = busy;
  $('btnLocal').disabled = busy;
  $('btnLocalClear').hidden = !CHK.local;
  $('btnLocalClear').disabled = busy;
  /* 取消按钮只在"确认阶段"有意义 —— 用来收起点错了的卡片。
     一旦开跑就锁死：传到一半断开会把设备留在 bootloader 里，这个口子不给用户开，
     升级中途的真掉线交给 upErrors + 关串口那条路去收场。
     进度面板里原先还有个同名的取消键，也一并去掉了。 */
  const goOpen = !$('ovl').hidden;
  $('btnUpCancel').disabled = !goOpen || busy;
}

/* ------------------------------------------------------------------ *
 *  动作
 * ------------------------------------------------------------------ */
async function onCheck(){
  if(!connected){ toast(t('tCheckNeedConn'), ''); return; }
  CHK.verdict = 'checking';
  renderUpdate();
  if(!CAT.devices.length) await loadCatalog();
  await readDeviceInfo();
  S.bootMode = !S.version;

  const entry = entryForModel(S.who);
  const f = entry ? latestFw(entry) : null;
  CHK.entry = entry; CHK.fw = f; CHK.cache = null;
  if(CHK.local){
    CHK.verdict = deviceVerdictAgainst(CHK.local.header.version);
  }else if(!entry){
    CHK.verdict = 'nomodel';
  }else{
    CHK.verdict = verdictOf(S.version, f && f.version);
  }
  renderAll();
  if(CHK.verdict !== 'nomodel') toast(t('tCheckOk'), 'ok');
  /* 判定"确实该刷"就直接把确认弹层摆出来 —— 省掉原先那一步「立即升级」。
     「已是最新」与"目录里没这个型号"都不弹，留在页面上就好。 */
  if(needFlashPrompt()) await openUpgradeDialog();
}

/* 下载并解析清单里的固件（下载后由 SW 缓存，第二次不再耗流量） */
async function loadFirmware(f){
  const url = fwUrl(f);
  if(CHK.cache && CHK.cache.url === url) return CHK.cache.fpk;
  logLine('no', 'GET ' + url);
  const res = await fetch(url, { cache:'default' });
  if(!res.ok) throw new Error('HTTP ' + res.status);
  const buf = await res.arrayBuffer();
  const fpk = parseFpk(buf, String(f.file).split('/').pop());
  if(!fpk.ok) throw new Error(fpk.errors.map(fpkErrText).join(t('errSep')));
  if(f.size && fpk.fileSize !== f.size){
    logLine('er', t('lgSizeMismatch', { a:fpk.fileSize, b:f.size }));
    toast(t('valSizeMismatch', { a:fpk.fileSize, b:f.size }), 'bad');
  }
  if(f.pkgCrc32 && hex8(fpk.pkgCrc32) !== String(f.pkgCrc32).toLowerCase().replace(/^0x/, '')){
    logLine('er', t('lgCrcMismatch'));
  }
  CHK.cache = { url, fpk };
  return fpk;
}

/* 「立即升级」：到这一步才真正下载固件（检查更新阶段只看清单里的版本号，不下载） */
/* ------------------------------------------------------------------ *
 *  打开升级弹层
 *
 *  两个入口都走这里：
 *    ① onCheck() 判定"确实该刷"时自动调用；
 *    ② 结论为「已是最新」时，用户点页面上的「重新刷入」。
 *  固件来源二选一：手选的本地文件优先，否则从目录里取（要下载 + 校验）。
 * ------------------------------------------------------------------ */
async function openUpgradeDialog(){
  if(UP.running) return;
  const f = CHK.fw && !CHK.local ? CHK.fw : null;
  let fpk = CHK.local ? CHK.local : null;
  if(!fpk && f){
    $('btnCheck').disabled = true;
    try{
      fpk = { name:String(f.file).split('/').pop(), header:await loadFirmware(f) };
    }catch(e){
      toast(t('tCatFail', { e:(e && e.message) || e }), 'bad');
      return;
    }finally{
      renderAll();                  /* 无论成败都把「检查更新」放回可用态 */
    }
  }
  if(!fpk) return;
  const val = validateTarget(fpk.header);
  if(val.errors.length){
    toast(val.errors[0], 'bad');
    logLine('er', t('lgTargetBad', { e:val.errors.join(t('errSep')) }));
    return;
  }
  $('cardGo').dataset.open = '1';
  askUpgrade(fpk, CHK.entry);
}

/* 检查完之后要不要直接把确认弹层摆出来。
   ★ 「已是最新」不弹 —— 只是想看看版本号，被一个刷机确认窗扑脸很烦；
     那种情况页面上留了「重新刷入」。没有目标（目录里没这个型号 / 没选本地
     固件）也没什么可弹的。 */
const FLASH_VERDICTS = ['newer', 'older', 'diff', 'nover', 'unknown'];
function needFlashPrompt(){
  return !!(CHK.fw || CHK.local) && FLASH_VERDICTS.indexOf(curVerdict()) >= 0;
}

async function onLocalFile(file){
  if(!file) return;
  try{
    const buf = await file.arrayBuffer();
    const hdr = parseFpk(buf, file.name);
    if(!hdr.ok) throw new Error(hdr.errors.map(fpkErrText).join('；'));
    CHK.local = { name:file.name, header:hdr };
    CHK.cache = null;
    logLine('no', 'LOCAL ' + file.name + '  ' + hdr.version);
    toast(t('tCatLocal', { f:file.name }), 'ok');
    renderAll();
  }catch(e){
    CHK.local = null;
    toast(t('tCatLocalBad', { e:(e && e.message) || e }), 'bad');
    renderAll();
  }
}
"use strict";
/* ------------------------------------------------------------------ *
 *  初始化 + 事件接线
 *
 *  语言与主题都是「本地有存档就用存档，没有才问系统」——用户手动选过的一定优先。
 * ------------------------------------------------------------------ */
LANG = LS.get('lang', sysLang());
/* 构建产物里 I18N 只有一种语言，落到 'zh' 可能落到不存在的键上 —— 落到实际加载的那一种。 */
if(!I18N[LANG]) LANG = Object.keys(I18N)[0] || 'zh';
LANGS.forEach(l => $('langSel').add(new Option(l.name, l.code)));
$('langSel').value = LANG;
buildThemeSelect();
applyTheme();
applyStaticI18n();
renderAll();

/* 注册 Service Worker 并接线「安装到桌面」按钮。
   放在这儿是有意的：initInstall() 里要读 t() 的文案，得等语言定下来。 */
initInstall();

if(FEATURES_OK){
  loadCatalog();                 /* 目录不阻塞界面：先渲染，回来了再刷 */
}else{
  showBanner();
  $('btnConn').disabled = true;
}

/* ------------------------------------------------------------------ *
 *  事件
 * ------------------------------------------------------------------ */
$('btnConn').addEventListener('click', () => { connect(); });
$('btnCheck').addEventListener('click', onCheck);
/* 「重新刷入」：只在结论为「已是最新」时可见（那种情况不自动弹层）。
   它不再重新检查一遍 —— 结论刚算过，直接开弹层即可。 */
$('btnReflash').addEventListener('click', () => { openUpgradeDialog(); });

$('btnRefresh').addEventListener('click', async () => {
  const s = await loadCatalog();
  toast(s === 'net' ? t('tCatNet') : (s === 'cache' ? t('tCatCache') : t('tCatFail', { e:CAT.error })), s === 'net' ? 'ok' : '');
});
$('btnLocal').addEventListener('click', () => $('fileLocal').click());
$('fileLocal').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';          /* 清空，允许重复选同一个文件 */
  onLocalFile(f);
});
$('btnLocalClear').addEventListener('click', () => {
  CHK.local = null; CHK.cache = null;
  toast(t('tCatLocalClear'), '');
  renderAll();
});

$('chkAck').addEventListener('change', syncConfirmBtn);
$('btnUpConfirm').addEventListener('click', () => {
  if(!$('chkAck').checked){ toast(t('tUpNeedAck'), 'bad'); return; }
  runUpgrade();
});
/* 关掉升级弹层：取消键 / Esc / 点遮罩，三条都收在 closeUpgradeDialog() 里，
   它内部对"升级中"做了拦截 —— 升级途中这些入口一律不生效。
   升级中途的真掉线不走这里，由 09-upgrade.js 的失败收尾统一关串口 + 提示。 */
$('btnUpCancel').addEventListener('click', closeUpgradeDialog);
$('ovlBg').addEventListener('click', closeUpgradeDialog);
document.addEventListener('keydown', (e) => {
  if(e.key !== 'Escape') return;
  if($('ovl').hidden) return;
  closeUpgradeDialog();
});

$('btnClearLog').addEventListener('click', () => { $('log').innerHTML = ''; });

$('langSel').addEventListener('change', () => {
  /* 升级途中不给换语言：构建产物里「换语言 = 刷一次页面」（见下），刷下去就把
     升级打断、设备留在 bootloader 里。先把下拉拨回去。 */
  if(UP.running){ $('langSel').value = LANG; return; }

  const want = $('langSel').value;
  LS.set('lang', want);

  /* build.py 把字典拆成 4 个单语言文件，首屏只下发用户实际需要的那一种 ——
     所以 dist 里本页字典只装了一种语言，切到没加载过的语言会只剩键名。
     存档已写好，刷新一次首屏加载器就会下发正确的那一本。
     （源目录 4 本字典全内联，I18N[want] 必然存在，走不到这条。） */
  if(!I18N[want]){ location.reload(); return; }

  LANG = want;
  applyStaticI18n();
  /* 下拉框里的 option 是 JS 生成的（不是 data-i18n），换语言必须重建一次，
     否则「跟随系统 / 深色 / 浅色」会停在上一种语言。 */
  buildThemeSelect();
  renderAll();                  /* 动态文案（版本结论、状态行、按钮禁用态）也要跟着重画 */
});
$('themeSel').addEventListener('change', () => {
  LS.set('theme', $('themeSel').value);
  applyTheme();
});

/* 勾选框与"校验无错误"共同决定能不能点开始 */
function syncConfirmBtn(){
  const errs = (UP.errors || []).length;
  $('btnUpConfirm').disabled = !$('chkAck').checked || errs > 0;
}
