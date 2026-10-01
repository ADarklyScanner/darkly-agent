// Minimal service worker so Chrome treats Nessari as an installable app (full screen, home-screen icon).
// It doesn't cache anything: the robot's own server is always on the same phone.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
