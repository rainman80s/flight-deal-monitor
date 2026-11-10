// Fare Radar: hero, deal columns, route search, logic, account and email sign-up.
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const money = (n) => `$${Math.round(n)}`;
  const cents = (n) => `$${Number(n).toFixed(2)}`;
  const fmt = (iso, opts) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", ...opts });
  const short = (iso) => fmt(iso, { weekday: "short", month: "short", day: "numeric" });
  const stops = (n) => (n === 0 ? "nonstop" : `${n} stop${n > 1 ? "s" : ""}`);
  const stopsPair = (d) => d.outbound_stops === d.return_stops
    ? `${stops(d.outbound_stops)} both ways` : `${stops(d.outbound_stops)} / ${stops(d.return_stops)}`;
  const isGoogle = (url) => !url || /google\.com\/travel/.test(url);
  const safeUrl = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u : null);

  const state = { origin: "", sort: "value", meta: null, deals: [], logic: null };

  // ---------------- routing ----------------
  function route() {
    const VIEWS = ["browse", "signup", "account", "logic", "about", "contact", "privacy", "terms", "accessibility"];
    const want = location.hash.slice(1);
    const tab = VIEWS.includes(want) ? want : "browse";
    for (const v of VIEWS) $(`#view-${v}`).hidden = v !== tab;
    const h = tab === "browse" ? "" : $(`#view-${tab} h1`).textContent;
    document.title = !h || h.includes("Fare Radar") ? h || "Fare Radar" : `${h} · Fare Radar`;
    if (tab === "account" && typeof renderAccount === "function") renderAccount();
    if (tab === "logic" && typeof renderLogic === "function") renderLogic();
    $(".segmented").dataset.active = tab;
    $$(".segmented a").forEach((a) => (a.dataset.tab === tab
      ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    if (location.hash === "#deals") $("#deals").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    else window.scrollTo(0, 0);
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
      $("#n-dest").textContent = m.destinations;
      $("#last-checked").textContent = m.last_checked_at ? `Fares updated ${ago(m.last_checked_at)}` : "";
      $("#demo-note").hidden = !m.demo;
      setupSearch(m);

      $('[data-filter="origin"]').replaceChildren(segButton("", "SEA + PDX", true, "radio"),
        ...m.origins.map((o) => segButton(o.code, o.code, false, "radio")));
      $("#home").replaceChildren(...m.origins.map((o) => segButton(o.code, `${o.city} (${o.code})`, true, "toggle")));

      for (const [id, v] of [["#dom", m.domestic_max], ["#intl", m.international_max]]) {
        const el = $(id);
        el.max = String(v);
        el.value = String(v);
        paintRange(el);
        $(`${id}-out`).textContent = money(v);
      }
    } catch {
      $("#last-checked").textContent = "";
    }
  }

  // ---------------- deals ----------------
  let reqId = 0;
  const COLS = { international: ["#rows-intl", "#empty-intl", "#rule-intl"], domestic: ["#rows-dom", "#empty-dom", "#rule-dom"] };

  async function loadDeals() {
    const id = ++reqId;
    $("#board").classList.add("loading");
    const fetchKind = async (kind) => {
      const q = new URLSearchParams({ sort: state.sort, limit: "25", kind });
      if (state.origin) q.set("origin", state.origin);
      try { return (await (await fetch(`/api/deals?${q}`)).json()).deals ?? []; } catch { return []; }
    };
    const [intl, dom] = await Promise.all([fetchKind("international"), fetchKind("domestic")]);
    if (id !== reqId) return;
    state.deals = [...intl, ...dom];
    $("#board").classList.remove("loading");
    for (const [kind, deals] of [["international", intl], ["domestic", dom]]) {
      const [rows, empty] = COLS[kind];
      $(rows).replaceChildren(...deals.map(row));
      $(empty).hidden = deals.length > 0;
      $(empty).textContent = state.origin
        ? `Nothing from ${state.origin} right now.`
        : kind === "international"
          ? "Nothing abroad under the limit right now. Fares like that come and go; this list updates every hour."
          : "Nothing in the US under the limit right now. This list updates every hour.";
    }
    renderPreview(state.deals.filter((d) => d.pinged).concat(state.deals));
  }

  /** One-line rule under each column header, from the Logic panel. */
  function renderColumnRules(logic) {
    if (!logic) return;
    const line = (c) => {
      const ping = c.alert.mode === "smart"
        ? `pings at ${c.alert.drop_percent}%+ below usual`
        : `pings under $${c.alert.under}`;
      return `${c.min_days_out}+ days out · ${c.min_trip_days}–${c.max_trip_days} day trips · under $${c.show_under} · ${ping}`;
    };
    $(COLS.international[2]).textContent = line(logic.categories.international);
    $(COLS.domestic[2]).textContent = line(logic.categories.domestic);
  }

  function setLink(a, url, fake, long = false, trip = null) {
    // Signed-in owners get a Buy button that opens the booking sheet instead of a link out.
    if (trip && canBook()) {
      a.textContent = "Buy";
      a.removeAttribute("aria-disabled");
      a.href = "#browse";
      a.onclick = (e) => { e.preventDefault(); openBook(trip); };
      a.title = "";
      return;
    }
    a.onclick = null;
    const u = safeUrl(url);
    a.textContent = isGoogle(u) ? (long ? "Search Google Flights" : "Search") : (long ? "Book with the airline" : "Book");
    if (u) { a.href = u; a.removeAttribute("aria-disabled"); }
    else { a.removeAttribute("href"); a.setAttribute("aria-disabled", "true"); }
    a.title = fake ? "Test fare: the search link won't show this price" : "";
  }

  const tripOf = (d) => ({ origin: d.origin, destination: d.destination, origin_city: d.origin_city,
    destination_city: d.destination_city, depart: d.depart_date, ret: d.return_date });

  function row(d) {
    const n = $("#row-tpl").content.firstElementChild.cloneNode(true);
    $(".o", n).textContent = d.origin;
    $(".d", n).textContent = d.destination;
    $(".city", n).textContent = d.destination_city;
    const how = d.estimate
      ? (d.airlines.length ? `${d.airlines.join(", ")} · Google price` : "price calendar estimate")
      : `${stopsPair(d)} · ${d.airlines.join(", ") || "—"}`;
    $(".dr-when", n).textContent = `${short(d.depart_date)} – ${short(d.return_date)} · ${d.trip_days} days · ${how}`;
    const usual = $(".dr-usual", n);
    if (d.pinged && d.ping_reason) {
      const why = document.createElement("span");
      why.className = "why";
      why.textContent = `Pinged: ${d.ping_reason}`;
      usual.append(why);
    } else if (d.typical) {
      usual.textContent = `Usually $${Math.round(d.typical.low)}–$${Math.round(d.typical.high)} on this route`;
    } else {
      usual.textContent = "Still learning this route's usual price";
    }
    const price = $(".dr-price", n);
    if (d.pinged) {
      const dot = document.createElement("span");
      dot.className = "ping-dot";
      dot.title = "Pinged";
      price.append(dot);
      n.classList.add("pinged");
    }
    price.append(money(d.price));
    setLink($("a", n), d.booking_url, d.is_fake, false, d.is_fake ? null : tripOf(d));
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

  // ---------------- recently checked ----------------
  const monthDay = (iso) => fmt(iso, { month: "short", day: "numeric" });

  async function loadChecks() {
    let checks = [];
    try { checks = (await (await fetch("/api/checks?limit=12")).json()).checks ?? []; } catch { /* empty */ }
    $("#checks").replaceChildren(...checks.map((c) => {
      const li = document.createElement("li");
      li.className = "row";
      const cell = (cls, ...kids) => {
        const s = document.createElement("span");
        s.className = cls;
        s.append(...kids);
        return s;
      };
      const txt = (cls, t) => { const s = document.createElement("span"); s.className = cls; s.textContent = t; return s; };
      const codes = txt("codes", "");
      const o = document.createElement("b"); o.textContent = c.origin;
      const d = document.createElement("b"); d.textContent = c.destination;
      codes.append(o, txt("arrow", "→"), d);
      const under = c.cheapest !== null && c.limit !== null && c.cheapest < c.limit;
      li.append(
        cell("k-route", codes, txt("city", c.destination_city)),
        cell("k-dates", txt("dates", `${monthDay(c.window_start)} – ${monthDay(c.window_end)}`),
          txt("sub", `${c.stay_days}-day trips`)),
        cell("k-price num", txt(under ? "under" : "over", c.cheapest === null ? "no fares" : money(c.cheapest)),
          txt("sub", c.cheapest_date ? `leaving ${short(c.cheapest_date)}` : ""), ...buyButton(c)),
        cell("k-limit num", txt("sub", c.limit ? money(c.limit) : "—")),
        cell("k-when num", txt("sub", ago(c.checked_at))),
      );
      return li;
    }));
    $("#checks-empty").hidden = checks.length > 0;
  }

  // ---------------- route search ----------------
  function option(value, label) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  }

  function setupSearch(m) {
    const form = $("#search-form");
    if (!m.search?.enabled) {
      $("#s-msg").textContent = "Route search turns on once live fares are connected.";
      $$("select, button", form).forEach((el) => { el.disabled = true; });
    }
    $("#cache-hours").textContent = m.search?.cache_hours ?? 12;
    $("#search-left").textContent = m.search?.left_today ?? m.search?.per_day ?? 15;
    $("#s-from").replaceChildren(...m.origins.map((o) => option(o.code, `${o.city} (${o.code})`)));
    const to = $("#s-to");
    const group = (label, kind) => {
      const g = document.createElement("optgroup");
      g.label = label;
      g.append(...m.destination_list.filter((d) => d.kind === kind)
        .sort((a, b) => a.city.localeCompare(b.city)).map((d) => option(d.code, `${d.city} (${d.code})`)));
      return g;
    };
    to.replaceChildren(group("United States", "domestic"), group("Abroad", "international"));
    const months = [];
    const now = new Date();
    for (let i = 0; i < 10; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      const ym = d.toISOString().slice(0, 7);
      months.push(option(ym, d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })));
    }
    $("#s-month").replaceChildren(...months);
    $("#s-month").selectedIndex = 1; // next month by default
    $("#s-stay").replaceChildren(...Array.from({ length: m.max_trip_days }, (_, i) => i + 1)
      .filter((n) => n >= 2).map((n) => option(String(n), `${n} days`)));
    $("#s-stay").value = "7";
  }

  function wireSearch() {
    $("#search-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("#s-go");
      const msg = $("#s-msg");
      msg.className = "s-msg";
      msg.textContent = "Checking every date in that month…";
      btn.disabled = true;
      try {
        const r = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ origin: $("#s-from").value, destination: $("#s-to").value,
            month: $("#s-month").value, stay_days: Number($("#s-stay").value) }),
        });
        const data = await r.json().catch(() => ({}));
        if (!data.ok) {
          msg.textContent = data.error || "That search didn't go through. Try again in a minute.";
          msg.classList.add("err");
          return;
        }
        msg.textContent = "";
        renderCalendar(data);
        $("#search-left").textContent = data.searches_left_today;
        loadChecks();
      } catch {
        msg.textContent = "Couldn't reach the server. Check your connection and try again.";
        msg.classList.add("err");
      } finally {
        btn.disabled = false;
      }
    });
  }

  function renderCalendar(data) {
    const priced = data.days.filter((x) => x.p !== null);
    const min = priced.length ? Math.min(...priced.map((x) => x.p)) : null;
    const cheap = priced.length ? [...priced].sort((a, b) => a.p - b.p)[Math.min(4, priced.length - 1)].p : null;
    const best = priced.find((x) => x.p === min);
    const summary = $("#s-summary");
    summary.replaceChildren();
    const strong = (t) => { const b = document.createElement("b"); b.textContent = t; return b; };
    summary.append(`${data.origin_city} → ${data.destination_city}, ${data.stay_days}-day trips: `);
    if (best) {
      summary.append("cheapest ", strong(money(best.p)), ` leaving ${short(best.d)}. `);
      summary.append(best.p < data.limit
        ? strong(`That's under the ${money(data.limit)} limit.`)
        : `The alert limit for this route is ${money(data.limit)}.`);
    } else {
      summary.append("no fares found for those dates.");
    }

    const cal = $("#s-cal");
    const cells = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => {
      const s = document.createElement("span");
      s.className = "dow";
      s.textContent = d;
      s.setAttribute("aria-hidden", "true");
      return s;
    });
    const lead = data.days.length ? new Date(`${data.days[0].d}T12:00:00Z`).getUTCDay() : 0;
    for (let i = 0; i < lead; i++) {
      const g = document.createElement("span");
      g.className = "day gap";
      g.setAttribute("aria-hidden", "true");
      cells.push(g);
    }
    for (const x of data.days) {
      const owner = canBook() && x.p !== null;
      const el = document.createElement(owner ? "button" : x.p !== null && /^https:\/\//.test(x.url) ? "a" : "span");
      if (owner) {
        el.type = "button";
        el.addEventListener("click", () => openBook({ origin: data.origin, destination: data.destination,
          origin_city: data.origin_city, destination_city: data.destination_city, depart: x.d, ret: x.r }));
      }
      el.className = "day";
      el.setAttribute("role", "listitem");
      if (x.p === null) el.classList.add("none");
      else if (x.p < data.limit) el.classList.add("deal");
      else if (x.p === min) el.classList.add("min");
      else if (cheap !== null && x.p <= cheap) el.classList.add("low");
      if (el.tagName === "A") { el.href = x.url; el.target = "_blank"; el.rel = "noopener"; }
      if (owner) el.title = "Book this date";
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = fmt(x.d, { month: "short", day: "numeric" });
      const p = document.createElement("span");
      p.className = "p";
      p.textContent = x.p === null ? "—" : money(x.p);
      el.append(n, p);
      el.setAttribute("aria-label", `${short(x.d)}: ${x.p === null ? "no fare" : money(x.p)}`);
      cells.push(el);
    }
    cal.replaceChildren(...cells);
    $("#s-foot").textContent = `${data.cached ? "Saved result" : "Checked live"} ${ago(data.checked_at)}. `
      + "Prices are Ignav's estimates for the cheapest fare that day; tap a date to see it on Google Flights.";
    $("#s-results").hidden = false;
  }

  // ---------------- owner sign-in ----------------
  state.me = { signed_in: false };
  const canBook = () => !!state.me.signed_in;
  const title = (s) => s.charAt(0) + s.slice(1).toLowerCase();

  async function loadMe() {
    try { state.me = await (await fetch("/api/me", { credentials: "same-origin" })).json(); } catch { /* signed out */ }
    const btn = $("#account-btn");
    btn.replaceChildren();
    if (state.me.signed_in) {
      const who = document.createElement("span");
      who.className = "acct-who";
      who.textContent = `${title(state.me.name)} · `;
      btn.append(who, "Account");
    } else {
      btn.textContent = "Sign in";
    }
    if (location.hash === "#account") renderAccount();
  }

  function buyButton(c) {
    if (!canBook() || !c.cheapest_date) return [];
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn small buy-small";
    b.textContent = "Buy";
    b.style.marginTop = "4px";
    b.addEventListener("click", () => openBook({ origin: c.origin, destination: c.destination, origin_city: c.origin_city,
      destination_city: c.destination_city, depart: c.cheapest_date, ret: c.cheapest_return }));
    return [b];
  }

  function wireAccount() {
    const openSignin = () => { $("#signin-msg").textContent = ""; $("#signin-dlg").showModal(); };
    $("#account-btn").addEventListener("click", () => {
      if (state.me.signed_in) location.hash = "#account";
      else openSignin();
    });
    $("#acct-signin").addEventListener("click", openSignin);
    $("#acct-signout").addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
      location.hash = "#browse";
      location.reload();
    });
    $("#signin-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = $("#signin-email");
      const msg = $("#signin-msg");
      msg.className = "form-msg";
      if (!email.value || !email.checkValidity()) {
        msg.textContent = "Enter your email address.";
        msg.classList.add("err");
        return;
      }
      const btn = $("button[type=submit]", e.target);
      btn.disabled = true;
      try {
        const r = await fetch("/api/login", { method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email.value.trim() }) });
        const data = await r.json().catch(() => ({}));
        msg.textContent = data.ok
          ? "If that email can book on this site, a sign-in link is on its way. It works for 20 minutes."
          : data.error || "That didn't go through. Try again.";
        msg.classList.add(data.ok ? "ok" : "err");
      } catch {
        msg.textContent = "Couldn't reach the server.";
        msg.classList.add("err");
      } finally { btn.disabled = false; }
    });
    wireBooking();
  }

  // ---------------- booking sheet ----------------
  let trip = null, offers = [], chosen = null;
  const hm = (s) => (s || "").slice(11, 16);
  const dur = (iso) => {
    const m = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(iso || "");
    return m ? `${m[1] ? `${m[1]}h` : ""}${m[1] && m[2] ? " " : ""}${m[2] ? `${m[2]}m` : ""}` : "";
  };

  function openBook(t) {
    if (!t.ret || t.ret <= t.depart) {
      const d = new Date(`${t.depart}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 7);
      t = { ...t, ret: d.toISOString().slice(0, 10) };
    }
    trip = t;
    offers = [];
    chosen = null;
    const b = state.me.booking || {};
    $("#book-title").textContent = `${t.origin_city || t.origin} → ${t.destination_city || t.destination}`;
    $("#b-depart").value = t.depart;
    $("#b-return").value = t.ret;
    $("#b-depart").min = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    $("#b-pct").textContent = b.max_price_increase_percent ?? 5;
    const g = $("#b-google");
    g.href = `https://www.google.com/travel/flights?q=${encodeURIComponent(
      `Flights from ${t.origin} to ${t.destination} on ${t.depart} through ${t.ret}`)}`;

    const mode = $("#book-mode");
    mode.hidden = b.test_mode === null || b.test_mode === undefined;
    mode.className = `mode-note${b.test_mode === false ? " live" : ""}`;
    mode.textContent = b.test_mode
      ? "Test mode: bookings go to Duffel's test system. Flights are fake and no money moves."
      : "Live mode: purchases are real and charged to your Duffel balance.";

    const problems = [];
    if (!b.duffel) problems.push("Add your Duffel access token as the <code>DUFFEL_ACCESS_TOKEN</code> secret in Cloudflare.");
    if (!b.enabled) problems.push("Purchasing is switched off in <code>config.json</code> (<code>booking_enabled</code>).");
    if (!(b.travelers || []).some((x) => x.ready)) {
      problems.push('Add traveler details on your <a href="#account" data-close>Account page</a>.');
    }
    const setup = $("#book-setup");
    setup.hidden = !problems.length;
    setup.innerHTML = problems.length ? `<b>Before you can buy:</b><br>${problems.join("<br>")}` : "";

    $("#b-travelers").replaceChildren(...(b.travelers || []).map((x) => {
      const l = document.createElement("label");
      l.className = `chk${x.ready ? "" : " off"}`;
      const i = document.createElement("input");
      i.type = "checkbox";
      i.value = x.name;
      i.disabled = !x.ready;
      i.checked = x.ready && x.name === state.me.name;
      l.append(i, ` ${title(x.name)}${x.ready ? "" : " (no details)"}`);
      return l;
    }));
    $("#b-find").disabled = !!problems.length && !b.duffel;
    $("#b-msg").textContent = "";
    $("#b-offers").replaceChildren();
    $("#b-confirm").hidden = true;
    $("#b-result").textContent = "";
    $("#book-dlg").showModal();
  }

  const travelersPicked = () => $$("#b-travelers input:checked").map((i) => i.value);

  async function post(url, body) {
    const r = await fetch(url, { method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return r.json().catch(() => ({ ok: false, error: "Unexpected response." }));
  }

  function wireBooking() {
    // Links inside the sheet (e.g. "Account page") close it before navigating.
    $("#book-setup").addEventListener("click", (e) => {
      if (e.target.closest("a[data-close]")) $("#book-dlg").close();
    });
    $("#book-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = $("#b-msg");
      msg.className = "s-msg";
      const travelers = travelersPicked();
      if (!travelers.length) { msg.textContent = "Pick who's flying."; msg.classList.add("err"); return; }
      trip.depart = $("#b-depart").value;
      trip.ret = $("#b-return").value;
      $("#b-find").disabled = true;
      $("#b-confirm").hidden = true;
      $("#b-result").textContent = "";
      msg.textContent = "Getting live fares from the airlines…";
      try {
        const data = await post("/api/offers", { origin: trip.origin, destination: trip.destination,
          depart_date: trip.depart, return_date: trip.ret, travelers });
        if (!data.ok) { msg.textContent = data.error; msg.classList.add("err"); return; }
        offers = data.offers;
        trip.travelers = travelers;
        msg.textContent = offers.length ? `${offers.length} options, cheapest first. Prices are for ${travelers.length === 1 ? "one person" : `${travelers.length} people`}, round trip.`
          : "No bookable flights for those dates. Try other dates.";
        renderOffers();
      } catch {
        msg.textContent = "Couldn't reach the server.";
        msg.classList.add("err");
      } finally { $("#b-find").disabled = false; }
    });

    $("#b-buy").addEventListener("click", async () => {
      if (!chosen) return;
      const btn = $("#b-buy");
      const out = $("#b-result");
      btn.disabled = true;
      out.className = "b-result";
      out.textContent = "Re-checking the price and booking…";
      try {
        const data = await post("/api/book", { offer_id: chosen.id, travelers: trip.travelers, expected_total: chosen.total,
          origin: trip.origin, destination: trip.destination, depart_date: trip.depart, return_date: trip.ret });
        out.textContent = data.message || data.error || "Something went wrong.";
        out.classList.add(data.ok ? "ok" : "err");
        if (data.ok) { $("#b-confirm").hidden = true; $("#b-offers").replaceChildren(); }
      } catch {
        out.textContent = "Couldn't reach the server. Check your email and the Duffel dashboard before trying again.";
        out.classList.add("err");
      } finally { btn.disabled = false; }
    });
  }

  function renderOffers() {
    const list = $("#b-offers");
    list.setAttribute("role", "radiogroup");
    list.replaceChildren(...offers.map((o) => {
      const li = document.createElement("li");
      li.className = "offer";
      li.setAttribute("role", "radio");
      li.setAttribute("aria-checked", "false");
      li.tabIndex = 0;
      const legs = document.createElement("div");
      legs.className = "legs";
      for (const s of o.slices) {
        const leg = document.createElement("div");
        leg.className = "leg";
        const when = document.createElement("b");
        when.textContent = `${fmt(s.depart_at.slice(0, 10), { weekday: "short", month: "short", day: "numeric" })} `
          + `${hm(s.depart_at)} → ${hm(s.arrive_at)}`;
        const info = document.createElement("span");
        info.className = "sub";
        info.textContent = `${s.from}–${s.to} · ${dur(s.duration)} · ${stops(s.stops)} · ${s.flights.join(", ")}`;
        leg.append(when, info);
        legs.append(leg);
      }
      const price = document.createElement("div");
      price.className = "o-price";
      const b = document.createElement("b");
      b.textContent = cents(o.total);
      const sp = document.createElement("span");
      sp.textContent = o.currency === "USD" ? "total" : o.currency;
      price.append(b, sp);
      const meta = document.createElement("div");
      meta.className = "o-meta";
      meta.textContent = [o.airline,
        o.refundable === true ? "refundable" : o.refundable === false ? "nonrefundable" : "refund rules unknown",
        o.changeable === true ? "changes allowed" : o.changeable === false ? "no changes" : null,
        o.needs_passport ? "needs passport details" : null].filter(Boolean).join(" · ");
      li.append(legs, price, meta);
      const pick = () => {
        chosen = o;
        $$(".offer", list).forEach((x) => x.setAttribute("aria-checked", String(x === li)));
        showConfirm();
      };
      li.addEventListener("click", pick);
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
      return li;
    }));
  }

  function showConfirm() {
    const o = chosen;
    const who = trip.travelers.map(title).join(" and ");
    $("#b-summary").textContent = `${trip.origin_city || trip.origin} → ${trip.destination_city || trip.destination}, `
      + `${short(trip.depart)} to ${short(trip.ret)}, for ${who}. ${o.airline}. Total ${cents(o.total)}.`;
    const terms = [
      o.refundable === true ? "Refundable before departure (airline penalties may apply)." : "Likely nonrefundable.",
      o.changeable === true ? "Changes allowed before departure (fees may apply)." : "Changes may not be allowed.",
      o.needs_passport ? "This airline needs passport details for every traveler." : null,
      o.test_mode ? "Test mode: no money moves." : "This charges your Duffel balance.",
    ].filter(Boolean);
    $("#b-terms").replaceChildren(...terms.map((t) => { const li = document.createElement("li"); li.textContent = t; return li; }));
    $("#b-buy").textContent = `${o.test_mode ? "Test buy" : "Buy"} for ${cents(o.total)}`;
    $("#b-confirm").hidden = false;
    $("#b-result").textContent = "";
    $("#b-confirm").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // ---------------- account: traveler details ----------------
  async function renderAccount() {
    const signedIn = !!state.me.signed_in;
    $("#acct-signed-out").hidden = signedIn;
    $("#acct-signed-in").hidden = !signedIn;
    if (!signedIn) return;
    $("#acct-name").textContent = title(state.me.name);
    let data;
    try { data = await (await fetch("/api/profiles", { credentials: "same-origin" })).json(); } catch { data = null; }
    const list = $("#acct-list");
    if (!data?.ok) { list.textContent = "Couldn't load traveler details. Refresh to try again."; return; }
    // You first, then everyone else.
    const people = [...data.travelers].sort((a, b) => Number(b.is_you) - Number(a.is_you));
    list.replaceChildren(...people.map(travelerForm));
  }

  function travelerForm(t) {
    const form = $("#traveler-tpl").content.firstElementChild.cloneNode(true);
    $(".t-name", form).textContent = `${title(t.name)}${t.is_you ? " (you)" : ""}`;
    const status = $(".t-status", form);
    const setStatus = (src, at) => {
      status.className = "t-status";
      if (src === "account") {
        status.textContent = `Ready to book · saved ${ago(at)}`;
        status.classList.add("ready");
      } else if (src === "secret") {
        status.textContent = "Using the TRAVELERS_JSON secret. Save here to take over.";
      } else {
        status.textContent = "Not set up: can't be booked yet";
        status.classList.add("todo");
      }
    };
    setStatus(t.source, t.updated_at);
    const p = t.profile || {};
    for (const k of ["title", "given_name", "family_name", "born_on", "gender", "email", "phone_number",
      "passport_expires_on", "passport_country"]) {
      const el = form.elements[k];
      if (el && p[k]) el.value = p[k];
    }
    if (p.passport_number_hint) {
      form.elements.passport_number.placeholder = `${p.passport_number_hint} (saved)`;
      form.elements.passport_number.title = "Leave blank to keep the saved number";
    }
    if (!t.is_you && !t.can_sign_in) {
      const note = document.createElement("p");
      note.className = "t-note";
      note.innerHTML = `You can book for ${title(t.name)}. To let them sign in and book themselves, add their email `
        + `as the <code>CONTACT_${t.name}_EMAIL</code> secret in Cloudflare.`;
      $(".t-head", form).after(note);
    }
    const uid = `t-${t.name.toLowerCase()}`;
    $$("input, select", form).forEach((el) => { el.id = `${uid}-${el.name}`; });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = $(".t-msg", form);
      msg.className = "t-msg";
      msg.textContent = "Saving…";
      $$(".f-err", form).forEach((x) => { x.textContent = ""; });
      $$("[aria-invalid]", form).forEach((x) => x.removeAttribute("aria-invalid"));
      const body = Object.fromEntries(new FormData(form).entries());
      const btn = $("button[type=submit]", form);
      btn.disabled = true;
      try {
        const r = await fetch(`/api/profiles/${encodeURIComponent(t.name)}`, { method: "PUT", credentials: "same-origin",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = await r.json().catch(() => ({}));
        if (data.ok) {
          msg.textContent = "Saved.";
          msg.classList.add("ok");
          setStatus("account", new Date().toISOString());
          form.elements.passport_number.value = "";
          if (data.profile?.passport_number_hint) {
            form.elements.passport_number.placeholder = `${data.profile.passport_number_hint} (saved)`;
          }
          loadMe(); // booking sheet picks up the new traveler status
        } else {
          msg.textContent = data.error || "Couldn't save.";
          msg.classList.add("err");
          for (const [k, v] of Object.entries(data.fields || {})) {
            const err = $(`.f-err[data-for="${k}"]`, form);
            if (err) err.textContent = v;
            form.elements[k]?.setAttribute("aria-invalid", "true");
          }
          $("[aria-invalid=true]", form)?.focus();
        }
      } catch {
        msg.textContent = "Couldn't reach the server.";
        msg.classList.add("err");
      } finally { btn.disabled = false; }
    });
    return form;
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
          msg.textContent = data.status === "owner"
            ? "You're one of this site's owners, so you already get every deal alert, with Buy buttons. Nothing to sign up for."
            : data.status === "updated"
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

  // ---------------- logic panel ----------------
  // Mirrors settings.ts `describe` so the summary updates as you type.
  function describeRules(kind, c) {
    const label = kind === "domestic" ? "US trips" : "Trips abroad";
    const ping = c.alert.mode === "smart"
      ? `ping when a fare is at least ${c.alert.drop_percent}% below that route's usual price `
        + `(under $${c.alert.under} until we've seen ${c.alert.min_samples} prices for the route)`
      : `ping when a fare is under $${c.alert.under}`;
    return `${label}: show round trips leaving ${c.min_days_out} to ${c.max_days_out} days from now, `
      + `${c.min_trip_days} to ${c.max_trip_days} days long, under $${c.show_under}; ${ping}.`;
  }

  async function loadLogic() {
    try { state.logic = await (await fetch("/api/logic", { credentials: "same-origin" })).json(); } catch { state.logic = null; }
    renderColumnRules(state.logic);
    return state.logic;
  }

  function readCat(sec) {
    const v = (n) => Number($(`[name="${n}"]`, sec).value);
    return {
      min_days_out: v("min_days_out"), max_days_out: v("max_days_out"),
      min_trip_days: v("min_trip_days"), max_trip_days: v("max_trip_days"), show_under: v("show_under"),
      alert: { mode: $("input[type=radio]:checked", sec)?.value ?? "under", under: v("alert.under"),
               drop_percent: v("alert.drop_percent"), min_samples: v("alert.min_samples") },
    };
  }

  function catForm(kind, c, canEdit) {
    const sec = $("#logic-cat-tpl").content.firstElementChild.cloneNode(true);
    sec.dataset.kind = kind;
    $(".lc-title", sec).textContent = kind === "domestic" ? "Domestic" : "International";
    const set = (n, val) => { $(`[name="${n}"]`, sec).value = val; };
    set("min_days_out", c.min_days_out); set("max_days_out", c.max_days_out);
    set("min_trip_days", c.min_trip_days); set("max_trip_days", c.max_trip_days); set("show_under", c.show_under);
    set("alert.under", c.alert.under); set("alert.drop_percent", c.alert.drop_percent); set("alert.min_samples", c.alert.min_samples);
    $$("input[type=radio]", sec).forEach((r) => { r.name = `mode-${kind}`; r.checked = r.value === c.alert.mode; });
    $$("input", sec).forEach((el) => {
      el.disabled = !canEdit;
      if (el.type !== "radio") el.id = `${kind}-${el.name.replace(".", "-")}`;
    });
    const refresh = () => {
      const now = readCat(sec);
      $(".lc-summary", sec).textContent = describeRules(kind, now);
      $(".smart-only", sec).hidden = now.alert.mode !== "smart";
    };
    sec.addEventListener("input", refresh);
    sec.addEventListener("change", refresh);
    refresh();
    return sec;
  }

  async function renderLogic() {
    const logic = await loadLogic();
    if (!logic) { $("#logic-cats").textContent = "Couldn't load the rules. Refresh to try again."; return; }
    const canEdit = !!logic.can_edit;
    $("#logic-readonly").hidden = canEdit;
    $("#logic-save").hidden = !canEdit;
    $("#logic-reset").hidden = !canEdit || !logic.customized;
    $("#logic-cats").replaceChildren(catForm("international", logic.categories.international, canEdit),
      catForm("domestic", logic.categories.domestic, canEdit));
    $("#logic-updated").textContent = logic.customized && logic.updated_at
      ? `Last changed ${ago(logic.updated_at)} by ${title(logic.updated_by || "")}.`
      : "Using the default rules.";
    renderLearned();
  }

  async function renderLearned() {
    let routes = [];
    try { routes = (await (await fetch("/api/baselines")).json()).routes ?? []; } catch { /* empty */ }
    $("#learned").replaceChildren(...routes.map((b) => {
      const li = document.createElement("li");
      li.className = "row";
      const cell = (cls, text) => { const s = document.createElement("span"); s.className = cls; s.textContent = text; return s; };
      const route = document.createElement("span");
      const codes = document.createElement("span");
      codes.className = "codes";
      const o = document.createElement("b"); o.textContent = b.origin;
      const d = document.createElement("b"); d.textContent = b.destination;
      const arrow = document.createElement("span"); arrow.className = "arrow"; arrow.textContent = "→";
      codes.append(o, arrow, d);
      route.append(codes, cell("city", `${b.destination_city} · ${b.kind === "domestic" ? "US" : "abroad"}`));
      li.append(route, cell("num-c", `$${b.low}–$${b.high}`), cell("num-c l-typ", `$${b.median}`),
        cell("num-c l-n sub", `${b.samples}`));
      return li;
    }));
    $("#learned-empty").hidden = routes.length > 0;
  }

  function wireLogic() {
    $("#logic-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = $("#logic-msg");
      msg.className = "t-msg";
      msg.textContent = "Saving…";
      $$("#logic-cats .f-err").forEach((x) => { x.textContent = ""; });
      $$("#logic-cats [aria-invalid]").forEach((x) => x.removeAttribute("aria-invalid"));
      const body = {};
      $$("#logic-cats .logic-cat").forEach((sec) => { body[sec.dataset.kind] = readCat(sec); });
      try {
        const r = await fetch("/api/logic", { method: "PUT", credentials: "same-origin",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = await r.json().catch(() => ({}));
        if (data.ok) {
          msg.textContent = "Saved. New rules apply from the next search.";
          msg.classList.add("ok");
          await loadLogic();
          $("#logic-reset").hidden = false;
          $("#logic-updated").textContent = `Last changed just now by ${title(state.me.name || "")}.`;
          loadDeals();
        } else {
          msg.textContent = data.error || "Couldn't save.";
          msg.classList.add("err");
          for (const [kind, errs] of Object.entries(data.fields || {})) {
            const sec = $(`.logic-cat[data-kind="${kind}"]`);
            for (const [k, v] of Object.entries(errs)) {
              const err = $(`.f-err[data-for="${k}"]`, sec);
              if (err) err.textContent = v;
              $(`[name="${k}"]`, sec)?.setAttribute("aria-invalid", "true");
            }
          }
        }
      } catch {
        msg.textContent = "Couldn't reach the server.";
        msg.classList.add("err");
      }
    });
    $("#logic-reset").addEventListener("click", async () => {
      if (!confirm("Go back to the default rules?")) return;
      await fetch("/api/logic/reset", { method: "POST", credentials: "same-origin" }).catch(() => {});
      $("#logic-msg").textContent = "Back to the defaults.";
      await renderLogic();
      loadDeals();
    });
  }

  // ---------------- contact ----------------
  function wireContact() {
    const form = $("#contact-form");
    const msg = $("#contact-msg");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      const email = form.elements.email;
      const text = form.elements.message;
      email.setAttribute("aria-invalid", String(!email.checkValidity() || !data.email));
      text.setAttribute("aria-invalid", String(String(data.message).trim().length < 5));
      if (email.getAttribute("aria-invalid") === "true") { msg.className = "t-msg err"; msg.textContent = "Add your email so we can reply."; email.focus(); return; }
      if (text.getAttribute("aria-invalid") === "true") { msg.className = "t-msg err"; msg.textContent = "Write a message first."; text.focus(); return; }
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      msg.className = "t-msg";
      msg.textContent = "Sending…";
      try {
        const r = await fetch("/api/contact", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
        });
        const out = await r.json().catch(() => ({}));
        if (!r.ok || !out.ok) throw new Error(out.error || "Couldn't send that. Try again in a bit.");
        form.reset();
        msg.className = "t-msg ok";
        msg.textContent = "Sent. We'll reply to your email.";
      } catch (err) {
        msg.className = "t-msg err";
        msg.textContent = err.message;
      } finally { btn.disabled = false; }
    });
  }

  // ---------------- boot ----------------
  $("#year").textContent = new Date().getFullYear();
  wireContact();
  wireRadio($('[data-filter="origin"]'), (v) => { state.origin = v; loadDeals(); });
  wireRadio($('[data-filter="sort"]'), (v) => { state.sort = v; loadDeals(); });
  wireSignup();
  route();
  wireSearch();
  wireAccount();
  wireLogic();
  Promise.all([loadMeta(), loadMe(), loadLogic()]).then(() => Promise.all([loadDeals(), loadChecks()]));
})();
