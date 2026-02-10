// public/sw.js
self.addEventListener('push', function(event) {
  const data = event.data.json();
  const options = {
    body: data.body,
    icon: '/icon.png', // optional
  };
  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});