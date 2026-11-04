# Tag Merger for Marinara Engine

A Marinara Engine External Extension that cleans up character tags across your whole library. Cards imported from many sources collect inconsistent tags: mixed case (`Female` / `female`), `#` prefixes (`#fantasy`), separators (`Demi-Human` / `demihuman`), typos and near-duplicates (`#assasin` / `Assassin`), emoji, and whole sentences typed into the tag field.

You keep a **dictionary** that maps each messy variant onto one clean **canonical** tag, curate it in a searchable editor, and apply it to every card in one go.

It is a port of the SillyTavern [Character Tag Merger](https://github.com/EnchantedRobot/SillyTavern-Tag-Merger) and reads and writes the same dictionary file, so you can bring your SillyTavern dictionary over unchanged.

## What it does

- **Canonical tags, grouped by category.** Each canonical lists the variant spellings that merge into it, with card counts. You can collapse categories, filter them to "with merges pending", and search everything from one box.
- **Unassigned and Removed lists.** Unassigned holds tags on your cards that nothing maps yet. Removed holds junk that Apply takes off every card. Click a tag to move it to a canonical, unassign it, remove it, or make it a new canonical. Use **Select** to move many at once.
- **Implications.** `Dark Elf → Elf` adds `Elf` to every card with `Dark Elf`, following chains (`Elf → Fantasy`).
- **Auto-filtering.** **Standardize unassigned** strips emoji and `#`, trims spaces, and Title Cases all-lowercase tags. **Auto-remove tags longer than N** sends sentence-length tags to Removed. Tags that a canonical claims are always kept.
- **Split combined tags.** A tag like `cold, sarcastic, tattoo artist` (several tags typed as one) is replaced by its pieces on Apply. Splitting happens only on `,` `;` `|` and line breaks, so `Hurt/Comfort` and `Dungeons & Dragons` stay whole. Each piece that matches a canonical becomes that canonical, and other pieces are added as new tags. Pieces on the Removed list, over the length limit, or one character long are dropped. The **Split** tab shows each combined tag and what it becomes. To keep a combined tag whole, map it to a canonical or move it to Removed.
- **Skip Removed.** With this on, Apply only renames, merges and splits, and nothing is removed.
- **Tidy tags on import.** Other extensions on the page can use the dictionary read-only through `window.marinaraTagMerger.mapTags(tags)`. Char Importer's **Merge with Tag Merger canonicals** option uses it, so new cards arrive with canonical tags (plus implications) and other tags standardized. Removed tags are not dropped there.
- **Clean Characters panel tag list.** With **Characters panel: canonical tags only** on (the default), the **Tags (N)** list in Marinara's Characters panel shows only tags spelled exactly like a canonical, plus any tag you are currently filtering by. The toggle shows how many are left, e.g. `Tags (2389) · 265 canonical`. This only changes what the list shows: no card is touched. Variant spellings stay hidden until Apply renames them. With an empty dictionary nothing is hidden. Persona tags, library cards and the character editor are not affected.
- **Import / export.** Uses the SillyTavern extension's `ctm-tag-mapping` JSON, optionally with your unassigned tags so an AI can sort them (see [`tags.md`](tags.md)).
- **Dictionary cleanup and category manager.** Cleanup drops redundant variant spellings and reports likely duplicate canonicals. The manager reorders, renames and deletes categories.
- **Undo.** The **Undo** button or Ctrl+Z steps back through dictionary edits (the last 50).

## Install

The extension needs **Full page access**. The sandboxed runtime cannot read the whole library or change tags. Full page code runs inside Marinara's page with the same authority as code pasted into the browser console, so read the files in `extension/` before you approve them.

1. Set `ENABLE_EXTERNAL_EXTENSIONS=true` in the Marinara host's `.env` and restart Marinara.
2. Open **Settings** > **Advanced** > **Danger Zone** and enable **Allow third-party extension imports**.
3. Open **Settings** > **Addons** > **External Extensions** and choose **Import Extension Folder**. Select the **`extension`** folder in this repository, not the repository root.
4. Open the draft, check the code, choose **Review and Run**, and approve the hash.

A tag icon appears in the top bar next to Settings. Every code change disables the extension until you review and approve the new hash.

## Move your dictionary from SillyTavern

1. In SillyTavern, open **Extensions** > **Character Tag Merger** and choose **Export Mapping**.
2. In Marinara, open Tag Merger, then **Tools** > **Import dictionary…** and pick that file.
3. Check the preview, then import. Nothing on your cards changes until you Apply.

Categories, removed tags and implications all come across. If you import over an existing dictionary, the current one is downloaded first.

## Apply safely

1. **Back up Marinara's data folder** before the first Apply.
2. Set the options in the footer, then choose **Apply…**. The editor reads the library again and shows exactly what will change: every rename with its card count, every removal and addition, and how many distinct tags the library has before and after. The preview is computed with the same rules Marinara's server uses, so it matches what gets written.
3. Choose **1. Download backup**. This saves the current tags of every card that is about to change. **2. Apply** stays disabled until you have done this.
4. Choose **2. Apply**. Changes go through Marinara's own bulk tag endpoint, so only the tags change.
5. Reload Marinara to see the new tags in its own lists.

To undo an Apply, choose **Tools** > **Restore tags from backup…** and pick the backup file. Each card in it gets its saved tags back, and cards deleted since then are skipped. Restore writes one card at a time to stay under Marinara's rate limit, so a few thousand cards take several minutes.

Marinara also saves a version of each card before its tags change (unless versioning is off for that card). A single card can therefore be rolled back from its version history, and its version number goes up by one.

## Notes and limits

- Matching is exact after normalizing: leading `#` stripped, whitespace collapsed, case ignored. `#Female`, `female ` and `FEMALE` are the same key. There is no fuzzy matching.
- A canonical always matches its own name, and that beats a variant listed under another canonical.
- Renaming a canonical keeps the old spelling as a variant, so cards that use it still follow.
- Lorebook entries that filter by character tag are not updated when a tag is renamed. Check those by hand.
- Persona tags are left alone.
- The dictionary lives in the extension's private Marinara storage, which is capped at 1,000,000 bytes. A dictionary of about 470 canonicals and 3,800 variants and removed tags uses roughly 75 KB.

## Development

Requires Node.js 22.18 or newer. There are no dependencies to install.

```sh
npm test          # unit tests (core logic + storage guards)
npm run check     # build the bundle the way Marinara wraps it, then test
npm run dev       # dev harness at http://localhost:5178 with a mock Marinara
```

- `extension/`: the importable extension. Marinara joins the `jsPath` files in order into one script inside an async function, so the files share one scope (no `import`/`export`, no duplicate top-level names). `scripts/build.mjs` reproduces that wrapping and compiles it.
  - `src/core.js`: pure tag logic. Normalization, buckets, dictionary edits, the apply plan, import/export, cleanup, and a port of Marinara's `applyCharacterTagEdit`.
  - `src/api.js`: the three Marinara routes used: `GET /api/characters/catalog`, `POST /api/characters/bulk-tags`, and `PATCH /api/characters/:id` (Restore only).
  - `src/store.js`: saved dictionary and options. It never writes before it has read the saved data.
  - `src/share.js`: `window.marinaraTagMerger`, the read-only API for other extensions.
  - `src/shelf.js`: marks non-canonical chips in Marinara's Characters panel tag list so `extension.css` can hide them.
  - `src/ui.js`, `src/main.js`, `extension.css`: the editor overlay and the top-bar launcher.
- `test/`: `node:test` suites.
  - Fixtures are the SillyTavern extension's sample data: its base dictionary and an anonymous tag corpus, cut into mock cards.
  - When a Marinara checkout sits at `../../Marinara-Engine` (or `CTM_ME_REPO`), a fuzz test checks the `applyCharacterTagEdit` port against the real source.
- `dev/`: the harness page and mock Marinara host. The mock library lives in the browser's localStorage and never touches a real install.
- `scripts/smoke.mjs`: an end-to-end browser run against the harness. It imports, edits, applies with backup, then restores and checks the library is back to the start. It needs `playwright-core` and a Chromium:

  ```sh
  npm run dev &
  CTM_PLAYWRIGHT=/path/to/node_modules/playwright-core CTM_CHROME=/usr/bin/google-chrome-stable npm run smoke
  ```
