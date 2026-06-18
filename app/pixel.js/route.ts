export const PIXEL_SCRIPT = `(function () {
  var scriptEl = document.currentScript || (function () { var s = document.getElementsByTagName("script"); return s[s.length - 1]; })();
  var writeKey = scriptEl && scriptEl.getAttribute("data-write-key");
  var origin = "";
  try { origin = new URL(scriptEl.src).origin; } catch (e) { origin = ""; }
  var endpoint = origin + "/api/v1/collect";
  if (!writeKey) return;

  function uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === "x" ? r : (r & 0x3) | 0x8; return v.toString(16);
    });
  }
  function aid() {
    try {
      var k = "_los_aid", v = localStorage.getItem(k);
      if (!v) { v = uuid(); localStorage.setItem(k, v); }
      return v;
    } catch (e) {
      var m = document.cookie.match(/(?:^|; )_los_aid=([^;]+)/);
      if (m) return m[1];
      var nv = uuid(); document.cookie = "_los_aid=" + nv + "; path=/; max-age=31536000"; return nv;
    }
  }
  function send(body) {
    body.writeKey = writeKey; body.anonymousId = aid();
    var json = JSON.stringify(body);
    try { if (navigator.sendBeacon) { navigator.sendBeacon(endpoint, json); return; } } catch (e) {}
    try { fetch(endpoint, { method: "POST", body: json, keepalive: true, headers: { "content-type": "text/plain" } }); } catch (e) {}
  }
  function utmFrom(search) {
    var utm = {}, q = new URLSearchParams(search);
    q.forEach(function (val, key) { if (key.indexOf("utm_") === 0) utm[key] = val; });
    return utm;
  }
  function page() {
    var q = new URLSearchParams(location.search);
    send({ type: "page", url: location.href, referrer: document.referrer || "", utm: utmFrom(location.search), campaignId: q.get("los_campaign") || q.get("utm_campaign") || undefined });
  }
  function track(event, valueCents, metadata) { send({ type: "track", event: event, valueCents: valueCents, metadata: metadata || {} }); }
  function identify(arg, traits) {
    var body = { type: "identify", traits: traits || {} };
    if (typeof arg === "string") body.email = arg;
    else if (arg) { body.email = arg.email; body.contactId = arg.contactId; if (arg.traits) body.traits = arg.traits; }
    send(body);
  }
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f || f.tagName !== "FORM" || f.hasAttribute("data-los-ignore")) return;
    track("form_submit", undefined, { id: f.id || "", name: f.getAttribute("name") || "", action: f.getAttribute("action") || "" });
    var email = f.querySelector("input[type=email]");
    if (email && email.value) identify(email.value);
  }, true);

  var existing = window.launchos && window.launchos.q;
  window.launchos = { track: track, identify: identify, page: page };
  if (existing && existing.length) { existing.forEach(function (a) { var m = a.shift(); if (window.launchos[m]) window.launchos[m].apply(null, a); }); }
  page();
})();`;

export async function GET(): Promise<Response> {
  return new Response(PIXEL_SCRIPT, {
    status: 200,
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
