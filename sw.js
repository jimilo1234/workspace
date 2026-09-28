// 支付行业新闻 · Service Worker（Web Push 接收端）
// 部署位置：站点根目录 /sw.js（GitHub Pages 项目页 workspace/ 下）
self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

// 收到服务端（Edge Function）推送 → 弹系统通知（页面关着也能收到）
self.addEventListener('push', function (event) {
  var data = { title: '支付行业新闻', body: '收到一条新消息' };
  try { if (event.data) { var j = event.data.json(); if (j && typeof j === 'object') data = j; } } catch (_) {}
  var title = data.title || '支付行业新闻';
  var options = {
    body: data.body || '',
    tag: data.tag || 'paynews-new',
    renotify: false,
    data: { url: data.url || './' },
    requireInteraction: false
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// 点击通知 → 聚焦已有窗口，否则打开页面
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
      for (var i = 0; i < clients.length; i++) {
        var c = clients[i];
        if ('focus' in c) { try { c.postMessage({ type: 'paynews-focus' }); } catch (_) {} return c.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
