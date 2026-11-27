const V='xuong-chu-v20';
const FILES=['./','./index.html','./manifest.webmanifest','./cau-mau.js','./cau-mau-2.js','./assets/bia-1.jpg','./assets/bia-2.jpg','./assets/bia-3.jpg','./assets/bia-4.jpg','./assets/bia-5.jpg','./assets/fonts/Lato-Black.ttf','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;
  e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(V).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request).then(m=>m||caches.match('./index.html'))))});
