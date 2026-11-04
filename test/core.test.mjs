import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { ROOT, loadCore, rng, sampleCards, sampleDict } from "./helpers.mjs";

const CTM = loadCore();
// core.js runs in its own vm realm; compare plain JSON copies.
const plain = (value) => JSON.parse(JSON.stringify(value));
const eq = (actual, expected, message) => assert.deepStrictEqual(plain(actual), plain(expected), message);

/** What Marinara's server would write: every call applied to the cards it names. */
function simulateServer(cards, calls, applyEdit = CTM.applyTagEdit) {
  const byId = new Map(cards.map((c) => [c.id, { ...c, tags: [...c.tags] }]));
  for (const call of calls) {
    assert.ok(call.ids.length >= 1 && call.ids.length <= CTM.BULK_ID_LIMIT, "bulk-tags accepts 1-5000 ids");
    const run = CTM.compileTagEdit(plain(call.edit));
    for (const id of call.ids) byId.get(id).tags = plain(applyEdit === CTM.applyTagEdit ? run(byId.get(id).tags) : applyEdit(byId.get(id).tags, plain(call.edit)));
  }
  return [...byId.values()];
}

function dictWith(mapping, extra = {}) {
  return CTM.sanitizeDict({ mapping, ...extra });
}

describe("normalization", () => {
  it("norm strips #, collapses whitespace, lowercases", () => {
    assert.equal(CTM.norm("  #Dark   Elf "), "dark elf");
    assert.equal(CTM.norm("##FEMALE"), "female");
  });

  it("standardizeTag cleans emoji, #, spacing and all-lowercase case only", () => {
    assert.equal(CTM.standardizeTag("🔥 dark  elf "), "Dark Elf");
    assert.equal(CTM.standardizeTag("#female"), "Female");
    assert.equal(CTM.standardizeTag("one-two"), "One-Two");
    assert.equal(CTM.standardizeTag("NSFW"), "NSFW");
    assert.equal(CTM.standardizeTag("AnyPOV"), "AnyPOV");
    assert.equal(CTM.standardizeTag("💕"), "");
  });

  it("pickCanonical prefers a capitalized variant, then Title Case", () => {
    assert.equal(CTM.pickCanonical([{ tag: "elf", count: 9 }, { tag: "Elf", count: 1 }]), "Elf");
    assert.equal(CTM.pickCanonical([{ tag: "#Vampire", count: 2 }]), "Vampire");
    assert.equal(CTM.pickCanonical([{ tag: "slice_of-life", count: 2 }]), "Slice Of Life");
  });
});

describe("applyTagEdit (port of Marinara's applyCharacterTagEdit)", () => {
  it("renames, removes, adds, and dedupes case-insensitively", () => {
    const out = CTM.applyTagEdit(["female", "FEMALE", "junk", "Elf"], {
      rename: [{ from: "female", to: "Female" }],
      remove: ["JUNK"],
      add: ["fantasy", "elf"],
    });
    eq(out, ["Female", "Elf", "fantasy"]);
  });

  const meRepo = resolve(process.env.CTM_ME_REPO ?? join(ROOT, "../../Marinara-Engine"));
  const meFile = join(meRepo, "packages/shared/src/utils/character-tag-edits.ts");
  it("matches the Marinara source on random inputs", { skip: !existsSync(meFile) && `no Marinara repo at ${meRepo}` }, async () => {
    const me = await import(pathToFileURL(meFile).href);
    const rand = rng(7);
    const pool = ["Elf", "elf", " ELF ", "#elf", "Dark Elf", "dark elf", "Female", "female", "x", "X ", "", "  ", "Fantasy"];
    const pick = () => pool[Math.floor(rand() * pool.length)];
    const list = (n) => Array.from({ length: Math.floor(rand() * n) }, pick);
    for (let i = 0; i < 3000; i++) {
      const tags = list(8);
      const edit = {
        rename: Array.from({ length: Math.floor(rand() * 4) }, () => ({ from: pick(), to: pick() })),
        remove: list(3),
        add: list(3),
      };
      eq(CTM.applyTagEdit(tags, edit), me.applyCharacterTagEdit(tags, edit), JSON.stringify({ tags, edit }));
    }
  });
});

