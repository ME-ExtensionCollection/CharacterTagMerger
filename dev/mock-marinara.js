// Mock Marinara host for the dev harness. Provides window.__marinaraRunFullPageExtension
// with a fake `marinara` API whose fetch answers the three routes the extension
// uses, backed by a mock library kept in localStorage (key ctm-harness-*).
// The mock library is built from test/fixtures (SillyTavern sample tags), never real cards.
//
// The bulk-tags handler uses CTM.applyTagEdit, which test/core.test.mjs checks
// against Marinara's real applyCharacterTagEdit.
(() => {
  "use strict";

  const LIB_KEY = "ctm-harness-library";
  const STORE_KEY = "ctm-harness-storage";
  const log = (...args) => console.info("[mock marinara]", ...args);

  // mulberry32, same as test/helpers.mjs
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  async function buildLibrary() {
    const { allTags } = await (await fetch("/test/fixtures/st-sample-tags.json")).json();
    const rand = rng(1);
    const cards = [];
    for (let i = 0, n = 0; i < allTags.length; n++) {
      const size = 5 + Math.floor(rand() * 18);
      cards.push({ id: `card-${n}`, name: `Mock Card ${n}`, tags: allTags.slice(i, i + size) });
      i += size;
    }
    // A few messy spellings worth seeing in the editor.
    cards.push({ id: "messy-1", name: "Messy One", tags: ["🔥 dark elf", "#Female", "  female ", "a very long tag that somebody wrote as a full sentence about the card"] });
    cards.push({ id: "messy-2", name: "Messy Two", tags: ["FEMALE", "#fantasy", "slice_of-life"] });
    // Several tags typed as one.
    cards.push({ id: "messy-3", name: "Messy Three", tags: ["cold, sarcastic, tattoo artist, dominant, nsfw-allowed", "Female"] });
    cards.push({ id: "messy-4", name: "Messy Four", tags: ["female, young adult, homeless, survivor, shy, e", "Experienced, Deal With It"] });
    return cards;
  }

  let library = null;
  const saveLibrary = () => localStorage.setItem(LIB_KEY, JSON.stringify(library));
  async function getLibrary() {
    if (library) return library;
    const saved = localStorage.getItem(LIB_KEY);
    library = saved ? JSON.parse(saved) : await buildLibrary();
    saveLibrary();
    return library;
  }

  const stats = { requests: 0, writes: 0, lastBulk: null };
  window.__ctmHarness = {
    stats,
    async reset() {
      localStorage.removeItem(LIB_KEY);
      localStorage.removeItem(STORE_KEY);
      library = null;
      location.reload();
    },
    library: () => getLibrary(),
  };

  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  async function mockFetch(input, init = {}) {
    stats.requests++;
    const url = new URL(typeof input === "string" ? input : input.url, location.origin);
    const method = (init.method ?? "GET").toUpperCase();
    await delay(15);
    const cards = await getLibrary();
    if (method !== "GET" && init.headers?.["x-marinara-csrf"] !== "1") return json(403, { error: "CSRF header missing" });

    if (method === "GET" && url.pathname === "/api/characters/catalog") {
      const limit = Math.min(100, Number(url.searchParams.get("limit")) || 100);
      const offset = Number(url.searchParams.get("offset")) || 0;
      const items = cards.slice(offset, offset + limit).map((c) => ({ ...c, comment: "", creator: "", favorite: false }));
      return json(200, { items, limit, offset, hasMore: offset + limit < cards.length, catalogGeneration: 1 });
    }

    if (method === "POST" && url.pathname === "/api/characters/bulk-tags") {
      if (init.headers?.["Content-Type"] !== "application/json") return json(415, { error: "Content-Type must be application/json" });
      const body = JSON.parse(init.body);
      if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 5000) return json(400, { error: "Select between 1 and 5,000 characters" });
      stats.lastBulk = body;
      const byId = new Map(cards.map((c) => [c.id, c]));
      const result = { updatedIds: [], unchangedIds: [], failedIds: [] };
      for (const id of body.ids) {
        const card = byId.get(id);
        if (!card) {
          result.failedIds.push(id);
          continue;
        }
        const next = CTM.applyTagEdit(card.tags, body);
        if (CTM.tagListsEqual(next, card.tags)) result.unchangedIds.push(id);
        else {
          card.tags = next;
          result.updatedIds.push(id);
          stats.writes++;
        }
      }
      saveLibrary();
      log("bulk-tags", body.ids.length, "ids", { rename: body.rename.length, remove: body.remove.length, add: body.add.length }, result.updatedIds.length, "updated");
      return json(200, result);
    }

    const patch = url.pathname.match(/^\/api\/characters\/([^/]+)$/);
    if (method === "PATCH" && patch) {
      const card = cards.find((c) => c.id === decodeURIComponent(patch[1]));
      if (!card) return json(404, { error: "Character not found" });
      card.tags = JSON.parse(init.body).data.tags;
      stats.writes++;
      saveLibrary();
      return json(200, { id: card.id });
    }

    return json(404, { error: `Mock has no ${method} ${url.pathname}` });
  }

  const storage = Object.freeze({
    async get() {
      return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
    },
    async patch(value) {
      const next = { ...JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}"), ...value };
      const text = JSON.stringify(next);
      if (text.length > 1_000_000) throw new Error("Extension storage is limited to 1,000,000 bytes");
      localStorage.setItem(STORE_KEY, text);
      return next;
    },
    async clear() {
      localStorage.removeItem(STORE_KEY);
    },
  });

  const cleanups = [];
  window.__marinaraRunFullPageExtension = (identity, main) => {
    const api = Object.freeze({
      version: 1,
      extension: Object.freeze(identity),
      estimateTextTokens: (text) => Math.ceil(String(text).length / 4),
      log: Object.freeze({ debug: console.debug, info: console.info, warn: console.warn, error: console.error }),
      storage,
      fetch: mockFetch,
      setTimeout: (cb, ms, ...args) => window.setTimeout(cb, ms, ...args),
      clearTimeout: (id) => window.clearTimeout(id),
      setInterval: (cb, ms, ...args) => window.setInterval(cb, ms, ...args),
      clearInterval: (id) => window.clearInterval(id),
      onCleanup: (fn) => cleanups.push(fn),
    });
    queueMicrotask(() =>
      main(api).then(
        () => log("extension ready"),
        (error) => console.error("[mock marinara] extension failed", error),
      ),
    );
  };
  window.__ctmHarness.stop = async () => {
    for (const fn of cleanups.reverse()) await fn();
    log("extension stopped");
  };
})();
