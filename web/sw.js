// 这个 Service Worker 已经停用，只负责把自己和旧缓存清理掉。
//
// 为什么去掉：它会把旧版本的 app.js 缓存下来继续发给页面，
// 导致「代码明明改了却不生效」，排查起来还特别隐蔽（一度给页面返回了 index.html）。
// 这个应用本来就是从本机服务器 / Electron 内部加载的，文件就在硬盘上，
// 再套一层缓存没有收益，只有风险。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('vc-')) await caches.delete(k);      // 只删自己的，模型缓存留着
    }
    await self.clients.claim();
    await self.registration.unregister();
    for (const c of await self.clients.matchAll()) c.navigate(c.url);
  })());
});