describe("bucketize", () => {
  const stats = CTM.scanCards([
    { id: "a", tags: ["female", "#Female", "Elves", "junk", "x".repeat(50)] },
    { id: "b", tags: ["Female", "Mystery", "Elf"] },
  ]);

  it("groups variants, sends junk and long tags to Removed, leaves the rest unassigned", () => {
    const dict = dictWith({ Female: [], Elf: ["elves"] }, { removedTags: ["Junk"] });
    const { groups, unassigned, removed } = CTM.bucketize(stats, dict, { maxTagLength: 40 });
    const female = groups.find((g) => g.canonical === "Female");
    eq(female.variants.map((v) => v.tag).sort(), ["#Female", "Female", "female"]);
    assert.equal(female.cardCount, 2);
    eq(unassigned.map((u) => u.tag), ["Mystery"]);
    eq(removed.filter((r) => r.count > 0).map((r) => [r.tag, r.auto]).sort(), [["junk", false], ["x".repeat(50), true]]);
  });

  it("a canonical's own name beats a variant listed under another canonical", () => {
    const dict = dictWith({ Elf: [], Fantasy: ["elf"] });
    const { groups } = CTM.bucketize(stats, dict);
    assert.ok(groups.find((g) => g.canonical === "Elf").variants.some((v) => v.tag === "Elf"));
    assert.ok(!groups.find((g) => g.canonical === "Fantasy").variants.some((v) => v.count > 0));
  });

  it("a variant under two canonicals goes to the one listed last, as in SillyTavern", () => {
    const dict = dictWith({ "Demi-Human": ["puppy girl"], "Dog Girl": ["Puppy Girl"] });
    const { groups } = CTM.bucketize(CTM.scanCards([{ id: "a", tags: ["puppy girl"] }]), dict);
    assert.equal(groups.find((g) => g.canonical === "Dog Girl").cardCount, 1);
    assert.equal(groups.find((g) => g.canonical === "Demi-Human").cardCount, 0);
  });

  it("mapping wins over removedTags and the length rule", () => {
    const long = "x".repeat(50);
    const dict = dictWith({ Female: [long] }, { removedTags: ["female"] });
    const { groups, removed } = CTM.bucketize(stats, dict);
    assert.equal(groups[0].variants.filter((v) => v.count > 0).length, 4);
    assert.ok(!removed.some((r) => r.count > 0));
  });
});

describe("dictionary edits", () => {
  it("assign / remove / unassign keep one home per spelling", () => {
    const dict = dictWith({ Elf: ["elves"], Fantasy: [] });
    assert.ok(CTM.assignTag(dict, "Elves", "Fantasy"));
    eq(dict.mapping, { Elf: [], Fantasy: ["Elves"] });
    assert.ok(CTM.removeTag(dict, "elves"));
    eq(dict.mapping.Fantasy, []);
    eq(dict.removedTags, ["elves"]);
    assert.ok(CTM.unassignTag(dict, "#ELVES"));
    eq(dict.removedTags, []);
    assert.equal(CTM.removeTag(dict, "elf"), false, "a canonical's own name cannot be removed");
  });

  it("rename keeps the old spelling as a variant and follows categories and implications", () => {
    const dict = dictWith({ "Sci-fi": ["scifi"], Cyberpunk: [] }, {
      categories: { "Sci-fi": "Genre" },
      implications: { Cyberpunk: ["Sci-fi"], "Sci-fi": ["Fiction"] },
    });
    assert.ok(CTM.renameCanonical(dict, "Sci-fi", "Science Fiction"));
    eq(Object.keys(dict.mapping), ["Science Fiction", "Cyberpunk"]);
    eq(dict.mapping["Science Fiction"], ["scifi", "Sci-fi"]);
    assert.equal(dict.categories["Science Fiction"], "Genre");
    eq(dict.implications, { Cyberpunk: ["Science Fiction"], "Science Fiction": ["Fiction"] });
    assert.equal(CTM.renameCanonical(dict, "Cyberpunk", "science fiction"), false, "clash with another canonical");
    assert.ok(CTM.renameCanonical(dict, "Cyberpunk", "CyberPunk"), "case-only rename");
    eq(dict.mapping.CyberPunk, []);
  });

  it("merge folds name, variants and implications into the target", () => {
    const dict = dictWith({ "Sci-Fi": ["scifi"], "Science Fiction": [], Fiction: [] }, { implications: { "Sci-Fi": ["Fiction"] } });
    assert.ok(CTM.mergeCanonical(dict, "Sci-Fi", "Science Fiction"));
    eq(dict.mapping, { "Science Fiction": ["Sci-Fi", "scifi"], Fiction: [] });
    eq(dict.implications, { "Science Fiction": ["Fiction"] });
  });

  it("delete category recategorizes instead of deleting canonicals", () => {
    const dict = dictWith({ A: [], B: [] }, { categories: { A: "One", B: "Two" }, categoryOrder: ["One", "Two"] });
    CTM.deleteCategory(dict, "One", "Two");
    eq(dict.categories, { A: "Two", B: "Two" });
    eq(dict.categoryOrder, ["Two"]);
    eq(Object.keys(dict.mapping), ["A", "B"]);
  });

  it("implications skip self and duplicates", () => {
    const dict = dictWith({ Elf: [] });
    assert.equal(CTM.addImplication(dict, "Elf", "elf"), false);
    assert.ok(CTM.addImplication(dict, "Elf", "Fantasy"));
    assert.equal(CTM.addImplication(dict, "Elf", "#fantasy"), false);
    CTM.removeImplication(dict, "Elf", "Fantasy");
    eq(dict.implications, {});
  });
});

