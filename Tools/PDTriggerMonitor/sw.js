/* Service Worker —— 只干两件事。
 *
 *  ① 让这个页面「可安装」：Chrome 的安装性检查要求站点存在一个**带 fetch 处理器**
 *     的 Service Worker（manifest 与 HTTPS 另两条由 manifest.json 和服务器负责）。
 *  ② 装好之后离线也能打开：所有资源本来就在本机跑（Web Serial 直连串口），
 *     没有理由因为断网就打不开。
 *
 *  刻意**不做预缓存清单**：源目录与 dist 的文件名不一样（dist 带内容 hash），
 *  写死清单就得让构建脚本生成两份不同的 sw.js。改成运行时缓存 —— 页面第一次
 *  访问时用到什么就存什么，同一份文件在两种目录结构下都对。
 *
 *  作用域天然限定在本目录（SW 脚本所在目录），不会接管同域下别的应用。
 */

const CACHE = 'pdtrigger-v1';
/* 本应用目录。SW 里 self.location 是脚本自身的 URL，'./' 就是它所在的目录。 */
const BASE = new URL('./', self.location).href;

self.addEventListener('install', function(){
  /* 不预缓存任何东西，装完立刻进入待命 —— 首次访问不该被 SW 拖慢 */
  self.skipWaiting();
});

self.addEventListener('activate', function(e){
  e.waitUntil((async function(){
    /* 换掉旧版本号留下的缓存。同版本号下不清理：文件名带内容 hash，
       旧条目不会被误读，留着反而让离线回退更全。 */
    const keys = await caches.keys();
    await Promise.all(keys.filter(function(k){ return k !== CACHE; })
                           .map(function(k){ return caches.delete(k); }));
    await self.clients.claim();
  })());
});

/* 存进 Cache 之前把 content-encoding / content-length 摘掉。
   fetch() 交给我们的 body 已经是**解压后**的，但响应头还标着 gzip ——
   原样存下去，回放时浏览器会再解一次，报 ERR_CONTENT_DECODING_FAILED。
   服务器（OSS/CDN）会对 HTML、JS 做 gzip，所以这一步是必须的。 */
async function stash(req, res){
  const h = new Headers(res.headers);
  h.delete('content-encoding');
  h.delete('content-length');
  const buf = await res.arrayBuffer();
  const out = new Response(buf, { status: res.status, statusText: res.statusText, headers: h });
  try {
    const c = await caches.open(CACHE);
    await c.put(req, out.clone());
  } catch (e) { /* 配额满之类，缓存失败不影响本次响应 */ }
  return out;
}

self.addEventListener('fetch', function(e){
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  /* 只管本域本目录。跨域资源（将来若要引外部库）交给浏览器自己处理，
     免得把不该缓存的东西缓存下来。 */
  if (url.origin !== self.location.origin) return;
  if (url.href.indexOf(BASE) !== 0) return;

  /* 导航请求（打开页面）：网络优先 —— 有新版本要能立刻拿到，断网才回缓存。 */
  if (req.mode === 'navigate') {
    e.respondWith((async function(){
      try {
        return await stash(req, await fetch(req));
      } catch (err) {
        const c = await caches.open(CACHE);
        return (await c.match(req)) || (await c.match(BASE)) || Response.error();
      }
    })());
    return;
  }

  /* 资源请求：缓存优先 —— dist 里文件名带内容 hash，内容一变名字就变，
     永远不会读到脏数据；源目录（无 hash）下开发时刷一下也就更新了。 */
  e.respondWith((async function(){
    const c = await caches.open(CACHE);
    const hit = await c.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') return await stash(req, res);
      return res;
    } catch (err) {
      return Response.error();
    }
  })());
});
