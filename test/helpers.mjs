// Shared test helpers: load extension/src/core.js the way Marinara does (plain
// script, no modules) and build mock character libraries from fixture data.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadCore() {
  const code = readFileSync(join(ROOT, "extension/src/core.js"), "utf8");
  return vm.runInNewContext(`${code}\n;CTM`, {}, { filename: "core.js" });
}

export function readFixture(name) {
  return JSON.parse(readFileSync(join(ROOT, "test/fixtures", name), "utf8"));
}

/** Small deterministic PRNG (mulberry32) so mock libraries are reproducible. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Mock library from the SillyTavern sample corpus: the flat `allTags` list is
 * cut into cards of 5-22 tags with a seeded PRNG. Not real cards, but real tag
 * spellings and frequencies.
 */
export function sampleCards(seed = 1) {
  const { allTags } = readFixture("st-sample-tags.json");
  const rand = rng(seed);
  const cards = [];
  for (let i = 0, n = 0; i < allTags.length; n++) {
    const size = 5 + Math.floor(rand() * 18);
    cards.push({ id: `card-${n}`, name: `Card ${n}`, tags: allTags.slice(i, i + size) });
    i += size;
  }
  return cards;
}

/** Flatten the ST categorized base dictionary into the extension's dict shape. */
export function sampleDict(CTM) {
  const json = readFixture("st-base-dictionary.json");
  return CTM.parseImport(json, CTM.emptyDict()).dict;
}
