// Character Tag Merger: pure tag logic. No DOM and no Marinara globals, so
// test/core.test.mjs can load this file on its own in a Node vm context.
//
// The model is a persistent dictionary:
//   mapping       { canonical: [variant, ...] }   insertion order = display order
//   removedTags   [tag, ...]                      junk, removed from every card on Apply
//   categories    { canonical: categoryName }     organization only, never part of a tag
//   categoryOrder [categoryName, ...]
//   implications  { canonical: [tag, ...] }       Apply also adds these (chains followed)
//
// Matching uses norm(): trim, strip leading '#', collapse whitespace, lowercase.
// Marinara's own bulk tag edit matches with foldTag() (trim + lowercase). Apply
// is expressed as edits for Marinara's POST /api/characters/bulk-tags, and the
// preview runs applyTagEdit(), a port of Marinara's applyCharacterTagEdit, so
// what the preview shows is exactly what the server writes.

const CTM = (() => {
  "use strict";

  const DEFAULT_MAX_TAG_LENGTH = 40;
  const UNCATEGORIZED = "(Uncategorized)";
  const EXPORT_FORMAT = "ctm-tag-mapping";
  const BACKUP_FORMAT = "ctm-tag-backup";
  const BULK_ID_LIMIT = 5000; // POST /api/characters/bulk-tags accepts 1-5000 ids

  // ── Normalization ──

  /** Dictionary match key: "#Female", "  female ", "FEMALE" all give "female". */
  function norm(tag) {
    return String(tag).trim().replace(/^#+/, "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  /** Marinara's match key (packages/shared/src/utils/character-tag-edits.ts). */
  function foldTag(tag) {
    return String(tag).trim().toLocaleLowerCase();
  }

  // Common emoji blocks plus the variation-selector, ZWJ and keycap combiners.
  // Not a full Unicode emoji database, but it covers what people paste into tags.
  const EMOJI_RE =
    /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}️‍⃣]/gu;

  /**
   * Clean one tag's spelling: strip emoji, trim, drop leading '#', collapse
   * whitespace, and title-case it when it is entirely lowercase ("dark elf" ->
   * "Dark Elf"). Tags that already contain a capital (NSFW, AnyPOV) keep their case.
   */
  function standardizeTag(tag) {
    let s = String(tag).replace(EMOJI_RE, "").trim().replace(/^#+/, "").trim().replace(/\s+/g, " ");
    if (s === s.toLowerCase()) {
      s = s.replace(/[A-Za-z][A-Za-z']*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
    }
    return s;
  }

  /**
   * Pick a display name for a new canonical made from some variants:
   * a capitalized variant (most used wins), else a '#'+capital one with the
   * '#' dropped, else a Title Cased version of the most used variant.
   */
  function pickCanonical(variants) {
    const byFreq = (a, b) => (b.count ?? 0) - (a.count ?? 0) || a.tag.localeCompare(b.tag);
    const caps = variants.filter((v) => /^[A-Z]/.test(v.tag));
    if (caps.length > 0) return [...caps].sort(byFreq)[0].tag.trim();
    const hashCaps = variants.filter((v) => /^#+[A-Z]/.test(v.tag));
    if (hashCaps.length > 0) return [...hashCaps].sort(byFreq)[0].tag.replace(/^#+/, "").trim();
    const top = [...variants].sort(byFreq)[0];
    const stripped = top.tag.replace(/^#+/, "").trim();
    if (stripped !== stripped.toLowerCase() && stripped !== stripped.toUpperCase()) return stripped;
    return stripped
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
      .join(" ");
  }

  // ── Marinara bulk edit, ported ──
  // Keep in step with packages/shared/src/utils/character-tag-edits.ts.
  // test/core.test.mjs checks parity against the real file when the repo is present.

  function cleanEditList(values) {
    const seen = new Set();
    const result = [];
    for (const value of values ?? []) {
      const trimmed = typeof value === "string" ? value.trim() : "";
      if (!trimmed || seen.has(foldTag(trimmed))) continue;
      seen.add(foldTag(trimmed));
      result.push(trimmed);
    }
    return result;
  }

  function normalizeTagEdit(edit) {
    const rename = [];
    const seenFrom = new Set();
    for (const item of edit.rename ?? []) {
      const from = typeof item?.from === "string" ? item.from.trim() : "";
      const to = typeof item?.to === "string" ? item.to.trim() : "";
      if (!from || !to || from === to || seenFrom.has(foldTag(from))) continue;
      seenFrom.add(foldTag(from));
      rename.push({ from, to });
    }
    return { add: cleanEditList(edit.add), remove: cleanEditList(edit.remove), rename };
  }

  /**
   * Compile an edit once into a function over tag lists. Rename, then remove,
   * then add. Case-insensitive; never leaves duplicates.
   */
  function compileTagEdit(edit) {
    const { add, remove, rename } = normalizeTagEdit(edit);
    const renameMap = new Map(rename.map((item) => [foldTag(item.from), item.to]));
    const removeSet = new Set(remove.map(foldTag));
    return (tags) => {
      const result = [];
      const seen = new Set();
      const push = (tag) => {
        const folded = foldTag(tag);
        if (!folded || seen.has(folded)) return;
        seen.add(folded);
        result.push(tag.trim());
      };
      for (const tag of tags) {
        if (typeof tag !== "string") continue;
        const renamed = renameMap.get(foldTag(tag)) ?? tag;
        if (removeSet.has(foldTag(renamed))) continue;
        push(renamed);
      }
      for (const tag of add) push(tag);
      return result;
    };
  }

  function applyTagEdit(tags, edit) {
    return compileTagEdit(edit)(tags);
  }

  function tagListsEqual(a, b) {
    return a.length === b.length && a.every((tag, index) => tag === b[index]);
  }

  // ── Dictionary ──

  function emptyDict() {
    return { mapping: {}, removedTags: [], categories: {}, categoryOrder: [], implications: {} };
  }

  const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const stringList = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === "string" && s.trim() !== "") : []);

  /** Coerce whatever came out of storage into a well-formed dictionary. */
  function sanitizeDict(raw) {
    const dict = emptyDict();
    if (!isRecord(raw)) return dict;
    if (isRecord(raw.mapping)) {
      for (const [canonical, variants] of Object.entries(raw.mapping)) {
        if (canonical.trim() === "") continue;
        dict.mapping[canonical] = [...new Set(stringList(variants))];
      }
    }
    dict.removedTags = [...new Set(stringList(raw.removedTags))];
    if (isRecord(raw.categories)) {
      for (const [canonical, cat] of Object.entries(raw.categories)) {
        if (canonical in dict.mapping && typeof cat === "string" && cat.trim() !== "") dict.categories[canonical] = cat;
      }
    }
    dict.categoryOrder = [...new Set(stringList(raw.categoryOrder))];
    for (const cat of Object.values(dict.categories)) if (!dict.categoryOrder.includes(cat)) dict.categoryOrder.push(cat);
    if (isRecord(raw.implications)) {
      for (const [canonical, targets] of Object.entries(raw.implications)) {
        const list = stringList(targets).filter((t) => norm(t) !== norm(canonical));
        if (canonical in dict.mapping && list.length > 0) dict.implications[canonical] = [...new Set(list)];
      }
    }
    return dict;
  }

  function cloneDict(dict) {
    return JSON.parse(JSON.stringify(dict));
  }

  /**
   * norm -> canonical. A canonical's own name always beats a variant listed
   * elsewhere. Between two variants the canonical listed last wins, the same
   * as the SillyTavern extension, so an imported dictionary matches the same way.
   */
  function buildLookup(dict) {
    const lookup = new Map();
    for (const [canonical, variants] of Object.entries(dict.mapping)) {
      for (const v of variants) lookup.set(norm(v), canonical);
    }
    for (const canonical of Object.keys(dict.mapping)) lookup.set(norm(canonical), canonical);
    return lookup;
  }

  /** Exact canonical names (trimmed), for showing only canonical tags in Marinara's lists. */
  function canonicalNames(dict) {
    return new Set(Object.keys(dict.mapping).map((c) => c.trim()));
  }

  function findCanonical(dict, name) {
    const key = norm(name);
    return Object.keys(dict.mapping).find((c) => norm(c) === key) ?? null;
  }

  /**
   * Spellings listed under more than one canonical. `winner` is the canonical
   * that actually gets the tag; the entries under the others never match.
   */
  function findConflicts(dict) {
    const owners = new Map(); // norm -> { spelling, canonicals: Set }
    for (const [canonical, variants] of Object.entries(dict.mapping)) {
      for (const t of [canonical, ...variants]) {
        const key = norm(t);
        if (!owners.has(key)) owners.set(key, { spelling: t, canonicals: new Set() });
        owners.get(key).canonicals.add(canonical);
      }
    }
    const lookup = buildLookup(dict);
    const conflicts = [];
    for (const [key, { spelling, canonicals }] of owners) {
      if (canonicals.size > 1) conflicts.push({ key, spelling, canonicals: [...canonicals], winner: lookup.get(key) });
    }
    return conflicts;
  }

  // ── Dictionary edits (mutate dict in place; the UI persists afterwards) ──

  /** Drop every spelling of `tag` from variant lists and the removed list. */
  function forgetTag(dict, tag) {
    const key = norm(tag);
    for (const canonical of Object.keys(dict.mapping)) {
      dict.mapping[canonical] = dict.mapping[canonical].filter((v) => norm(v) !== key);
    }
    dict.removedTags = dict.removedTags.filter((t) => norm(t) !== key);
  }

  function assignTag(dict, tag, canonical) {
    if (!(canonical in dict.mapping) || norm(tag) === norm(canonical)) return false;
    if (findCanonical(dict, tag)) return false; // another canonical's own name; merge canonicals instead
    forgetTag(dict, tag);
    dict.mapping[canonical].push(tag);
    return true;
  }

  function removeTag(dict, tag) {
    if (findCanonical(dict, tag)) return false;
    forgetTag(dict, tag);
    dict.removedTags.push(tag);
    return true;
  }

  function unassignTag(dict, tag) {
    if (findCanonical(dict, tag)) return false;
    forgetTag(dict, tag);
    return true;
  }

  /** Returns the canonical's name: the new one, or an existing one with the same spelling. */
  function createCanonical(dict, name, category = "") {
    const clean = String(name).trim();
    if (!clean) return null;
    const existing = findCanonical(dict, clean);
    if (existing) return existing;
    forgetTag(dict, clean);
    dict.mapping[clean] = [];
    setCategory(dict, clean, category);
    return clean;
  }

  function replaceKey(obj, oldKey, newKey) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k === oldKey ? newKey : k] = v;
    return out;
  }

  /**
   * Rename a canonical in place. The old spelling stays as a variant, so cards
   * that carry it are still renamed on Apply. Fails if another canonical
   * already has that spelling (merge instead).
   */
  function renameCanonical(dict, oldName, newName) {
    const next = String(newName).trim();
    if (!(oldName in dict.mapping) || !next || next === oldName) return false;
    const clash = findCanonical(dict, next);
    if (clash && clash !== oldName) return false;
    const variants = dict.mapping[oldName].filter((v) => norm(v) !== norm(next));
    forgetTag(dict, next);
    if (norm(oldName) !== norm(next)) variants.push(oldName);
    dict.mapping = replaceKey(dict.mapping, oldName, next);
    dict.mapping[next] = variants;
    if (oldName in dict.categories) dict.categories = replaceKey(dict.categories, oldName, next);
    if (oldName in dict.implications) dict.implications = replaceKey(dict.implications, oldName, next);
    for (const c of Object.keys(dict.implications)) {
      dict.implications[c] = dict.implications[c].map((t) => (norm(t) === norm(oldName) ? next : t));
    }
    return true;
  }

  /** Delete a canonical. Its variants become unassigned; implications to and from it go. */
  function deleteCanonical(dict, name) {
    if (!(name in dict.mapping)) return false;
    delete dict.mapping[name];
    delete dict.categories[name];
    delete dict.implications[name];
    for (const c of Object.keys(dict.implications)) {
      dict.implications[c] = dict.implications[c].filter((t) => norm(t) !== norm(name));
      if (dict.implications[c].length === 0) delete dict.implications[c];
    }
    return true;
  }

  /** Fold one canonical (name + variants) into another. */
  function mergeCanonical(dict, from, into) {
    if (!(from in dict.mapping) || !(into in dict.mapping) || from === into) return false;
    const variants = [from, ...dict.mapping[from]];
    const implied = dict.implications[from] ?? [];
    deleteCanonical(dict, from);
    for (const v of variants) if (norm(v) !== norm(into)) assignTag(dict, v, into);
    for (const t of implied) addImplication(dict, into, t);
    return true;
  }

  function setCategory(dict, canonical, category) {
    if (!(canonical in dict.mapping)) return;
    const cat = String(category ?? "").trim();
    if (!cat || cat === UNCATEGORIZED) {
      delete dict.categories[canonical];
      return;
    }
    dict.categories[canonical] = cat;
    if (!dict.categoryOrder.includes(cat)) dict.categoryOrder.push(cat);
  }

  function renameCategory(dict, oldName, newName) {
    const next = String(newName).trim();
    if (!next || next === UNCATEGORIZED || !dict.categoryOrder.includes(oldName)) return false;
    if (next !== oldName && dict.categoryOrder.includes(next)) return false;
    dict.categoryOrder = dict.categoryOrder.map((c) => (c === oldName ? next : c));
    for (const [canonical, cat] of Object.entries(dict.categories)) if (cat === oldName) dict.categories[canonical] = next;
    return true;
  }

  /** Delete a category; its canonicals move to `target` ('' = uncategorized). Nothing is deleted but the label. */
  function deleteCategory(dict, name, target = "") {
    dict.categoryOrder = dict.categoryOrder.filter((c) => c !== name);
    for (const [canonical, cat] of Object.entries(dict.categories)) {
      if (cat === name) setCategory(dict, canonical, target === name ? "" : target);
    }
  }

  function moveCategory(dict, name, delta) {
    const i = dict.categoryOrder.indexOf(name);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= dict.categoryOrder.length) return;
    [dict.categoryOrder[i], dict.categoryOrder[j]] = [dict.categoryOrder[j], dict.categoryOrder[i]];
  }

  function addImplication(dict, canonical, target) {
    const t = String(target).trim();
    if (!(canonical in dict.mapping) || !t || norm(t) === norm(canonical)) return false;
    const list = (dict.implications[canonical] ??= []);
    if (list.some((x) => norm(x) === norm(t))) return false;
    list.push(t);
    return true;
  }

  function removeImplication(dict, canonical, target) {
    const list = dict.implications[canonical];
    if (!list) return;
    dict.implications[canonical] = list.filter((t) => t !== target);
    if (dict.implications[canonical].length === 0) delete dict.implications[canonical];
  }

  // ── Combined tags ("cold, sarcastic") ──

  // Only separators that never appear in real single tags. "/", "&" and "and"
  // are left alone: Hurt/Comfort, Dungeons & Dragons, Mother and Daughter.
  const SPLIT_RE = /[,;|\n]+/;

  /** Pieces of a combined tag, or null when it is a single tag. */
  function splitTag(tag) {
    const pieces = String(tag)
      .split(SPLIT_RE)
      .map((p) => p.trim())
      .filter(Boolean);
    return pieces.length > 1 ? pieces : null;
  }

  /** Shared context for resolvePart. */
  function partContext(dict, { maxTagLength = DEFAULT_MAX_TAG_LENGTH, standardize = false, skipRemoved = false } = {}, lookup = buildLookup(dict)) {
    return { lookup, removedKeys: new Set(dict.removedTags.map(norm)), maxTagLength, standardize, skipRemoved };
  }

  /**
   * What one piece of a combined tag becomes:
   *   canonical  -> that canonical's name
   *   removed / too-long -> dropped (kept as typed when Skip Removed is on)
   *   too-short (one character, e.g. a truncated "e") -> dropped
   *   otherwise  -> kept as a new tag, cleaned by standardizeTag when Standardize is on
   * Returns { tag, target, reason }; target is null when the piece is dropped.
   */
  function resolvePart(piece, ctx) {
    const tag = String(piece).trim();
    const key = norm(tag);
    if (key.length < 2) return { tag, target: null, reason: "too-short" };
    const canonical = ctx.lookup.get(key);
    if (canonical) return { tag, target: canonical, reason: "canonical" };
    const keep = () => (ctx.standardize ? standardizeTag(tag) || tag : tag);
    if (ctx.removedKeys.has(key)) return ctx.skipRemoved ? { tag, target: keep(), reason: "new" } : { tag, target: null, reason: "removed" };
    if (ctx.maxTagLength && key.length > ctx.maxTagLength) {
      return ctx.skipRemoved ? { tag, target: keep(), reason: "new" } : { tag, target: null, reason: "too-long" };
    }
    return { tag, target: keep(), reason: "new" };
  }

  // ── Library scan + buckets ──

  /**
   * cards: [{ id, name, tags }] -> Map(exact tag -> { count, ids }).
   * A card listing the same tag twice (any case) counts once.
   */
  function scanCards(cards) {
    const stats = new Map();
    for (const card of cards ?? []) {
      const seen = new Set();
      for (const tag of card.tags ?? []) {
        if (typeof tag !== "string" || tag.trim() === "") continue;
        const key = foldTag(tag);
        if (seen.has(key)) continue;
        seen.add(key);
        let entry = stats.get(tag);
        if (!entry) stats.set(tag, (entry = { count: 0, ids: [] }));
        entry.count++;
        entry.ids.push(card.id);
      }
    }
    return stats;
  }

  /**
   * Sort every tag on the cards into one of:
   *   groups      one per canonical (all canonicals, even unused), with observed + declared variants
   *   unassigned  on cards, claimed by nothing
   *   removed     in removedTags, or unclaimed and longer than maxTagLength (auto: true)
   *   split       unclaimed combined tags ("cold, sarcastic") with their raw pieces, when `split` is on
   * Precedence: canonical, removedTags, split, length rule, unassigned. So a combined
   * tag you mapped or removed is left alone, and splitting beats the length rule.
   */
  function bucketize(stats, dict, { maxTagLength = DEFAULT_MAX_TAG_LENGTH, split = true } = {}) {
    const lookup = buildLookup(dict);
    const removedKeys = new Set(dict.removedTags.map(norm));
    const groups = new Map();
    for (const [canonical, variants] of Object.entries(dict.mapping)) {
      const vmap = new Map();
      for (const v of variants) vmap.set(v, { tag: v, count: 0, ids: [], own: false });
      groups.set(canonical, vmap);
    }
    const unassigned = [];
    const splits = [];
    const removed = new Map(dict.removedTags.map((t) => [t, { tag: t, count: 0, ids: [], auto: false }]));
    for (const [tag, entry] of stats) {
      const key = norm(tag);
      const item = { tag, count: entry.count, ids: entry.ids };
      const canonical = lookup.get(key);
      if (canonical) {
        groups.get(canonical).set(tag, { ...item, own: key === norm(canonical) });
      } else if (removedKeys.has(key)) {
        removed.set(tag, { ...item, auto: false });
      } else if (split && splitTag(tag)) {
        splits.push({ ...item, parts: splitTag(tag) });
      } else if (maxTagLength && key.length > maxTagLength) {
        removed.set(tag, { ...item, auto: true });
      } else {
        unassigned.push(item);
      }
    }
    const byCount = (a, b) => b.count - a.count || a.tag.localeCompare(b.tag);
    return {
      groups: [...groups].map(([canonical, vmap]) => {
        const variants = [...vmap.values()].sort(byCount);
        const ids = new Set();
        for (const v of variants) for (const id of v.ids) ids.add(id);
        return {
          canonical,
          category: dict.categories[canonical] ?? "",
          implies: [...(dict.implications[canonical] ?? [])],
          variants,
          cardCount: ids.size,
        };
      }),
      unassigned: unassigned.sort(byCount),
      removed: [...removed.values()].sort(byCount),
      split: splits.sort(byCount),
    };
  }

  /**
   * Implied tags a card should gain. `implies` maps canonical -> targets,
   * matched by norm() and followed transitively; cycles stop at the visited set.
   */
  function expandImplications(names, implies, blocked) {
    const byKey = new Map();
    for (const [from, targets] of Object.entries(implies ?? {})) {
      const k = norm(from);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(...(targets ?? []));
    }
    const have = new Set(names.map(norm));
    const queue = [...have];
    const added = [];
    while (queue.length > 0) {
      for (const target of byKey.get(queue.shift()) ?? []) {
        const k = norm(target);
        if (have.has(k) || blocked?.has(k)) continue;
        have.add(k);
        added.push(target);
        queue.push(k);
      }
    }
    return added;
  }

  // ── Tags for one card being imported (used by other extensions) ──

  /**
   * Sort a new card's tags against the dictionary, without dropping any:
   *   canonical  tags a canonical claims, as that canonical, plus their implications
   *   other      every other tag, cleaned by standardizeTag
   * Removed and too-long rules are not applied, and combined tags are not
   * split, so the caller decides what happens to `other`.
   * @returns {{canonical: string[], other: string[]}}
   */
  function mapImportTags(tags, dict) {
    const lookup = buildLookup(dict);
    const canonical = [];
    const other = [];
    const seen = new Set();
    const push = (list, tag) => {
      const key = foldTag(tag);
      if (!key || seen.has(key)) return;
      seen.add(key);
      list.push(tag);
    };
    const leftovers = [];
    for (const raw of Array.isArray(tags) ? tags : []) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      const match = lookup.get(norm(raw));
      if (match) {
        push(canonical, match);
        continue;
      }
      const clean = standardizeTag(raw) || raw.trim();
      const cleanMatch = lookup.get(norm(clean));
      if (cleanMatch) push(canonical, cleanMatch);
      else leftovers.push(clean);
    }
    const implies = {};
    for (const [name, targets] of Object.entries(dict.implications)) {
      if (name in dict.mapping) implies[name] = targets.map((t) => lookup.get(norm(t)) ?? t.trim());
    }
    const blocked = new Set(dict.removedTags.map(norm));
    for (const tag of expandImplications([...canonical], implies, blocked)) push(canonical, tag);
    // After the canonicals, so a tidied tag never duplicates one
    for (const tag of leftovers) push(other, tag);
    return { canonical, other };
  }

  // ── Apply plan ──

  /**
   * Work out what Apply does to every card. Pure.
   *
   * options:
   *   standardize   also clean the spelling of unassigned tags (standardizeTag)
   *   skipRemoved   leave Removed tags (listed and too-long) on the cards
   *   maxTagLength  auto-remove cutoff; 0 disables
   *   splitCombined replace combined tags ("cold, sarcastic") with their pieces
   *
   * Returns { changes: [{id, name, before, after}], calls: [{ids, edit}], summary }.
   * Every call is a POST /api/characters/bulk-tags body minus ids-chunking;
   * applyTagEdit(card.tags, call.edit) equals `after` for each card in the call.
   */
  function planApply(cards, dict, options = {}) {
    const { standardize = false, skipRemoved = false, maxTagLength = DEFAULT_MAX_TAG_LENGTH, splitCombined = true } = options;
    const stats = scanCards(cards);
    const { groups, unassigned, removed, split } = bucketize(stats, dict, { maxTagLength, split: splitCombined });

    // Renames, one per fold key (Marinara keeps the first rename for a key).
    const rename = [];
    const renameKeys = new Set();
    const addRename = (from, to) => {
      const key = foldTag(from);
      if (renameKeys.has(key) || from.trim() === to) return;
      renameKeys.add(key);
      rename.push({ from, to });
    };
    for (const group of groups) {
      for (const v of group.variants) if (v.count > 0 && v.tag !== group.canonical) addRename(v.tag, group.canonical);
    }
    if (standardize) {
      for (const u of unassigned) {
        const clean = standardizeTag(u.tag);
        if (clean && clean !== u.tag) addRename(u.tag, clean);
      }
    }
    const remove = skipRemoved ? [] : removed.filter((r) => r.count > 0).map((r) => r.tag);

    // Combined tags come off the card and their kept pieces are added back.
    // Skip Removed does not apply: splitting replaces a tag, it does not delete it.
    const lookup = buildLookup(dict);
    const ctx = partContext(dict, { maxTagLength, standardize, skipRemoved }, lookup);
    const splitTo = new Map(); // fold(combined tag) -> kept pieces
    for (const s of split) {
      splitTo.set(foldTag(s.tag), s.parts.map((p) => resolvePart(p, ctx).target).filter(Boolean));
      remove.push(s.tag);
    }

    // Implications, resolved to canonical spellings. Removed spellings are never added.
    const implies = {};
    for (const [canonical, targets] of Object.entries(dict.implications)) {
      if (canonical in dict.mapping) implies[canonical] = targets.map((t) => lookup.get(norm(t)) ?? t.trim());
    }
    const blocked = new Set([...dict.removedTags.map(norm), ...removed.map((r) => norm(r.tag))]);
    const hasImplications = Object.keys(implies).length > 0;

    const applyBase = compileTagEdit({ rename, remove });
    const withAdd = new Map(); // add-list key -> compiled edit
    const changes = [];
    const groupsByAdd = new Map(); // add-list key -> { add, ids, tagLists }
    for (const card of cards) {
      const before = (card.tags ?? []).filter((t) => typeof t === "string");
      const renamed = applyBase(before);
      const pieces = [];
      if (splitTo.size) {
        const seen = new Set();
        for (const t of before) {
          for (const piece of splitTo.get(foldTag(t)) ?? []) {
            if (seen.has(foldTag(piece))) continue;
            seen.add(foldTag(piece));
            pieces.push(piece);
          }
        }
      }
      const implied = hasImplications ? expandImplications([...renamed, ...pieces], implies, blocked) : [];
      const add = [...pieces, ...implied];
      const key = add.join("\u0000");
      if (add.length > 0 && !withAdd.has(key)) withAdd.set(key, compileTagEdit({ rename, remove, add }));
      const after = add.length > 0 ? withAdd.get(key)(before) : renamed;
      if (tagListsEqual(before, after)) continue;
      changes.push({ id: card.id, name: card.name ?? "", before, after, renamed, pieces });
      if (!groupsByAdd.has(key)) groupsByAdd.set(key, { add, ids: [], tagLists: [] });
      const group = groupsByAdd.get(key);
      group.ids.push(card.id);
      group.tagLists.push(before);
    }

    const calls = [];
    for (const { add, ids, tagLists } of groupsByAdd.values()) {
      for (let start = 0; start < ids.length; start += BULK_ID_LIMIT) {
        const edit = trimEdit({ rename, remove, add }, tagLists.slice(start, start + BULK_ID_LIMIT));
        calls.push({ ids: ids.slice(start, start + BULK_ID_LIMIT), edit });
      }
    }

    return { changes, calls, summary: summarize(changes, rename, remove, stats, splitTo) };
  }

  /**
   * Keep only the rename/remove entries that can touch these cards, so a
   * request does not carry the whole dictionary. Exact: a rename only fires on
   * a tag the card has, and a removal only checks the card's tags after renaming.
   */
  function trimEdit(edit, cardTagLists) {
    const present = new Set();
    for (const tags of cardTagLists) for (const t of tags) present.add(foldTag(t));
    const rename = edit.rename.filter((r) => present.has(foldTag(r.from)));
    const reachable = new Set(present);
    for (const r of rename) reachable.add(foldTag(r.to));
    const remove = edit.remove.filter((t) => reachable.has(foldTag(t)));
    return { rename, remove, add: edit.add };
  }

  function summarize(changes, rename, remove, stats, splitTo = new Map()) {
    const renamed = new Map();
    const removed = new Map();
    const added = new Map();
    const splitCounts = new Map();
    const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
    const renameTo = new Map(normalizeTagEdit({ rename }).rename.map((r) => [foldTag(r.from), r.to]));
    const removeSet = new Set(remove.map(foldTag));
    for (const change of changes) {
      for (const tag of change.before) {
        if (splitTo.has(foldTag(tag))) {
          bump(splitCounts, tag);
          continue;
        }
        const to = renameTo.get(foldTag(tag));
        const final = to ?? tag;
        if (removeSet.has(foldTag(final))) bump(removed, tag);
        else if (to !== undefined && to !== tag.trim()) bump(renamed, `${tag}\u0000${to}`);
      }
      const kept = new Set([...change.renamed, ...(change.pieces ?? [])].map(foldTag));
      for (const tag of change.after) if (!kept.has(foldTag(tag))) bump(added, tag);
    }
    const changedIds = new Set(changes.map((c) => c.id));
    const distinctAfter = new Set();
    for (const c of changes) for (const t of c.after) distinctAfter.add(t);
    for (const [tag, entry] of stats) if (entry.ids.some((id) => !changedIds.has(id))) distinctAfter.add(tag);
    const byCount = (x, y) => y.count - x.count || String(x.tag ?? x.from).localeCompare(String(y.tag ?? y.from));
    return {
      cardsChanged: changes.length,
      distinctBefore: stats.size,
      distinctAfter: distinctAfter.size,
      renamed: [...renamed].map(([k, count]) => {
        const [from, to] = k.split("\u0000");
        return { from, to, count };
      }).sort(byCount),
      removed: [...removed].map(([tag, count]) => ({ tag, count })).sort(byCount),
      added: [...added].map(([tag, count]) => ({ tag, count })).sort(byCount),
      split: [...splitCounts].map(([from, count]) => ({ from, to: splitTo.get(foldTag(from)) ?? [], count })).sort(byCount),
    };
  }

  // ── Backup / restore of card tags ──

  function buildBackup(changes, now = new Date()) {
    return {
      format: BACKUP_FORMAT,
      version: 1,
      createdAt: now.toISOString(),
      cards: changes.map((c) => ({ id: c.id, name: c.name, tags: [...c.before] })),
    };
  }

  /** Cards whose current tags differ from the backup. Missing cards are listed, never recreated. */
  function planRestore(backup, cards) {
    if (!isRecord(backup) || backup.format !== BACKUP_FORMAT || !Array.isArray(backup.cards)) {
      throw new Error("Not a Tag Merger backup file.");
    }
    const current = new Map(cards.map((c) => [c.id, c]));
    const restore = [];
    const missing = [];
    let unchanged = 0;
    for (const entry of backup.cards) {
      if (!isRecord(entry) || typeof entry.id !== "string" || !Array.isArray(entry.tags)) continue;
      const tags = entry.tags.filter((t) => typeof t === "string");
      const card = current.get(entry.id);
      if (!card) {
        missing.push({ id: entry.id, name: typeof entry.name === "string" ? entry.name : "" });
        continue;
      }
      const now = (card.tags ?? []).filter((t) => typeof t === "string");
      if (tagListsEqual(now, tags)) unchanged++;
      else restore.push({ id: entry.id, name: card.name ?? entry.name ?? "", current: now, tags });
    }
    return { restore, missing, unchanged };
  }

  // ── Import / export (same file format as the SillyTavern extension) ──

  function exportDict(dict, { unassigned = null, now = new Date() } = {}) {
    const grouped = {};
    for (const cat of dict.categoryOrder) grouped[cat] = {};
    const uncategorized = {};
    for (const [canonical, variants] of Object.entries(dict.mapping)) {
      const cat = dict.categories[canonical];
      const target = cat ? (grouped[cat] ??= {}) : uncategorized;
      target[canonical] = [...variants];
    }
    if (Object.keys(uncategorized).length > 0) grouped[UNCATEGORIZED] = uncategorized;
    const out = {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: now.toISOString(),
      mapping: grouped,
      removedTags: [...dict.removedTags],
      implies: Object.fromEntries(
        Object.entries(dict.implications)
          .filter(([c, t]) => c in dict.mapping && t.length > 0)
          .map(([c, t]) => [c, [...t]]),
      ),
    };
    if (unassigned) out.unassigned = Object.fromEntries(unassigned.map((u) => [u.tag, u.count]));
    return out;
  }

  /**
   * Parse an exported dictionary (categorized or flat mapping). A flat file keeps
   * current categories. No `implies` field keeps current implications; any
   * `implies` value, even {}, replaces them. Throws a user-facing Error when unusable.
   */
  function parseImport(json, current) {
    if (!isRecord(json)) throw new Error("File is not a JSON object.");
    const raw = json.mapping;
    if (!isRecord(raw)) throw new Error('File has no "mapping" object.');

    let skipped = 0;
    const cleanList = (list) => {
      if (!Array.isArray(list)) {
        skipped++;
        return [];
      }
      const out = [];
      for (const v of list) {
        if (typeof v === "string" && v.trim() !== "") out.push(v);
        else skipped++;
      }
      return out;
    };

    const dict = emptyDict();
    const values = Object.values(raw);
    const isFlat = values.length > 0 && values.every((v) => Array.isArray(v));
    if (isFlat) {
      for (const [canonical, variants] of Object.entries(raw)) {
        if (canonical.trim() === "") {
          skipped++;
          continue;
        }
        dict.mapping[canonical] = cleanList(variants);
        const cat = current.categories[canonical];
        if (cat) dict.categories[canonical] = cat;
      }
      dict.categoryOrder = [...current.categoryOrder];
    } else {
      for (const [cat, canonicals] of Object.entries(raw)) {
        if (!isRecord(canonicals)) {
          skipped++;
          continue;
        }
        const isUncat = cat === UNCATEGORIZED || cat.trim() === "";
        if (!isUncat && !dict.categoryOrder.includes(cat)) dict.categoryOrder.push(cat);
        for (const [canonical, variants] of Object.entries(canonicals)) {
          if (canonical.trim() === "") {
            skipped++;
            continue;
          }
          if (canonical in dict.mapping) dict.mapping[canonical].push(...cleanList(variants));
          else dict.mapping[canonical] = cleanList(variants);
          if (isUncat) delete dict.categories[canonical];
          else dict.categories[canonical] = cat;
        }
      }
    }
    for (const k of Object.keys(dict.mapping)) dict.mapping[k] = [...new Set(dict.mapping[k])];
    dict.removedTags = json.removedTags === undefined ? [] : [...new Set(cleanList(json.removedTags))];

    const conflicts = findConflicts(dict);
    const impliesKept = json.implies === undefined;
    let rawImplies = impliesKept ? current.implications : json.implies;
    if (!isRecord(rawImplies)) {
      if (!impliesKept) skipped++;
      rawImplies = {};
    }
    const impliesDropped = [];
    for (const [from, targets] of Object.entries(rawImplies)) {
      const canonical = findCanonical(dict, from);
      if (!canonical) {
        if (!impliesKept) impliesDropped.push(from);
        continue;
      }
      for (const t of cleanList(targets)) addImplication(dict, canonical, t);
    }
    return { dict: sanitizeDict(dict), skipped, conflicts, impliesKept, impliesDropped };
  }

  /** Compare two dictionaries for the import preview. */
  function diffDicts(current, next) {
    const cur = new Set(Object.keys(current.mapping));
    const nxt = new Set(Object.keys(next.mapping));
    const count = (d) => Object.values(d.mapping).reduce((n, v) => n + v.length, 0);
    return {
      canonicals: [cur.size, nxt.size],
      variants: [count(current), count(next)],
      removed: [current.removedTags.length, next.removedTags.length],
      categories: [current.categoryOrder.length, next.categoryOrder.length],
      implications: [Object.keys(current.implications).length, Object.keys(next.implications).length],
      added: [...nxt].filter((c) => !cur.has(c)),
      dropped: [...cur].filter((c) => !nxt.has(c)),
    };
  }

  // ── Dictionary cleanup ──

  /**
   * Tidy the dictionary without changing what it matches:
   *   - drop variants that are the canonical's own spelling (it always matches itself)
   *   - drop variants that normalize the same as an earlier one ("Elf", "#elf", "ELF")
   *   - drop removed entries the length rule already covers
   * Canonicals are never renamed or merged; near-duplicates and conflicts are only reported.
   */
  function planCleanup(dict, maxTagLength = DEFAULT_MAX_TAG_LENGTH) {
    const variantPlans = [];
    for (const [canonical, variants] of Object.entries(dict.mapping)) {
      const seen = new Set([norm(canonical)]);
      const cleaned = [];
      const dropped = [];
      for (const v of variants) {
        if (seen.has(norm(v))) dropped.push(v);
        else {
          seen.add(norm(v));
          cleaned.push(v);
        }
      }
      if (dropped.length) variantPlans.push({ canonical, cleaned, dropped });
    }
    const prunedRemoved = maxTagLength ? dict.removedTags.filter((t) => norm(t).length > maxTagLength) : [];
    const byKey = new Map();
    for (const canonical of Object.keys(dict.mapping)) {
      const key = norm(canonical).replace(/[\s_-]+/g, "");
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(canonical);
    }
    const duplicates = [...byKey.values()].filter((names) => names.length > 1);
    // Entries that lose a conflict never match anything, so dropping them is safe.
    const conflicts = findConflicts(dict);
    const conflictFixes = [];
    for (const c of conflicts) {
      for (const canonical of c.canonicals) {
        if (canonical === c.winner) continue;
        for (const v of dict.mapping[canonical]) if (norm(v) === c.key) conflictFixes.push({ canonical, tag: v, winner: c.winner });
      }
    }
    return { variantPlans, prunedRemoved, duplicates, conflicts, conflictFixes };
  }

  function applyCleanup(dict, plan) {
    for (const { canonical, cleaned } of plan.variantPlans) {
      if (canonical in dict.mapping) dict.mapping[canonical] = [...cleaned];
    }
    for (const { canonical, tag } of plan.conflictFixes ?? []) {
      if (canonical in dict.mapping) dict.mapping[canonical] = dict.mapping[canonical].filter((v) => v !== tag);
    }
    const pruned = new Set(plan.prunedRemoved);
    dict.removedTags = dict.removedTags.filter((t) => !pruned.has(t));
  }

  return Object.freeze({
    DEFAULT_MAX_TAG_LENGTH,
    UNCATEGORIZED,
    EXPORT_FORMAT,
    BACKUP_FORMAT,
    BULK_ID_LIMIT,
    norm,
    foldTag,
    standardizeTag,
    pickCanonical,
    applyTagEdit,
    compileTagEdit,
    normalizeTagEdit,
    tagListsEqual,
    emptyDict,
    sanitizeDict,
    cloneDict,
    buildLookup,
    canonicalNames,
    findCanonical,
    findConflicts,
    assignTag,
    removeTag,
    unassignTag,
    createCanonical,
    renameCanonical,
    deleteCanonical,
    mergeCanonical,
    setCategory,
    renameCategory,
    deleteCategory,
    moveCategory,
    addImplication,
    removeImplication,
    splitTag,
    partContext,
    resolvePart,
    scanCards,
    bucketize,
    expandImplications,
    mapImportTags,
    planApply,
    trimEdit,
    buildBackup,
    planRestore,
    exportDict,
    parseImport,
    diffDicts,
    planCleanup,
    applyCleanup,
  });
})();
