// Fare Radar: route map, featured deal, departures board, and email sign-up.
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const money = (n) => `$${Math.round(n)}`;
  const fmt = (iso, opts) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", ...opts });
  const short = (iso) => fmt(iso, { weekday: "short", month: "short", day: "numeric" });
  const stops = (n) => (n === 0 ? "nonstop" : `${n} stop${n > 1 ? "s" : ""}`);
  const stopsPair = (d) => d.outbound_stops === d.return_stops
    ? `${stops(d.outbound_stops)} both ways` : `${stops(d.outbound_stops)} / ${stops(d.return_stops)}`;
  const isGoogle = (url) => !url || /google\.com\/travel/.test(url);
  const safeUrl = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u : null);

  // Airport coordinates [lat, lon] for the route map.
  const AIRPORTS = {
    SEA: [47.45, -122.31], PDX: [45.59, -122.6], LAX: [33.94, -118.41], SFO: [37.62, -122.38], SAN: [32.73, -117.19],
    LAS: [36.08, -115.15], PHX: [33.43, -112.01], DEN: [39.86, -104.67], SLC: [40.79, -111.98], ANC: [61.17, -150],
    HNL: [21.32, -157.92], OGG: [20.9, -156.43], DFW: [32.9, -97.04], AUS: [30.19, -97.67], ORD: [41.98, -87.9],
    MSP: [44.88, -93.22], ATL: [33.64, -84.43], MIA: [25.79, -80.29], MCO: [28.43, -81.31], BOS: [42.36, -71.01],
    JFK: [40.64, -73.78], EWR: [40.69, -74.17], DCA: [38.85, -77.04], MSY: [29.99, -90.26], BNA: [36.12, -86.68],
    SJC: [37.36, -121.93], SMF: [38.7, -121.59], BOI: [43.56, -116.22], YVR: [49.19, -123.18], MEX: [19.44, -99.07],
    CUN: [21.04, -86.87], SJD: [23.15, -109.72], PVR: [20.68, -105.25], GDL: [20.52, -103.31], LIR: [10.59, -85.54],
    SJO: [9.99, -84.2], NRT: [35.77, 140.39], HND: [35.55, 139.78], KIX: [34.43, 135.23], ICN: [37.46, 126.44],
    TPE: [25.08, 121.23], MNL: [14.51, 121.02], BKK: [13.69, 100.75], SIN: [1.36, 103.99], LHR: [51.47, -0.45],
    DUB: [53.42, -6.27], KEF: [63.99, -22.61], CDG: [49.01, 2.55], AMS: [52.31, 4.76], FRA: [50.03, 8.57],
    MAD: [40.47, -3.56], BCN: [41.3, 2.08], LIS: [38.77, -9.13], FCO: [41.8, 12.25], SYD: [-33.94, 151.18],
    AKL: [-37.01, 174.79],
  };

  const state = { origin: "", kind: "", sort: "recent", max: null, meta: null, deals: [] };

  // ---------------- route map ----------------
  // Equirectangular, centred on Seattle's longitude so Asia sits left and Europe right.
  const W = 1000, H = 290, CENTER_LON = -122, LAT_TOP = 68, LAT_BOTTOM = -42;
  function project([lat, lon]) {
    const rel = ((lon - CENTER_LON + 540) % 360) - 180;
    return [((rel + 180) / 360) * W, ((LAT_TOP - lat) / (LAT_TOP - LAT_BOTTOM)) * H];
  }
  const NS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs, text) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function arcPath(a, b) {
    const [x1, y1] = project(a), [x2, y2] = project(b);
    const dist = Math.hypot(x2 - x1, y2 - y1);
    const mx = (x1 + x2) / 2, my = Math.max(4, (y1 + y2) / 2 - Math.min(90, dist * 0.2));
    return `M${x1.toFixed(1)} ${y1.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }

  function drawMap(deals) {
    const map = $("#map");
    const origins = (state.meta?.origins ?? [{ code: "SEA" }, { code: "PDX" }]).map((o) => o.code);
    const hot = new Map(); // destination -> cheapest deal
    for (const d of deals) if (!hot.has(d.destination) || d.price < hot.get(d.destination).price) hot.set(d.destination, d);

    const g = [];
    for (let lon = -180; lon < 180; lon += 30) {
      const x = ((lon + 180) / 360) * W;
      g.push(svg("line", { class: "grid", x1: x, y1: 0, x2: x, y2: H }));
    }
    for (let lat = -30; lat <= 60; lat += 30) {
      const y = ((LAT_TOP - lat) / (LAT_TOP - LAT_BOTTOM)) * H;
      g.push(svg("line", { class: "grid", x1: 0, y1: y, x2: W, y2: y }));
    }
    const dests = Object.keys(AIRPORTS).filter((c) => !origins.includes(c));
    const home = AIRPORTS.SEA;
    for (const c of dests) if (!hot.has(c)) g.push(svg("path", { class: "arc", d: arcPath(home, AIRPORTS[c]) }));
    for (const [c, d] of hot) if (AIRPORTS[c]) g.push(svg("path", { class: "arc hot", d: arcPath(AIRPORTS[d.origin] ?? home, AIRPORTS[c]) }));
    for (const c of dests) {
      const [x, y] = project(AIRPORTS[c]);
      g.push(svg("circle", { class: hot.has(c) ? "dot hot" : "dot", cx: x, cy: y, r: hot.has(c) ? 3.5 : 2 }));
    }
    // Price labels for current deals; skip ones that would collide.
    const placed = [];
    for (const [c, d] of [...hot].sort((a, b) => a[1].price - b[1].price)) {
      const [x, y] = project(AIRPORTS[c] ?? home);
      if (placed.some(([px, py]) => Math.abs(px - x) < 70 && Math.abs(py - y) < 16)) continue;
      placed.push([x, y]);
      g.push(svg("text", { x: x + 7, y: y - 6 }, c));
      g.push(svg("text", { class: "price", x: x + 7 + c.length * 7.4, y: y - 6 }, ` ${money(d.price)}`));
    }
    for (const c of origins) {
      const [x, y] = project(AIRPORTS[c]);
      g.push(svg("circle", { class: "dot home", cx: x, cy: y, r: 4 }));
    }
    const [sx, sy] = project(AIRPORTS.SEA);
    g.push(svg("text", { class: "home-label", x: sx + 8, y: sy - 8 }, "SEA · PDX"));
    map.replaceChildren(...g);
  }

  // ---------------- routing ----------------
  function route() {
    const tab = location.hash === "#signup" ? "signup" : "browse";
    $("#view-browse").hidden = tab !== "browse";
    $("#view-signup").hidden = tab !== "signup";
    $(".segmented").dataset.active = tab;
    $$(".segmented a").forEach((a) => (a.dataset.tab === tab
      ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);

  // ---------------- controls ----------------
  function segButton(value, label, on, kind) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.value = value;
    b.textContent = label;
    if (kind === "radio") { b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(on)); }
    else b.setAttribute("aria-pressed", String(on));
    return b;
  }
  function wireRadio(group, onChange) {
    group.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      $$("button", group).forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      onChange(b.dataset.value);
    });
  }
  function paintRange(input) {
    input.style.setProperty("--pct", `${((input.value - input.min) / (input.max - input.min)) * 100}%`);
  }

  // ---------------- meta ----------------
  function ago(iso) {
    const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
    const h = Math.round(mins / 60);
    return h < 24 ? `${h} hour${h === 1 ? "" : "s"} ago` : `${Math.round(h / 24)} days ago`;
  }

  async function loadMeta() {
    try {
      const m = await (await fetch("/api/meta")).json();
      state.meta = m;
      $("#lim-dom").textContent = money(m.domestic_max);
      $("#lim-intl").textContent = money(m.international_max);
      $("#n-routes").textContent = m.routes;
      $("#n-dest").textContent = m.destinations;
      $("#last-checked").textContent = m.last_checked_at
        ? `Last search ${ago(m.last_checked_at)}. ${m.searches_per_cycle} fares priced per run, ${m.cycle.toLocaleString()} runs so far.`
        : "The first search hasn't run yet.";
      $("#demo-note").hidden = !m.demo;

      $('[data-filter="origin"]').replaceChildren(segButton("", "SEA + PDX", true, "radio"),
        ...m.origins.map((o) => segButton(o.code, o.code, false, "radio")));
      $("#home").replaceChildren(...m.origins.map((o) => segButton(o.code, `${o.city} (${o.code})`, true, "toggle")));

      const max = $("#max");
      max.max = String(m.international_max);
      max.value = max.max;
      paintRange(max);
      for (const [id, v] of [["#dom", m.domestic_max], ["#intl", m.international_max]]) {
        const el = $(id);
        el.max = String(v);
        el.value = String(v);
        paintRange(el);
        $(`${id}-out`).textContent = money(v);
      }
    } catch {
      $("#last-checked").textContent = "Couldn't load search status.";
    }
  }

  // ---------------- deals ----------------
  let reqId = 0;
  async function loadDeals() {
    const id = ++reqId;
    $("#board").classList.add("loading");
    const q = new URLSearchParams({ sort: state.sort, limit: "60" });
    if (state.origin) q.set("origin", state.origin);
    if (state.kind) q.set("kind", state.kind);
    if (state.max) q.set("max", String(state.max));
    let deals = [];
    try { deals = (await (await fetch(`/api/deals?${q}`)).json()).deals ?? []; } catch { /* empty state */ }
    if (id !== reqId) return;
    state.deals = deals;
    $("#board").classList.remove("loading");
    renderBest(deals);
    $("#rows").replaceChildren(...deals.map(row));
    $("#empty").hidden = deals.length > 0;
    drawMap(deals);
    renderPreview(deals);
  }

  function limitFor(d) {
    const m = state.meta;
    if (!m) return null;
    return d.kind === "domestic" ? m.domestic_max : m.international_max;
  }

  function renderBest(deals) {
    const scored = deals.map((d) => [d, limitFor(d) ? d.price / limitFor(d) : 1]).sort((a, b) => a[1] - b[1]);
    const best = scored[0]?.[0];
    $("#best").hidden = !best;
    if (!best) return;
    const lim = limitFor(best);
    const pct = lim ? Math.round((1 - best.price / lim) * 100) : 0;
    $("#best-why").textContent = lim
      ? `Best value on this list: ${pct}% under the ${money(lim)} ${best.kind === "domestic" ? "US" : "international"} limit`
      : "Best value on this list";
    const h = $("#best-route");
    h.textContent = `${best.origin_city} to ${best.destination_city}`;
    const codes = document.createElement("span");
    codes.className = "codes-inline";
    codes.textContent = `${best.origin}–${best.destination}`;
    h.append(codes);
    $("#best-detail").textContent = `${short(best.depart_date)} to ${short(best.return_date)} · ${best.trip_days} days · `
      + `${stopsPair(best)} · ${best.airlines.join(", ") || "airline varies"}`;
    $("#best-price").textContent = money(best.price);
    setLink($("#best-link"), best.booking_url, best.is_fake, true);
  }

  function setLink(a, url, fake, long = false) {
    const u = safeUrl(url);
    a.textContent = isGoogle(u) ? (long ? "Search Google Flights" : "Search") : (long ? "Book with the airline" : "Book");
    if (u) { a.href = u; a.removeAttribute("aria-disabled"); }
    else { a.removeAttribute("href"); a.setAttribute("aria-disabled", "true"); }
    a.title = fake ? "Test fare: the search link won't show this price" : "";
  }

  function row(d) {
    const n = $("#row-tpl").content.firstElementChild.cloneNode(true);
    $(".o", n).textContent = d.origin;
    $(".d", n).textContent = d.destination;
    $(".city", n).textContent = d.destination_city;
    $(".dates", n).textContent = `${short(d.depart_date)} – ${short(d.return_date)}`;
    const days = $(".days", n);
    days.textContent = `${d.trip_days} days`;
    days.dataset.meta = ` · ${stops(Math.max(d.outbound_stops, d.return_stops))} · ${d.airlines.join(", ")}`;
    $(".c-stops", n).textContent = stopsPair(d);
    $(".c-air", n).textContent = d.airlines.join(", ") || "—";
    $(".c-price", n).textContent = money(d.price);
    setLink($("a", n), d.booking_url, d.is_fake);
    $("a", n).setAttribute("aria-label", `Book ${d.origin_city} to ${d.destination_city}, ${money(d.price)}`);
    return n;
  }

  // The sign-up page shows the real alert layout, filled with the newest deal.
  function renderPreview(deals) {
    const d = deals[0];
    if (!d) return;
    $("#pv-subject").textContent = `${d.origin_city} → ${d.destination_city} ${money(d.price)} round trip, `
      + `${short(d.depart_date)}–${short(d.return_date)}`;
    $("#pv-route").textContent = `${d.origin_city} → ${d.destination_city}`;
    $("#pv-price").textContent = money(d.price);
    $("#pv-dates").textContent = `${short(d.depart_date)} → ${short(d.return_date)} · ${d.trip_days} days · ${stopsPair(d)}`;
    $(".pv-btn").textContent = isGoogle(safeUrl(d.booking_url)) ? "See it on Google Flights" : "Book on the airline's site";
    $("#preview-src").textContent = d.is_fake ? "(filled with a test fare)" : "(filled with the newest deal)";
  }

  // ---------------- sign up ----------------
  function wireSignup() {
    const form = $("#signup-form");
    const email = $("#email");
    $("#home").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const on = b.getAttribute("aria-pressed") !== "true";
      const others = $$("#home button").filter((x) => x !== b && x.getAttribute("aria-pressed") === "true");
      if (!on && !others.length) return; // at least one airport
      b.setAttribute("aria-pressed", String(on));
    });
    for (const id of ["#dom", "#intl"]) {
      const el = $(id);
      el.addEventListener("input", () => { $(`${id}-out`).textContent = money(el.value); paintRange(el); });
    }
    email.addEventListener("input", () => email.removeAttribute("aria-invalid"));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = $("#form-msg");
      msg.className = "form-msg";
      if (!email.value || !email.checkValidity()) {
        email.setAttribute("aria-invalid", "true");
        msg.textContent = "That email address doesn't look complete.";
        msg.classList.add("err");
        email.focus();
        return;
      }
      const btn = $("button[type=submit]", form);
      btn.disabled = true;
      btn.textContent = "Sending…";
      try {
        const r = await fetch("/api/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: email.value.trim(),
            origins: $$("#home button[aria-pressed=true]").map((b) => b.dataset.value),
            domestic_max: Number($("#dom").value),
            international_max: Number($("#intl").value),
            website: $("#website").value,
          }),
        });
        const data = await r.json().catch(() => ({}));
        if (data.ok) {
          msg.textContent = data.status === "updated"
            ? "Saved. Your airports and limits are updated."
            : `Sent a confirmation link to ${email.value.trim()}. Alerts start once you tap it.`;
          msg.classList.add("ok");
        } else {
          msg.textContent = data.error || "That didn't go through. Try again in a minute.";
          msg.classList.add("err");
        }
      } catch {
        msg.textContent = "Couldn't reach the server. Check your connection and try again.";
        msg.classList.add("err");
      } finally {
        btn.disabled = false;
        btn.textContent = "Send me deals";
      }
    });
  }

  // ---------------- boot ----------------
  wireRadio($('[data-filter="origin"]'), (v) => { state.origin = v; loadDeals(); });
  wireRadio($('[data-filter="kind"]'), (v) => { state.kind = v; loadDeals(); });
  wireRadio($('[data-filter="sort"]'), (v) => { state.sort = v; loadDeals(); });
  const max = $("#max");
  let t;
  max.addEventListener("input", () => {
    paintRange(max);
    const top = Number(max.value) >= Number(max.max);
    state.max = top ? null : Number(max.value);
    $("#max-out").textContent = top ? "any price" : money(max.value);
    clearTimeout(t);
    t = setTimeout(loadDeals, 180);
  });
  wireSignup();
  route();
  drawMap([]);
  loadMeta().then(loadDeals);
})();