describe("planApply on the sample library", () => {
  const cards = sampleCards();
  const base = sampleDict(CTM);
  const withImplications = () => {
    const dict = CTM.cloneDict(base);
    const names = Object.keys(dict.mapping);
    for (let i = 0; i + 1 < 40; i += 2) CTM.addImplication(dict, names[i], names[i + 1]);
    CTM.addImplication(dict, names[1], "Brand New Tag");
    return dict;
  };

  for (const options of [
    {},
    { skipRemoved: true },
    { standardize: true },
    { standardize: true, skipRemoved: true, maxTagLength: 0 },
  ]) {
    it(`preview equals what the server writes ${JSON.stringify(options)}`, () => {
      const dict = withImplications();
      const plan = CTM.planApply(cards, dict, options);
      assert.ok(plan.changes.length > 0);
      const written = new Map(simulateServer(cards, plan.calls).map((c) => [c.id, c.tags]));
      const changed = new Set(plan.changes.map((c) => c.id));
      for (const change of plan.changes) eq(written.get(change.id), change.after, change.id);
      for (const card of cards) if (!changed.has(card.id)) eq(written.get(card.id), card.tags, `${card.id} untouched`);
      assert.equal(new Set(plan.calls.flatMap((c) => c.ids)).size, plan.calls.flatMap((c) => c.ids).length, "each card written once");
    });
  }

  it("trimmed per-call edits give the same result as the full edit", () => {
    const dict = withImplications();
    const plan = CTM.planApply(cards, dict, { standardize: true });
    const full = CTM.planApply(cards, dict, { standardize: true });
    const fullEdit = { rename: full.calls.flatMap((c) => c.edit.rename), remove: full.calls.flatMap((c) => c.edit.remove) };
    for (const change of plan.changes) {
      const call = plan.calls.find((c) => c.ids.includes(change.id));
      eq(CTM.applyTagEdit(change.before, { ...fullEdit, add: call.edit.add }), change.after);
    }
  });

  it("Skip Removed never removes a tag that is not renamed", () => {
    const plan = CTM.planApply(cards, base, { skipRemoved: true });
    const renameTo = new Map(plan.calls.flatMap((c) => c.edit.rename).map((r) => [CTM.foldTag(r.from), r.to]));
    for (const { before, after } of plan.changes) {
      const afterKeys = new Set(after.map(CTM.foldTag));
      for (const tag of before) {
        const key = CTM.foldTag(tag);
        assert.ok(afterKeys.has(CTM.foldTag(renameTo.get(key) ?? tag)), `${tag} survives`);
      }
    }
    eq(plan.summary.removed, []);
    for (const call of plan.calls) eq(call.edit.remove, []);
  });

  it("only touches tags the dictionary or an option claims", () => {
    const plan = CTM.planApply(cards, base, {});
    const { groups, removed } = CTM.bucketize(CTM.scanCards(cards), base);
    const removedSet = new Set(removed.filter((r) => r.count > 0).map((r) => CTM.foldTag(r.tag)));
    const target = new Map();
    for (const g of groups) for (const v of g.variants) if (v.count > 0) target.set(CTM.foldTag(v.tag), g.canonical);
    for (const { before, after } of plan.changes) {
      const afterKeys = new Set(after.map(CTM.foldTag));
      for (const tag of before) {
        const key = CTM.foldTag(tag);
        if (removedSet.has(key)) assert.ok(!afterKeys.has(key) || target.has(key), `removed ${tag}`);
        else if (target.has(key)) assert.ok(afterKeys.has(CTM.foldTag(target.get(key))), `${tag} -> ${target.get(key)}`);
        else assert.ok(afterKeys.has(key), `unclaimed ${tag} kept`);
      }
    }
  });

  it("is idempotent: planning again after Apply changes nothing", () => {
    for (const options of [{}, { standardize: true }]) {
      const dict = withImplications();
      const first = CTM.planApply(cards, dict, options);
      const after = simulateServer(cards, first.calls);
      const second = CTM.planApply(after, dict, options);
      eq(second.changes.map((c) => [c.id, c.before, c.after]), [], JSON.stringify(options));
    }
  });

  it("summary counts fit the changes and the tag list shrinks", () => {
    const plan = CTM.planApply(cards, base, { standardize: true });
    const { summary } = plan;
    assert.equal(summary.cardsChanged, plan.changes.length);
    assert.ok(summary.distinctAfter < summary.distinctBefore);
    const written = simulateServer(cards, plan.calls);
    assert.equal(summary.distinctAfter, CTM.scanCards(written).size);
    assert.ok(summary.renamed.length > 0 && summary.removed.length > 0);
  });

  it("splits a library over 5000 changed cards into several calls", () => {
    const many = Array.from({ length: 12000 }, (_, i) => ({ id: `m${i}`, name: "", tags: ["female"] }));
    const plan = CTM.planApply(many, dictWith({ Female: [] }));
    eq(plan.calls.map((c) => c.ids.length), [5000, 5000, 2000]);
  });
});

