// Browser smoke test against the dev harness (mock Marinara, mock library).
// Drives the real UI end to end: open, import the ST base dictionary, edit,
// apply with backup, then restore the backup and check the mock library is
// back to where it started.
//
// Needs `node scripts/serve.mjs` running, plus playwright-core and a Chromium:
//   CTM_PLAYWRIGHT=/path/to/playwright-core   (default: import "playwright-core")
//   CTM_CHROME=/usr/bin/google-chrome-stable  (default: Playwright's own browser)
//   CTM_SHOTS=/some/dir                       (optional screenshots)
// Usage: node scripts/smoke.mjs [baseUrl]
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.argv[2] ?? "http://localhost:5178";
const pw = await import(process.env.CTM_PLAYWRIGHT ? pathToFileURL(join(process.env.CTM_PLAYWRIGHT, "index.mjs")).href : "playwright-core");
const shots = process.env.CTM_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const browser = await pw.chromium.launch({ executablePath: process.env.CTM_CHROME || undefined, headless: true });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const shot = async (name) => shots && page.screenshot({ path: join(shots, `${name}.png`) });
const step = (text) => console.log(`- ${text}`);

const library = () => page.evaluate(async () => JSON.parse(JSON.stringify(await window.__ctmHarness.library())));
const dialog = (title) => page.locator(".ctm-dialog", { has: page.getByRole("heading", { name: title }) });

await page.goto(`${BASE}/dev/harness.html`);
await page.evaluate(() => localStorage.clear());
await page.reload();

step("launcher mounts before Settings");
const launcher = page.locator("[data-ctm-launcher]");
await launcher.waitFor();
assert.equal(await page.locator('nav[data-tour="panel-buttons"] > *').nth(1).getAttribute("data-ctm-launcher"), "");
const original = await library();

step("open: empty dictionary, library loads");
await launcher.click();
await page.locator(".ctm-stats", { hasText: "distinct tags" }).waitFor();
await page.getByText("No canonical tags yet").waitFor();
await shot("01-empty");

step("import the SillyTavern base dictionary");
await page.getByRole("button", { name: "Tools ▾" }).click();
const chooser = page.waitForEvent("filechooser");
await page.getByRole("button", { name: "Import dictionary…" }).click();
await (await chooser).setFiles(join(ROOT, "test/fixtures/st-base-dictionary.json"));
await dialog("Import dictionary").waitFor();
await shot("02-import-preview");
await dialog("Import dictionary").getByRole("button", { name: "Import" }).click();
await page.locator(".ctm-cat").first().waitFor();
await shot("03-imported");

step("search finds a canonical and its variants");
await page.getByLabel("Search tags").fill("elf");
await page.locator(".ctm-canon-name").first().waitFor();
const names = await page.locator(".ctm-canon-name").evaluateAll((els) => els.map((e) => e.value));
assert.ok(names.some((n) => /elf/i.test(n)), `canonicals for "elf": ${names}`);
await shot("04-search");

step("move an unassigned tag into a canonical, then undo");
await page.getByLabel("Search tags").fill("");
await page.waitForTimeout(250);
const firstChip = page.locator(".ctm-side .ctm-chip").first();
const tag = await firstChip.locator(".ctm-chip-label").textContent();
await firstChip.click();
await page.locator(".ctm-popover input").fill("romance");
await page.locator(".ctm-popover .ctm-pop-item").first().click();
await page.getByLabel("Search tags").fill(tag);
await page.waitForTimeout(250);
assert.ok((await page.locator(".ctm-canon-pane, .ctm-pane").first().locator(".ctm-chip-label", { hasText: tag }).count()) > 0, `${tag} now under a canonical`);
await page.getByRole("button", { name: "Undo" }).click();
await page.waitForTimeout(100);
assert.equal(await page.locator(".ctm-pane").first().locator(".ctm-chip-label", { hasText: tag }).count(), 0, "undo put it back");
await page.getByLabel("Search tags").fill("");

assert.equal(await page.locator(".ctm-side").getByText("null", { exact: true }).count(), 0, "no stray text in the side pane");

step("rename a canonical keeps the old spelling, add an implication");
await page.getByLabel("Search tags").fill("dark elf");
await page.waitForTimeout(250);
const darkElf = page.locator('.ctm-row[data-canonical="Dark Elf"]');
await darkElf.locator(".ctm-canon-name").fill("Drow Elf");
await darkElf.locator(".ctm-canon-name").press("Enter");
await page.getByLabel("Search tags").fill("drow elf");
await page.waitForTimeout(250);
const renamed = page.locator('.ctm-row[data-canonical="Drow Elf"]');
await renamed.getByTitle("Dark Elf").waitFor(); // "+N unused" lists the old spelling
await renamed.getByRole("button", { name: "+ implies" }).click();
await page.locator(".ctm-popover input").fill("Elf");
await page.locator(".ctm-popover .ctm-pop-item", { hasText: /^Elf/ }).first().click();
await renamed.locator(".ctm-chip--implies", { hasText: "→ Elf" }).waitFor();
await page.getByLabel("Search tags").fill("");

