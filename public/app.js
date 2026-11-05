// Fare Radar front end: Browse (deals list with filters) and Sign up.
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const money = (n) => `$${Math.round(n)}`;
  const fmtDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined,
    { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const stops = (n) => (n === 0 ? "Nonstop" : `${n} stop${n > 1 ? "s" : ""}`);

  const state = { origin: "", kind: "", sort: "recent", max: null, meta: null };

  // ---------------- routing ----------------
  function route() {
    const tab = location.hash === "#signup" ? "signup" : "browse";
    $("#view-browse").hidden = tab !== "browse";
    $("#view-signup").hidden = tab !== "signup";
    $(".segmented").dataset.active = tab;
    $$(".segmented a").forEach((a) => a.setAttribute("aria-selected", String(a.dataset.tab === tab)));
    if (tab === "signup") setTimeout(() => $("#email").focus({ preventScroll: true }), 300);
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }
  window.addEventListener("hashchange", route);

  // ---------------- pills ----------------
  function wirePills(group, onChange) {
    group.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      $$("button", group).forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      onChange(b.dataset.value);
    });
  }

  function paintRange(input) {
    const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty("--pct", `${pct}%`);
  }

  // ---------------- meta ----------------
  async function loadMeta() {
    try {
      const r = await fetch("/api/meta");
      const m = await r.json();
      state.meta = m;
      $("#stat-dest").textContent = `${m.destinations}`;
      $("#stat-dom").textContent = money(m.domestic_max);
      $("#stat-intl").textContent = money(m.international_max);
      $("#stat-checks").textContent = m.cycle > 0 ? `${m.cycle.toLocaleString()} checks run` : "Watching now";
      if (m.subscribers > 0) {
        $("#stat-subs").textContent = `${m.subscribers.toLocaleString()} subscribed`;
        $("#stat-subs-chip").hidden = false;
      }
      $("#demo-banner").hidden = !m.demo;

      // origin filter + signup toggles from the server's airports
      const og = $('[data-filter="origin"]');
      og.replaceChildren(pill("", "All", true, "radio"), ...m.origins.map((o) => pill(o.code, o.code, false, "radio")));
      const home = $("#home");
      home.replaceChildren(...m.origins.map((o) => pill(o.code, `${o.city} (${o.code})`, true, "toggle")));

      const max = $("#max");
      max.max = String(m.international_max);
      max.value = max.max;
      paintRange(max);
      for (const [id, val] of [["#dom", m.domestic_max], ["#intl", m.international_max]]) {
        const el = $(id);
        el.max = String(val);
        el.value = String(val);
        paintRange(el);
        $(`${id}-out`).textContent = money(val);
      }
    } catch {
      $('[data-filter="origin"]').replaceChildren(pill("", "All", true, "radio"));
    }
  }

  function pill(value, label, on, kind) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.value = value;
    b.textContent = label;
    if (kind === "radio") { b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(on)); }
    else b.setAttribute("aria-pressed", String(on));
    return b;
  }

  // ---------------- deals ----------------
  let reqId = 0;
  async function loadDeals() {
    const id = ++reqId;
    const grid = $("#deals");
    if (!grid.children.length) {
      grid.replaceChildren(...Array.from({ length: 6 }, () => {
        const s = document.createElement("div");
        s.className = "deal glass skeleton";
        return s;
      }));
    }
    const q = new URLSearchParams({ sort: state.sort, limit: "60" });
    if (state.origin) q.set("origin", state.origin);
    if (state.kind) q.set("kind", state.kind);
    if (state.max) q.set("max", String(state.max));
    let deals = [];
    try {
      const r = await fetch(`/api/deals?${q}`);
      deals = (await r.json()).deals ?? [];
    } catch { /* show empty state */ }
    if (id !== reqId) return;
    grid.replaceChildren(...deals.map(card));
    $("#empty").hidden = deals.length > 0;
  }

  function card(d, i) {
    const n = $("#deal-tpl").content.firstElementChild.cloneNode(true);
    n.style.animationDelay = `${Math.min(i, 12) * 35}ms`;
    const tag = $(".tag", n);
    tag.textContent = d.kind === "domestic" ? "Domestic" : "International";
    if (d.kind !== "domestic") tag.classList.add("intl");
    $(".fake-tag", n).hidden = !d.is_fake;
    $(".o", n).textContent = d.origin;
    $(".oc", n).textContent = d.origin_city;
    $(".d", n).textContent = d.destination;
    $(".dc", n).textContent = d.destination_city;
    $(".price", n).textContent = money(d.price);
    $(".days", n).textContent = `${d.trip_days} days`;
    $(".dep", n).textContent = fmtDate(d.depart_date);
    $(".ret", n).textContent = fmtDate(d.return_date);
    $(".stops", n).textContent = d.outbound_stops === d.return_stops
      ? stops(d.outbound_stops) : `${stops(d.outbound_stops)} / ${stops(d.return_stops)}`;
    $(".air", n).textContent = d.airlines.join(", ") || "—";
    const a = $("a.view", n);
    if (d.booking_url && /^https:\/\//.test(d.booking_url)) a.href = d.booking_url;
    else a.setAttribute("aria-disabled", "true");
    n.setAttribute("aria-label", `${d.origin_city} to ${d.destination_city}, ${money(d.price)} round trip`);
    return n;
  }

  // ---------------- sign up ----------------
  function wireSignup() {
    const form = $("#signup-form");
    $("#home").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const on = b.getAttribute("aria-pressed") !== "true";
      const others = $$("#home button").filter((x) => x !== b && x.getAttribute("aria-pressed") === "true");
      if (!on && !others.length) return; // keep at least one airport
      b.setAttribute("aria-pressed", String(on));
    });
    for (const id of ["#dom", "#intl"]) {
      const el = $(id);
      el.addEventListener("input", () => { $(`${id}-out`).textContent = money(el.value); paintRange(el); });
    }
    const email = $("#email");
    email.addEventListener("input", () => email.removeAttribute("aria-invalid"));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = $("#form-msg");
      msg.className = "form-msg";
      if (!email.value || !email.checkValidity()) {
        email.setAttribute("aria-invalid", "true");
        msg.textContent = "Enter a valid email.";
        msg.classList.add("err");
        email.focus();
        return;
      }
      const btn = $("button[type=submit]", form);
      btn.disabled = true;
      $("span", btn).textContent = "Signing you up…";
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
            ? "Your alert settings are updated."
            : "Check your inbox and tap the link to confirm.";
          msg.classList.add("ok");
          if (data.status !== "updated") form.reset();
        } else {
          msg.textContent = data.error || "Something went wrong. Try again.";
          msg.classList.add("err");
        }
      } catch {
        msg.textContent = "Couldn't reach the server. Try again.";
        msg.classList.add("err");
      } finally {
        btn.disabled = false;
        $("span", btn).textContent = "Sign me up";
        for (const id of ["#dom", "#intl"]) { $(`${id}-out`).textContent = money($(id).value); paintRange($(id)); }
      }
    });
  }

  // ---------------- boot ----------------
  wirePills($('[data-filter="origin"]'), (v) => { state.origin = v; loadDeals(); });
  wirePills($('[data-filter="kind"]'), (v) => { state.kind = v; loadDeals(); });
  wirePills($('[data-filter="sort"]'), (v) => { state.sort = v; loadDeals(); });
  const max = $("#max");
  let t;
  max.addEventListener("input", () => {
    paintRange(max);
    const atTop = Number(max.value) >= Number(max.max);
    state.max = atTop ? null : Number(max.value);
    $("#max-out").textContent = atTop ? "Any" : `≤ ${money(max.value)}`;
    clearTimeout(t);
    t = setTimeout(loadDeals, 180);
  });
  wireSignup();
  route();
  loadMeta().then(loadDeals);
})();
