(async () => {
  // Safety net: never leave fade-in sections invisible, even if loading fails or is slow
  setTimeout(() => document.querySelectorAll(".reveal").forEach(el => el.classList.add("in")), 1200);

  const PAGE = 12;

  // Approximate display rates; orders are charged in INR.
  const FX = {
    INR: { r: 1, s: "₹", d: 0 },
    USD: { r: 1 / 88, s: "$", d: 2 },
    GBP: { r: 1 / 118, s: "£", d: 2 },
    CAD: { r: 1 / 64, s: "C$", d: 2 },
  };
  const CAT_ORDER = ["offers", "chilli", "podis", "masalas", "pickles", "essentials"];
  const STATUS_STEPS = ["new", "confirmed", "packed", "shipped", "delivered"];
  const STATUS_TEXT = { new: "Order placed", confirmed: "Confirmed", packed: "Packed", shipped: "Shipped", delivered: "Delivered", cancelled: "Cancelled" };

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

  let accessToken = null; // Supabase session token of the logged-in customer
  async function api(path, opts = {}) {
    const headers = opts.body ? { "Content-Type": "application/json" } : {};
    if (accessToken) headers.Authorization = "Bearer " + accessToken;
    const res = await fetch("/api" + path, {
      ...opts,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
    return data;
  }

  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem("lp_" + k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("lp_" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  /* ---------- Where this visitor came from (kept from the first visit; sent with the order) ---------- */
  const touch = (() => {
    const q = new URLSearchParams(location.search);
    let host = "";
    try { if (document.referrer && !document.referrer.startsWith(location.origin)) host = new URL(document.referrer).hostname.replace(/^(www|m|l|lm)\./, ""); } catch { /* bad referrer */ }
    const fromSite = [[/google\./, "google", "organic"], [/instagram\.com/, "instagram", "referral"], [/(facebook|fb)\.com/, "facebook", "referral"],
      [/youtube\.com|youtu\.be/, "youtube", "referral"], [/whatsapp/, "whatsapp", "referral"], [/bing\.|duckduckgo\.|yahoo\./, "search", "organic"]]
      .find(([re]) => re.test(host));
    let source, medium;
    if (q.get("utm_source")) { source = q.get("utm_source"); medium = q.get("utm_medium") || ""; }
    else if (q.get("gclid")) { source = "google"; medium = "cpc"; }
    else if (q.get("fbclid")) { source = /instagram/.test(host) ? "instagram" : "facebook"; medium = "social"; }
    else if (fromSite) { source = fromSite[1]; medium = fromSite[2]; }
    else if (host) { source = host; medium = "referral"; }
    else { source = "direct"; medium = ""; }
    const now = { source: source.toLowerCase().slice(0, 40), medium: medium.toLowerCase().slice(0, 40), campaign: (q.get("utm_campaign") || "").slice(0, 80),
      link: (q.get("lp_link") || "").slice(0, 40), referrer: (document.referrer || "").slice(0, 300), landing: (location.pathname + location.search).slice(0, 300),
      at: new Date().toISOString() };
    // Keep the first source; a "direct" first visit is replaced by the first real one
    let first = store.get("first_touch");
    const isNewSource = !first || (first.source === "direct" && now.source !== "direct");
    if (isNewSource) { first = now; store.set("first_touch", first); }
    if (now.source !== "direct" || !store.get("last_touch")) store.set("last_touch", now);
    let visitor = store.get("visitor");
    if (!visitor) { visitor = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); store.set("visitor", visitor); }
    if (isNewSource) api("/visit", { method: "POST", body: { visitor, ...first } }).catch(() => { /* best effort */ });
    // Tidy the address bar so shared links don't carry our tags
    if (["utm_source", "utm_medium", "utm_campaign", "lp_link", "gclid", "fbclid"].some(k => q.has(k))) {
      ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "lp_link", "gclid", "fbclid"].forEach(k => q.delete(k));
      history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : "") + location.hash);
    }
    return { first: () => store.get("first_touch", first), last: () => store.get("last_touch", now) };
  })();

  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  /* ---------- Load catalogue ---------- */
  let catalog;
  try {
    catalog = await api("/catalog");
  } catch {
    $("#grid").innerHTML = `<p class="muted">We couldn't load the products. Please refresh the page.</p>`;
    return;
  }
  const P = catalog.products;
  const CATS = catalog.categories;
  const S = catalog.settings;
  const byId = Object.fromEntries(P.map(p => [p.id, p]));
  const variantById = {};
  P.forEach(p => p.v.forEach(v => { variantById[v.id] = { p, v }; }));

  // Analytics events (sent by js/analytics.js when Google Analytics / Meta Pixel are set up); values are always in rupees
  const track = (name, data) => (window.lpq = window.lpq || []).push([name, { currency: "INR", ...data }]);
  const gaItem = (p, v, qty) => ({ item_id: v.id, item_name: p.t, item_variant: v.t, price: v.p, quantity: qty });
  const cartGaItems = () => state.cart.map(l => gaItem(variantById[l.vid].p, variantById[l.vid].v, l.q));

  // Cart lines are { vid, q }; drop lines whose size no longer exists
  const state = {
    cat: "all", mild: false, sort: "featured", shown: PAGE,
    currency: store.get("currency", "INR"),
    cart: store.get("cart2", []).filter(l => variantById[l.vid]),
    wish: store.get("wish", []).filter(id => byId[id]),
    sel: {},
    qty: {}, // quantity chosen on each product card
    coupon: null, // { code, discount }
    subscribe: 0, // repeat every N days (subscribe & save)
  };

  const img = u => u || "";
  const money = inr => {
    const c = FX[state.currency] || FX.INR;
    return c.s + (inr * c.r).toLocaleString(state.currency === "INR" ? "en-IN" : "en-US", { minimumFractionDigits: c.d, maximumFractionDigits: c.d });
  };
  const rupees = n => "₹" + Number(n).toLocaleString("en-IN");
  const selVariant = p => p.v[state.sel[p.id] ?? Math.max(0, p.v.findIndex(v => v.a))] || p.v[0];
  const inStock = p => p.v.some(v => v.a);
  const stars = n => "★★★★★".slice(0, Math.round(n)) + "☆☆☆☆☆".slice(0, 5 - Math.round(n));
  const catName = id => (CATS.find(c => c.id === id) || {}).name || "";
  const heartSvg = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.5-9.3C1 8 3.4 4.5 7 4.5c2 0 3.6 1.1 5 3 1.4-1.9 3-3 5-3 3.6 0 6 3.5 4.5 7.2C19.5 16.4 12 21 12 21z"/></svg>';

  /* ---------- Store-wide settings into the page ---------- */
  function applySettings() {
    const wa = `https://wa.me/${S.whatsapp}`;
    $$("[data-wa]").forEach(a => { a.href = a.dataset.wa ? `${wa}?text=${encodeURIComponent(a.dataset.wa)}` : wa; });
    $$("[data-fssai]").forEach(el => { el.textContent = el.dataset.fssai.replace("{n}", S.fssai); });
    $$("[data-social]").forEach(a => {
      const url = S[a.dataset.social];
      if (url) a.href = url; else a.hidden = true;
    });
  }

  /* ---------- Categories ---------- */
  function renderCategories() {
    $("#catGrid").innerHTML = CATS.map(c => {
      const n = P.filter(p => p.c === c.id).length;
      if (!n) return "";
      return `<button class="cat reveal in" data-cat="${esc(c.id)}">
        <img src="${esc(img(c.cover || P.find(p => p.c === c.id)?.img))}" alt="${esc(c.name)}" loading="lazy" />
        <span class="cat-label"><strong>${esc(c.name)}</strong><small>${n} products</small></span>
      </button>`;
    }).join("");
  }

  /* ---------- Festive offers (home page) ---------- */
  function renderOffers() {
    const offers = P.filter(p => p.c === "offers");
    $("#offers").hidden = !offers.length;
    if (!offers.length) return;
    $("#offersTitle").textContent = catName("offers") || "Festive Offers";
    $("#offersText").textContent = S.offersText || "";
    $("#offerGrid").innerHTML = offers.map(p => `<article class="offer-card">
      <div class="ph" data-quick="${p.id}"><img src="${esc(img(p.img))}" alt="${esc(p.t)}" loading="lazy" /><span class="quick">View details</span></div>
      <div class="tb"><h3>${esc(p.t)}</h3>${buyBlock(p, { showCat: false })}</div>
    </article>`).join("");
  }

  /* ---------- Featured row: the chilli powders ---------- */
  function renderTrial() {
    const trial = P.filter(p => p.c === "chilli");
    $("#trial").hidden = !trial.length;
    $("#trialRow").innerHTML = trial.map(p => {
      const v = selVariant(p);
      return `<article class="trial-card">
        <div class="ph" data-quick="${p.id}"><img src="${esc(img(p.img))}" alt="${esc(p.t)}" loading="lazy" /></div>
        <div class="tb">
          <h3>${esc(p.t.split(" / ")[0])}</h3>
          ${buyBlock(p)}
        </div>
      </article>`;
    }).join("");
  }

  // Price with paise, e.g. ₹350.00 (other currencies already show 2 decimals)
  const price2 = inr => state.currency === "INR" ? "₹" + Number(inr).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : money(inr);
  const qtyOf = id => state.qty[id] || 1;

  function buyBlock(p, { showCat = true, heart = false } = {}) {
    const v = selVariant(p);
    const ok = inStock(p);
    return `
      ${showCat ? `<p class="pcat">${esc(catName(p.c))}${p.m ? " · 🌶️ Spicy" : ""}</p>` : ""}
      <span class="price">${price2(v.p)}</span>
      ${p.v.length === 1 && p.v[0].t === "Pack" ? "" : `<div class="sizes" style="--n:${p.v.length}">${p.v.map((x, idx) =>
        `<button class="size ${x === v ? "active" : ""}" data-variant="${p.id}:${idx}" ${x.a ? "" : "disabled"}>${esc(x.t)}</button>`).join("")}</div>`}
      <div class="buy${heart ? " with-heart" : ""}">
        <div class="stepper"><button data-pq="${p.id}:-1" aria-label="Decrease quantity">−</button><span>${qtyOf(p.id)}</span><button data-pq="${p.id}:1" aria-label="Increase quantity">+</button></div>
        <button class="atc" data-add="${p.id}" ${ok ? "" : "disabled"}>${ok ? `<span class="atc-long">Add to cart</span><span class="atc-short">🛒 Add</span>` : "Sold out"}</button>
        ${heart ? `<button class="buy-heart ${state.wish.includes(p.id) ? "on" : ""}" data-wish="${p.id}" aria-label="Add to wishlist" title="Wishlist">${heartSvg}</button>` : ""}
      </div>`;
  }

  // Refresh one product's selected size and price everywhere it is shown, without rebuilding cards
  function updateCard(id) {
    const p = byId[id], v = selVariant(p);
    $$(`[data-variant^="${id}:"]`).forEach(b => b.classList.toggle("active", Number(b.dataset.variant.split(":")[1]) === p.v.indexOf(v)));
    $$(`[data-add="${id}"]`).forEach(b => {
      const box = b.closest(".card, .trial-card, .offer-card");
      const pr = box && box.querySelector(".price");
      if (pr) pr.textContent = price2(v.p);
    });
  }

  /* ---------- Shop ---------- */
  function renderTabs() {
    const all = [{ id: "all", name: "All items" }, ...CATS];
    $("#tabs").innerHTML = all.map(c => {
      const n = c.id === "all" ? P.length : P.filter(p => p.c === c.id).length;
      if (!n) return "";
      return `<button class="tab ${state.cat === c.id ? "active" : ""}" data-tab="${esc(c.id)}" role="tab">${esc(c.name)}<small>${n}</small></button>`;
    }).join("");
  }

  function filtered() {
    let list = P.filter(p =>
      (state.cat === "all" || p.c === state.cat) &&
      (!state.mild || !p.m));
    const price = p => selVariant(p).p;
    if (state.sort === "featured") {
      const catRank = c => { const i = CAT_ORDER.indexOf(c); return i < 0 ? 50 : i; };
      list = [...list].sort((a, b) =>
        (state.cat === "all" ? catRank(a.c) - catRank(b.c) : 0) || (a.pin ?? 999) - (b.pin ?? 999));
    }
    if (state.sort === "low") list = [...list].sort((a, b) => price(a) - price(b));
    if (state.sort === "high") list = [...list].sort((a, b) => price(b) - price(a));
    if (state.sort === "az") list = [...list].sort((a, b) => a.t.localeCompare(b.t));
    return [...list.filter(inStock), ...list.filter(p => !inStock(p))];
  }

  function cardHtml(p, i) {
    const v = selVariant(p);
    const ok = inStock(p);
    const wished = state.wish.includes(p.id);
    return `<article class="card" style="animation-delay:${(i % PAGE) * 35}ms">
      <div class="ph" data-quick="${p.id}">
        <img src="${esc(img(p.img))}" alt="${esc(p.t)}" loading="lazy" />
        <div class="tags">${p.m ? '<span class="tag spicy">🌶️ Spicy</span>' : ""}${ok ? "" : '<span class="tag out">Sold out</span>'}</div>
        <span class="quick">Quick view</span>
        <button class="heart ${wished ? "on" : ""}" data-wish="${p.id}" aria-label="Add to wishlist">${heartSvg}</button>
      </div>
      <div class="body">
        <h3><span class="vegdot ${p.nv ? "nv" : ""}" title="${p.nv ? "Non-veg" : "Veg"}"></span>${esc(p.t)}</h3>
        ${p.r ? `<span class="rating" title="${p.r.avg} out of 5">${stars(p.r.avg)} <small>(${p.r.n})</small></span>` : ""}
        ${buyBlock(p)}
      </div>
    </article>`;
  }

  function renderGrid() {
    const list = filtered();
    $("#grid").innerHTML = list.slice(0, state.shown).map(cardHtml).join("");
    $("#resultCount").textContent = `Showing ${Math.min(state.shown, list.length)} of ${list.length} products`;
    $("#loadMore").classList.toggle("hidden", state.shown >= list.length);
  }

  function setCat(cat) {
    state.cat = cat;
    state.shown = PAGE;
    renderTabs();
    renderGrid();
    showActiveTab();
  }

  // Phones: slide the category row so the chosen one is in view
  function showActiveTab() {
    const row = $("#tabs"), t = row && row.querySelector(".tab.active");
    if (!t || row.scrollWidth <= row.clientWidth) return;
    row.scrollLeft = Math.max(0, t.offsetLeft - row.offsetLeft - (row.clientWidth - t.offsetWidth) / 2);
  }

  // Phones: after picking a category further down the page, go back to the start of its products
  function toShopTop() {
    if (innerWidth > 900) return;
    const lay = $(".shop-layout"), head = $(".header");
    const y = lay.getBoundingClientRect().top + scrollY - (head ? head.offsetHeight : 64);
    if (scrollY > y + 10) window.scrollTo({ top: y, behavior: "instant" });
  }

  /* ---------- Quick view + reviews ---------- */
  async function openQuick(id) {
    const p = byId[id];
    const v = selVariant(p);
    const ok = inStock(p);
    const pics = [p.img, ...(p.g || [])].filter(Boolean);
    $("#modalBody").innerHTML = `<div class="qv">
      <div class="qv-img">
        <div class="qv-main"><img id="qvMain" src="${esc(img(pics[0]))}" alt="${esc(p.t)}" />${pics.length > 1 ? `<button type="button" class="qv-nav prev" data-step="-1" aria-label="Previous photo">‹</button><button type="button" class="qv-nav next" data-step="1" aria-label="Next photo">›</button><span class="qv-count" id="qvCount">1 / ${pics.length}</span>` : ""}</div>
        ${pics.length > 1 ? `<div class="qv-thumbs">${pics.map((u, i) => `<button type="button" class="${i ? "" : "active"}" data-pic="${i}" aria-label="Photo ${i + 1}"><img src="${esc(img(u))}" alt="" loading="lazy" /></button>`).join("")}</div>` : ""}
      </div>
      <div class="qv-info">
        <p class="eyebrow">${esc(catName(p.c))}${p.m ? " · 🌶️ Spicy" : ""}</p>
        <h2>${esc(p.t)}</h2>
        ${p.r ? `<span class="rating">${stars(p.r.avg)} <small>${p.r.avg} · ${p.r.n} review${p.r.n > 1 ? "s" : ""}</small></span>` : ""}
        <div class="qv-buy">${buyBlock(p, { showCat: false, heart: true })}</div>
        <p class="qv-desc">${esc(p.d || "Sun-dried and slow-ground in small batches. 100% natural: no colours, preservatives or chemicals.")}</p>
        <p class="qv-share"><button type="button" class="linkish" data-share="${esc(p.h)}">🔗 Share this product</button></p>
        <div class="qv-related" id="qvRelated" hidden></div>
        <details class="qv-rev"><summary>Reviews &amp; write a review</summary>
        <div class="reviews" id="reviews"><h4>Reviews</h4><p class="muted">Loading…</p></div>
        <form class="form review-form" id="reviewForm" data-product="${p.id}">
          <h4>Write a review</h4>
          <div class="star-pick" role="radiogroup" aria-label="Rating">
            ${[5, 4, 3, 2, 1].map(n => `<label><input type="radio" name="rating" value="${n}" ${n === 5 ? "checked" : ""} /><span>★</span></label>`).join("")}
          </div>
          <input name="name" id="revName" required maxlength="60" placeholder="Your name" />
          <textarea name="text" id="revText" required minlength="5" maxlength="1000" rows="3" placeholder="How did you like it?"></textarea>
          ${auth.user ? `<label class="rev-photo">📷 Add a photo (optional)<input type="file" id="revPhoto" accept="image/jpeg,image/png,image/webp" /></label>`
            : `<small class="muted">Log in to add a photo and get a “Verified buyer” badge.</small>`}
          <button class="btn btn-outline" type="submit">Submit review</button>
        </form>
        </details>
      </div>
    </div>`;
    // Photo gallery: thumbnails, previous/next buttons and swipe on touch screens
    const thumbs = $(".qv-thumbs"), main = $(".qv-main");
    let cur = 0;
    const show = i => {
      cur = (i + pics.length) % pics.length;
      $("#qvMain").src = img(pics[cur]);
      $("#qvCount").textContent = `${cur + 1} / ${pics.length}`;
      thumbs.querySelectorAll("button").forEach((x, n) => {
        x.classList.toggle("active", n === cur);
        if (n === cur) x.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    };
    if (thumbs) {
      thumbs.onclick = e => { const b = e.target.closest("[data-pic]"); if (b) show(+b.dataset.pic); };
      main.onclick = e => { const b = e.target.closest("[data-step]"); if (b) show(cur + +b.dataset.step); };
      let x0 = null, y0 = 0;
      main.addEventListener("touchstart", e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
      main.addEventListener("touchend", e => {
        if (x0 === null) return;
        const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
        x0 = null;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) show(cur + (dx < 0 ? 1 : -1));
      });
    }
    openModal("modal");
    try {
      const list = await api(`/products/${id}/reviews`);
      $("#reviews").innerHTML = `<h4>Reviews</h4>` + (list.length
        ? list.map(r => `<div class="review"><b>${esc(r.name)}</b> <span class="rating">${stars(r.rating)}</span>${r.verified ? ` <span class="verified">✓ Verified buyer</span>` : ""}<p>${esc(r.text)}</p>${r.photo ? `<a href="${esc(r.photo)}" target="_blank" rel="noopener"><img class="rev-img" src="${esc(r.photo)}" alt="Photo from ${esc(r.name)}" loading="lazy" /></a>` : ""}</div>`).join("")
        : `<p class="muted">No reviews yet. Be the first to share your experience.</p>`);
    } catch { $("#reviews").hidden = true; }
    loadRelated(id);
  }

  async function loadRelated(id) {
    try {
      const list = (await api(`/products/${id}/related`)).filter(x => byId[x.id] && inStock(byId[x.id]));
      const box = $("#qvRelated");
      if (!box || !list.length || !$("#modal").classList.contains("show")) return;
      const together = list.some(x => x.together);
      box.innerHTML = `<h4>${together ? "Customers also bought" : "You may also like"}</h4><div class="rel-row">${list.map(x => {
        const q = byId[x.id];
        return `<button type="button" class="rel" data-quick="${q.id}"><img src="${esc(img(q.img))}" alt="" loading="lazy" /><span>${esc(q.t)}</span><small>${money(selVariant(q).p)}</small></button>`;
      }).join("")}</div>`;
      box.hidden = false;
    } catch { /* optional extra */ }
  }

  // Shrink a photo in the browser before upload (max 1280px, JPEG)
  function shrinkPhoto(file) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => {
        const k = Math.min(1, 1280 / Math.max(im.width, im.height));
        const c = document.createElement("canvas");
        c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
        c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
        URL.revokeObjectURL(im.src);
        resolve(c.toDataURL("image/jpeg", 0.85));
      };
      im.onerror = () => reject(new Error("That photo couldn't be read. Try a JPG or PNG."));
      im.src = URL.createObjectURL(file);
    });
  }

  function openModal(id) { $("#" + id).classList.add("show"); $("#" + id).setAttribute("aria-hidden", "false"); }
  function closeModal(id) { $("#" + id).classList.remove("show"); $("#" + id).setAttribute("aria-hidden", "true"); }

  /* ---------- Cart & wishlist ---------- */
  // Each browser gets a random cart id so the shop can follow up on carts left without ordering
  const newCartId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
  let cartId = store.get("cartId", null);
  if (!cartId) { cartId = newCartId(); store.set("cartId", cartId); }
  let syncTimer;
  function syncCart() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      api("/cart", { method: "POST", body: { cartId, items: cartItems() } }).catch(() => { /* best effort */ });
    }, 1500);
  }

  function save() {
    syncCart();
    store.set("cart2", state.cart);
    store.set("wish", state.wish);
  }

  function addToCart(id) {
    const p = byId[id];
    const v = selVariant(p);
    const line = state.cart.find(l => l.vid === v.id);
    const n = qtyOf(id);
    if (line) line.q = Math.min(50, line.q + n);
    else state.cart.push({ vid: v.id, q: n });
    state.qty[id] = 1;
    state.coupon = null;
    save();
    renderCart();
    track("add_to_cart", { value: v.p * n, items: [gaItem(p, v, n)] });
    bump("#cartCount");
    toast(`Added ${n} × ${p.t} to cart`);
    $$(`[data-pq="${id}:1"]`).forEach(b => { b.parentElement.querySelector("span").textContent = 1; });
  }

  function toggleWish(id) {
    const i = state.wish.indexOf(id);
    if (i >= 0) state.wish.splice(i, 1);
    else state.wish.push(id);
    save();
    $$(`[data-wish="${id}"]`).forEach(b => {
      b.classList.toggle("on", i < 0);
      if (b.classList.contains("btn")) b.textContent = i < 0 ? "♥ In wishlist" : "♡ Wishlist";
    });
    renderWish();
    bump("#wishCount");
    toast(i < 0 ? "Saved to wishlist ♥" : "Removed from wishlist");
  }

  function bump(sel) {
    const key = sel === "#cartCount" ? "cart" : "wish";
    $$(`${sel}, [data-badge="${key}"]`).forEach(b => {
      b.classList.remove("bump");
      void b.offsetWidth;
      b.classList.add("bump");
    });
  }

  function setBadge(sel, n) {
    const key = sel === "#cartCount" ? "cart" : "wish";
    $$(`${sel}, [data-badge="${key}"]`).forEach(el => { el.textContent = n; el.classList.toggle("show", n > 0); });
  }

  const subtotal = () => state.cart.reduce((s, l) => s + variantById[l.vid].v.p * l.q, 0);
  const region = () => $("#shipTo").value;

  // Shipping by weight (same rules as server/shipping.js): "250 g" -> 250, "1 kg" -> 1000, no weight -> 500 g
  const gramsOf = label => { const m = String(label).match(/(\d+(?:\.\d+)?)\s*(kgs?|grams?|grms?|gms?|g)\b/i); return m ? Math.round(parseFloat(m[1]) * (/^k/i.test(m[2]) ? 1000 : 1)) : null; };
  const cartGrams = () => state.cart.reduce((t, l) => t + (gramsOf(variantById[l.vid].v.t) ?? 500) * l.q, 0);
  const weightCharge = grams => { for (const [limit, price] of S.shipping.tiers || []) if (grams <= limit) return price; return 0; };

  function totals() {
    const sub = subtotal();
    const discount = state.subscribe && S.subscribe ? Math.floor(sub * S.subscribe.percent / 100) : state.coupon ? state.coupon.discount : 0;
    const r = region();
    let shipping = r === "intl" ? 0 : S.shipping.byWeight ? weightCharge(cartGrams()) : r === "india" ? S.shipping.india : S.shipping.aptg;
    if (S.shipping.freeAbove > 0 && sub - discount >= S.shipping.freeAbove) shipping = 0;
    return { sub, discount, shipping, total: sub - discount + shipping };
  }

  function renderCart() {
    const count = state.cart.reduce((s, l) => s + l.q, 0);
    setBadge("#cartCount", count);
    $("#cartCount2").textContent = count;
    $("#cartPanel").innerHTML = state.cart.length
      ? state.cart.map((l, i) => {
        const { p, v } = variantById[l.vid];
        return `<div class="line">
          <img src="${esc(img(p.img))}" alt="" />
          <div><h4>${esc(p.t)}</h4><small>${esc(v.t)} · ${money(v.p)}</small>
            <div class="qty"><button data-qty="${i}:-1" aria-label="Decrease">−</button><span>${l.q}</span><button data-qty="${i}:1" aria-label="Increase">+</button></div>
            ${v.a ? "" : '<small class="err">Sold out. Please remove.</small>'}
          </div>
          <div class="right"><strong>${money(v.p * l.q)}</strong><br /><button class="rm" data-rm="${i}">Remove</button></div>
        </div>`;
      }).join("")
      : `<div class="empty"><div>🧺</div><p>Your cart is empty.<br />Go on, add a little Guntur heat.</p></div>`;
    renderTotals();
    $("#checkoutBtn").disabled = !state.cart.length;
  }

  function renderTotals() {
    const t = totals();
    const intl = region() === "intl";
    $("#totals").innerHTML = `
      <div class="total-row sm"><span>Subtotal</span><span>${money(t.sub)}</span></div>
      ${t.discount ? `<div class="total-row sm ok"><span>${state.subscribe ? `Subscription ${S.subscribe.percent}% off` : `Coupon ${esc(state.coupon.code)}`}</span><span>−${money(t.discount)}</span></div>` : ""}
      <div class="total-row sm"><span>Shipping</span><span>${intl ? "Confirmed on WhatsApp" : t.shipping ? money(t.shipping) : "Free"}</span></div>
      <div class="total-row"><span>Total</span><strong>${money(t.total)}</strong></div>`;
    const kg = (cartGrams() / 1000).toLocaleString("en-IN", { maximumFractionDigits: 2 });
    const lastKg = S.shipping.byWeight && S.shipping.tiers.length ? S.shipping.tiers[S.shipping.tiers.length - 1][0] / 1000 : 0;
    const weightNote = S.shipping.byWeight && state.cart.length ? ` Order weight ${kg} kg.${lastKg ? ` Free shipping above ${lastKg} kg.` : ""}` : "";
    const notes = {
      aptg: "Delivered across Andhra Pradesh & Telangana in 3–6 business days." + weightNote,
      india: "Delivered in 5–9 business days." + weightNote,
      intl: "We'll confirm the shipping cost and payment on WhatsApp.",
    };
    $("#shipNote").textContent = notes[region()];
  }

  // A friend's referral link (?ref=CODE) fills the coupon box
  function prefillReferral() {
    const ref = store.get("ref", "");
    if (ref && !state.coupon && !$("#couponInput").value) $("#couponInput").value = ref;
  }

  async function applyCoupon(e) {
    e.preventDefault();
    const code = $("#couponInput").value.trim();
    if (!code) return;
    try {
      const r = await api("/coupons/check", { method: "POST", body: { code, items: cartItems(), region: region() } });
      state.coupon = { code: r.code, discount: r.discount };
      toast(`Coupon applied: you save ${rupees(r.discount)}`);
    } catch (err) {
      state.coupon = null;
      toast(err.message);
    }
    renderTotals();
  }

  function renderWish() {
    setBadge("#wishCount", state.wish.length);
    $("#wishCount2").textContent = state.wish.length;
    $("#wishPanel").innerHTML = state.wish.length
      ? state.wish.map(id => {
        const p = byId[id], v = selVariant(p);
        return `<div class="line">
          <img src="${esc(img(p.img))}" alt="" />
          <div><h4>${esc(p.t)}</h4><small>${esc(v.t)} · ${money(v.p)}</small></div>
          <div class="right"><button class="add" data-add="${id}" ${inStock(p) ? "" : "disabled"}>+ Add</button><br /><button class="rm" data-wish="${id}">Remove</button></div>
        </div>`;
      }).join("")
      : `<div class="empty"><div>💛</div><p>No favourites yet.<br />Tap the heart on any product to save it.</p></div>`;
  }

  function openDrawer(panel) {
    $$(".drawer-tabs button").forEach(b => b.classList.toggle("active", b.dataset.panel === panel));
    $("#cartPanel").classList.toggle("hidden", panel !== "cart");
    $("#wishPanel").classList.toggle("hidden", panel !== "wish");
    $("#cartFoot").classList.toggle("hidden", panel !== "cart");
    $("#drawer").classList.add("open");
    $("#drawer").setAttribute("aria-hidden", "false");
    $("#overlay").classList.add("show");
  }
  function closeDrawer() {
    $("#drawer").classList.remove("open");
    $("#drawer").setAttribute("aria-hidden", "true");
    $("#overlay").classList.remove("show");
    $("#nav").classList.remove("open");
  }

  /* ---------- Shipping region from the PIN code (no message shown; the server uses the same rule) ---------- */
  function regionFromPin(pin) {
    pin = String(pin || "").trim();
    if (!/^[1-8]\d{5}$/.test(pin) || region() === "intl") return;
    const r = +pin.slice(0, 2) >= 50 && +pin.slice(0, 2) <= 53 ? "aptg" : "india";
    if (region() !== r) { $("#shipTo").value = r; state.coupon = null; renderTotals(); $("#checkoutTotal").textContent = money(totals().total); }
  }

  /* ---------- Checkout ---------- */
  const cartItems = () => state.cart.map(l => ({ variantId: l.vid, qty: l.q }));

  function openCheckout() {
    if (S.loginRequired && !auth.user) {
      auth.afterLogin = openCheckout;
      openLogin("Log in to place your order. We'll email you a code.");
      return;
    }
    const intl = region() === "intl" && S.intlViaWhatsapp;
    const opts = [];
    if (!intl && S.onlinePayment) opts.push(["online", "Pay online", "UPI, cards, net banking (Razorpay)"]);
    if (!intl && S.cod) opts.push(["cod", "Cash on delivery", "Pay when your order arrives"]);
    if (!state.subscribe && (intl || !opts.length)) opts.push(["whatsapp", "Confirm on WhatsApp", "We'll share shipping cost and payment details"]);
    $("#subscribeWrap").hidden = !(auth.user && S.subscribe && !intl);
    $("#subscribeNote").textContent = S.subscribe ? `Save ${S.subscribe.percent}% on every order. We'll place it automatically; skip, pause or cancel any time in My account.${state.coupon ? " (Replaces your coupon.)" : ""}` : "";
    $("#payOptions").innerHTML = opts.map(([v, t, d], i) =>
      `<label class="pay-opt"><input type="radio" name="payment" value="${v}" ${i === 0 ? "checked" : ""} /><span><b>${t}</b><small>${d}</small></span></label>`).join("");
    $("#checkoutTotal").textContent = money(totals().total);
    const saved = { ...store.get("customer", {}), ...(auth.profile || {}) };
    for (const [k, v] of Object.entries(saved)) { const el = $(`#checkoutForm [name="${k}"]`); if (el && !el.value && v) el.value = v; }
    if (saved.address && !saved.house && !$("#coHouse").value) fillAddress(saved.address);
    const emailEl = $("#coEmail");
    if (auth.user?.email) { emailEl.value = auth.user.email; emailEl.readOnly = true; } else emailEl.readOnly = false;
    $("#saveAddrWrap").hidden = !auth.user;
    if (!$("#checkout").classList.contains("show")) {
      loadSavedAddresses();
      if ($("#coPin").value) regionFromPin($("#coPin").value);
    }
    openModal("checkout");
    track("begin_checkout", { value: totals().total, items: cartGaItems() });
  }

  let savedAddresses = [];
  async function loadSavedAddresses() {
    const box = $("#savedAddr");
    box.hidden = true;
    if (!auth.user) return;
    try { savedAddresses = await api("/me/addresses"); } catch { savedAddresses = []; }
    if (!savedAddresses.length) return;
    box.innerHTML = `<small class="muted">Deliver to a saved address:</small><div class="addr-chips">${savedAddresses.map(a =>
      `<button type="button" class="addr-chip" data-addr="${a.id}"><b>${esc(a.label || a.name)}</b><small>${esc(a.city)} ${esc(a.pincode)}</small></button>`).join("")}</div>`;
    box.hidden = false;
  }
  function useAddress(id) {
    const a = savedAddresses.find(x => x.id === id);
    if (!a) return;
    const f = $("#checkoutForm");
    f.name.value = a.name; f.phone.value = a.phone; fillAddress(a.address); f.city.value = a.city; f.pin.value = a.pincode;
    f.addrLabel.value = a.label;
    $$(".addr-chip").forEach(b => b.classList.toggle("active", +b.dataset.addr === id));
    regionFromPin(a.pincode);
  }
  // Re-check payment options after the PIN code changes (cash on delivery may not be offered there)
  function refreshPayOptions() {
    if (!$("#checkout").classList.contains("show")) return;
    const chosen = $("#checkoutForm").payment?.value;
    openCheckout();
    if (chosen) { const r = $(`#payOptions input[value="${chosen}"]`); if (r) r.checked = true; }
  }

  // Address in separate boxes, sent to the shop as one line: "House, Street, Area, Near Landmark"
  const joinAddress = f => [f.house, f.street, f.area, f.landmark ? "Near " + f.landmark : ""].map(x => String(x || "").trim()).filter(Boolean).join(", ");
  function fillAddress(full) {
    const f = $("#checkoutForm");
    const parts = String(full || "").split(/,\s*/);
    const near = parts.length > 3 && /^near /i.test(parts[parts.length - 1]) ? parts.pop().replace(/^near /i, "") : "";
    f.house.value = parts[0] || ""; f.street.value = parts[1] || ""; f.area.value = parts.slice(2).join(", "); f.landmark.value = near;
  }

  let razorpayLoaded;
  function loadRazorpay() {
    razorpayLoaded ||= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://checkout.razorpay.com/v1/checkout.js";
      s.onload = resolve;
      s.onerror = () => { razorpayLoaded = null; reject(new Error("Couldn't load the payment window. Check your internet and try again.")); };
      document.head.appendChild(s);
    });
    return razorpayLoaded;
  }

  async function placeOrder(form) {
    const btn = $("#placeBtn");
    const f = Object.fromEntries(new FormData(form));
    const address = joinAddress(f);
    const customer = { name: f.name, phone: f.phone, email: f.email, address, city: f.city, pin: f.pin, note: f.note };
    store.set("customer", { name: f.name, phone: f.phone, email: f.email, house: f.house, street: f.street, area: f.area, landmark: f.landmark, address, city: f.city, pin: f.pin });
    btn.disabled = true;
    btn.textContent = "Placing order…";
    try {
      const items = cartGaItems();
      const order = await api("/orders", {
        method: "POST",
        body: { cartId, items: cartItems(), region: region(), coupon: state.subscribe ? undefined : state.coupon?.code, paymentMethod: f.payment, customer,
          gift: { on: Boolean(f.gift), message: f.giftMessage || "" },
          subscribe: state.subscribe ? { every: state.subscribe } : undefined,
          saveAddress: auth.user && f.saveAddr ? { label: f.addrLabel || "" } : undefined,
          heardFrom: f.heard || "", attribution: { first: touch.first(), last: touch.last() } },
      });
      order.items = items;
      if (order.razorpay) {
        // The order now exists, so empty the cart: paying again must not create a second order
        clearCart();
        try { await payOnline(order); } catch (err) { orderPending(order, err.message); return; }
      }
      orderDone(order);
    } catch (err) {
      if (/log in/i.test(err.message)) { auth.afterLogin = openCheckout; openLogin(err.message); }
      else toast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Place order";
    }
  }

  async function payOnline(order) {
    await loadRazorpay();
    return new Promise((resolve, reject) => {
      const rp = new window.Razorpay({
        key: order.razorpay.key,
        order_id: order.razorpay.orderId,
        amount: order.razorpay.amount,
        currency: "INR",
        name: "Truchilli",
        description: `Order ${order.code}`,
        prefill: { name: order.razorpay.name, contact: order.razorpay.phone, email: order.razorpay.email },
        theme: { color: "#4a230c" },
        handler: async resp => {
          try {
            await api("/payments/verify", { method: "POST", body: { code: order.code, ...resp } });
            order.paid = true;
            resolve();
          } catch (e) { reject(e); }
        },
        modal: {
          ondismiss: () => reject(new Error(`Payment not completed. Your order ${order.code} is saved; you can pay again or contact us on WhatsApp.`)),
        },
      });
      rp.on("payment.failed", r => reject(new Error(r.error?.description || "Payment failed. Please try again.")));
      rp.open();
    });
  }

  function clearCart() {
    state.subscribe = 0;
    $("#coSubscribe").value = "";
    cartId = newCartId();
    store.set("cartId", cartId);
    state.cart = [];
    state.coupon = null;
    save();
    renderCart();
    closeModal("checkout");
    closeDrawer();
  }

  function orderDone(order) {
    clearCart();
    track("purchase", { transaction_id: order.code, value: order.total, items: order.items || [] });
    const how = { online: "Payment received. Thank you!", cod: "Pay in cash when your order arrives.", whatsapp: "Send us the order on WhatsApp so we can confirm shipping and payment." }[order.paymentMethod];
    $("#successBody").innerHTML = `
      <div class="success-ic">✓</div>
      <h3>Order placed!</h3>
      <p>Your order number is</p>
      <p class="order-code">${esc(order.code)}</p>
      <p class="muted">${esc(how)} Total: <b>${rupees(order.total)}</b></p>
      <div class="success-actions">
        <a class="btn btn-primary" target="_blank" rel="noopener" href="https://wa.me/${S.whatsapp}?text=${encodeURIComponent(order.message)}">Send order on WhatsApp</a>
        <button class="btn btn-outline" type="button" data-track-code="${esc(order.code)}">Track this order</button>
      </div>`;
    openModal("success");
  }

  // Online orders whose payment was closed or failed: { code: { phone, items } }, so "Pay now" can retry
  const unpaid = {};

  function orderPending(order, reason) {
    unpaid[order.code] = { phone: order.razorpay.phone, items: order.items };
    $("#successBody").innerHTML = `
      <div class="success-ic warn">!</div>
      <h3>Payment not completed</h3>
      <p class="muted">${esc(reason)}</p>
      <p>Your order number is</p>
      <p class="order-code">${esc(order.code)}</p>
      <p class="muted">Your order is saved. Pay now to confirm it. Total: <b>${rupees(order.total)}</b></p>
      <div class="success-actions">
        <button class="btn btn-primary" type="button" data-pay-code="${esc(order.code)}">Pay ${rupees(order.total)} now</button>
        <a class="btn btn-outline" target="_blank" rel="noopener" href="https://wa.me/${S.whatsapp}?text=${encodeURIComponent(order.message)}">Contact us on WhatsApp</a>
      </div>`;
    openModal("success");
  }

  // "Pay now" for an unpaid online order (after a closed payment window, or from tracking / My account)
  async function payAgain(code, btn, token) {
    const phone = unpaid[code]?.phone || $("#trackPhone").value || store.get("customer", {}).phone || "";
    if (btn) btn.disabled = true;
    try {
      const order = await api(`/orders/${encodeURIComponent(code)}/pay`, { method: "POST", body: { phone, token } });
      order.items = unpaid[code]?.items;
      closeModal("track");
      closeModal("account");
      try { await payOnline(order); } catch (err) { orderPending(order, err.message); return; }
      delete unpaid[code];
      orderDone(order);
    } catch (err) {
      toast(err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // COD confirmation link (?confirm=<token>)
  async function codConfirm(tok) {
    try {
      const o = await api("/cod/" + encodeURIComponent(tok));
      const render = o => {
        $("#successBody").innerHTML = o.status === "cancelled" ? `<div class="success-ic warn">✕</div><h3>Order ${esc(o.code)} is cancelled</h3><p class="muted">No problem. You're welcome back any time.</p>`
          : o.confirmed ? `<div class="success-ic">✓</div><h3>Thank you, ${esc(o.name.split(" ")[0])}!</h3><p>Your cash-on-delivery order <b>${esc(o.code)}</b> is confirmed. We're making it fresh for you.</p><p class="muted">Keep ${rupees(o.total)} ready when it arrives.</p>`
          : `<h3>Please confirm your order</h3><p class="order-code">${esc(o.code)}</p>
            <ul class="track-items">${o.items.map(i => `<li>${esc(i.title)} (${esc(i.variant)}) × ${i.qty}</li>`).join("")}</ul>
            <p>Cash on delivery: <b>${rupees(o.total)}</b> · ${esc(o.city)}</p>
            <div class="success-actions"><button class="btn btn-primary" type="button" id="codYes">Yes, confirm my order</button>
              <button class="btn btn-outline" type="button" id="codNo">Cancel it</button></div>`;
        const go = async action => {
          if (action === "cancel" && !window.confirm("Cancel this order?")) return;
          try { render(await api("/cod/" + encodeURIComponent(tok), { method: "POST", body: { action } })); } catch (err) { toast(err.message); }
        };
        if ($("#codYes")) { $("#codYes").onclick = () => go("confirm"); $("#codNo").onclick = () => go("cancel"); }
      };
      render(o);
      openModal("success");
    } catch (err) { toast(err.message); }
  }

  /* ---------- Order tracking ---------- */
  async function trackOrder(e) {
    e.preventDefault();
    const code = $("#trackCode").value.trim(), phone = $("#trackPhone").value.trim();
    const out = $("#trackResult");
    out.innerHTML = `<p class="muted">Looking up your order…</p>`;
    try {
      const o = await api(`/orders/track?code=${encodeURIComponent(code)}&phone=${encodeURIComponent(phone)}`);
      renderTrackResult(o, out);
    } catch (err) {
      out.innerHTML = `<p class="err">${esc(err.message)}</p>`;
    }
  }

  function openTrack(code) {
    if (code) $("#trackCode").value = code;
    const saved = store.get("customer", {});
    if (saved.phone && !$("#trackPhone").value) $("#trackPhone").value = saved.phone;
    $("#trackResult").innerHTML = "";
    closeModal("success");
    openModal("track");
    if (code && $("#trackPhone").value) $("#trackForm").requestSubmit();
  }

  // Date an order reached a status (latest time, from the order history)
  function stepDate(o, status) {
    const ev = (o.history || []).filter(h => h.status === status).pop();
    return ev ? `<small class="step-date">${new Date(ev.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</small>` : "";
  }
  function renderTrackResult(o, out) {
    const cur = STATUS_STEPS.indexOf(o.status);
    out.innerHTML = `
      <h4>Order ${esc(o.code)} · ${rupees(o.total)}</h4>
      ${o.status === "cancelled" ? `<p class="err">This order was cancelled.</p>` : `<ol class="steps">${STATUS_STEPS.map((s, i) =>
        `<li class="${i <= cur ? "done" : ""}">${STATUS_TEXT[s]}${stepDate(o, s)}</li>`).join("")}</ol>`}
      ${o.trackingNo ? `<p>Courier: <b>${esc(o.courier || "—")}</b> · Tracking no: <b>${esc(o.trackingNo)}</b></p>` : ""}
      <p class="muted">Payment: ${esc({ online: "Online", cod: "Cash on delivery", whatsapp: "Via WhatsApp" }[o.paymentMethod])} (${esc(o.paymentStatus)})</p>
      ${o.paymentMethod === "online" && o.paymentStatus !== "paid" && o.status !== "cancelled" && S.onlinePayment
        ? `<p><button class="btn btn-primary" type="button" data-pay-code="${esc(o.code)}">Pay ${rupees(o.total)} now</button></p>` : ""}
      <ul class="track-items">${o.items.map(i => `<li>${esc(i.title)} (${esc(i.variant)}) × ${i.qty}</li>`).join("")}</ul>
      ${(o.complaints || []).map(c => `<div class="complaint ${c.status}"><b>${esc(c.kind)}</b> · ${{ open: "We're looking into it", refunded: `Refunded ₹${c.refund}`, replaced: `Replacement sent (${esc(c.replacement)})`, rejected: "Not accepted", resolved: "Resolved" }[c.status]}${c.resolution ? `<br><small>${esc(c.resolution)}</small>` : ""}</div>`).join("")}
      <p class="order-actions">${o.items.some(i => variantById[i.variantId]) ? `<button class="btn btn-outline" type="button" data-reorder="${esc(o.code)}">🔁 Order again</button>` : ""}
        ${o.canReport ? `<button class="btn btn-outline" type="button" data-report="${esc(o.code)}">⚠️ Report a problem</button>` : ""}</p>
      <form class="form report-form" id="reportForm" data-code="${esc(o.code)}" hidden>
        <h4>What went wrong?</h4>
        <select name="kind" required><option value="damaged">Arrived damaged</option><option value="wrong">Wrong item</option><option value="missing">Item missing</option>
          <option value="quality">Taste or quality problem</option><option value="late">Arrived very late</option><option value="other">Something else</option></select>
        <textarea name="message" required minlength="5" maxlength="1500" rows="3" placeholder="Tell us what happened"></textarea>
        <label class="rev-photo">📷 Add a photo (helps us sort it out faster)<input type="file" name="photoFile" accept="image/jpeg,image/png,image/webp" /></label>
        <button class="btn btn-primary" type="submit">Send report</button>
      </form>`;
    lastOrders[o.code] = o;
  }
  const lastOrders = {};
  function reorder(code) {
    const o = lastOrders[code];
    let added = 0, missing = 0;
    for (const i of o.items) {
      const hit = variantById[i.variantId];
      if (!hit || !hit.v.a) { missing++; continue; }
      const line = state.cart.find(l => l.vid === i.variantId);
      if (line) line.q = Math.min(50, line.q + i.qty); else state.cart.push({ vid: i.variantId, q: i.qty });
      added++;
    }
    state.coupon = null;
    save(); renderCart();
    closeModal("account"); closeModal("track");
    if (added) { openDrawer("cart"); toast(missing ? `Added ${added} item(s). ${missing} are no longer available.` : "Added to your cart"); }
    else toast("Sorry, these items are no longer available.");
  }

  /* ---------- Customer login (Supabase email OTP) ---------- */
  const auth = { client: null, user: null, profile: null, afterLogin: null, email: "" };

  async function initAuth() {
    if (!S.supabase) { $("#accountBtn").hidden = true; return; }
    try {
      await new Promise((resolve, reject) => {
        const sc = document.createElement("script");
        sc.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js";
        sc.onload = resolve;
        sc.onerror = reject;
        document.head.appendChild(sc);
      });
      auth.client = window.supabase.createClient(S.supabase.url, S.supabase.anonKey);
      const { data } = await auth.client.auth.getSession();
      await setSession(data.session);
      auth.client.auth.onAuthStateChange((_event, session) => { setSession(session); });
    } catch (e) {
      console.error("Login unavailable", e);
    }
  }

  async function setSession(session) {
    accessToken = session?.access_token || null;
    auth.user = session ? { id: session.user.id, email: session.user.email || "" } : null;
    $("#accountBtn").classList.toggle("in", Boolean(auth.user));
    if (!auth.user) { auth.profile = null; return; }
    if (state.cart.length) syncCart();
    if (!auth.profile) {
      try {
        const me = await api("/me");
        const p = me.profile;
        auth.profile = p ? { name: p.name, email: p.email, address: p.address, city: p.city, pin: p.pincode } : {};
      } catch { auth.profile = {}; }
    }
  }

  function openLogin(hint) {
    if (!auth.client) { toast("Login is not available right now. Please try again later."); return; }
    $("#loginHint").textContent = hint || "We'll email you a login code.";
    $("#loginErr").textContent = "";
    $("#emailForm").hidden = false;
    $("#otpForm").hidden = true;
    const saved = store.get("customer", {}).email;
    if (saved && !$("#loginEmail").value) $("#loginEmail").value = saved;
    closeModal("checkout");
    openModal("login");
    setTimeout(() => $("#loginEmail").focus(), 250);
  }

  let resendTimer;
  async function sendOtp(e) {
    e?.preventDefault();
    const email = $("#loginEmail").value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $("#loginErr").textContent = "Enter a valid email address."; return; }
    auth.email = email;
    const btn = $("#sendOtpBtn");
    btn.disabled = true;
    btn.textContent = "Sending…";
    $("#loginErr").textContent = "";
    const { error } = await auth.client.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    btn.disabled = false;
    btn.textContent = "Send code";
    if (error) { $("#loginErr").textContent = error.message; return; }
    $("#emailForm").hidden = true;
    $("#otpForm").hidden = false;
    $("#loginHint").textContent = `Enter the code we emailed to ${auth.email}. Check your spam folder if you don't see it.`;
    $("#loginOtp").value = "";
    setTimeout(() => $("#loginOtp").focus(), 100);
    let left = 30;
    const rs = $("#resendOtp");
    rs.disabled = true;
    rs.textContent = `Resend in ${left}s`;
    clearInterval(resendTimer);
    resendTimer = setInterval(() => {
      left--;
      if (left <= 0) { clearInterval(resendTimer); rs.disabled = false; rs.textContent = "Resend code"; }
      else rs.textContent = `Resend in ${left}s`;
    }, 1000);
  }

  async function verifyOtp(e) {
    e.preventDefault();
    const btn = $("#verifyOtpBtn");
    btn.disabled = true;
    btn.textContent = "Checking…";
    const { data, error } = await auth.client.auth.verifyOtp({ email: auth.email, token: $("#loginOtp").value.trim(), type: "email" });
    btn.disabled = false;
    btn.textContent = "Verify & log in";
    if (error) {
      $("#loginErr").textContent = /expired|invalid/i.test(error.message) ? "That code is wrong or has expired. Try again or resend it." : error.message;
      return;
    }
    await setSession(data.session);
    closeModal("login");
    toast("You're logged in 👋");
    const next = auth.afterLogin;
    auth.afterLogin = null;
    if (next) next();
  }

  function referralBox(rf) {
    const msg = `I love Truchilli's Guntur chilli powders and masalas! Get ₹${rf.amount} off your first order with my code ${rf.code}: ${rf.link}`;
    const open = rf.rewards.filter(x => (x.max_uses === null || x.used < x.max_uses) && (!x.expires_at || new Date(x.expires_at) >= new Date(new Date().toDateString())));
    return `<div class="ref-box">
      <h4>Give ₹${rf.amount}, get ₹${rf.amount} 🎁</h4>
      <p class="muted">Friends get ₹${rf.amount} off their first order${rf.minOrder ? ` (₹${rf.minOrder}+)` : ""} with your code. When it's delivered, you get a ₹${rf.amount} coupon.</p>
      <div class="ref-code"><b>${esc(rf.code)}</b>
        <button class="btn btn-outline" type="button" data-copy="${esc(rf.link)}">Copy link</button>
        <a class="btn btn-primary" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}">Share on WhatsApp</a></div>
      ${rf.friends ? `<p class="muted">${rf.friends} friend${rf.friends > 1 ? "s have" : " has"} ordered with your code.</p>` : ""}
      ${open.length ? `<p>Your reward coupons: ${open.map(x => `<b class="coupon-tag">${esc(x.coupon_code)}</b> ₹${x.amount} off`).join(" · ")}</p>` : ""}
    </div>`;
  }

  async function renderMySubs() {
    const box = $("#mySubs");
    try {
      const subs = await api("/me/subscriptions");
      box.innerHTML = subs.length ? `<h4>My subscriptions</h4>${subs.map(s => `<div class="sub-row">
        <div><b>Every ${s.every / 7} weeks</b> · ${s.status === "active" ? `next order ${new Date(s.next).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}` : "paused"}
          <br><small class="muted">${s.items.map(i => `${esc(i.title)} (${esc(i.label)}) × ${i.qty}`).join(", ")}</small></div>
        <div class="sub-actions">${s.status === "active" ? `<button class="rm" data-msub="${s.id}" data-act="skip">Skip next</button><button class="rm" data-msub="${s.id}" data-act="pause">Pause</button>`
          : `<button class="rm" data-msub="${s.id}" data-act="resume">Resume</button>`}
          <button class="rm" data-msub="${s.id}" data-act="every" data-every="${s.every === 14 ? 28 : 14}">Every ${s.every === 14 ? 4 : 2} weeks</button>
          <button class="rm" data-msub="${s.id}" data-act="cancel">Cancel</button></div></div>`).join("")}` : "";
    } catch { box.innerHTML = ""; }
  }

  async function renderMyAddresses() {
    const box = $("#myAddresses");
    try {
      savedAddresses = await api("/me/addresses");
      box.innerHTML = savedAddresses.length ? savedAddresses.map(a => `<div class="addr-row"><div><b>${esc(a.label || a.name)}</b><br><small class="muted">${esc(a.name)}, ${esc(a.address)}, ${esc(a.city)} - ${esc(a.pincode)} · ${esc(a.phone)}</small></div>
        <button class="rm" type="button" data-del-addr="${a.id}">Delete</button></div>`).join("")
        : `<p class="muted">Addresses you save at checkout appear here.</p>`;
    } catch (err) { box.innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  }

  async function openAccount() {
    if (!auth.client) { openTrack(); return; }
    if (!auth.user) { auth.afterLogin = openAccount; openLogin(); return; }
    $("#accountBody").innerHTML = `<p class="muted">Loading your orders…</p>`;
    openModal("account");
    try {
      const me = await api("/me");
      $("#accountBody").innerHTML = `
        <div class="acct-head"><div><b>${esc(me.profile?.name || "Welcome!")}</b><br><small class="muted">${esc(me.email)}</small></div>
          <button class="btn btn-outline" type="button" id="logoutBtn">Log out</button></div>
        <h4>My orders</h4>
        <div class="acct-orders">${me.orders.length ? me.orders.map(o => `
          <button class="acct-order" type="button" data-my-order="${esc(o.code)}">
            <span><b>${esc(o.code)}</b><small>${new Date(o.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} · ${o.items} item${o.items === 1 ? "" : "s"} · ${rupees(o.total)}</small></span>
            ${o.payment_method === "online" && o.payment_status !== "paid" && o.status !== "cancelled"
              ? `<span class="st unpaid">Payment pending</span>`
              : `<span class="st ${esc(o.status)}">${esc(STATUS_TEXT[o.status] || o.status)}</span>`}
          </button>`).join("") : `<p class="muted">No orders yet. Your orders will appear here.</p>`}</div>
        <div class="track-result" id="myOrderDetail"></div>
        ${me.referral ? referralBox(me.referral) : ""}
        <div id="mySubs"></div>
        <h4>Saved addresses</h4><div id="myAddresses"><p class="muted">Loading…</p></div>`;
      renderMyAddresses();
      renderMySubs();
      $("#logoutBtn").onclick = async () => {
        await auth.client.auth.signOut();
        await setSession(null);
        closeModal("account");
        toast("Logged out");
      };
    } catch (err) {
      $("#accountBody").innerHTML = `<p class="err">${esc(err.message)}</p>`;
    }
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast("Link copied"); } catch { window.prompt("Copy this link", text); }
  }

  /* ---------- Search ---------- */
  function renderSearch(q) {
    q = q.trim().toLowerCase();
    const res = q.length < 2 ? [] : P.filter(p => (p.t + " " + p.d).toLowerCase().includes(q)).slice(0, 12);
    $("#searchResults").innerHTML = q.length < 2 ? "" : res.length
      ? res.map(p => `<button class="sr-item" data-quick="${p.id}"><img src="${esc(img(p.img))}" alt="" /><span><strong>${esc(p.t)}</strong><small>${money(selVariant(p).p)}</small></span></button>`).join("")
      : `<p class="muted">No products match "${esc(q)}".</p>`;
  }

  function renderAll() {
    renderOffers();
    renderTrial();
    renderGrid();
    renderCart();
    renderWish();
    renderSearch($("#searchInput").value);
  }

  /* ---------- Events ---------- */
  document.addEventListener("click", e => {
    const t = e.target.closest("[data-pq],[data-add],[data-wish],[data-quick],[data-variant],[data-tab],[data-cat],[data-qty],[data-rm],[data-close],[data-track-code],[data-open-track],[data-open-account],[data-my-order],[data-pay-code],[data-reorder],[data-addr],[data-del-addr],[data-share],[data-copy],[data-report],[data-msub]");
    if (!t) return;
    const d = t.dataset;
    if (d.pq) {
      const [id, delta] = d.pq.split(":").map(Number);
      state.qty[id] = Math.min(50, Math.max(1, qtyOf(id) + delta));
      t.parentElement.querySelector("span").textContent = state.qty[id];
      return;
    }
    if (d.add) { e.stopPropagation(); addToCart(+d.add); if (t.classList.contains("add")) { t.classList.add("added"); setTimeout(() => t.classList.remove("added"), 900); } }
    else if (d.wish) { e.stopPropagation(); toggleWish(+d.wish); }
    else if (d.variant) {
      const [id, idx] = d.variant.split(":").map(Number);
      state.sel[id] = idx;
      updateCard(id); // update in place: no re-render, no flicker
      if ($("#modal").classList.contains("show")) openQuick(id);
    }
    else if (d.quick) {
      $("#searchBar").classList.remove("open");
      openQuick(+d.quick);
      const p = byId[+d.quick], v = selVariant(p);
      track("view_item", { value: v.p, items: [gaItem(p, v, 1)] });
    }
    else if (d.tab) { setCat(d.tab); toShopTop(); }
    else if (d.cat) { setCat(d.cat); document.getElementById("shop").scrollIntoView(); }
    else if (d.qty) {
      const [i, delta] = d.qty.split(":").map(Number);
      state.cart[i].q = Math.min(50, state.cart[i].q + delta);
      if (state.cart[i].q < 1) state.cart.splice(i, 1);
      state.coupon = null;
      save(); renderCart();
    }
    else if (d.rm) { state.cart.splice(+d.rm, 1); state.coupon = null; save(); renderCart(); }
    else if (d.close) closeModal(d.close);
    else if (d.trackCode !== undefined) openTrack(d.trackCode);
    else if (d.payCode) payAgain(d.payCode, t);
    else if (d.reorder) reorder(d.reorder);
    else if (d.share) {
      const url = `${location.origin}/p/${d.share}`;
      if (navigator.share) navigator.share({ title: document.title, url }).catch(() => {});
      else copyText(url);
    }
    else if (d.copy) copyText(d.copy);
    else if (d.msub) {
      if (d.act === "cancel" && !window.confirm("Cancel this subscription?")) return;
      api(`/me/subscriptions/${d.msub}`, { method: "PATCH", body: { action: d.act, every: d.every } })
        .then(() => { toast({ skip: "Next order skipped", pause: "Subscription paused", resume: "Subscription resumed", cancel: "Subscription cancelled", every: "Frequency changed" }[d.act]); renderMySubs(); })
        .catch(err => toast(err.message));
    }
    else if (d.report) { const f = $("#reportForm"); f.hidden = !f.hidden; if (!f.hidden) f.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
    else if (d.addr) useAddress(+d.addr);
    else if (d.delAddr) {
      if (!window.confirm("Delete this saved address?")) return;
      api("/me/addresses/" + d.delAddr, { method: "DELETE" }).then(() => { toast("Address deleted"); renderMyAddresses(); }).catch(err => toast(err.message));
    }
    else if (d.openTrack !== undefined) { e.preventDefault(); closeDrawer(); openTrack(); }
    else if (d.openAccount !== undefined) { e.preventDefault(); closeDrawer(); openAccount(); }
    else if (d.myOrder) {
      api(`/me/orders/${encodeURIComponent(d.myOrder)}`).then(o => {
        renderTrackResult(o, $("#myOrderDetail"));
        $("#myOrderDetail").scrollIntoView({ block: "nearest", behavior: "smooth" });
      }).catch(err => toast(err.message));
    }
  });

  // Report a problem with an order (logged in, or with the phone number used for tracking)
  document.addEventListener("submit", async e => {
    if (e.target.id !== "reportForm") return;
    e.preventDefault();
    const f = e.target, btn = f.querySelector("button[type=submit]");
    const body = { kind: f.kind.value, message: f.message.value, phone: $("#trackPhone").value || store.get("customer", {}).phone || "" };
    btn.disabled = true;
    try {
      const file = f.photoFile.files[0];
      if (file) { btn.textContent = "Uploading photo…"; body.photo = await shrinkPhoto(file); }
      btn.textContent = "Sending…";
      await api(`/orders/${encodeURIComponent(f.dataset.code)}/complaints`, { method: "POST", body });
      f.outerHTML = `<p class="ok">Thank you. We've got your report and will get back to you within a day.</p>`;
      $(`[data-report="${f.dataset.code}"]`)?.remove();
    } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = "Send report"; }
  });

  document.addEventListener("submit", async e => {
    if (e.target.id !== "reviewForm") return;
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector("button[type=submit]");
    try {
      const file = $("#revPhoto")?.files?.[0];
      delete f.photo;
      if (file) { btn.disabled = true; btn.textContent = "Uploading photo…"; f.photo = await shrinkPhoto(file); }
      await api(`/products/${e.target.dataset.product}/reviews`, { method: "POST", body: f });
      e.target.innerHTML = `<p class="ok">Thank you! Your review will appear after we check it.</p>`;
    } catch (err) { toast(err.message); if (btn) { btn.disabled = false; btn.textContent = "Submit review"; } }
  });

  $("#cartBtn").addEventListener("click", () => { prefillReferral(); openDrawer("cart"); });
  $("#wishBtn").addEventListener("click", () => openDrawer("wish"));
  $$(".drawer-tabs button").forEach(b => b.addEventListener("click", () => openDrawer(b.dataset.panel)));
  $("#closeDrawer").addEventListener("click", closeDrawer);
  $("#overlay").addEventListener("click", closeDrawer);
  $("#closeModal").addEventListener("click", () => closeModal("modal"));
  $$(".modal").forEach(m => m.addEventListener("click", e => { if (e.target === m) closeModal(m.id); }));
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    $$(".modal.show").forEach(m => closeModal(m.id));
    closeDrawer();
    $("#searchBar").classList.remove("open");
  });

  $("#menuBtn").addEventListener("click", () => { $("#nav").classList.add("open"); $("#overlay").classList.add("show"); });
  $$("#nav a").forEach(a => a.addEventListener("click", closeDrawer));

  function toggleSearch() {
    const open = $("#searchBar").classList.toggle("open");
    if (open) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      setTimeout(() => $("#searchInput").focus(), 200);
    }
  }
  $("#searchBtn").addEventListener("click", toggleSearch);

  // Mobile bottom bar
  $$(".bottom-nav [data-open]").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.open === "search") toggleSearch();
    else if (b.dataset.open === "account") openAccount();
    else openDrawer(b.dataset.open);
  }));
  $$(".bottom-nav a").forEach(a => a.addEventListener("click", closeDrawer));

  const bnLinks = $$(".bottom-nav a");
  const shopEl = document.getElementById("shop");
  const markActive = () => {
    const r = shopEl.getBoundingClientRect();
    const inShop = r.top < innerHeight * 0.5 && r.bottom > innerHeight * 0.3;
    bnLinks[0].classList.toggle("active", !inShop);
    bnLinks[1].classList.toggle("active", inShop);
  };
  addEventListener("scroll", markActive, { passive: true });
  markActive();
  $("#searchInput").addEventListener("input", e => renderSearch(e.target.value));

  $("#fMild").addEventListener("change", e => { state.mild = e.target.checked; state.shown = PAGE; renderGrid(); });
  $("#sort").addEventListener("change", e => { state.sort = e.target.value; renderGrid(); });
  $("#loadMore").addEventListener("click", () => { state.shown += PAGE; renderGrid(); });

  $("#currency").value = state.currency;
  $("#currency").addEventListener("change", e => {
    state.currency = e.target.value;
    store.set("currency", state.currency);
    renderAll();
    if (state.currency !== "INR") toast("Prices shown are approximate. Orders are charged in INR.");
  });

  $("#shipTo").addEventListener("change", () => { state.coupon = null; renderTotals(); });
  $("#couponForm").addEventListener("submit", applyCoupon);
  $("#coPin").addEventListener("change", () => regionFromPin($("#coPin").value));
  $("#coGift").addEventListener("change", ev => { $("#coGiftMsg").hidden = !ev.target.checked; });
  $("#coSubscribe").addEventListener("change", ev => {
    state.subscribe = Number(ev.target.value) || 0;
    renderTotals();
    refreshPayOptions();
    $("#checkoutTotal").textContent = money(totals().total);
  });
  $("#checkoutBtn").addEventListener("click", openCheckout);
  $("#checkoutForm").addEventListener("submit", e => { e.preventDefault(); placeOrder(e.target); });
  $("#trackForm").addEventListener("submit", trackOrder);
  $("#accountBtn").addEventListener("click", openAccount);
  $("#emailForm").addEventListener("submit", sendOtp);
  $("#otpForm").addEventListener("submit", verifyOtp);
  $("#resendOtp").addEventListener("click", () => sendOtp());
  $("#changeEmail").addEventListener("click", () => { $("#otpForm").hidden = true; $("#emailForm").hidden = false; $("#loginErr").textContent = ""; });
  $("#newsletter").addEventListener("submit", async e => {
    e.preventDefault();
    try {
      await api("/subscribe", { method: "POST", body: { email: e.target.email.value } });
      e.target.reset();
      toast("Thanks for subscribing! 💛");
    } catch (err) { toast(err.message); }
  });

  /* ---------- Reveal on scroll + counters ---------- */
  const io = new IntersectionObserver(entries => entries.forEach(en => {
    if (!en.isIntersecting) return;
    en.target.classList.add("in");
    io.unobserve(en.target);
  }), { threshold: 0.12 });

  function countUp(el) {
    const end = +el.dataset.count, t0 = performance.now();
    const tick = now => {
      const k = Math.min(1, (now - t0) / 1400);
      el.textContent = Math.round(end * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ---------- Why section: ingredient photos + EN/TE switch ---------- */
  const INGREDIENTS = {
    base: [
      { en: "Guntur chilli", te: "గుంటూరు మిర్చి", p: "Guntur Chilli Powder / Guntur Pachi Karam" },
      { en: "Byadagi chilli", te: "బ్యాడగి మిర్చి", p: "Byadagi / Kashmiri Chilli Powder" },
      { en: "Pickle chilli", te: "పచ్చళ్ల కారం", p: "Pickles Chilli Powder / Pachalla Karam" },
    ],
    millets: [
      { en: "Cashew", te: "జీడిపప్పు", p: "Cashew Chilli Powder / Jeedipappu Karam Podi" },
      { en: "Toor dal", te: "కంది పప్పు", p: "Toor Dal Chilli Powder / Kandhi Karam Podi" },
      { en: "Chana dal", te: "శనగ పప్పు", p: "Chana Dal Chilli Powder / Senaga Pappu Karam Podi" },
      { en: "Sesame", te: "నువ్వులు", p: "White Sesame Seeds Chilli Powder / Nuvvula Karam Podi" },
      { en: "Curry leaf", te: "కరివేపాకు", p: "Curry Leaf Chilli Powder / Karivepaku Karam" },
    ],
    seeds: [
      { en: "Coriander", te: "ధనియాలు", p: "Coriander Powder / Dhaniya Podi" },
      { en: "Cumin", te: "జిలకర్ర", p: "Jeera Powder / Jilakarra Podi" },
      { en: "Garam masala", te: "గరం మసాలా", p: "Garam Masala" },
      { en: "Turmeric", te: "పసుపు", p: "Turmeric Powder / Pasupu" },
    ],
  };
  $$("[data-ing]").forEach(row => {
    row.innerHTML = INGREDIENTS[row.dataset.ing].map(i => {
      // A fixed plain photo (src) where the product's own photo is now a poster with its name on it
      const pic = i.src || P.find(p => p.t === i.p)?.img;
      return `<div class="ing">${pic ? `<img src="${esc(img(pic))}" alt="" loading="lazy" />` : ""}<b>${esc(i.en)}</b><small>${esc(i.te)}</small></div>`;
    }).join("");
  });
  function setLang(lang) {
    $("#why").dataset.lang = lang;
    $$("[data-lang-btn]").forEach(x => {
      const on = x.dataset.langBtn === lang;
      x.classList.toggle("active", on);
      x.setAttribute("aria-pressed", String(on));
    });
  }
  $$("[data-lang-btn]").forEach(b => b.addEventListener("click", () => setLang(b.dataset.langBtn)));
  // Always open in Telugu; the English button switches for this visit only
  setLang("te");

  /* ---------- Init ---------- */
  $("#year").textContent = new Date().getFullYear();
  $$("[data-count]").forEach(el => { el.dataset.count = el.dataset.count === "26" ? P.length : P.filter(p => p.m).length; });
  applySettings();
  renderCategories();
  renderTabs();
  renderAll();
  $$(".reveal").forEach(el => io.observe(el));
  $$("[data-count]").forEach(countUp);
  if (location.hash === "#track") openTrack();
  {
    const q = new URLSearchParams(location.search);
    const ref = (q.get("ref") || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20);
    if (ref) { store.set("ref", ref); toast(`Your friend's code ${ref} will be added at checkout 🎁`); }
    const again = q.get("again"), sig = q.get("s"), confirm = q.get("confirm"), pay = q.get("pay");
    if (confirm) codConfirm(confirm);
    if (pay) payAgain(pay.split(".")[0], null, pay);
    if (ref || again || confirm || pay) { q.delete("ref"); q.delete("again"); q.delete("s"); q.delete("confirm"); q.delete("pay"); history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : "") + location.hash); }
    if (again && sig) api(`/orders/${encodeURIComponent(again)}/again?s=${encodeURIComponent(sig)}`).then(o => {
      lastOrders[o.code] = { code: o.code, items: o.items };
      reorder(o.code);
    }).catch(err => toast(err.message));
    const pm = location.hash.match(/^#p=([a-z0-9-]+)/);
    const deep = pm && P.find(p => p.h === pm[1]);
    if (deep) openQuick(deep.id);
  }
  initAuth().then(() => { if (location.hash === "#account") openAccount(); });
})();