describe("combined tags", () => {
  it("splits only on , ; | and newlines", () => {
    eq(CTM.splitTag("cold, sarcastic"), ["cold", "sarcastic"]);
    eq(CTM.splitTag("a; b | c\nd"), ["a", "b", "c", "d"]);
    for (const t of ["Hurt/Comfort", "Dungeons & Dragons", "Mother and Daughter", "Solo", "trailing,", ", "]) assert.equal(CTM.splitTag(t), null, t);
  });

  it("a mapped or removed combined tag is left alone; a long one splits instead of being removed", () => {
    const long = "female, young adult, homeless, survivor, intelligent, resourceful, e";
    const stats = CTM.scanCards([{ id: "a", tags: ["can be wholesome, can be sexy", "made by me, credits", long, "cold, sarcastic"] }]);
    const dict = dictWith({ "Can Be Wholesome, Can Be Sexy": [] }, { removedTags: ["made by me, credits"] });
    const { groups, removed, split, unassigned } = CTM.bucketize(stats, dict, { maxTagLength: 40 });
    assert.equal(groups[0].cardCount, 1);
    eq(removed.filter((r) => r.count).map((r) => r.tag), ["made by me, credits"]);
    eq(split.map((x) => x.tag).sort(), ["cold, sarcastic", long].sort());
    eq(unassigned, []);
    assert.equal(CTM.bucketize(stats, dict, { maxTagLength: 40, split: false }).split.length, 0);
  });

  it("resolves pieces: canonical, kept, or dropped as junk", () => {
    const dict = dictWith({ Female: [], Sarcastic: ["snarky"] }, { removedTags: ["nsfw-allowed"] });
    const ctx = CTM.partContext(dict, { maxTagLength: 20 });
    const r = (p, c = ctx) => plain(CTM.resolvePart(p, c));
    eq(r("female"), { tag: "female", target: "Female", reason: "canonical" });
    eq(r(" snarky "), { tag: "snarky", target: "Sarcastic", reason: "canonical" });
    eq(r("tattoo artist"), { tag: "tattoo artist", target: "tattoo artist", reason: "new" });
    eq(r("nsfw-allowed"), { tag: "nsfw-allowed", target: null, reason: "removed" });
    eq(r("x".repeat(21)), { tag: "x".repeat(21), target: null, reason: "too-long" });
    eq(r("e"), { tag: "e", target: null, reason: "too-short" });
    eq(r("tattoo artist", CTM.partContext(dict, { standardize: true })).target, "Tattoo Artist");
    eq(r("nsfw-allowed", CTM.partContext(dict, { skipRemoved: true })).target, "nsfw-allowed");
    eq(r("e", CTM.partContext(dict, { skipRemoved: true })).target, null);
  });

  const cards = [
    { id: "a", name: "A", tags: ["cold, sarcastic, tattoo artist, nsfw-allowed, e", "Female"] },
    { id: "b", name: "B", tags: ["Sarcastic", "cold; Elves"] },
    { id: "c", name: "C", tags: ["can be wholesome, can be sexy"] },
  ];
  const dict = dictWith({ Elf: ["elves"], Fantasy: [], "Can Be Wholesome, Can Be Sexy": [] }, { removedTags: ["nsfw-allowed"], implications: { Elf: ["Fantasy"] } });

  for (const options of [{}, { skipRemoved: true }, { standardize: true }]) {
    it(`apply replaces combined tags with their pieces ${JSON.stringify(options)}`, () => {
      const plan = CTM.planApply(cards, dict, options);
      const written = new Map(simulateServer(cards, plan.calls).map((c) => [c.id, c.tags]));
      for (const change of plan.changes) eq(written.get(change.id), change.after);
      const cold = options.standardize ? "Cold" : "cold";
      const tattoo = options.standardize ? "Tattoo Artist" : "tattoo artist";
      eq(written.get("a"), ["Female", cold, options.standardize ? "Sarcastic" : "sarcastic", tattoo, ...(options.skipRemoved ? ["nsfw-allowed"] : [])]);
      eq(written.get("b"), ["Sarcastic", cold, "Elf", "Fantasy"], "pieces dedupe with existing tags; implication follows a piece");
      eq(written.get("c"), ["Can Be Wholesome, Can Be Sexy"], "a mapped combined tag is renamed, not split");
      eq(plan.summary.removed, []);
      eq(plan.summary.added, [{ tag: "Fantasy", count: 1 }]);
      eq(plan.summary.split.map((x) => x.from).sort(), ["cold, sarcastic, tattoo artist, nsfw-allowed, e", "cold; Elves"].sort());
      const again = CTM.planApply(simulateServer(cards, plan.calls), dict, options);
      eq(again.changes, [], "idempotent");
    });
  }

  it("splitCombined: false leaves combined tags to the other rules", () => {
    const plan = CTM.planApply(cards, dict, { splitCombined: false, maxTagLength: 0 });
    assert.ok(!plan.changes.some((c) => c.id === "a"));
    eq(plan.summary.split, []);
    const longRule = CTM.planApply(cards, dict, { splitCombined: false });
    eq(longRule.summary.removed.map((r) => r.tag), ["cold, sarcastic, tattoo artist, nsfw-allowed, e"], "length rule removes it when splitting is off");
  });
});

