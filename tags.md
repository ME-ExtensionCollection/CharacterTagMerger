---
name: tags
description: Review and improve a Tag Merger tag-mapping JSON export (Marinara Engine Tag Merger, or the SillyTavern Character Tag Merger; same format). Use when given a file with "format": "ctm-tag-mapping", or asked to sort unassigned character tags into canonicals, suggest merges, or clean up a tag dictionary. Returns a complete, importable JSON file.
---

# Character Tag Merger: tag mapping files

You've been given a tag dictionary exported from the **Tag Merger** extension for Marinara Engine (or its SillyTavern predecessor, Character Tag Merger, which uses the same file format). It maps messy tags from character cards (different case, `#` prefixes, typos, near-synonyms) onto one clean **canonical** tag each. Your job is to improve it and return a file the user can import back.

## File format

```json
{
  "format": "ctm-tag-mapping",
  "version": 1,
  "exportedAt": "2026-10-14T12:00:00.000Z",
  "mapping": {
    "Genre": {
      "Romance": ["love", "romantic", "true love"],
      "Comedy": ["funny", "humor"]
    },
    "Species": {
      "Elf": ["elves", "high elf", "dark elf"]
    },
    "(Uncategorized)": {
      "Some Canonical": []
    }
  },
  "removedTags": ["anypov", "big breasts", "made by me"],
  "implies": {
    "Dark Elf": ["Elf"],
    "Elf": ["Fantasy"]
  },
  "unassigned": { "elf girl": 14, "rom-com": 6, "pointy ears": 1 }
}
```

| Field | Meaning |
|---|---|
| `mapping` | **Category → canonical → variants.** Each top-level key is a category. Categories are used only for organizing the editor and never become part of a tag. The key order is the display order. |
| category `"(Uncategorized)"` | Special key for canonicals with no category. Don't use it as a real category name. |
| canonical (inner key) | The clean tag every variant gets renamed to, spelled the way it should appear (e.g. `"Slice of Life"`, `"AnyPOV"`, `"NSFW"`). |
| variants (array) | Tag spellings that get merged into that canonical. It may be empty. |
| `removedTags` | Junk tags that are removed from every card. |
| `implies` | **Canonical → extra tags.** On Apply, every card that ends up with the canonical also gets each implied tag. Chains are followed: with the example above, a `Dark Elf` card also gets `Elf` and `Fantasy`. The key must be a canonical in `mapping`. A target should normally be another canonical. A target that isn't one gets created as a new tag. |
| `unassigned` | **Read-only input.** These tags are on the user's cards but nothing maps them yet. The value is how many cards use the tag. Higher counts matter more. The importer ignores this field. |
| `format`, `version`, `exportedAt` | Metadata. Keep `format` and `version` as they are. |

### How matching works
- Matching is **normalized**: leading `#` stripped, whitespace trimmed and collapsed, lowercased. `"#Elf Girl"`, `"elf girl"` and `"ELF  GIRL"` are all the same key.
  - Don't add variants that differ only in case, `#` or spacing.
  - Do add real spelling differences: `"elfgirl"`, `"elf-girl"`, `"elves"` and `"elf_girl"` are all distinct keys.
- A canonical always matches its own name, so you don't need to list it as a variant.
- Matching is **exact after normalization**. There is no fuzzy matching. A typo only merges if it is listed.
- A tag that appears under a canonical **and** in `removedTags` stays mapped, because the mapping wins.
- Unmapped tags containing `,` `;` or `|` are split into separate tags (an option that is on by default). Each piece goes through the same matching, so you don't need to map combined tags like `"cold, sarcastic"`; map their pieces instead. Map or remove a combined tag only to stop it from being split.
- Unmapped tags longer than ~40 characters are removed automatically (an option that is on by default), so you don't need to list sentence-length junk.
- Implications run **after** renaming. They match canonical names normalized, follow chains, ignore cycles, and never add a tag that's in `removedTags`.

