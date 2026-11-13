// Fare Radar: deals for everyone; alerts, personal logic and route search for members.
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
  const isGoogle = (url) => typeof url === "string" && /^https:\/\/(www\.)?google\.com\/travel\/flights/.test(url);
  const googleUrl = (o, dst, dep, ret) => `https://www.google.com/travel/flights?q=${encodeURIComponent(
    `Flights from ${o} to ${dst} on ${dep} through ${ret}`)}`;
  const safeUrl = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u : null);

  const ago = (iso) => {
    const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
    const h = Math.round(mins / 60);
    return h < 24 ? `${h} hour${h === 1 ? "" : "s"} ago` : `${Math.round(h / 24)} days ago`;
  };
  const longDate = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const title = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : "");
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const flash = (node, text, kind) => { node.className = `${node.className.split(" ")[0]}${kind ? ` ${kind}` : ""}`; node.textContent = text; };

  // Remember where a visitor came from (first touch, 30 days) so sign-ups can be credited to a channel.
  try {
    const q = new URLSearchParams(location.search);
    const src = (q.get("utm_source") || q.get("ref") || "").toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 40);
    if (src && !/(?:^|; )fr_src=/.test(document.cookie)) {
      document.cookie = `fr_src=${src}; Max-Age=${30 * 86400}; Path=/; SameSite=Lax; Secure`;
    }
  } catch { /* cookies blocked */ }

  const state = { origin: "", sort: "value", meta: null, deals: [], me: { signed_in: false }, rules: null, note: null };
  const isMember = () => !!state.me.entitled;
  const isAdmin = () => state.me.role === "admin" && !state.me.must_change_password;
  /** Pro (paid) features are switched on for everyone only after launch; until then the site says "coming soon". */
  const proLive = () => !!state.meta?.billing?.launched;
  const canBook = () => state.me.role === "admin" && !!state.me.booking;

  // ---------------- API ----------------
  class ApiError extends Error { constructor(m, status, data) { super(m); this.status = status; this.data = data; } }
  async function api(path, method = "GET", data) {
    let r;
    try {
      r = await fetch(path, { method, credentials: "same-origin",
        headers: data !== undefined ? { "Content-Type": "application/json" } : {},
        body: data !== undefined ? JSON.stringify(data) : undefined });
    } catch { throw new ApiError("Couldn't reach the server. Check your connection and try again.", 0, {}); }
    const out = await r.json().catch(() => ({}));
    if (out.code === "must_change_password") openPw();
    if (!r.ok || out.ok === false) throw new ApiError(out.error || "That didn't go through. Try again.", r.status, out);
    return out;
  }
  /** Only ever send people to Stripe's own pages. */
  const stripeUrl = (u) => (typeof u === "string" && /^https:\/\/(checkout|billing)\.stripe\.com\//.test(u) ? u : null);

  // ---------------- routing ----------------
  const VIEWS = ["browse", "signup", "account", "logic", "admin", "about", "contact", "privacy", "terms", "accessibility"];
  function route() {
    const [want, query = ""] = location.hash.slice(1).split("?");
    const q = new URLSearchParams(query);
    // One-time tokens arrive in the URL fragment; read them, then wipe them from the address bar and history.
    if (want === "reset" || want === "verify") {
      const token = q.get("token") || "";
      history.replaceState(null, "", want === "reset" ? "#browse" : "#account");
      if (want === "reset") { state.resetToken = token; openAuth("reset"); }
      else verifyEmail(token);
      return route();
    }
    if (want.startsWith("deal=")) {
      history.replaceState(null, "", "#browse");
      openSharedDeal(decodeURIComponent(want.slice(5)));
      return route();
    }
    if (want === "signin") {
      history.replaceState(null, "", "#browse");
      const err = q.get("error");
      openAuth("signin", err ? ({ cancelled: "Sign-in was cancelled.", expired: "That took too long. Try again.",
        unavailable: "That sign-in option isn't available right now." }[err] || "Couldn't sign you in with that account. Try again.") : "");
      return route();
    }
    if (want === "account" && q.get("billing")) {
      history.replaceState(null, "", "#account");
      if (q.get("billing") === "success") syncBilling();
      else state.note = "Checkout was cancelled. Nothing was charged.";
    }
    const tab = VIEWS.includes(want) ? want : "browse";
    for (const v of VIEWS) $(`#view-${v}`).hidden = v !== tab;
    const h = tab === "browse" ? "" : $(`#view-${tab} h1`).textContent;
    document.title = !h || h.includes("Fare Radar") ? h || "Fare Radar" : `${h} · Fare Radar`;
    if (tab === "account") renderAccount();
    if (tab === "logic") renderLogic();
    if (tab === "signup") renderAlerts();
    if (tab === "admin") renderAdmin();
    $(".segmented").dataset.active = tab;
    $$(".segmented a").forEach((a) => (a.dataset.tab === tab
      ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    if (want === "deals") $("#deals").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
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
  async function loadMeta() {
    try {
      const m = await (await fetch("/api/meta")).json();
      state.meta = m;
      document.body.classList.toggle("pro-soon", !m.billing?.launched);
      $("#n-dest").textContent = m.destinations;
      $("#last-checked").textContent = m.last_checked_at ? `Fares updated ${ago(m.last_checked_at)}` : "";
      $("#demo-note").hidden = !m.demo;
      setupSearch(m);
      $('[data-filter="origin"]').replaceChildren(segButton("", "SEA + PDX", true, "radio"),
        ...m.origins.map((o) => segButton(o.code, o.code, false, "radio")));
      $$(".st-dest").forEach((x) => { x.textContent = m.destinations; });
      renderStats(m.stats);
      renderPlanCta();
      const providers = m.auth?.providers || [];
      $("#oauth-google").hidden = !providers.includes("google");
      $("#oauth-apple").hidden = !providers.includes("apple");
      $("#oauth-buttons").hidden = !providers.length;
    } catch {
      $("#last-checked").textContent = "";
    }
  }

  /** Real numbers only; hidden until there's something worth saying. */
  function renderStats(s) {
    const box = $("#stats");
    if (!s || !s.deals_30d) { box.hidden = true; return; }
    box.replaceChildren();
    const stat = (n, label) => { const d = el("span", "stat"); d.append(el("b", "", n), el("span", "", label)); return d; };
    box.append(stat(String(s.deals_30d), "deals found in the last 30 days"));
    if (s.avg_below_usual_pct) box.append(stat(`${s.avg_below_usual_pct}%`, "below the usual price, on average"));
    if (s.routes_tracked) box.append(stat(String(s.routes_tracked), "routes whose prices we track"));
    box.hidden = false;
  }

  /** The member plan's button does the next sensible thing for whoever's looking. */
  function renderPlanCta() {
    const b = $("#plan-cta");
    if (!b) return;
    $(".plan:not(.plan-member) .btn").hidden = !!state.me.signed_in;
    if (isMember()) {
      b.textContent = state.me.role === "admin" ? "You have full access" : state.me.role === "tester" ? "You're a beta tester" : "You're a member";
      b.disabled = true; return;
    }
    if (!proLive()) {
      b.disabled = !!state.me.pro_waitlist;
      b.textContent = !state.me.signed_in ? "Create a free account" : state.me.pro_waitlist ? "You're on the list ✓" : "Notify me when Pro launches";
      return;
    }
    b.disabled = false;
    b.textContent = ctaLabel();
  }

  // ---------------- deals ----------------
  let reqId = 0;
  const COLS = { international: ["#rows-intl", "#empty-intl", "#rule-intl"], domestic: ["#rows-dom", "#empty-dom", "#rule-dom"] };
  const VISIBLE_ROWS = 10;

  async function loadDeals() {
    const id = ++reqId;
    $("#board").classList.add("loading");
    const fetchKind = async (kind) => {
      const q = new URLSearchParams({ sort: state.sort, limit: "60", kind });
      if (state.origin) q.set("origin", state.origin);
      try { return (await (await fetch(`/api/deals?${q}`, { credentials: "same-origin" })).json()).deals ?? []; } catch { return []; }
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
        : "Nothing fits right now. Fares like that come and go; this list updates every hour.";
      const count = $(`#count-${kind === "international" ? "intl" : "dom"}`);
      count.textContent = deals.length ? `${deals.length} deal${deals.length === 1 ? "" : "s"}` : "";
    }
    fitColumns();
    renderPreview(state.deals.filter((d) => d.pinged).concat(state.deals));
  }

  /** Each column shows 10 deals; the rest scroll inside the card. */
  function fitColumns() {
    for (const [rows] of Object.values(COLS)) {
      const list = $(rows);
      const items = [...list.children];
      const more = list.parentElement.querySelector(".col-more");
      if (items.length > VISIBLE_ROWS) {
        list.style.maxHeight = `${items.slice(0, VISIBLE_ROWS).reduce((h, r) => h + r.offsetHeight, 0)}px`;
        list.classList.add("scrolls");
        more.hidden = false;
        more.textContent = `Scroll for ${items.length - VISIBLE_ROWS} more`;
      } else {
        list.style.maxHeight = "";
        list.classList.remove("scrolls");
        more.hidden = true;
      }
    }
  }
  let fitTimer;
  window.addEventListener("resize", () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitColumns, 150); });
  $$(".deal-list").forEach((list) => list.addEventListener("scroll", () => {
    const more = list.parentElement.querySelector(".col-more");
    if (more) more.classList.toggle("done", list.scrollTop + list.clientHeight >= list.scrollHeight - 4);
  }));

  /** One-line rule under each column header: your own rules if you're a member, else the site's. */
  function renderColumnRules() {
    const cats = state.rules || state.meta?.rules;
    if (!cats) return;
    const line = (c) => {
      const ping = c.alert.mode === "smart" ? `alerts at ${c.alert.drop_percent}%+ below usual` : `alerts under $${c.alert.under}`;
      return `${c.min_days_out}+ days out · ${c.min_trip_days}–${c.max_trip_days} day trips · under $${c.show_under} · ${ping}`;
    };
    $(COLS.international[2]).textContent = line(cats.international);
    $(COLS.domestic[2]).textContent = line(cats.domestic);
    $("#rules-whose").textContent = state.rules ? "Showing deals by your own rules." : "";
  }

  const tripOf = (d) => ({ origin: d.origin, destination: d.destination, origin_city: d.origin_city,
    destination_city: d.destination_city, depart: d.depart_date, ret: d.return_date });

  function row(d) {
    const n = $("#row-tpl").content.firstElementChild.cloneNode(true);
    $(".o", n).textContent = d.origin;
    $(".d", n).textContent = d.destination;
    $(".city", n).textContent = d.destination_city;
    const how = d.estimate
      ? (d.airlines.length ? `${airlineNames(d.airlines)} · estimate` : "price estimate")
      : `${stopsPair(d)} · ${airlineNames(d.airlines) || "—"}`;
    $(".dr-when", n).textContent = `${short(d.depart_date)} – ${short(d.return_date)} · ${d.trip_days} days · ${how}`;
    const usual = $(".dr-usual", n);
    if (d.pinged && d.ping_reason) usual.append(el("span", "why", `Deal: ${d.ping_reason}`));
    else if (d.typical) usual.textContent = `Usually $${Math.round(d.typical.low)}–$${Math.round(d.typical.high)} on this route`;
    else usual.textContent = "Still learning this route's usual price";
    const price = $(".dr-price", n);
    if (d.pinged) {
      const dot = el("span", "ping-dot");
      dot.title = "Worth an alert";
      price.append(dot);
      n.classList.add("pinged");
    }
    price.append(money(d.price));
    const btn = $(".dr-open", n);
    btn.setAttribute("aria-label", `${d.origin_city} to ${d.destination_city}, ${money(d.price)}, ${short(d.depart_date)} to ${short(d.return_date)}. Show details`);
    btn.addEventListener("click", () => openDeal(d));
    return n;
  }

  // ---------------- one deal, at a glance ----------------
  const AIRLINES = {
    AS: ["Alaska Airlines", "https://www.alaskaair.com"], DL: ["Delta", "https://www.delta.com"],
    UA: ["United", "https://www.united.com"], AA: ["American Airlines", "https://www.aa.com"],
    WN: ["Southwest", "https://www.southwest.com"], B6: ["JetBlue", "https://www.jetblue.com"],
    F9: ["Frontier", "https://www.flyfrontier.com"], NK: ["Spirit", "https://www.spirit.com"],
    G4: ["Allegiant", "https://www.allegiantair.com"], HA: ["Hawaiian Airlines", "https://www.hawaiianairlines.com"],
    SY: ["Sun Country", "https://www.suncountry.com"], MX: ["Breeze", "https://www.flybreeze.com"],
    XP: ["Avelo", "https://www.aveloair.com"], AC: ["Air Canada", "https://www.aircanada.com"],
    WS: ["WestJet", "https://www.westjet.com"], PD: ["Porter", "https://www.flyporter.com"],
    TS: ["Air Transat", "https://www.airtransat.com"], Y4: ["Volaris", "https://www.volaris.com"],
    AM: ["Aeroméxico", "https://www.aeromexico.com"], VB: ["Viva Aerobus", "https://www.vivaaerobus.com"],
    CM: ["Copa Airlines", "https://www.copaair.com"], AV: ["Avianca", "https://www.avianca.com"],
    LA: ["LATAM", "https://www.latamairlines.com"], JL: ["Japan Airlines", "https://www.jal.co.jp/en/"],
    NH: ["ANA", "https://www.ana.co.jp/en/us/"], ZG: ["ZIPAIR", "https://www.zipair.net/en"],
    KE: ["Korean Air", "https://www.koreanair.com"], OZ: ["Asiana", "https://flyasiana.com"],
    BR: ["EVA Air", "https://www.evaair.com"], CI: ["China Airlines", "https://www.china-airlines.com"],
    CX: ["Cathay Pacific", "https://www.cathaypacific.com"], SQ: ["Singapore Airlines", "https://www.singaporeair.com"],
    PR: ["Philippine Airlines", "https://www.philippineairlines.com"], BA: ["British Airways", "https://www.britishairways.com"],
    VS: ["Virgin Atlantic", "https://www.virginatlantic.com"], LH: ["Lufthansa", "https://www.lufthansa.com"],
    AF: ["Air France", "https://www.airfrance.us"], KL: ["KLM", "https://www.klm.us"],
    IB: ["Iberia", "https://www.iberia.com"], EI: ["Aer Lingus", "https://www.aerlingus.com"],
    FI: ["Icelandair", "https://www.icelandair.com"], SK: ["SAS", "https://www.flysas.com"],
    LX: ["SWISS", "https://www.swiss.com"], TP: ["TAP Air Portugal", "https://www.flytap.com"],
    AY: ["Finnair", "https://www.finnair.com"], DE: ["Condor", "https://www.condor.com"],
    TK: ["Turkish Airlines", "https://www.turkishairlines.com"], EK: ["Emirates", "https://www.emirates.com"],
    QR: ["Qatar Airways", "https://www.qatarairways.com"], NZ: ["Air New Zealand", "https://www.airnewzealand.com"],
    QF: ["Qantas", "https://www.qantas.com"], FJ: ["Fiji Airways", "https://www.fijiairways.com"],
  };
  /** "flyfrontier.com" → "Frontier", else the bare host name. */
  function siteName(url) {
    let host = "";
    try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { return "the booking site"; }
    for (const [name, home] of Object.values(AIRLINES)) {
      try { if (new URL(home).hostname.replace(/^www\./, "") === host) return name; } catch { /* skip */ }
    }
    return host;
  }
  const airlineNames = (codes) => (codes || []).map((c) => AIRLINES[c]?.[0] || c).join(", ");

  function openDeal(d) {
    const dlg = $("#deal-dlg");
    $("#deal-kind").textContent = `${d.kind === "international" ? "International" : "Domestic"}${d.pinged ? " · worth an alert" : ""}`;
    $("#deal-title").textContent = `${d.origin_city} → ${d.destination_city}`;
    $("#deal-codes").textContent = `${d.origin} → ${d.destination}`;
    $("#deal-price").textContent = money(d.price);
    const save = $("#deal-save");
    const med = d.typical?.median;
    // The reason line already says "% below the usual" for those; don't say it twice.
    save.hidden = !(med && d.price < med) || /below the usual/.test(d.ping_reason || "");
    if (med && d.price < med) {
      save.textContent = `${money(med - d.price)} below the usual ${money(med)} for this route (${Math.round((1 - d.price / med) * 100)}% off)`;
    }
    state.openDealCode = d.code;
    $("#deal-share").textContent = "Share";
    const why = $("#deal-why");
    why.hidden = !(d.pinged && d.ping_reason);
    why.textContent = d.ping_reason ? `Why it's a deal: ${d.ping_reason}` : "";
    $("#deal-depart").textContent = short(d.depart_date);
    $("#deal-return").textContent = short(d.return_date);
    $("#deal-days").textContent = `${d.trip_days} days`;
    $("#deal-airline").textContent = airlineNames(d.airlines) || "Shown when you open the fare";
    $("#deal-stops").textContent = d.estimate ? "Shown when you open the fare" : stopsPair(d);
    $("#deal-usual").textContent = d.typical
      ? `$${Math.round(d.typical.low)}–$${Math.round(d.typical.high)} (typically $${Math.round(d.typical.median)})`
      : "Still learning this route";
    $("#deal-note").textContent = d.is_fake ? "This is a test fare, not a real flight."
      : d.estimate ? "This price comes from a fare calendar or Google's explore view. The exact fare and flight times show when you open it." : "";
    $("#deal-found-line").textContent = `Found ${ago(d.found_at)}.`;

    // Buttons go where their labels say: "Google Flights" is always Google (for this exact route and
    // dates); a provider's deep link to an airline or agency is labeled with that site's own name.
    const first = (d.airlines || []).find((c) => AIRLINES[c]);
    const deep = safeUrl(d.booking_url) && !isGoogle(d.booking_url) ? d.booking_url : null;
    const air = $("#deal-airline-btn");
    if (!d.is_fake && deep) {
      air.hidden = false;
      air.textContent = `Book on ${siteName(deep)}`;
      air.href = deep;
    } else if (!d.is_fake && first && new Set(d.airlines).size === 1) {
      air.hidden = false;
      air.textContent = `Go to ${AIRLINES[first][0]}`;
      air.href = AIRLINES[first][1];
    } else air.hidden = true;
    const g = $("#deal-google-btn");
    g.href = safeUrl(d.booking_url) && isGoogle(d.booking_url) ? d.booking_url : googleUrl(d.origin, d.destination, d.depart_date, d.return_date);
    g.className = air.hidden ? "btn primary" : "btn glass-btn";
    const buy = $("#deal-buy");
    buy.hidden = !(canBook() && !d.is_fake);
    buy.onclick = () => { dlg.close(); openBook(tripOf(d)); };
    dlg.showModal();
  }

  /** Opens a deal someone shared (#deal=CODE). */
  async function openSharedDeal(code) {
    if (!/^[A-Za-z0-9]{2,24}$/.test(code)) return;
    try {
      const out = await api(`/api/deal?code=${encodeURIComponent(code)}`);
      openDeal(out.deal);
      if (out.stale) $("#deal-found-line").textContent = `Found ${ago(out.deal.found_at)}, so the price has probably changed.`;
    } catch (e) {
      $("#last-checked").textContent = e.status === 404 ? "That shared deal has expired. Here's what's cheap right now." : "";
    }
  }

  function wireDealCard() {
    const dlg = $("#share-dlg");
    let shareText = "";
    $("#deal-share").addEventListener("click", () => {
      const url = `${location.origin}/#deal=${encodeURIComponent(state.openDealCode || "")}`;
      const title = $("#deal-title").textContent;
      shareText = `${title} for ${$("#deal-price").textContent} round trip on Fare Radar`;
      $("#share-summary").textContent = `${shareText}. Anyone with the link can see it, no account needed.`;
      $("#share-url").value = url;
      $("#share-sms").href = `sms:?&body=${encodeURIComponent(`${shareText}: ${url}`)}`;
      $("#share-mail").href = `mailto:?subject=${encodeURIComponent(shareText)}&body=${encodeURIComponent(`Found this cheap flight:\n\n${shareText}\n${url}\n\nPrices move fast, so book soon if you want it.`)}`;
      $("#share-more").hidden = !navigator.share;
      flash($("#share-msg"), "");
      $("#share-copy").textContent = "Copy link";
      dlg.showModal();
      $("#share-url").select();
    });
    $("#share-copy").addEventListener("click", async () => {
      const input = $("#share-url");
      let ok = false;
      try { await navigator.clipboard.writeText(input.value); ok = true; } catch {
        // Older browsers: select the text and use the legacy copy command.
        input.select();
        try { ok = document.execCommand("copy"); } catch { ok = false; }
      }
      $("#share-copy").textContent = ok ? "Copied ✓" : "Copy link";
      flash($("#share-msg"), ok ? "Link copied. Paste it anywhere." : "Couldn't copy automatically. Select the link and copy it.", ok ? "ok" : "err");
    });
    $("#share-url").addEventListener("focus", (e) => e.target.select());
    $("#share-more").addEventListener("click", async () => {
      try { await navigator.share({ title: "Fare Radar deal", text: shareText, url: $("#share-url").value }); } catch { /* dismissed */ }
    });
  }

  // The alerts page shows the real alert layout, filled with the newest deal.
  function renderPreview(deals) {
    const d = deals[0];
    if (!d) return;
    $("#pv-subject").textContent = `${d.origin_city} → ${d.destination_city} ${money(d.price)} round trip, `
      + `${short(d.depart_date)}–${short(d.return_date)}`;
    $("#pv-route").textContent = `${d.origin_city} → ${d.destination_city}`;
    $("#pv-price").textContent = money(d.price);
    $("#pv-dates").textContent = `${short(d.depart_date)} → ${short(d.return_date)} · ${d.trip_days} days · ${stopsPair(d)}`;
    $("#preview-src").textContent = d.is_fake ? " (filled with a test fare)" : " (filled with the newest deal)";
  }

  // ---------------- paywall ----------------
  /** Free-trial days this visitor would get (first membership only). */
  const trialDays = () => (state.me.signed_in ? state.me.subscription?.trial_days ?? 0 : state.meta?.billing?.trial_days ?? 0);
  const ctaLabel = () => (trialDays() ? `Start ${trialDays()}-day free trial` : "Become a member · $8/month");

  /** Fills a locked panel: sign up first, or become a member. */
  function fillLock(node, feature) {
    node.replaceChildren();
    const signedIn = !!state.me.signed_in;
    if (!proLive()) {
      node.append(el("h3", "", `${feature} is part of Pro, coming soon`));
      node.append(el("p", "", signedIn
        ? "Pro adds your own logic, alerts for just the places you pick, and checking any route across a whole month. Want to hear when it opens?"
        : "Pro adds your own logic, alert filters and route search. It isn't open yet, but a free account gets deal alerts by email right now."));
      const actions = el("div", "t-actions");
      if (signedIn) {
        const b = el("button", "btn primary", state.me.pro_waitlist ? "You're on the list ✓" : "Notify me when Pro launches");
        b.type = "button";
        b.disabled = !!state.me.pro_waitlist;
        b.addEventListener("click", () => joinWaitlist(b, node));
        actions.append(b);
      } else {
        const a = el("button", "btn primary", "Create a free account");
        a.type = "button";
        a.addEventListener("click", () => openAuth("signup"));
        const s2 = el("button", "btn glass-btn", "Sign in");
        s2.type = "button";
        s2.addEventListener("click", () => openAuth("signin"));
        actions.append(a, s2);
      }
      node.append(actions, el("p", "t-msg lock-msg"));
      return;
    }
    node.append(el("h3", "", `${feature} is for members`));
    const trial = trialDays();
    const offer = trial ? `Try it free for ${trial} days, then $8/month.` : "Membership is $8/month.";
    node.append(el("p", "", signedIn
      ? `${offer} It covers deal alerts by your own rules, your own logic, and checking any route across a whole month. Cancel any time.`
      : `Create a free account, then become a member. ${offer} You get deal alerts by your own rules, your own logic, and route search. Cancel any time.`));
    const actions = el("div", "t-actions");
    if (signedIn) {
      const b = el("button", "btn primary", ctaLabel());
      b.type = "button";
      b.addEventListener("click", () => startCheckout(b, node));
      const more = el("a", "btn glass-btn", "What's included");
      more.href = "#account";
      actions.append(b, more);
    } else {
      const a = el("button", "btn primary", "Create an account");
      a.type = "button";
      a.addEventListener("click", () => openAuth("signup"));
      const s = el("button", "btn glass-btn", "Sign in");
      s.type = "button";
      s.addEventListener("click", () => openAuth("signin"));
      actions.append(a, s);
    }
    node.append(actions, el("p", "t-msg lock-msg"));
  }

  function renderLocks() {
    const member = isMember();
    $("#search-locked").hidden = member;
    $("#search-form").hidden = !member;
    if (!member) fillLock($("#search-locked"), "Route search");
  }

  async function startCheckout(btn, where) {
    const msg = $(".lock-msg, .t-msg", where) || $("#mem-msg");
    if (state.meta && !state.meta.billing?.enabled) { flash(msg, "Memberships open soon. Check back in a few days.", "err"); return; }
    btn.disabled = true;
    flash(msg, "Opening secure checkout…");
    try {
      const out = await api("/api/billing/checkout", "POST", {});
      const url = stripeUrl(out.url);
      if (!url) throw new ApiError("Checkout isn't available right now.", 0, {});
      location.href = url;
    } catch (e) { flash(msg, e.message, "err"); btn.disabled = false; }
  }

  /** Puts the signed-in person on the Pro launch list. */
  async function joinWaitlist(btn, where) {
    const msg = $(".lock-msg, .t-msg", where) || $("#mem-msg");
    btn.disabled = true;
    try {
      await api("/api/account/pro-waitlist", "PUT", { on: true });
      state.me.pro_waitlist = true;
      btn.textContent = "You're on the list ✓";
      flash(msg, "Thanks! We'll email you once when Pro opens.", "ok");
      renderPlanCta();
    } catch (e) { flash(msg, e.message, "err"); btn.disabled = false; }
  }

  async function syncBilling() {
    state.note = "Thanks! Confirming your membership with Stripe…";
    try {
      const out = await api("/api/billing/sync", "POST", {});
      state.note = out.entitled ? "Welcome aboard. Your membership is active: alerts, your own logic and route search are unlocked."
        : "Your payment is still processing. This page updates once Stripe confirms it.";
    } catch (e) { state.note = e.message; }
    await refreshMe();
  }

  // ---------------- route search (members) ----------------
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

  // ---------------- who's signed in ----------------
  async function loadMe() {
    try { state.me = await (await fetch("/api/me", { credentials: "same-origin" })).json(); } catch { state.me = { signed_in: false }; }
    const btn = $("#account-btn");
    btn.replaceChildren();
    if (state.me.signed_in) {
      btn.append(el("span", "acct-who", `${state.me.name} · `), "Account");
    } else btn.textContent = "Sign in";
    if (state.me.must_change_password) openPw();
    $("#nav-admin").hidden = !isAdmin();
    $(".segmented").classList.toggle("has-admin", isAdmin());
    state.rules = null;
    if (isMember()) {
      try { state.rules = (await api("/api/account/rules")).categories; } catch { /* site rules */ }
    }
    renderColumnRules();
    renderLocks();
    renderPlanCta();
  }

  /** After signing in or out, or a membership change: reload what depends on it. */
  async function refreshMe() {
    await loadMe();
    loadDeals();
    route();
  }

  // ---------------- sign in / create account / forgot / reset ----------------
  let authMode = "signin";
  function openAuth(mode, message = "") {
    authMode = mode;
    const dlg = $("#auth-dlg");
    const form = $("#auth-form");
    const titles = { signin: "Sign in", signup: "Create your account", forgot: "Reset your password", reset: "Choose a new password" };
    $("#auth-title").textContent = titles[mode];
    $$(".auth-tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === mode)));
    $(".auth-tabs").hidden = mode === "forgot" || mode === "reset";
    $("#oauth-buttons").hidden = !(state.meta?.auth?.providers?.length) || mode === "forgot" || mode === "reset";
    $(".auth-name", form).hidden = mode !== "signup";
    $(".auth-pass", form).hidden = mode === "forgot";
    form.elements.email.closest("label").hidden = mode === "reset";
    form.elements.password.autocomplete = mode === "signin" ? "current-password" : "new-password";
    form.elements.password.required = mode !== "forgot";
    $(".auth-pass .field-label", form).textContent = mode === "reset" ? "New password" : "Password";
    $(".auth-hint", form).hidden = !(mode === "signup" || mode === "reset");
    $(".auth-legal", form).hidden = mode !== "signup";
    $("#auth-forgot").hidden = mode !== "signin";
    $("#auth-submit").textContent = { signin: "Sign in", signup: "Create account", forgot: "Email me a reset link", reset: "Save new password" }[mode];
    form.elements.password.value = "";
    $$("[aria-invalid]", form).forEach((x) => x.removeAttribute("aria-invalid"));
    flash($("#auth-msg"), message, message ? "err" : "");
    if (!dlg.open) dlg.showModal();
    (mode === "reset" ? form.elements.password : form.elements.email).focus();
  }

  function wireAuth() {
    $("#account-btn").addEventListener("click", () => {
      if (state.me.signed_in) location.hash = "#account";
      else openAuth("signin");
    });
    $$("[data-auth]").forEach((b) => b.addEventListener("click", () => openAuth(b.dataset.auth)));
    $$(".auth-tabs button").forEach((b) => b.addEventListener("click", () => openAuth(b.dataset.mode)));
    $("#auth-forgot").addEventListener("click", () => openAuth("forgot"));
    $$("#auth-dlg [data-close]").forEach((a) => a.addEventListener("click", () => $("#auth-dlg").close()));

    $("#auth-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const msg = $("#auth-msg");
      const email = form.elements.email.value.trim();
      const password = form.elements.password.value;
      $$("[aria-invalid]", form).forEach((x) => x.removeAttribute("aria-invalid"));
      if (authMode !== "reset" && (!email || !form.elements.email.checkValidity())) {
        form.elements.email.setAttribute("aria-invalid", "true");
        return flash(msg, "Enter your email address.", "err");
      }
      if (authMode !== "forgot" && !password) {
        form.elements.password.setAttribute("aria-invalid", "true");
        return flash(msg, "Enter your password.", "err");
      }
      const btn = $("#auth-submit");
      btn.disabled = true;
      flash(msg, authMode === "forgot" ? "Sending…" : "One moment…");
      try {
        if (authMode === "forgot") {
          await api("/api/auth/forgot", "POST", { email });
          flash(msg, `If there's an account for ${email}, a reset link is on its way. It works once, for 30 minutes.`, "ok");
          return;
        }
        if (authMode === "reset") {
          await api("/api/auth/reset", "POST", { token: state.resetToken, password });
          state.resetToken = null;
          state.note = "Your password is changed and you're signed in. Every other device was signed out.";
        } else if (authMode === "signup") {
          const out = await api("/api/auth/signup", "POST", { email, password, name: form.elements.name.value.trim() });
          state.note = out.verification_sent
            ? `Welcome to Fare Radar! We sent a confirmation link to ${email}.`
            : "Welcome to Fare Radar! Your account is ready.";
        } else {
          await api("/api/auth/login", "POST", { email, password });
        }
        form.reset();
        $("#auth-dlg").close();
        if (authMode === "signup" || authMode === "reset") location.hash = "#account";
        await refreshMe();
      } catch (err) {
        if (err.data?.token) state.resetToken = err.data.token; // a fresh reset link after a rejected password
        const field = err.data?.field;
        if (field && form.elements[field]) form.elements[field].setAttribute("aria-invalid", "true");
        flash(msg, err.message, "err");
      } finally { btn.disabled = false; }
    });
  }

  async function verifyEmail(token) {
    try {
      await api("/api/auth/verify", "POST", { token });
      state.note = "Your email is confirmed. Thanks!";
    } catch (e) { state.note = e.message; }
    if (state.me.signed_in) await refreshMe();
    else renderAccount();
  }

  // ---------------- forced password change ----------------
  function openPw() {
    const dlg = $("#pw-dlg");
    if (!dlg.open) dlg.showModal();
  }
  function wirePw() {
    const dlg = $("#pw-dlg");
    dlg.addEventListener("cancel", (e) => e.preventDefault()); // Escape can't skip it
    $("#pw-signout").addEventListener("click", signOut);
    $("#pw-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const msg = $("#pw-msg");
      if (f.elements.password.value !== f.elements.again.value) return flash(msg, "The new passwords don't match.", "err");
      try {
        await api("/api/auth/password", "POST", { current: f.elements.current.value, password: f.elements.password.value });
        f.reset();
        dlg.close();
        state.note = "Your new password is saved.";
        await refreshMe();
      } catch (err) { flash(msg, err.message, "err"); }
    });
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
    location.hash = "#browse";
    location.reload();
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
    g.href = googleUrl(t.origin, t.destination, t.depart, t.ret);

    const mode = $("#book-mode");
    mode.hidden = b.test_mode === null || b.test_mode === undefined;
    mode.className = `mode-note${b.test_mode === false ? " live" : ""}`;
    mode.textContent = b.test_mode
      ? "Test mode: bookings go to Duffel's test system. Flights are fake and no money moves."
      : "Live mode: purchases are real and charged to your Duffel balance.";

    const problems = [];
    if (!b.duffel) problems.push(["Add your Duffel access token as the DUFFEL_ACCESS_TOKEN secret in Cloudflare."]);
    if (!b.enabled) problems.push(["Purchasing is switched off in config.json (booking_enabled)."]);
    if (!(b.travelers || []).some((x) => x.ready)) {
      const a = el("a", "", "Account page");
      a.href = "#account";
      a.dataset.close = "";
      problems.push(["Add traveler details on your ", a, "."]);
    }
    const setup = $("#book-setup");
    setup.hidden = !problems.length;
    setup.replaceChildren();
    if (problems.length) {
      setup.append(el("b", "", "Before you can buy:"));
      for (const parts of problems) setup.append(document.createElement("br"), ...parts);
    }

    $("#b-travelers").replaceChildren(...(b.travelers || []).map((x) => {
      const l = document.createElement("label");
      l.className = `chk${x.ready ? "" : " off"}`;
      const i = document.createElement("input");
      i.type = "checkbox";
      i.value = x.name;
      i.disabled = !x.ready;
      i.checked = x.ready && x.name === state.me.contact;
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


  // ---------------- account page ----------------
  async function renderAccount() {
    const me = state.me;
    $("#acct-signed-out").hidden = !!me.signed_in;
    $("#acct-signed-in").hidden = !me.signed_in;
    const note = $("#acct-note");
    note.hidden = !state.note;
    note.textContent = state.note || "";
    if (!me.signed_in) return;

    // membership
    const sub = me.subscription || {};
    const pill = $("#mem-pill");
    const text = $("#mem-text");
    const subscribe = $("#mem-subscribe");
    const manage = $("#mem-manage");
    subscribe.hidden = true;
    const wait = $("#mem-waitlist");
    wait.hidden = true;
    manage.hidden = !sub.can_manage;
    $("#mem-title").textContent = proLive() ? "Membership" : "Your plan";
    if (me.role === "tester") {
      pill.textContent = "Beta tester";
      text.textContent = "You have every Pro feature free while we test it. Thanks for helping!";
    } else if (me.role === "admin") {
      pill.textContent = "Admin";
      text.textContent = "Full access at no charge, plus booking and the site-wide settings.";
    } else if (me.entitled) {
      pill.textContent = sub.status === "past_due" ? "Payment due" : sub.status === "trialing" ? "Free trial" : "Member";
      text.textContent = sub.status === "past_due"
        ? "Your last payment didn't go through. Update your card in Manage billing to keep your membership."
        : sub.cancel_at_period_end && sub.renews_at ? `Your membership ends on ${longDate(sub.renews_at)}. You won't be charged again. You can restart it in Manage billing.`
        : sub.status === "trialing" && sub.renews_at
          ? `Your free trial runs until ${longDate(sub.renews_at)}. After that it's ${sub.price} unless you cancel in Manage billing before then. We'll email you 3 days before.`
        : sub.renews_at ? `Renews on ${longDate(sub.renews_at)} at ${sub.price}.` : "Your membership is active.";
    } else if (!proLive()) {
      pill.textContent = "Free";
      text.textContent = "Free accounts get every deal and email alerts. Pro adds the extras below. It's coming soon.";
      wait.hidden = false;
      wait.disabled = !!me.pro_waitlist;
      wait.textContent = me.pro_waitlist ? "You're on the list ✓" : "Notify me when Pro launches";
    } else {
      pill.textContent = "Free";
      text.textContent = trialDays()
        ? `Try membership free for ${trialDays()} days, then ${sub.price || "$8/month"}. Cancel any time before the trial ends and you won't be charged.`
        : `Become a member for ${sub.price || "$8/month"} to unlock everything below. Cancel any time.`;
      subscribe.hidden = false;
      subscribe.textContent = ctaLabel();
    }
    pill.dataset.kind = me.role === "admin" ? "admin" : me.entitled ? "member" : "free";
    $("#nav-admin").hidden = !isAdmin();
    $("#mem-perks").hidden = me.entitled && me.role !== "admin" ? false : false;

    // profile
    $("#acct-email").value = me.email;
    const form = $("#acct-profile");
    if (document.activeElement !== form.elements.name) form.elements.name.value = me.name === me.email.split("@")[0] ? "" : me.name;
    const vline = $("#acct-verify-line");
    vline.replaceChildren();
    if (me.email_verified) vline.append("Email confirmed ✓");
    else {
      vline.append("Your email isn't confirmed yet. ");
      const b = el("button", "linkish", "Send the confirmation email again");
      b.type = "button";
      b.addEventListener("click", async () => {
        b.disabled = true;
        try { await api("/api/auth/verify/resend", "POST", {}); b.replaceWith("Sent. Check your inbox."); }
        catch (e) { b.replaceWith(e.message); }
      });
      vline.append(b);
    }

    // password
    const methods = (me.sign_in_methods || []).map((m) => ({ password: "email and password", google: "Google", apple: "Apple" }[m] || m));
    $("#acct-methods").textContent = methods.length ? `You sign in with ${methods.join(", ")}.` : "";
    $("#pw-current-wrap").hidden = !me.has_password;
    $("#acct-password button[type=submit]").textContent = me.has_password ? "Change password" : "Set a password";

    // owners' traveler details
    $("#acct-owner").hidden = !canBook();
    if (canBook()) {
      try {
        const data = await (await fetch("/api/profiles", { credentials: "same-origin" })).json();
        if (data?.ok) {
          const people = [...data.travelers].sort((a, b) => Number(b.is_you) - Number(a.is_you));
          $("#acct-list").replaceChildren(...people.map(travelerForm));
        }
      } catch { $("#acct-list").textContent = "Couldn't load traveler details. Refresh to try again."; }
    }
    $("#acct-delete").hidden = me.role === "admin";
    $("#delete-pass-wrap").hidden = !me.has_password;
  }

  function wireAccountPage() {
    $("#mem-subscribe").addEventListener("click", (e) => startCheckout(e.currentTarget, $("#mem-subscribe").closest("section")));
    $("#mem-waitlist").addEventListener("click", (e) => joinWaitlist(e.currentTarget, e.currentTarget.closest("section")));
    $("#mem-manage").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const msg = $("#mem-msg");
      btn.disabled = true;
      try {
        const url = stripeUrl((await api("/api/billing/portal", "POST", {})).url);
        if (!url) throw new ApiError("Billing isn't available right now.", 0, {});
        location.href = url;
      } catch (err) { flash(msg, err.message, "err"); btn.disabled = false; }
    });

    $("#acct-profile").addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = $(".t-msg", e.target);
      try {
        await api("/api/account", "PUT", { name: e.target.elements.name.value });
        flash(msg, "Saved.", "ok");
        await loadMe();
      } catch (err) { flash(msg, err.message, "err"); }
    });

    $("#acct-password").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const msg = $(".t-msg", f);
      try {
        await api("/api/auth/password", "POST", { current: f.elements.current.value, password: f.elements.password.value });
        f.reset();
        flash(msg, "Saved. Every other device was signed out.", "ok");
        await loadMe();
        renderAccount();
      } catch (err) {
        if (err.data?.field && f.elements[err.data.field]) f.elements[err.data.field].focus();
        flash(msg, err.message, "err");
      }
    });

    $("#acct-signout").addEventListener("click", signOut);
    $("#acct-signout-all").addEventListener("click", async () => {
      if (!confirm("Sign out of Fare Radar on every device, including this one?")) return;
      try { await api("/api/account/signout-all", "POST", {}); location.hash = "#browse"; location.reload(); }
      catch (err) { flash($("#acct-data-msg"), err.message, "err"); }
    });

    const dlg = $("#delete-dlg");
    $("#acct-delete").addEventListener("click", () => {
      $("#delete-confirm").value = "";
      $("#delete-pass").value = "";
      flash($("#delete-msg"), "");
      dlg.showModal();
    });
    $("#delete-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const confirmText = $("#delete-confirm").value.trim().toUpperCase();
      if (confirmText !== "DELETE") return flash($("#delete-msg"), "Type DELETE to confirm.", "err");
      try {
        await api("/api/account/delete", "POST", { confirm: confirmText, password: $("#delete-pass").value });
        dlg.close();
        location.hash = "#browse";
        location.reload();
      } catch (err) { flash($("#delete-msg"), err.message, "err"); }
    });
  }

  // ---------------- alerts page ----------------
  async function renderAlerts() {
    // Alerts are free for anyone signed in; the place and nonstop filters are Pro.
    const signedIn = !!state.me.signed_in;
    $("#alerts-locked").hidden = signedIn;
    $("#alerts-form").hidden = !signedIn;
    if (!signedIn) return fillAlertsSignup($("#alerts-locked"));
    const pro = isMember();
    $$("#alerts-form .pro-tag").forEach((t) => { t.hidden = pro; });
    $$("#alerts-scope button").forEach((b) => { b.disabled = !pro; });
    $("#alerts-form").elements.nonstop.disabled = !pro;
    let acct;
    try { acct = (await api("/api/account")).account; } catch { return; }
    const f = $("#alerts-form");
    const setSwitch = (on) => {
      f.elements.on.checked = on;
      $(".switch-label", f).textContent = on ? "On" : "Off";
      f.classList.toggle("is-off", !on);
    };
    setSwitch(acct.alerts.on);
    const origins = state.meta?.origins || [{ code: "SEA", city: "Seattle" }, { code: "PDX", city: "Portland" }];
    $("#alerts-home").replaceChildren(...origins.map((o) =>
      segButton(o.code, `${o.city} (${o.code})`, acct.alerts.origins.includes(o.code), "toggle")));
    // Which places: everywhere, or a picked list (grouped US / abroad).
    const picked = acct.alerts.destinations;
    const list = state.meta?.destination_list || [];
    const group = (label, kind) => {
      const box = el("div", "dest-group");
      box.append(el("p", "field-label", label));
      for (const d of list.filter((x) => x.kind === kind).sort((a, b) => a.city.localeCompare(b.city))) {
        const lab = el("label", "chk");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = d.code;
        input.checked = !!picked && picked.includes(d.code);
        lab.append(input, ` ${d.city}`);
        box.append(lab);
      }
      return box;
    };
    $("#alerts-dests").replaceChildren(group("United States", "domestic"), group("Abroad", "international"));
    setScope(!!picked);
    f.elements.nonstop.checked = !!acct.alerts.nonstop_only;
    const cats = state.rules || state.meta?.rules;
    $("#alerts-rules").textContent = cats
      ? `${describeRules("international", cats.international)} ${describeRules("domestic", cats.domestic)}` : "";
    $("#alerts-status").textContent = !acct.email_verified
      ? "Confirm your email (see your Account page) to start getting alerts."
      : !acct.alerts.on ? "Alerts are off." : acct.alerts.last_sent_at
        ? `On. Last alert ${ago(acct.alerts.last_sent_at)}.` : "On. You'll get an email the next time a fare fits your rules.";
    f.onchange = (e) => { if (e.target.name === "on") setSwitch(e.target.checked); };
  }

  function fillAlertsSignup(node) {
    node.replaceChildren(el("h3", "", "Deal alerts are free"),
      el("p", "", "Create a free account and we'll email you when a fare out of Seattle or Portland is worth it. No digests, no newsletters."));
    const actions = el("div", "t-actions");
    const a = el("button", "btn primary", "Create a free account");
    a.type = "button";
    a.addEventListener("click", () => openAuth("signup"));
    const s2 = el("button", "btn glass-btn", "Sign in");
    s2.type = "button";
    s2.addEventListener("click", () => openAuth("signin"));
    actions.append(a, s2);
    node.append(actions);
  }

  function setScope(some) {
    $$("#alerts-scope button").forEach((b) => b.setAttribute("aria-checked", String((b.dataset.value === "some") === some)));
    $("#alerts-dests").hidden = !some;
  }

  function wireAlerts() {
    $("#alerts-scope").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b) setScope(b.dataset.value === "some");
    });
    $("#alerts-home").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const on = b.getAttribute("aria-pressed") !== "true";
      if (!on && !$$("#alerts-home button").some((x) => x !== b && x.getAttribute("aria-pressed") === "true")) return;
      b.setAttribute("aria-pressed", String(on));
    });
    $("#alerts-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = $(".t-msg", e.target);
      try {
        const pro = isMember();
        await api("/api/account/alerts", "PUT", { on: e.target.elements.on.checked,
          origins: $$("#alerts-home button[aria-pressed=true]").map((b) => b.dataset.value),
          destinations: !pro || $("#alerts-dests").hidden ? "everywhere" : $$("#alerts-dests input:checked").map((x) => x.value),
          nonstop_only: pro && e.target.elements.nonstop.checked });
        flash(msg, e.target.elements.on.checked ? "Saved. Alerts are on." : "Saved. Alerts are off.", "ok");
        renderAlerts();
      } catch (err) { flash(msg, err.message, "err"); }
    });
  }

  // ---------------- admin panel (owners only) ----------------
  const roleName = (r) => ({ admin: "Admin", tester: "Beta tester", member: "Member" }[r] || r);

  function adminRow(u, onChange) {
    const li = el("li", "admin-user");
    const who = el("div", "admin-who");
    who.append(el("b", "", u.email), el("span", "fine",
      `${roleName(u.role)}${u.name ? ` · ${u.name}` : ""} · joined ${ago(u.created_at)}${u.email_verified ? "" : " · email not confirmed"}`
      + `${u.subscription_status ? ` · Stripe: ${u.subscription_status}` : ""}${u.pro_waitlist ? " · on Pro list" : ""}`));
    li.append(who);
    if (u.role !== "admin") {
      const tester = u.role === "tester";
      const b = el("button", tester ? "btn glass-btn small" : "btn primary small", tester ? "Remove tester access" : "Give full access (tester)");
      b.type = "button";
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          const out = await api("/api/admin/users/role", "PUT", { id: u.id, role: tester ? "member" : "tester" });
          onChange(out.user);
        } catch (e) { b.disabled = false; b.textContent = e.message; }
      });
      li.append(b);
    }
    return li;
  }

  async function renderAdmin() {
    if (!isAdmin()) { location.hash = "#browse"; return; }
    renderContent();
    try {
      const out = await api("/api/admin/testers");
      const c = out.counts;
      $("#admin-counts").textContent = `${c.users} account${c.users === 1 ? "" : "s"} · ${c.testers} beta tester${c.testers === 1 ? "" : "s"}`
        + ` · ${c.waitlist} on the Pro launch list${c.paying ? ` · ${c.paying} paying` : ""}`
        + (c.sources?.length ? `. Sign-ups by source: ${c.sources.map((s) => `${s.source} ${s.n}`).join(", ")}` : "");
      const list = $("#admin-testers");
      list.replaceChildren(...(out.testers.length ? out.testers.map((u) => adminRow(u, () => renderAdmin()))
        : [el("li", "fine", "No beta testers yet. Find an account above to add one.")]));
    } catch (e) { $("#admin-counts").textContent = e.message; }
  }

  function wireAdmin() {
    $("#admin-find").addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = $(".t-msg", e.target);
      const box = $("#admin-result");
      box.hidden = true;
      try {
        const out = await api(`/api/admin/users?email=${encodeURIComponent(e.target.elements.email.value.trim())}`);
        if (!out.user) { flash(msg, "No account with that email.", "err"); return; }
        flash(msg, "");
        const show = (u) => {
          const ul = el("ul", "admin-list");
          ul.append(adminRow(u, (nu) => { show(nu); renderAdmin(); }));
          box.replaceChildren(ul);
          box.hidden = false;
        };
        show(out.user);
      } catch (err) { flash(msg, err.message, "err"); }
    });
  }

  // ---------------- admin: content library ----------------
  const FOLDER_HINTS = {
    "talking-heads": "Clips of you or Brock talking to the camera. Vertical is best. Videos of any length are fine.",
    "trip-photos": "Photos from your trips. The best ones become backgrounds and slides.",
    "trip-videos": "Trip footage: takeoffs, window seats, beaches, cities. Short clips work best.",
    music: "Licensed beats only, and drop the license PDF here too so we always have proof.",
    ready: "Finished posts from Claude, with a caption file for each. Download and post.",
  };
  let folder = "talking-heads";
  const size = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

  async function renderContent() {
    $$("#content-folders button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.folder === folder)));
    $("#content-hint").textContent = FOLDER_HINTS[folder];
    const list = $("#content-files");
    try {
      const out = await api(`/api/admin/media?folder=${folder}`);
      list.replaceChildren(...(out.files.length ? out.files.map(fileRow) : [el("li", "fine", "Nothing here yet.")]));
    } catch (e) { list.replaceChildren(el("li", "fine", e.message)); }
  }

  function fileRow(f) {
    const li = el("li", "admin-user content-file");
    if (/^image\/(jpeg|png|webp)/.test(f.type || "")) {
      const img = document.createElement("img");
      img.className = "thumb-img";
      img.alt = "";
      img.loading = "lazy";
      img.src = `/api/admin/media/file?key=${encodeURIComponent(f.key)}&view=1`;
      li.append(img);
    }
    const who = el("div", "admin-who");
    who.append(el("b", "", f.name), el("span", "fine", `${size(f.size)} · ${ago(f.uploaded)}${f.by ? ` · ${title(f.by)}` : ""}`));
    const acts = el("div", "t-actions content-acts");
    const dl = el("a", "btn glass-btn small", "Download");
    dl.href = `/api/admin/media/file?key=${encodeURIComponent(f.key)}`;
    const del = el("button", "btn glass-btn small danger-text", "Delete");
    del.type = "button";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete "${f.name}" for both of you? This can't be undone.`)) return;
      del.disabled = true;
      try {
        await api(`/api/admin/media?key=${encodeURIComponent(f.key)}`, "DELETE");
        li.hidden = true;
      } catch (e) { del.disabled = false; del.textContent = e.message; }
    });
    acts.append(dl, del);
    li.append(who, acts);
    return li;
  }

  /** Sends one chunk with progress (fetch can't report upload progress). */
  function putPart(url, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("PUT", url);
      x.withCredentials = true;
      x.upload.onprogress = (e) => onProgress(e.loaded);
      x.onload = () => {
        let data = {};
        try { data = JSON.parse(x.responseText); } catch { /* not JSON */ }
        if (x.status >= 200 && x.status < 300 && data.ok) resolve(data);
        else reject(new Error(data.error || `Upload failed (${x.status})`));
      };
      x.onerror = () => reject(new Error("Network error. Check your connection and try again."));
      x.send(blob);
    });
  }

  async function uploadFile(file, into) {
    const row = el("li", "upload-row");
    const bar = el("progress");
    bar.max = 100;
    bar.value = 0;
    const msg = el("span", "fine", "Starting…");
    row.append(el("span", "", file.name), bar, msg);
    $("#content-uploads").append(row);
    let start;
    try {
      start = await api("/api/admin/media/start", "POST", { folder: into, name: file.name, size: file.size, type: file.type });
      const parts = [];
      const total = file.size;
      let done = 0;
      for (let off = 0, n = 1; off < total; off += start.chunk, n++) {
        const blob = file.slice(off, Math.min(total, off + start.chunk));
        const q = new URLSearchParams({ key: start.key, uploadId: start.uploadId, n: String(n) });
        for (let tries = 1; ; tries++) {
          try {
            const part = await putPart(`/api/admin/media/part?${q}`, blob, (sent) => {
              bar.value = Math.round(((done + sent) / total) * 100);
              msg.textContent = `${bar.value}% of ${size(total)}`;
            });
            parts.push({ n: part.n, etag: part.etag });
            break;
          } catch (e) {
            if (tries >= 3) throw e;
            await new Promise((r) => setTimeout(r, 1500 * tries));
          }
        }
        done += blob.size;
      }
      await api("/api/admin/media/finish", "POST", { key: start.key, uploadId: start.uploadId, parts });
      bar.value = 100;
      msg.textContent = "Uploaded ✓";
      msg.className = "fine ok-text";
      if (into === folder) renderContent();
      setTimeout(() => { row.hidden = true; }, 4000);
    } catch (e) {
      msg.textContent = e.message;
      msg.className = "fine err-text";
      if (start?.uploadId) api("/api/admin/media/abort", "POST", { key: start.key, uploadId: start.uploadId }).catch(() => {});
    }
  }

  function wireContent() {
    $("#content-folders").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b) { folder = b.dataset.folder; renderContent(); }
    });
    const send = (files) => { for (const f of files) uploadFile(f, folder); };
    $("#content-input").addEventListener("change", (e) => { send([...e.target.files]); e.target.value = ""; });
    const drop = $("#content-drop");
    ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
    drop.addEventListener("drop", (e) => { e.preventDefault(); send([...(e.dataTransfer?.files || [])]); });
  }

  // ---------------- owners: traveler details ----------------
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
      note.append(`You can book for ${title(t.name)}. To let them sign in and book themselves, add their email as the `,
        el("code", "", `CONTACT_${t.name}_EMAIL`), " secret in Cloudflare.");
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


  // ---------------- logic (members) ----------------
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
    const locked = !isMember();
    $("#logic-locked").hidden = !locked;
    $("#logic-body").hidden = locked;
    if (locked) return fillLock($("#logic-locked"), "Your own logic");
    let data;
    try { data = await api("/api/account/rules"); } catch (e) { $("#logic-cats").textContent = e.message; return; }
    state.rules = data.categories;
    renderColumnRules();
    $("#logic-cats").replaceChildren(catForm("international", data.categories.international, true),
      catForm("domestic", data.categories.domestic, true));
    $("#logic-reset").hidden = !data.customized;
    $("#logic-site").hidden = state.me.role !== "admin";
    $("#logic-updated").textContent = data.customized ? "You're using your own rules." : "You're using the site defaults.";
    renderLearned();
  }

  function showFieldErrors(fields) {
    for (const [kind, errs] of Object.entries(fields || {})) {
      const sec = $(`.logic-cat[data-kind="${kind}"]`);
      for (const [k, v] of Object.entries(errs)) {
        const err = $(`.f-err[data-for="${k}"]`, sec);
        if (err) err.textContent = v;
        $(`[name="${k}"]`, sec)?.setAttribute("aria-invalid", "true");
      }
    }
  }

  function wireLogic() {
    const collect = () => {
      $$("#logic-cats .f-err").forEach((x) => { x.textContent = ""; });
      $$("#logic-cats [aria-invalid]").forEach((x) => x.removeAttribute("aria-invalid"));
      const body = {};
      $$("#logic-cats .logic-cat").forEach((sec) => { body[sec.dataset.kind] = readCat(sec); });
      return body;
    };
    $("#logic-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = $("#logic-msg");
      flash(msg, "Saving…");
      try {
        const out = await api("/api/account/rules", "PUT", collect());
        state.rules = out.categories;
        flash(msg, "Saved. Your deals and alerts now follow these rules.", "ok");
        $("#logic-reset").hidden = false;
        $("#logic-updated").textContent = "You're using your own rules.";
        renderColumnRules();
        loadDeals();
      } catch (err) { flash(msg, err.message, "err"); showFieldErrors(err.data?.fields); }
    });
    $("#logic-reset").addEventListener("click", async () => {
      if (!confirm("Go back to the site's default rules?")) return;
      try {
        await api("/api/account/rules", "DELETE");
        flash($("#logic-msg"), "Back to the site defaults.", "ok");
        await renderLogic();
        loadDeals();
      } catch (err) { flash($("#logic-msg"), err.message, "err"); }
    });
    $("#logic-site").addEventListener("click", async () => {
      if (!confirm("Make these the defaults for visitors and for members who haven't set their own rules? The hourly search uses them too.")) return;
      try {
        await api("/api/logic", "PUT", collect());
        flash($("#logic-msg"), "Saved as the site defaults.", "ok");
        await loadMeta();
        renderColumnRules();
      } catch (err) { flash($("#logic-msg"), err.message, "err"); showFieldErrors(err.data?.fields); }
    });
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
  wireRadio($('[data-filter="origin"]'), (v) => { state.origin = v; loadDeals(); });
  wireRadio($('[data-filter="sort"]'), (v) => { state.sort = v; loadDeals(); });
  wireAuth();
  wirePw();
  wireAccountPage();
  wireAlerts();
  wireLogic();
  wireSearch();
  wireBooking();
  wireContact();
  wireDealCard();
  wireAdmin();
  wireContent();
  $("#plan-cta").addEventListener("click", (e) => {
    if (!state.me.signed_in) openAuth("signup");
    else if (isMember()) return;
    else if (!proLive()) joinWaitlist(e.currentTarget, e.currentTarget.closest(".plan"));
    else startCheckout(e.currentTarget, e.currentTarget.closest(".plan"));
  });
  Promise.all([loadMeta(), loadMe()]).then(() => { route(); loadDeals(); });
})();