describe("backup and restore", () => {
  it("restoring a backup returns every changed card to its old tags", () => {
    const cards = sampleCards(3);
    const plan = CTM.planApply(cards, sampleDict(CTM), { standardize: true });
    const backup = plain(CTM.buildBackup(plan.changes, new Date(0)));
    const after = simulateServer(cards, plan.calls);
    const { restore, missing, unchanged } = CTM.planRestore(backup, [...after.slice(1)]);
    assert.equal(missing.length, plan.changes.some((c) => c.id === after[0].id) ? 1 : 0);
    assert.equal(unchanged, 0);
    const byId = new Map(cards.map((c) => [c.id, c.tags]));
    for (const r of restore) eq(r.tags, byId.get(r.id));
    assert.throws(() => CTM.planRestore({ format: "other" }, cards), /backup/);
  });
});

describe("import and export", () => {
  it("round-trips the SillyTavern base dictionary", () => {
    const dict = sampleDict(CTM);
    dict.implications = { [Object.keys(dict.mapping)[0]]: [Object.keys(dict.mapping)[1]] };
    const exported = plain(CTM.exportDict(dict, { now: new Date(0) }));
    assert.equal(exported.format, "ctm-tag-mapping");
    const { dict: back, conflicts } = CTM.parseImport(exported, CTM.emptyDict());
    eq(back, dict);
    assert.ok(Array.isArray(conflicts));
  });

  it("accepts a flat mapping and keeps current categories and implications", () => {
    const current = dictWith({ Elf: [] }, { categories: { Elf: "Species" }, implications: { Elf: ["Fantasy"] } });
    const { dict, impliesKept } = CTM.parseImport({ mapping: { Elf: ["elves", 3, ""], Orc: [] } }, current);
    assert.ok(impliesKept);
    eq(dict.mapping, { Elf: ["elves"], Orc: [] });
    eq(dict.categories, { Elf: "Species" });
    eq(dict.implications, { Elf: ["Fantasy"] });
  });

  it("an explicit implies field replaces implications; unknown keys are reported", () => {
    const current = dictWith({ Elf: [] }, { implications: { Elf: ["Fantasy"] } });
    const result = CTM.parseImport({ mapping: { Elf: [] }, implies: { Nope: ["X"] } }, current);
    eq(result.dict.implications, {});
    eq(result.impliesDropped, ["Nope"]);
  });

  it("reports spellings claimed by two canonicals", () => {
    const { conflicts } = CTM.parseImport({ mapping: { A: ["x"], B: ["X"] } }, CTM.emptyDict());
    eq(conflicts, [{ key: "x", spelling: "x", canonicals: ["A", "B"], winner: "B" }]);
  });

  it("rejects files without a mapping", () => {
    assert.throws(() => CTM.parseImport([], CTM.emptyDict()), /JSON object/);
    assert.throws(() => CTM.parseImport({}, CTM.emptyDict()), /mapping/);
  });
});

