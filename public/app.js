// Fare Radar: featured deal, departures board, and email sign-up.
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

  const state = { origin: "", kind: "", sort: "recent", max: null, meta: null, deals: [] };

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
      $("#days-out").textContent = `${m.min_days_out} to ${m.max_days_out}`;
      $("#n-dest").textContent = m.destinations;
      $("#last-checked").textContent = m.last_checked_at
        ? `Last search ${ago(m.last_checked_at)}. ${m.cycle.toLocaleString()} runs so far, about ${m.runs_per_day} a day.`
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
  loadMeta().then(loadDeals);
})();
