// Visitor analytics: Google Analytics 4 and Meta Pixel, loaded only when their IDs are set in admin Settings.
// Pages report events with (window.lpq ||= []).push([name, data]) using GA4 names and fields:
//   view_item, add_to_cart, begin_checkout, purchase  ->  { value, currency, items: [{ item_id, item_name, item_variant, price, quantity }], transaction_id }
(() => {
  const META_EVENTS = { view_item: "ViewContent", add_to_cart: "AddToCart", begin_checkout: "InitiateCheckout", purchase: "Purchase" };

  function load(src) {
    const s = document.createElement("script");
    s.async = true;
    s.src = src;
    document.head.appendChild(s);
  }

  function start({ ga, pixel }) {
    if (ga) {
      window.dataLayer = window.dataLayer || [];
      window.gtag = function () { window.dataLayer.push(arguments); };
      window.gtag("js", new Date());
      window.gtag("config", ga);
      load("https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(ga));
    }
    if (pixel) {
      const fbq = window.fbq = function () { fbq.callMethod ? fbq.callMethod.apply(fbq, arguments) : fbq.queue.push(arguments); };
      if (!window._fbq) window._fbq = fbq;
      fbq.push = fbq; fbq.loaded = true; fbq.version = "2.0"; fbq.queue = [];
      fbq("init", pixel);
      fbq("track", "PageView");
      load("https://connect.facebook.net/en_US/fbevents.js");
    }

    function send([name, data = {}]) {
      if (ga) window.gtag("event", name, data);
      if (pixel && META_EVENTS[name]) {
        const items = data.items || [];
        window.fbq("track", META_EVENTS[name], {
          value: data.value, currency: data.currency || "INR", content_type: "product",
          content_ids: items.map(i => String(i.item_id)),
          contents: items.map(i => ({ id: String(i.item_id), quantity: i.quantity })),
          num_items: items.reduce((n, i) => n + (i.quantity || 0), 0),
        }, data.transaction_id ? { eventID: data.transaction_id } : undefined);
      }
    }

    // Send what the page queued before we were ready, then send new events straight away
    const queued = window.lpq || [];
    window.lpq = { push: send };
    queued.forEach(send);
  }

  // IDs are cached for the browser session so each page view doesn't call the server
  let ids = null;
  try { ids = JSON.parse(sessionStorage.getItem("lp_site")); } catch { /* storage unavailable */ }
  if (ids) { if (ids.ga || ids.pixel) start(ids); return; }
  fetch("/api/site").then(r => (r.ok ? r.json() : null)).then(d => {
    if (!d) return;
    try { sessionStorage.setItem("lp_site", JSON.stringify(d)); } catch { /* storage unavailable */ }
    if (d.ga || d.pixel) start(d);
  }).catch(() => { /* analytics is optional */ });
})();