step("category manager, cleanup report, export");
await page.getByRole("button", { name: "Tools ▾" }).click();
await page.getByRole("button", { name: "Manage categories…" }).click();
await dialog("Categories").locator(".ctm-catmgr-row").first().waitFor();
await shot("08-categories");
await dialog("Categories").getByRole("button", { name: "Close" }).click();
await page.getByRole("button", { name: "Tools ▾" }).click();
await page.getByRole("button", { name: "Clean up dictionary…" }).click();
const cleanup = page.locator(".ctm-dialog").last();
await cleanup.waitFor();
await shot("09-cleanup");
await cleanup.getByRole("button", { name: /Cancel|OK/ }).click();
await page.getByRole("button", { name: "Tools ▾" }).click();
const exportDownload = page.waitForEvent("download");
await page.getByRole("button", { name: "Export dictionary", exact: true }).click();
const exported = JSON.parse(await (await import("node:fs/promises")).readFile(await (await exportDownload).path(), "utf8"));
assert.equal(exported.format, "ctm-tag-mapping");
assert.ok(exported.implies["Drow Elf"]?.includes("Elf"), "export carries the implication");

step("combined tags show in the Split tab and the apply preview");
await page.getByRole("tab", { name: /^Split \(/ }).click();
const splitRow = page.locator(".ctm-split-row", { hasText: "cold, sarcastic, tattoo artist" });
await splitRow.waitFor();
assert.equal(await splitRow.locator(".ctm-split-parts del", { hasText: /^e$/ }).count(), 0, "e belongs to the other row");
await page.locator(".ctm-split-row", { hasText: "homeless" }).locator(".ctm-split-parts del", { hasText: /^e$/ }).waitFor();
await shot("10-split");
await page.getByRole("button", { name: "Apply…" }).click();
await dialog("Apply tag changes").getByText(/^Split into separate tags \(\d+\)/).waitFor();
await dialog("Apply tag changes").getByRole("button", { name: "Cancel" }).click();
await page.getByRole("tab", { name: /^Unassigned/ }).click();

step("Skip Removed: preview removes nothing");
await page.getByLabel("Skip Removed").check();
await page.getByRole("button", { name: "Apply…" }).click();
await dialog("Apply tag changes").getByText("Skip Removed: on (nothing is removed)").waitFor();
await dialog("Apply tag changes").getByText("Skip Removed is on.").waitFor();
await dialog("Apply tag changes").getByRole("button", { name: "Cancel" }).click();
await page.getByLabel("Skip Removed").uncheck();

step("apply needs a backup first, then writes the mock library");
await page.getByRole("button", { name: "Apply…" }).click();
const apply = dialog("Apply tag changes");
await apply.getByRole("button", { name: "1. Download backup" }).waitFor();
await shot("05-apply-preview");
const applyButton = apply.getByRole("button", { name: /^2\. Apply to/ });
assert.ok(await applyButton.isDisabled(), "Apply disabled before backup");
const download = page.waitForEvent("download");
await apply.getByRole("button", { name: "1. Download backup" }).click();
const backupPath = join(shots ?? ROOT, "smoke-backup.json");
await (await download).saveAs(backupPath);
await applyButton.click();
await dialog("Applied").waitFor();
await shot("06-applied");
const applied = await library();
const changed = applied.filter((c, i) => JSON.stringify(c.tags) !== JSON.stringify(original[i].tags));
assert.ok(changed.length > 0, "library changed");
await dialog("Applied").getByRole("button", { name: "Close" }).click();

step("restore the backup returns the library to the start");
await page.getByRole("button", { name: "Tools ▾" }).click();
const chooser2 = page.waitForEvent("filechooser");
await page.getByRole("button", { name: "Restore tags from backup…" }).click();
await (await chooser2).setFiles(backupPath);
await dialog("Restore tags from backup").getByRole("button", { name: /^Restore/ }).click();
await dialog("Restore finished").waitFor({ timeout: 10 * 60_000 });
await dialog("Restore finished").getByRole("button", { name: "OK" }).click();
assert.deepEqual(await library(), original, "library restored");

step("dictionary survives a reload");
await page.reload();
await page.locator("[data-ctm-launcher]").click();
await page.locator(".ctm-cat").first().waitFor();
await page.keyboard.press("Escape");
assert.equal(await page.locator(".ctm-overlay").count(), 0, "Escape closes");

step("narrow screen layout");
await page.setViewportSize({ width: 390, height: 844 });
await page.locator("[data-ctm-launcher]").click();
await page.locator(".ctm-cat").first().waitFor();
await shot("07-phone");

assert.deepEqual(errors, [], "no page errors");
await browser.close();
console.log(`Smoke test passed: ${changed.length} mock cards changed and restored.`);
