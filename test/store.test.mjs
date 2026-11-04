// The store is the one place that writes the saved dictionary, so it gets its
// own guard tests: it must never overwrite saved data it has not read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";
import { ROOT } from "./helpers.mjs";

function loadStore(saved, { failWrites = false } = {}) {
  const writes = [];
  const marinara = {
    storage: {
      get: async () => structuredClone(saved),
      patch: async (value) => {
        if (failWrites) throw new Error("storage full");
        writes.push(structuredClone(value));
        return value;
      },
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
  const code = ["extension/src/core.js", "extension/src/store.js"].map((p) => readFileSync(join(ROOT, p), "utf8")).join("\n\n");
  const store = vm.runInNewContext(`${code}\n;ctmStore`, { marinara, TextEncoder, structuredClone });
  return { store, writes };
}

const SAVED = { dict: { mapping: { Elf: ["elves"] }, removedTags: ["junk"] }, settings: { skipRemoved: true } };

describe("ctmStore", () => {
  it("never writes before the saved data is loaded", async () => {
    const { store, writes } = loadStore(SAVED);
    store.save();
    store.setSetting("standardize", true);
    await store.flush();
    assert.equal(writes.length, 0);
    assert.throws(() => {
      store.dict = {};
    }, /not loaded/);
  });

  it("flush without a change writes nothing", async () => {
    const { store, writes } = loadStore(SAVED);
    await store.load();
    await store.flush();
    assert.equal(writes.length, 0);
    assert.deepEqual(Object.keys(store.dict.mapping), ["Elf"]);
    assert.equal(store.settings.skipRemoved, true);
  });

  it("writes the loaded dictionary plus the change", async () => {
    const { store, writes } = loadStore(SAVED);
    await store.load();
    store.dict.mapping.Orc = [];
    store.save();
    await store.flush();
    assert.equal(writes.length, 1);
    assert.deepEqual(Object.keys(writes[0].dict.mapping), ["Elf", "Orc"]);
    assert.deepEqual(writes[0].dict.removedTags, ["junk"]);
    assert.equal(writes[0].settings.skipRemoved, true);
  });

  it("a failed write stays pending and reports the error", async () => {
    const { store } = loadStore(SAVED, { failWrites: true });
    const errors = [];
    store.setErrorHandler((e) => errors.push(e.message));
    await store.load();
    store.setSetting("standardize", true);
    await store.flush();
    await store.flush();
    assert.deepEqual(errors, ["storage full", "storage full"]);
  });

  it("starts empty when nothing is saved", async () => {
    const { store } = loadStore({});
    await store.load();
    assert.deepEqual(JSON.parse(JSON.stringify(store.dict)), { mapping: {}, removedTags: [], categories: {}, categoryOrder: [], implications: {} });
    assert.equal(store.maxTagLength, 40);
  });
});