## Rules (the importer depends on these)
1. **Each normalized spelling belongs to exactly one canonical.** If a variant (or a canonical's own name) appears under two canonicals, only one wins and the import preview flags a conflict. Pick one home.
2. Each canonical appears **once**, under one category.
3. Every variant and removed tag must be a non-empty **string**. Anything else is skipped.
4. Keep the overall shape: `mapping` holds category objects, which hold canonical → array.
5. **The file replaces the user's dictionary.** If you leave a canonical, variant, removed tag or implication out, it's deleted. Return the **whole** dictionary, not a diff. Always include `implies`. Use `{}` only if the user wants every implication removed.
6. `implies` keys must be canonicals that exist in your `mapping`. Don't let a canonical imply itself.

## What to do
1. **Sort `unassigned`**, most-used first. For each tag:
   - add it as a variant of the best existing canonical, **or**
   - add it to `removedTags` if it's junk (see below), **or**
   - create a new canonical if several unassigned tags share a concept that has no home. Put it in a fitting existing category. Use a new category only if none fits.
2. **Find duplicate canonicals**: synonyms or near-duplicates that should be one tag (e.g. `"Sci-Fi"` / `"Science Fiction"`). Merge by keeping one canonical and moving the other's name and variants under it as variants.
3. **Spot misplaced variants** (a variant that clearly belongs to a different canonical) and move them.
4. Check **canonical spelling and category placement**.
5. **Use implications for hierarchy.** When a specific canonical belongs to a broader one, keep both as separate canonicals and add `"Specific": ["Broad"]` to `implies`. Examples: `Dark Elf` → `Elf`, `Vampire` → `Supernatural`, `Yandere` → `Obsessive`, `Cyberpunk` → `Sci-Fi`.
   - This beats merging: it keeps the specific tag for searching and still lets the broad tag group cards together.
   - Imply only what is **always** true of the specific tag. `Werewolf` → `Monster` is fine. `Elf` → `Romance` isn't.
   - Rely on chains rather than repeating ancestors: if `Dark Elf` → `Elf` and `Elf` → `Fantasy`, don't also add `Dark Elf` → `Fantasy`.
   - Don't imply across categories just because tags often appear together.
6. Leave `unassigned` out of your output, or empty it.

### Curation principles
- **Merge or imply?** Merge (make it a variant) when two tags mean the same thing (`elves` and `Elf`). Imply when one is a kind of the other and both are worth keeping (`Dark Elf` → `Elf`). If a specific tag has very few cards and adds nothing useful, merging it into the broad canonical is fine.
- **Prefer a loose mapping over removing a tag.** Cards often have only a few tags. A tag with even a minor thematic link to a canonical should be mapped there rather than junked (e.g. `gorgon` → `Lamia`, `orphan` → `Trauma`, `guns` → `Action`).
- **Coarse buckets are fine** for long, noisy tails: a general `Fetish` canonical for niche kinks, `Working Class` for rare job titles, `Age Defined` for age tags.
- **Deliberate junk classes** (send these to `removedTags`):
  - body/appearance (`big breasts`, `tall`, hair or eye colour)
  - POV markers (`anypov`, `malepov`)
  - event, jam or "week" names
  - author handles and credits
  - model or platform meta
  - invented world or series names
  - tags that describe nothing
- Keep canonical names short and conventionally capitalized. Don't rename existing canonicals just for style: a rename changes the tag on every card that has it.
- If unsure, map the tag and say so in your notes rather than inventing structure.

## Output
1. **The complete JSON file** in one fenced ```json block. It must be valid JSON: no comments, no trailing commas, no `...` placeholders. Keep every existing canonical, variant and removed tag you didn't deliberately move, merge or drop.
2. Below it, a short **change summary**:
   - new canonicals
   - merged canonicals
   - implications added or removed
   - notable variant moves
   - tags sent to `removedTags`
   - any judgment calls the user should double-check

If the dictionary is too large to return in one response, ask before splitting it. Never return a partial file presented as complete, because importing it would delete everything left out.
