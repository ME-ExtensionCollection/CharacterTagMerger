// Character Tag Merger: the editor overlay. Plain DOM; every tag string goes
// in through textContent or input.value, never as HTML, because tags come from
// card authors.

const ctmUi = (() => {
  "use strict";

  const CHIP_LIMIT = 300; // side-pane chips rendered before "Show more"
  const LIST_LIMIT = 500; // rows per preview list
  const UNDO_LIMIT = 50;
  const RESTORE_SPACING_MS = 150; // ~400 PATCH/min, under Marinara's 600 requests/min default

  let root = null;
  let cards = [];
  let stats = new Map();
  let buckets = { groups: [], unassigned: [], removed: [] };
  let loading = false;
  let busy = false; // a write is running: no closing
  let popover = null;
  const dialogs = [];
  const undoStack = [];
  const view = {
    q: "",
    show: "all", // all | pending | used | unused
    openCats: new Set(),
    tab: "unassigned",
    hideOneOffs: false,
    selecting: false,
    selected: new Set(),
    chipLimit: CHIP_LIMIT,
  };
  const els = {};

  // ── DOM helpers ──

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "style") Object.assign(node.style, value);
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key in node && key !== "list") node[key] = value;
      else node.setAttribute(key, value === true ? "" : value);
    }
    append(node, children);
    return node;
  }

  function append(node, children) {
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    // Lucide "tags"
    tags: [
      ["path", { d: "m15 5 6.3 6.3a2.4 2.4 0 0 1 0 3.4L17 19" }],
      ["path", { d: "M9.586 5.586A2 2 0 0 0 8.172 5H3a1 1 0 0 0-1 1v5.172a2 2 0 0 0 .586 1.414L8.29 18.29a2.426 2.426 0 0 0 3.42 0l3.58-3.58a2.426 2.426 0 0 0 0-3.42z" }],
      ["circle", { cx: "6.5", cy: "9.5", r: ".5", fill: "currentColor" }],
    ],
    x: [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]],
    search: [["circle", { cx: "11", cy: "11", r: "8" }], ["path", { d: "m21 21-4.3-4.3" }]],
  };

  function icon(name, size = 16) {
    const svg = document.createElementNS(SVG_NS, "svg");
    for (const [k, v] of Object.entries({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) {
      svg.setAttribute(k, String(v));
    }
    for (const [tag, attrs] of ICONS[name]) {
      const child = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, v);
      svg.append(child);
    }
    return svg;
  }

  function button(label, onClick, { kind = "", title, disabled } = {}) {
    const mods = kind.split(" ").filter(Boolean).map((k) => ` ctm-btn--${k}`).join("");
    return h("button", { type: "button", class: `ctm-btn${mods}`, title, disabled, onClick }, label);
  }

  function checkbox(label, checked, onChange, title) {
    return h(
      "label",
      { class: "ctm-check", title },
      h("input", { type: "checkbox", checked, onChange: (e) => onChange(e.currentTarget.checked) }),
      h("span", { text: label }),
    );
  }

  const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

  function downloadJson(filename, data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = h("a", { href: url, download: filename, style: { display: "none" } });
    document.body.append(a);
    a.click();
    a.remove();
    marinara.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function pickJsonFile() {
    return new Promise((resolve, reject) => {
      const input = h("input", { type: "file", accept: ".json,application/json", style: { display: "none" } });
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return resolve(null);
        try {
          resolve({ name: file.name, json: JSON.parse(await file.text()) });
        } catch {
          reject(new Error(`${file.name} is not valid JSON.`));
        }
      });
      input.addEventListener("cancel", () => {
        input.remove();
        resolve(null);
      });
      document.body.append(input);
      input.click();
    });
  }

  function toast(text, kind = "info") {
    if (!els.toasts) return;
    const node = h("div", { class: `ctm-toast ctm-toast--${kind}`, role: "status", text });
    els.toasts.append(node);
    marinara.setTimeout(() => node.remove(), kind === "error" ? 9000 : 4500);
  }

  // ── Popover picker ──

  function closePopover() {
    popover?.node.remove();
    popover = null;
  }

  /**
   * A filterable menu next to `anchor`.
   *   options(q)  -> [{ label, hint?, onPick }]   filtered list (q is lowercase)
   *   create(raw) -> { label, onPick } | null       typed value that is not in the list
   *   fixed       [{ label, onPick, kind? }]        actions under the list
   */
  function openPicker(anchor, { placeholder = "Filter…", options, create, fixed = [], note } = {}) {
    closePopover();
    let active = 0;
    let items = [];
    const input = options ? h("input", { class: "ctm-input", type: "text", placeholder }) : null;
    const list = h("div", { class: "ctm-pop-list", role: "listbox" });
    const pick = (item) => {
      closePopover();
      item.onPick();
    };
    const renderList = () => {
      if (!options) return;
      const raw = input.value.trim();
      items = options(raw.toLowerCase()).slice(0, 60);
      const extra = raw && create ? create(raw) : null;
      if (extra) items.push(extra);
      active = Math.min(active, Math.max(0, items.length - 1));
      list.replaceChildren(
        ...(items.length
          ? items.map((item, i) =>
              h(
                "button",
                { type: "button", class: `ctm-pop-item${i === active ? " is-active" : ""}`, onClick: () => pick(item), onMouseenter: () => (active = i) },
                h("span", { text: item.label }),
                item.hint ? h("span", { class: "ctm-muted", text: item.hint }) : null,
              ),
            )
          : [h("div", { class: "ctm-pop-empty", text: "No matches" })]),
      );
    };
    const node = h(
      "div",
      { class: "ctm-popover", role: "dialog" },
      note ? h("div", { class: "ctm-pop-note", text: note }) : null,
      input,
      options ? list : null,
      fixed.length
        ? h(
            "div",
            { class: "ctm-pop-fixed" },
            fixed.map((item) => h("button", { type: "button", class: `ctm-pop-item${item.kind ? ` ctm-pop-item--${item.kind}` : ""}`, onClick: () => pick(item), text: item.label })),
          )
        : null,
    );
    input?.addEventListener("input", () => {
      active = 0;
      renderList();
    });
    input?.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length);
        renderList();
      } else if (e.key === "Enter" && items[active]) {
        e.preventDefault();
        pick(items[active]);
      }
    });
    root.append(node);
    popover = { node, anchor };
    renderList();
    const r = anchor.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    const top = r.bottom + box.height + 8 > window.innerHeight ? Math.max(8, r.top - box.height - 4) : r.bottom + 4;
    node.style.top = `${top}px`;
    node.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - box.width - 8))}px`;
    (input ?? node.querySelector("button"))?.focus();
  }

  // ── Dialogs ──

  /** A modal panel inside the overlay. Returns { body, setActions, close, result }. */
  function openDialog({ title, body = [], wide = false, closable = true }) {
    closePopover();
    let resolve;
    const result = new Promise((r) => (resolve = r));
    const bodyEl = h("div", { class: "ctm-dialog-body" }, body);
    const actionsEl = h("div", { class: "ctm-dialog-actions" });
    const box = h("div", { class: `ctm-dialog${wide ? " ctm-dialog--wide" : ""}`, role: "dialog", "aria-modal": "true" }, h("h3", { text: title }), bodyEl, actionsEl);
    const backdrop = h("div", { class: "ctm-dialog-backdrop" }, box);
    const handle = {
      body: bodyEl,
      closable,
      setBody: (...nodes) => bodyEl.replaceChildren(...nodes.flat(Infinity).filter(Boolean)),
      setActions(actions) {
        actionsEl.replaceChildren(
          ...actions.map((a) => button(a.label, () => (a.onClick ? a.onClick() : handle.close(a.value)), { kind: a.kind, disabled: a.disabled, title: a.title })),
        );
      },
      close(value = null) {
        backdrop.remove();
        const i = dialogs.indexOf(handle);
        if (i >= 0) dialogs.splice(i, 1);
        resolve(value);
      },
      result,
    };
    dialogs.push(handle);
    root.append(backdrop);
    return handle;
  }

  async function confirmDialog(title, body, okLabel, { kind = "primary", wide = false } = {}) {
    const d = openDialog({ title, body, wide });
    d.setActions([
      { label: "Cancel", value: false },
      { label: okLabel, value: true, kind },
    ]);
    return (await d.result) === true;
  }

  function messageDialog(title, body) {
    const d = openDialog({ title, body });
    d.setActions([{ label: "OK", value: true, kind: "primary" }]);
    return d.result;
  }

  function promptDialog(title, label, value = "") {
    const input = h("input", { class: "ctm-input", type: "text", value });
    const d = openDialog({ title, body: [h("label", { class: "ctm-field" }, h("span", { text: label }), input)] });
    const submit = () => d.close(input.value.trim() || null);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    d.setActions([
      { label: "Cancel", value: null },
      { label: "OK", kind: "primary", onClick: submit },
    ]);
    marinara.setTimeout(() => input.select(), 0);
    return d.result;
  }

  /** A titled, scrollable list for previews, capped at LIST_LIMIT rows. */
  function section(title, rows, empty = null) {
    if (!rows.length && !empty) return null;
    const shown = rows.slice(0, LIST_LIMIT);
    return h(
      "div",
      { class: "ctm-section" },
      h("div", { class: "ctm-section-title", text: title }),
      rows.length
        ? h("div", { class: "ctm-section-list" }, shown, rows.length > shown.length ? h("div", { class: "ctm-muted", text: `…and ${(rows.length - shown.length).toLocaleString()} more` }) : null)
        : h("div", { class: "ctm-muted", text: empty }),
    );
  }

  const diffRow = (from, to, count) =>
    h("div", { class: "ctm-diff" }, h("del", { text: from }), " → ", h("ins", { text: to }), count !== undefined ? h("span", { class: "ctm-count", text: `×${count}` }) : null);
  const conflictRow = (c) =>
    h("div", { class: "ctm-diff" }, h("b", { text: c.spelling }), ": ", c.canonicals.map((name, i) => [i ? ", " : "", name === c.winner ? h("ins", { text: `${name} (wins)` }) : h("del", { text: name })]));
  const tagRow = (tag, count, kind = "") => h("div", { class: `ctm-diff ${kind}` }, h("span", { text: tag }), count !== undefined ? h("span", { class: "ctm-count", text: `×${count}` }) : null);

  // ── State ──

  const dict = () => ctmStore.dict;

  function recompute() {
    buckets = CTM.bucketize(stats, dict(), { maxTagLength: ctmStore.maxTagLength });
  }

  /** Run a dictionary edit with undo, save and re-render. `fn` returns false to signal "nothing changed". */
  function edit(fn, failMessage) {
    const snapshot = JSON.stringify(dict());
    const ok = fn(dict());
    if (ok === false) {
      if (failMessage) toast(failMessage, "warn");
      return false;
    }
    if (JSON.stringify(dict()) === snapshot) return false;
    undoStack.push(snapshot);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    ctmStore.save();
    refresh();
    return true;
  }

  function undo() {
    const snapshot = undoStack.pop();
    if (!snapshot) return;
    ctmStore.dict = JSON.parse(snapshot);
    refresh();
    toast("Undid the last dictionary change.");
  }

  function refresh() {
    recompute();
    render();
  }

  async function loadLibrary() {
    if (loading) return;
    loading = true;
    els.stats.textContent = "Loading characters…";
    try {
      cards = await ctmApi.loadCharacters((n) => {
        els.stats.textContent = `Loading characters… ${n.toLocaleString()}`;
      });
      stats = CTM.scanCards(cards);
      loading = false;
      refresh();
    } catch (error) {
      loading = false;
      renderFooter();
      els.stats.textContent = "Could not load characters.";
      toast(error.message, "error");
    }
  }

  // ── Matching for search and filters ──

  const matches = (text, q) => !q || CTM.norm(text).includes(q);
  const observed = (group) => group.variants.filter((v) => v.count > 0 && v.tag !== group.canonical);
  const isPending = (group) => observed(group).length > 0;

  function groupVisible(group, q) {
    if (view.show === "pending" && !isPending(group)) return false;
    if (view.show === "used" && group.cardCount === 0) return false;
    if (view.show === "unused" && group.cardCount > 0) return false;
    if (!q) return true;
    return matches(group.canonical, q) || group.variants.some((v) => v.count > 0 && matches(v.tag, q)) || group.implies.some((t) => matches(t, q));
  }

  // ── Render ──

  function render() {
    if (!root) return;
    const keep = [els.canonScroll, els.sideScroll].map((n) => n?.scrollTop ?? 0);
    renderStats();
    renderCanon();
    renderSide();
    renderFooter();
    [els.canonScroll, els.sideScroll].forEach((n, i) => n && (n.scrollTop = keep[i]));
  }

  function renderStats() {
    const removing = buckets.removed.filter((r) => r.count > 0).length;
    els.stats.textContent = [
      plural(cards.length, "card"),
      plural(stats.size, "distinct tag"),
      plural(buckets.groups.length, "canonical"),
      `${buckets.unassigned.length.toLocaleString()} unassigned`,
      `${removing.toLocaleString()} to remove`,
    ].join(" · ");
  }

  function renderCanon() {
    const q = CTM.norm(view.q);
    const byCat = new Map();
    for (const group of buckets.groups) {
      const cat = group.category || "";
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(group);
    }
    const order = [...dict().categoryOrder.filter((c) => byCat.has(c)), ...[...byCat.keys()].filter((c) => c && !dict().categoryOrder.includes(c))];
    if (byCat.has("")) order.push("");

    const sections = [];
    for (const cat of order) {
      const all = byCat.get(cat);
      const catMatches = q && cat && matches(cat, q);
      const shown = all.filter((g) => groupVisible(g, catMatches && view.show === "all" ? "" : q));
      if (!shown.length) continue;
      const open = q || view.show !== "all" || view.openCats.has(cat);
      const pending = all.filter(isPending).length;
      const header = h(
        "button",
        {
          type: "button",
          class: "ctm-cat-header",
          "aria-expanded": String(!!open),
          onClick: () => {
            if (view.openCats.has(cat)) view.openCats.delete(cat);
            else view.openCats.add(cat);
            render();
          },
        },
        h("span", { class: "ctm-cat-caret", text: open ? "▾" : "▸" }),
        h("span", { class: "ctm-cat-name", text: cat || "Uncategorized" }),
        h("span", { class: "ctm-muted", text: q || view.show !== "all" ? `${shown.length} of ${all.length}` : plural(all.length, "canonical") }),
        pending ? h("span", { class: "ctm-badge", title: "Canonicals that rename or merge tags on Apply", text: `${pending} to merge` }) : null,
      );
      sections.push(h("section", { class: "ctm-cat" }, header, open ? h("div", { class: "ctm-cat-rows" }, shown.map(renderRow)) : null));
    }
    els.canonScroll.replaceChildren(
      ...(sections.length
        ? sections
        : [h("div", { class: "ctm-empty", text: buckets.groups.length ? "No canonical tags match." : "No canonical tags yet. Import your dictionary (Tools → Import) or add one with + New canonical." })]),
    );
  }

  function renderRow(group) {
    const nameInput = h("input", { class: "ctm-input ctm-canon-name", type: "text", value: group.canonical, title: "Rename this canonical. The old spelling stays as a variant." });
    nameInput.addEventListener("change", () => {
      const next = nameInput.value.trim();
      if (!next || next === group.canonical) {
        nameInput.value = group.canonical;
        return;
      }
      const clash = CTM.findCanonical(dict(), next);
      if (!edit((d) => CTM.renameCanonical(d, group.canonical, next), clash ? `"${clash}" already exists. Use ⋯ → Merge into instead.` : "Could not rename.")) {
        nameInput.value = group.canonical;
      }
    });
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") nameInput.blur();
    });

    const chips = observed(group).map((v) => tagChip(v, group));
    const unused = group.variants.filter((v) => v.count === 0);
    return h(
      "div",
      { class: `ctm-row${group.cardCount === 0 ? " ctm-row--idle" : ""}${isPending(group) ? " ctm-row--pending" : ""}`, dataset: { canonical: group.canonical } },
      h(
        "div",
        { class: "ctm-row-head" },
        nameInput,
        h("span", { class: "ctm-count", title: "Cards with this canonical or one of its variants", text: plural(group.cardCount, "card") }),
        h("button", {
          type: "button",
          class: "ctm-btn ctm-btn--ghost ctm-btn--small",
          title: "Change category",
          text: group.category || "Uncategorized",
          onClick: (e) => openCategoryPicker(e.currentTarget, group),
        }),
        h("button", { type: "button", class: "ctm-btn ctm-btn--ghost ctm-btn--small", title: "More actions", text: "⋯", "aria-label": `Actions for ${group.canonical}`, onClick: (e) => openRowMenu(e.currentTarget, group) }),
      ),
      chips.length || unused.length
        ? h(
            "div",
            { class: "ctm-chips" },
            chips,
            unused.length ? h("span", { class: "ctm-muted ctm-unused", title: unused.map((v) => v.tag).join(", "), text: `+${unused.length} unused` }) : null,
          )
        : null,
      h(
        "div",
        { class: "ctm-implies" },
        group.implies.map((t) =>
          h(
            "span",
            { class: "ctm-chip ctm-chip--implies", title: `Apply also adds "${t}" to every card with ${group.canonical}` },
            h("span", { text: `→ ${t}` }),
            h("button", { type: "button", class: "ctm-chip-x", title: "Stop implying this tag", "aria-label": `Stop implying ${t}`, text: "×", onClick: () => edit((d) => CTM.removeImplication(d, group.canonical, t)) }),
          ),
        ),
        h("button", { type: "button", class: "ctm-link", text: "+ implies", title: "Also add another tag to every card with this canonical (e.g. Dark Elf → Elf). Chains are followed.", onClick: (e) => openImpliesPicker(e.currentTarget, group) }),
      ),
    );
  }

  function tagChip(item, from) {
    const fromGroup = typeof from === "object" ? from : null;
    const own = fromGroup && item.own;
    const selected = view.selecting && !fromGroup && view.selected.has(item.tag);
    const cls = ["ctm-chip"];
    if (own) cls.push("ctm-chip--own");
    if (from === "removed") cls.push(item.auto ? "ctm-chip--auto" : "ctm-chip--removed");
    if (selected) cls.push("is-selected");
    let title = "Click to move";
    if (own) title = `Same tag as "${fromGroup.canonical}" in a different spelling. Apply renames it.`;
    else if (item.auto) title = `Longer than ${ctmStore.maxTagLength} characters, so it is removed automatically. Map it to a canonical to keep it.`;
    else if (view.selecting && !fromGroup) title = "Click to select";
    return h(
      "button",
      {
        type: "button",
        class: cls.join(" "),
        title,
        onClick: (e) => {
          if (view.selecting && !fromGroup) {
            if (view.selected.has(item.tag)) view.selected.delete(item.tag);
            else view.selected.add(item.tag);
            renderSide();
            return;
          }
          if (own) {
            toast(title);
            return;
          }
          openTagMenu(e.currentTarget, item, from);
        },
      },
      h("span", { class: "ctm-chip-label", text: item.tag }),
      h("span", { class: "ctm-chip-count", text: item.count.toLocaleString() }),
    );
  }

  function canonicalOptions(q, exclude, onPick) {
    return buckets.groups
      .filter((g) => g.canonical !== exclude && (!q || g.canonical.toLowerCase().includes(q)))
      .map((g) => ({ label: g.canonical, hint: g.category, onPick: () => onPick(g.canonical) }));
  }

  function openTagMenu(anchor, item, from) {
    const fromGroup = typeof from === "object" ? from : null;
    const fixed = [];
    if (fromGroup || (from === "removed" && !item.auto)) fixed.push({ label: "Unassign (leave as is)", onPick: () => edit((d) => CTM.unassignTag(d, item.tag)) });
    if (from !== "removed") fixed.push({ label: "Remove from every card", kind: "danger", onPick: () => edit((d) => CTM.removeTag(d, item.tag)) });
    fixed.push({
      label: "New canonical from this tag",
      onPick: () => {
        const name = CTM.pickCanonical([item]);
        edit((d) => {
          const created = CTM.createCanonical(d, name, fromGroup?.category ?? "");
          if (CTM.norm(created) !== CTM.norm(item.tag)) CTM.assignTag(d, item.tag, created);
        });
      },
    });
    openPicker(anchor, {
      placeholder: "Move to canonical…",
      note: `${item.tag} · ${plural(item.count, "card")}`,
      options: (q) => canonicalOptions(q, fromGroup?.canonical, (canonical) => edit((d) => CTM.assignTag(d, item.tag, canonical), "That tag is a canonical's own name.")),
      fixed,
    });
  }

  function openRowMenu(anchor, group) {
    openPicker(anchor, {
      note: group.canonical,
      fixed: [
        {
          label: "Merge into another canonical…",
          onPick: () =>
            openPicker(anchor, {
              placeholder: `Merge ${group.canonical} into…`,
              options: (q) =>
                canonicalOptions(q, group.canonical, (target) => {
                  if (edit((d) => CTM.mergeCanonical(d, group.canonical, target))) toast(`Merged "${group.canonical}" into "${target}".`);
                }),
            }),
        },
        {
          label: "Delete canonical (variants become unassigned)",
          kind: "danger",
          onPick: () => edit((d) => CTM.deleteCanonical(d, group.canonical)),
        },
      ],
    });
  }

  function openCategoryPicker(anchor, group) {
    openPicker(anchor, {
      placeholder: "Filter or type a new category…",
      options: (q) =>
        dict()
          .categoryOrder.filter((c) => c !== group.category && (!q || c.toLowerCase().includes(q)))
          .map((c) => ({ label: c, onPick: () => edit((d) => CTM.setCategory(d, group.canonical, c)) })),
      create: (raw) =>
        dict().categoryOrder.some((c) => c.toLowerCase() === raw.toLowerCase()) ? null : { label: `+ New category "${raw}"`, onPick: () => edit((d) => CTM.setCategory(d, group.canonical, raw)) },
      fixed: group.category ? [{ label: "Uncategorized", onPick: () => edit((d) => CTM.setCategory(d, group.canonical, "")) }] : [],
    });
  }

  function openImpliesPicker(anchor, group) {
    const taken = new Set([CTM.norm(group.canonical), ...group.implies.map(CTM.norm)]);
    openPicker(anchor, {
      placeholder: "Canonical, or type any tag…",
      options: (q) => canonicalOptions(q, group.canonical, (c) => edit((d) => CTM.addImplication(d, group.canonical, c))).filter((o) => !taken.has(CTM.norm(o.label))),
      create: (raw) =>
        taken.has(CTM.norm(raw)) || CTM.findCanonical(dict(), raw) ? null : { label: `+ Imply "${raw}" (not a canonical)`, onPick: () => edit((d) => CTM.addImplication(d, group.canonical, raw)) },
    });
  }

  function sideItems() {
    const q = CTM.norm(view.q);
    let items = view.tab === "unassigned" ? buckets.unassigned : buckets.removed.filter((r) => r.count > 0);
    if (view.tab === "unassigned" && view.hideOneOffs) items = items.filter((i) => i.count > 1);
    return q ? items.filter((i) => matches(i.tag, q)) : items;
  }

  function renderSide() {
    const unassignedCount = buckets.unassigned.length;
    const removedCount = buckets.removed.filter((r) => r.count > 0).length;
    els.tabs.replaceChildren(
      ...[
        ["unassigned", `Unassigned (${unassignedCount.toLocaleString()})`, "On cards, mapped to nothing. Left as they are on Apply."],
        ["removed", `Removed (${removedCount.toLocaleString()})`, "Removed from every card on Apply, unless Skip Removed is on."],
      ].map(([tab, label, title]) =>
        h("button", {
          type: "button",
          class: `ctm-tab${view.tab === tab ? " is-active" : ""}`,
          role: "tab",
          "aria-selected": String(view.tab === tab),
          title,
          text: label,
          onClick: () => {
            view.tab = tab;
            view.selecting = false;
            view.selected.clear();
            view.chipLimit = CHIP_LIMIT;
            renderSide();
          },
        }),
      ),
    );

    const items = sideItems();
    const tools = [];
    if (view.tab === "unassigned") {
      tools.push(
        checkbox("Hide one-offs", view.hideOneOffs, (v) => {
          view.hideOneOffs = v;
          renderSide();
        }, "Hide tags that are on only one card"),
      );
    }
    tools.push(h("span", { class: "ctm-muted", text: plural(items.length, "tag") }));
    tools.push(
      button(view.selecting ? "Done selecting" : "Select", () => {
        view.selecting = !view.selecting;
        view.selected.clear();
        renderSide();
      }, { kind: "small" }),
    );
    els.sideTools.replaceChildren(...tools);
    els.bulkBar.replaceChildren(...(view.selecting ? bulkBar(items) : []));
    els.bulkBar.hidden = !view.selecting;

    const shown = items.slice(0, view.chipLimit);
    els.sideScroll.replaceChildren(
      ...(items.length
        ? [
            h("div", { class: "ctm-chips" }, shown.map((item) => tagChip(item, view.tab))),
            items.length > shown.length
              ? button(`Show ${Math.min(CHIP_LIMIT, items.length - shown.length).toLocaleString()} more (${(items.length - shown.length).toLocaleString()} hidden)`, () => {
                  view.chipLimit += CHIP_LIMIT;
                  renderSide();
                }, { kind: "ghost" })
              : null,
          ].filter(Boolean)
        : [h("div", { class: "ctm-empty", text: view.q ? "No tags match." : view.tab === "unassigned" ? "Every tag is mapped or removed." : "No tags are set to be removed." })]),
    );
  }

  function bulkBar(items) {
    const selected = [...view.selected];
    const n = selected.length;
    const others = view.tab === "unassigned" ? "removed" : "unassigned";
    const moveTo = (fn) => {
      edit((d) => {
        for (const tag of selected) fn(d, tag);
      });
      view.selected.clear();
      renderSide();
    };
    const parts = [
      h("span", { class: "ctm-bulk-count", text: `${n} selected` }),
      button("Select all shown", () => {
        for (const item of items.slice(0, view.chipLimit)) view.selected.add(item.tag);
        renderSide();
      }, { kind: "small" }),
    ];
    if (n > 0) {
      parts.push(
        button("Move to canonical…", (e) =>
          openPicker(e.currentTarget, {
            placeholder: "Move to canonical…",
            options: (q) => canonicalOptions(q, null, (c) => moveTo((d, tag) => CTM.assignTag(d, tag, c))),
          }), { kind: "small" }),
        button("New canonical", () => {
          const picked = items.filter((i) => view.selected.has(i.tag));
          const name = CTM.pickCanonical(picked.length ? picked : selected.map((tag) => ({ tag, count: 0 })));
          moveTo((d, tag) => {
            const created = CTM.createCanonical(d, name);
            if (CTM.norm(tag) !== CTM.norm(created)) CTM.assignTag(d, tag, created);
          });
        }, { kind: "small" }),
        others === "removed"
          ? button("Remove", () => moveTo((d, tag) => CTM.removeTag(d, tag)), { kind: "small danger" })
          : button("Back to Unassigned", () => moveTo((d, tag) => CTM.unassignTag(d, tag)), { kind: "small" }),
        button("Clear", () => {
          view.selected.clear();
          renderSide();
        }, { kind: "small ghost" }),
      );
    }
    return parts;
  }

  function renderFooter() {
    els.undo.disabled = undoStack.length === 0;
    els.apply.disabled = loading || cards.length === 0;
  }

  // ── Actions: new canonical, categories ──

  async function onNewCanonical() {
    const name = await promptDialog("New canonical tag", "Name");
    if (!name) return;
    const existing = CTM.findCanonical(dict(), name);
    if (existing) {
      toast(`"${existing}" already exists.`, "warn");
      view.q = existing;
      els.search.value = existing;
      render();
      return;
    }
    edit((d) => CTM.createCanonical(d, name));
    view.q = name;
    els.search.value = name;
    render();
  }

  function openCategoryManager() {
    const d = openDialog({ title: "Categories", wide: true });
    const draw = () => {
      const order = dict().categoryOrder;
      const counts = new Map();
      for (const cat of Object.values(dict().categories)) counts.set(cat, (counts.get(cat) ?? 0) + 1);
      d.setBody(
        h("p", { class: "ctm-muted", text: "Categories only organize this editor; they never become part of a tag. Deleting a category moves its canonicals, it never deletes them." }),
        order.length
          ? order.map((cat, i) => {
              const name = h("input", { class: "ctm-input", type: "text", value: cat });
              name.addEventListener("change", () => {
                if (!edit((dd) => CTM.renameCategory(dd, cat, name.value), "That category name is taken.")) name.value = cat;
                draw();
              });
              return h(
                "div",
                { class: "ctm-catmgr-row" },
                name,
                h("span", { class: "ctm-muted", text: plural(counts.get(cat) ?? 0, "canonical") }),
                button("↑", () => (edit((dd) => CTM.moveCategory(dd, cat, -1)), draw()), { kind: "small", disabled: i === 0, title: "Move up" }),
                button("↓", () => (edit((dd) => CTM.moveCategory(dd, cat, 1)), draw()), { kind: "small", disabled: i === order.length - 1, title: "Move down" }),
                button("Delete", async () => {
                  let target = "";
                  if (counts.get(cat)) {
                    const select = h("select", { class: "ctm-input" }, h("option", { value: "", text: "Uncategorized" }), order.filter((c) => c !== cat).map((c) => h("option", { value: c, text: c })));
                    const ok = await confirmDialog(`Delete "${cat}"?`, [h("p", { text: `${plural(counts.get(cat), "canonical")} use it. Move them to:` }), select], "Move and delete");
                    if (!ok) return;
                    target = select.value;
                  }
                  edit((dd) => CTM.deleteCategory(dd, cat, target));
                  draw();
                }, { kind: "small danger" }),
              );
            })
          : h("div", { class: "ctm-empty", text: "No categories yet. Pick one from a canonical's category button to create it." }),
      );
    };
    d.setActions([{ label: "Close", value: true, kind: "primary" }]);
    draw();
  }

  // ── Actions: import / export / cleanup ──

  function exportDictionary(withUnassigned) {
    const data = CTM.exportDict(dict(), { unassigned: withUnassigned ? buckets.unassigned : null });
    downloadJson(`tag-mapping-${stamp()}${withUnassigned ? "-with-unassigned" : ""}.json`, data);
    toast(`Exported ${plural(Object.keys(dict().mapping).length, "canonical")}${withUnassigned ? ` and ${plural(buckets.unassigned.length, "unassigned tag")}` : ""}.`);
  }

  async function importDictionary() {
    let file;
    try {
      file = await pickJsonFile();
    } catch (error) {
      toast(error.message, "error");
      return;
    }
    if (!file) return;
    let parsed;
    try {
      parsed = CTM.parseImport(file.json, dict());
    } catch (error) {
      toast(`Could not import ${file.name}: ${error.message}`, "error");
      return;
    }
    if (Object.keys(parsed.dict.mapping).length === 0) {
      toast(`Could not import ${file.name}: the mapping is empty.`, "error");
      return;
    }
    const diff = CTM.diffDicts(dict(), parsed.dict);
    const hasCurrent = Object.keys(dict().mapping).length > 0 || dict().removedTags.length > 0;
    const totals = [
      ["Canonicals", diff.canonicals],
      ["Variants", diff.variants],
      ["Removed tags", diff.removed],
      ["Categories", diff.categories],
      ["Implications", diff.implications],
    ];
    const ok = await confirmDialog(
      "Import dictionary",
      [
        h("p", {}, "From ", h("b", { text: file.name }), ". This replaces the saved dictionary. Cards are not touched until you Apply."),
        h("table", { class: "ctm-table" }, h("tr", {}, h("th"), h("th", { text: "Current" }), h("th", { text: "Imported" })), totals.map(([label, [a, b]]) => h("tr", {}, h("td", { text: label }), h("td", { text: a.toLocaleString() }), h("td", { text: b.toLocaleString() })))),
        parsed.impliesKept ? h("p", { class: "ctm-muted", text: "The file has no implications, so the current ones are kept." }) : null,
        parsed.skipped ? h("p", { class: "ctm-warn", text: `${plural(parsed.skipped, "malformed entry", "malformed entries")} skipped.` }) : null,
        section(`New canonicals (${diff.added.length})`, diff.added.map((c) => tagRow(c))),
        section(`Canonicals not in the file (${diff.dropped.length})`, diff.dropped.map((c) => tagRow(c, undefined, "ctm-diff--del"))),
        section(`Tags listed under two canonicals (${parsed.conflicts.length}). The one listed last gets the tag, as in SillyTavern; Tools → Clean up dictionary removes the extra entries.`, parsed.conflicts.map(conflictRow)),
        section(`Implications skipped: not a canonical (${parsed.impliesDropped.length})`, parsed.impliesDropped.map((c) => tagRow(c))),
        hasCurrent ? h("p", { class: "ctm-muted", text: "Your current dictionary is downloaded first, so you can import it back." }) : null,
      ],
      hasCurrent ? "Download current and import" : "Import",
      { wide: true },
    );
    if (!ok) return;
    if (hasCurrent) downloadJson(`tag-mapping-before-import-${stamp()}.json`, CTM.exportDict(dict()));
    undoStack.push(JSON.stringify(dict()));
    ctmStore.dict = parsed.dict;
    refresh();
    toast(`Imported ${plural(Object.keys(parsed.dict.mapping).length, "canonical")}.`);
  }

  async function cleanupDictionary() {
    const plan = CTM.planCleanup(dict(), ctmStore.maxTagLength);
    if (!plan.variantPlans.length && !plan.prunedRemoved.length && !plan.duplicates.length && !plan.conflictFixes.length) {
      toast("Nothing to clean up. The dictionary is tidy.");
      return;
    }
    const changes = plan.variantPlans.length + plan.prunedRemoved.length + plan.conflictFixes.length;
    const body = [
      h("p", { text: "Only the saved dictionary changes: no card is touched and nothing that matches today stops matching. Canonicals are never renamed or merged here." }),
      section(
        `Redundant variant spellings (${plan.variantPlans.length} canonicals): same tag as the canonical or another variant`,
        plan.variantPlans.map((p) =>
          h("div", { class: "ctm-diff" }, h("b", { text: p.canonical }), " ", p.dropped.map((t) => [h("del", { text: t }), " "])),
        ),
      ),
      section(`Removed entries already covered by the length rule (${plan.prunedRemoved.length})`, plan.prunedRemoved.map((t) => tagRow(t, undefined, "ctm-diff--del"))),
      section(`Possible duplicate canonicals (${plan.duplicates.length}), not merged: use ⋯ → Merge into`, plan.duplicates.map((names) => tagRow(names.join(" / ")))),
      section(`Tags listed under two canonicals (${plan.conflicts.length}): the struck-through entries never match and are removed`, plan.conflicts.map(conflictRow)),
    ];
    if (!changes) {
      await messageDialog("Dictionary report", body);
      return;
    }
    if (await confirmDialog("Clean up dictionary", body, "Clean up", { wide: true })) {
      edit((d) => CTM.applyCleanup(d, plan));
      toast("Dictionary cleaned up.");
    }
  }

  // ── Actions: apply / restore ──

  const progressText = (text) => h("p", { class: "ctm-progress", text });

  async function onApply() {
    await ctmStore.flush();
    const loadingDialog = openDialog({ title: "Apply tag changes", body: [progressText("Reading the character library…")], closable: false });
    try {
      cards = await ctmApi.loadCharacters((n) => loadingDialog.setBody(progressText(`Reading the character library… ${n.toLocaleString()}`)));
      stats = CTM.scanCards(cards);
      recompute();
    } catch (error) {
      loadingDialog.close();
      toast(error.message, "error");
      return;
    }
    loadingDialog.close();
    render();

    const settings = ctmStore.settings;
    const options = { standardize: settings.standardize, skipRemoved: settings.skipRemoved, maxTagLength: ctmStore.maxTagLength };
    const plan = CTM.planApply(cards, dict(), options);
    if (!plan.changes.length) {
      await messageDialog("Nothing to change", [h("p", { text: "Every card already matches the dictionary." })]);
      return;
    }
    const { summary } = plan;
    const backup = CTM.buildBackup(plan.changes);
    let backedUp = false;
    const d = openDialog({ title: "Apply tag changes", wide: true });
    d.setBody(
      h("p", {}, h("b", { text: plural(summary.cardsChanged, "card") }), " will change. Distinct tags in the library: ", h("b", { text: `${summary.distinctBefore.toLocaleString()} → ${summary.distinctAfter.toLocaleString()}` }), "."),
      h(
        "ul",
        { class: "ctm-options-used" },
        h("li", { text: settings.standardize ? "Standardize unassigned: on (unmapped tags get clean spelling)" : "Standardize unassigned: off" }),
        h("li", { text: settings.skipRemoved ? "Skip Removed: on (nothing is removed)" : "Skip Removed: off (Removed tags are taken off cards)" }),
        h("li", { text: ctmStore.maxTagLength ? `Auto-remove: unmapped tags longer than ${ctmStore.maxTagLength} characters` : "Auto-remove long tags: off" }),
      ),
      section(`Renamed / merged (${summary.renamed.length})`, summary.renamed.map((r) => diffRow(r.from, r.to, r.count))),
      section(`Removed (${summary.removed.length})`, summary.removed.map((r) => tagRow(r.tag, r.count, "ctm-diff--del")), settings.skipRemoved ? "Skip Removed is on." : null),
      section(`Added by implications (${summary.added.length})`, summary.added.map((r) => tagRow(r.tag, r.count, "ctm-diff--add"))),
      h(
        "div",
        { class: "ctm-note" },
        h("p", { text: "1. Download a backup of these cards' current tags. Tools → Restore tags from backup puts them back." }),
        h("p", { text: "2. Apply. Marinara saves a version of each changed card first (unless versioning is off for it), so a single card can also be rolled back from its version history." }),
        h("p", { class: "ctm-muted", text: "Lorebook entries that filter by character tag are not updated." }),
      ),
    );
    const actions = () => [
      { label: "Cancel", value: false },
      { label: backedUp ? "Backup downloaded ✓" : "1. Download backup", onClick: () => {
          downloadJson(`tag-merger-backup-${stamp()}.json`, backup);
          backedUp = true;
          d.setActions(actions());
        } },
      { label: `2. Apply to ${plural(summary.cardsChanged, "card")}`, value: true, kind: "primary", disabled: !backedUp, title: backedUp ? "" : "Download the backup first" },
    ];
    d.setActions(actions());
    if ((await d.result) !== true) return;
    await runApply(plan);
  }

  async function runApply(plan) {
    busy = true;
    const total = plan.changes.length;
    const progress = openDialog({ title: "Applying…", body: [progressText(`Writing 0 of ${total.toLocaleString()} cards…`)], closable: false });
    const result = { updated: 0, unchanged: 0, failed: 0, error: null };
    let done = 0;
    for (let i = 0; i < plan.calls.length; i++) {
      const call = plan.calls[i];
      try {
        const r = await ctmApi.bulkTags(call.ids, call.edit);
        result.updated += r.updatedIds?.length ?? 0;
        result.unchanged += r.unchangedIds?.length ?? 0;
        result.failed += r.failedIds?.length ?? 0;
      } catch (error) {
        result.error = error.message;
        result.failed += plan.calls.slice(i).reduce((n, c) => n + c.ids.length, 0);
        break;
      }
      done += call.ids.length;
      progress.setBody(progressText(`Writing ${done.toLocaleString()} of ${total.toLocaleString()} cards…`));
    }
    progress.close();
    busy = false;
    const d = openDialog({
      title: result.failed ? "Applied with problems" : "Applied",
      body: [
        h("p", { text: `${plural(result.updated, "card")} updated, ${result.unchanged.toLocaleString()} already matched, ${result.failed.toLocaleString()} failed.` }),
        result.error ? h("p", { class: "ctm-warn", text: `Stopped early: ${result.error}. Cards after the failure were not written; your backup still has their old tags.` }) : null,
        h("p", { class: "ctm-muted", text: "Marinara's own lists keep showing the old tags until the page reloads." }),
      ],
    });
    d.setActions([
      { label: "Close", value: "close" },
      { label: "Reload Marinara", value: "reload", kind: "primary" },
    ]);
    const choice = await d.result;
    if (choice === "reload") {
      await ctmStore.flush();
      window.location.reload();
      return;
    }
    await loadLibrary();
  }

  async function restoreBackup() {
    let file;
    try {
      file = await pickJsonFile();
    } catch (error) {
      toast(error.message, "error");
      return;
    }
    if (!file) return;
    let plan;
    try {
      const current = await ctmApi.loadCharacters();
      plan = CTM.planRestore(file.json, current);
    } catch (error) {
      toast(`Could not restore ${file.name}: ${error.message}`, "error");
      return;
    }
    if (!plan.restore.length) {
      await messageDialog("Nothing to restore", [h("p", { text: `Every card in ${file.name} already has its backed-up tags.` }), plan.missing.length ? h("p", { class: "ctm-muted", text: `${plural(plan.missing.length, "card")} from the backup no longer exist.` }) : null]);
      return;
    }
    const minutes = Math.ceil((plan.restore.length * RESTORE_SPACING_MS) / 60000);
    const ok = await confirmDialog(
      "Restore tags from backup",
      [
        h("p", {}, h("b", { text: plural(plan.restore.length, "card") }), ` get the tags saved in ${file.name}. ${plan.unchanged.toLocaleString()} already match. About ${plural(minutes, "minute")}.`),
        plan.missing.length ? h("p", { class: "ctm-warn", text: `${plural(plan.missing.length, "card")} from the backup no longer exist and are skipped.` }) : null,
        section("Cards", plan.restore.map((r) => h("div", { class: "ctm-diff" }, h("b", { text: r.name || r.id }), " ", h("del", { text: r.current.join(", ") || "(none)" }), " → ", h("ins", { text: r.tags.join(", ") || "(none)" })))),
      ],
      `Restore ${plural(plan.restore.length, "card")}`,
      { wide: true },
    );
    if (!ok) return;

    busy = true;
    let cancelled = false;
    let done = 0;
    const failed = [];
    const progress = openDialog({ title: "Restoring…", body: [progressText("Starting…")], closable: false });
    progress.setActions([{ label: "Stop", onClick: () => (cancelled = true) }]);
    for (const entry of plan.restore) {
      if (cancelled) break;
      try {
        await ctmApi.setTags(entry.id, entry.tags);
      } catch (error) {
        failed.push(`${entry.name || entry.id}: ${error.message}`);
      }
      done++;
      progress.setBody(progressText(`Restored ${done.toLocaleString()} of ${plan.restore.length.toLocaleString()} cards…`));
      await new Promise((r) => marinara.setTimeout(r, RESTORE_SPACING_MS));
    }
    progress.close();
    busy = false;
    await messageDialog(cancelled ? "Restore stopped" : "Restore finished", [
      h("p", { text: `${plural(done - failed.length, "card")} restored${cancelled ? `, ${(plan.restore.length - done).toLocaleString()} not reached` : ""}, ${failed.length.toLocaleString()} failed.` }),
      section("Failures", failed.map((f) => tagRow(f))),
      h("p", { class: "ctm-muted", text: "Reload Marinara to see the restored tags in its own lists." }),
    ]);
    await loadLibrary();
  }

  function openTools(anchor) {
    openPicker(anchor, {
      fixed: [
        { label: "Import dictionary…", onPick: importDictionary },
        { label: "Export dictionary", onPick: () => exportDictionary(false) },
        { label: "Export with unassigned tags (for AI review)", onPick: () => exportDictionary(true) },
        { label: "Clean up dictionary…", onPick: cleanupDictionary },
        { label: "Manage categories…", onPick: openCategoryManager },
        { label: "Restore tags from backup…", onPick: restoreBackup },
      ],
    });
  }

  // ── Overlay lifecycle ──

  function onKeydown(e) {
    if (!root) return;
    if (e.key === "Escape") {
      e.stopImmediatePropagation();
      e.preventDefault();
      if (popover) closePopover();
      else if (dialogs.length) {
        const top = dialogs[dialogs.length - 1];
        if (top.closable) top.close(null);
      } else if (!busy) close();
      return;
    }
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing && !dialogs.length) {
      e.preventDefault();
      undo();
    }
  }

  function onPointerdown(e) {
    if (popover && !popover.node.contains(e.target) && !popover.anchor.contains(e.target)) closePopover();
  }

  function build() {
    let searchTimer = 0;
    els.search = h("input", { class: "ctm-input ctm-search", type: "search", placeholder: "Search tags, variants, categories…", "aria-label": "Search tags" });
    els.search.addEventListener("input", () => {
      marinara.clearTimeout(searchTimer);
      searchTimer = marinara.setTimeout(() => {
        view.q = els.search.value;
        view.chipLimit = CHIP_LIMIT;
        render();
      }, 150);
    });
    els.stats = h("div", { class: "ctm-stats", "aria-live": "polite" });
    els.canonScroll = h("div", { class: "ctm-scroll" });
    els.sideScroll = h("div", { class: "ctm-scroll" });
    els.tabs = h("div", { class: "ctm-tabs", role: "tablist" });
    els.sideTools = h("div", { class: "ctm-toolbar" });
    els.bulkBar = h("div", { class: "ctm-bulk", hidden: true });
    els.toasts = h("div", { class: "ctm-toasts" });
    els.undo = button("Undo", undo, { title: "Undo the last dictionary change (Ctrl+Z)" });
    els.apply = button("Apply…", () => void onApply(), { kind: "primary", title: "Preview, back up, then write the changes to your cards" });

    const settings = ctmStore.settings;
    const lengthInput = h("input", { class: "ctm-input ctm-input--num", type: "number", min: "1", step: "1", value: String(settings.maxTagLength), "aria-label": "Maximum tag length" });
    lengthInput.addEventListener("change", () => {
      ctmStore.setSetting("maxTagLength", lengthInput.value);
      lengthInput.value = String(ctmStore.settings.maxTagLength);
      refresh();
    });
    const showSelect = h(
      "select",
      { class: "ctm-input ctm-input--select", "aria-label": "Show canonicals" },
      [["all", "All canonicals"], ["pending", "With merges pending"], ["used", "Used on cards"], ["unused", "Not on any card"]].map(([value, text]) => h("option", { value, text })),
    );
    showSelect.value = view.show;
    showSelect.addEventListener("change", () => {
      view.show = showSelect.value;
      render();
    });

    root = h(
      "div",
      { class: "ctm-overlay", onKeydown: (e) => e.stopPropagation(), onPointerdown },
      h(
        "div",
        { class: "ctm-window", role: "dialog", "aria-modal": "true", "aria-label": "Tag Merger" },
        h(
          "header",
          { class: "ctm-header" },
          h("div", { class: "ctm-title" }, icon("tags", 18), h("h2", { text: "Tag Merger" })),
          els.stats,
          h("label", { class: "ctm-search-wrap" }, icon("search", 14), els.search),
          button("Reload library", () => void loadLibrary(), { kind: "ghost", title: "Read the character library again" }),
          h("button", { type: "button", class: "ctm-btn ctm-btn--ghost ctm-close", title: "Close (Esc)", "aria-label": "Close", onClick: () => !busy && close() }, icon("x")),
        ),
        h(
          "div",
          { class: "ctm-main" },
          h(
            "section",
            { class: "ctm-pane" },
            h(
              "div",
              { class: "ctm-toolbar" },
              h("h3", { text: "Canonical tags" }),
              showSelect,
              button("Expand all", () => {
                for (const g of buckets.groups) view.openCats.add(g.category || "");
                render();
              }, { kind: "small ghost" }),
              button("Collapse all", () => {
                view.openCats.clear();
                render();
              }, { kind: "small ghost" }),
              button("+ New canonical", () => void onNewCanonical(), { kind: "small" }),
            ),
            els.canonScroll,
          ),
          h("aside", { class: "ctm-pane ctm-side" }, els.tabs, els.sideTools, els.bulkBar, els.sideScroll),
        ),
        h(
          "footer",
          { class: "ctm-footer" },
          h(
            "div",
            { class: "ctm-options" },
            checkbox("Standardize unassigned", settings.standardize, (v) => ctmStore.setSetting("standardize", v), "On Apply, also clean the spelling of unmapped tags: strip emoji and #, trim spaces, Title Case all-lowercase tags."),
            checkbox("Skip Removed", settings.skipRemoved, (v) => ctmStore.setSetting("skipRemoved", v), "On Apply, only rename and merge. Removed tags (listed and too long) stay on cards."),
            h(
              "span",
              { class: "ctm-check" },
              checkbox("Auto-remove tags longer than", settings.autoRemoveLong, (v) => {
                ctmStore.setSetting("autoRemoveLong", v);
                refresh();
              }, "Unmapped tags longer than this go to Removed automatically. Mapped tags are always kept."),
              lengthInput,
            ),
          ),
          h("div", { class: "ctm-actions" }, els.undo, button("Tools ▾", (e) => openTools(e.currentTarget)), els.apply),
        ),
        els.toasts,
      ),
    );
  }

  async function open() {
    if (root) {
      els.search.focus();
      return;
    }
    ctmStore.setErrorHandler((error) => toast(`Could not save the dictionary: ${error.message}`, "error"));
    try {
      await ctmStore.load();
    } catch (error) {
      marinara.log.error("Could not read saved dictionary", error);
      window.alert(`Tag Merger could not read its saved dictionary: ${error.message}`);
      return;
    }
    build();
    document.body.append(root);
    window.addEventListener("keydown", onKeydown, true);
    els.search.focus();
    refresh();
    await loadLibrary();
  }

  async function close() {
    if (!root) return;
    closePopover();
    for (const d of [...dialogs]) d.close(null);
    window.removeEventListener("keydown", onKeydown, true);
    root.remove();
    root = null;
    await ctmStore.flush();
  }

  return Object.freeze({ open, close, isOpen: () => !!root, isBusy: () => busy });
})();
