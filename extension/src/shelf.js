// Character Tag Merger: show only canonical tags in Marinara's Characters
// panel tag shelf (the "Tags (N)" list). Display only; card tags never change.
//
// CSS cannot match a tag's text, so sync() marks each non-canonical chip with
// data-ctm-shelf-hidden and extension.css hides it. Markup follows
// packages/client/src/components/panels/CharactersPanel.tsx: chips are
// div.group/tag > button{tag}, keyed by tag text, so marks survive re-renders.
// A data attribute is used because React rewrites className on selection.

const ctmShelf = (() => {
  "use strict";

  const ROOT = '[data-component="CharactersPanelScroll"]';
  const CHIP = `${ROOT} .group\\/tag`;
  const TOGGLE = `${ROOT} button[aria-expanded]`;
  const HIDDEN = "data-ctm-shelf-hidden";
  const COUNT = "data-ctm-shelf-count";
  const TITLE = "Tag Merger shows only canonical tags here, plus any tag you are filtering by.";

  function clear() {
    for (const node of document.querySelectorAll(`[${HIDDEN}]`)) node.removeAttribute(HIDDEN);
    for (const node of document.querySelectorAll(`[${COUNT}]`)) {
      node.removeAttribute(COUNT);
      if (node.title === TITLE) node.removeAttribute("title");
    }
  }

  function sync() {
    if (!ctmStore.loaded) return;
    const names = CTM.canonicalNames(ctmStore.dict);
    // With an empty dictionary every chip would vanish; stay out of the way instead.
    if (!ctmStore.settings.shelfCanonicalOnly || names.size === 0) {
      clear();
      return;
    }
    let shown = 0;
    let total = 0;
    for (const chip of document.querySelectorAll(CHIP)) {
      const tag = chip.querySelector("button")?.textContent.trim() ?? "";
      // An included or excluded tag stays visible so an active filter is never hidden.
      const filtering = chip.classList.contains("mari-chrome-control--selected") || chip.classList.contains("mari-chrome-control--danger");
      const hide = !filtering && !names.has(tag);
      total++;
      if (!hide) shown++;
      if (chip.hasAttribute(HIDDEN) !== hide) chip.toggleAttribute(HIDDEN, hide);
    }
    const toggle = document.querySelector(TOGGLE);
    if (toggle) {
      const label = total ? `${shown} canonical` : "canonical only";
      if (toggle.getAttribute(COUNT) !== label) toggle.setAttribute(COUNT, label);
      if (!toggle.title) toggle.title = TITLE;
    }
  }

  return Object.freeze({ sync, clear });
})();