describe("dictionary cleanup", () => {
  it("never changes which canonical a card tag lands in", () => {
    const cards = sampleCards(5);
    const dict = sampleDict(CTM);
    const first = Object.keys(dict.mapping)[0];
    dict.mapping[first].push(first.toLowerCase(), `#${dict.mapping[first][0] ?? "x"}`, "🔥 burning");
    const variantsBefore = dict.mapping[first].length;
    const before = CTM.bucketize(CTM.scanCards([...cards, { id: "z", tags: ["🔥 burning"] }]), dict, { maxTagLength: 0 });
    const plan = CTM.planCleanup(dict, 0);
    assert.ok(plan.variantPlans.length > 0);
    CTM.applyCleanup(dict, plan);
    assert.equal(dict.mapping[first].length, variantsBefore - 2, "own name and # duplicate dropped, emoji kept");
    const after = CTM.bucketize(CTM.scanCards([...cards, { id: "z", tags: ["🔥 burning"] }]), dict, { maxTagLength: 0 });
    const placement = (b) => b.groups.flatMap((g) => g.variants.filter((v) => v.count > 0).map((v) => `${v.tag}=>${g.canonical}`)).sort();
    eq(placement(after), placement(before));
    eq(after.unassigned.map((u) => u.tag).sort(), before.unassigned.map((u) => u.tag).sort());
  });

  it("removes the conflict entries that never match, keeping every tag's placement", () => {
    const dict = dictWith({ "Demi-Human": ["Puppy Girl", "Cat_Ears"], "Dog Girl": ["puppy girl"], "Cat Girl": ["Cat_Ears"], Bimbo: ["Airhead"], Airhead: [] });
    const cards = [{ id: "a", tags: ["Puppy Girl", "cat_ears", "airhead"] }];
    const placement = () => CTM.bucketize(CTM.scanCards(cards), dict).groups.filter((g) => g.cardCount).map((g) => g.canonical).sort();
    const before = placement();
    const plan = CTM.planCleanup(dict);
    eq(plan.conflictFixes.map((f) => [f.canonical, f.tag]), [["Demi-Human", "Puppy Girl"], ["Demi-Human", "Cat_Ears"], ["Bimbo", "Airhead"]]);
    CTM.applyCleanup(dict, plan);
    eq(placement(), before);
    eq(before, ["Airhead", "Cat Girl", "Dog Girl"]);
    eq(CTM.findConflicts(dict), []);
  });

  it("reports near-duplicate canonicals without merging them", () => {
    const dict = dictWith({ "Sci-Fi": [], SciFi: [], "sci fi": [] });
    const plan = CTM.planCleanup(dict);
    eq(plan.duplicates, [["Sci-Fi", "SciFi", "sci fi"]]);
    CTM.applyCleanup(dict, plan);
    eq(Object.keys(dict.mapping), ["Sci-Fi", "SciFi", "sci fi"]);
  });
});
