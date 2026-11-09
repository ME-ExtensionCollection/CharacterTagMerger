// Character Tag Merger: a read-only API for other extensions on this page.
// Char Importer uses mapTags to tidy tags on cards it imports; Character
// Library uses canonicalTags and mapTagsBatch to filter by canonical tags.
// It reads the dictionary and never writes. When the dictionary is saved,
// a "marinara-tag-merger:changed" event is dispatched on window.

const ctmShared = Object.freeze({
  version: 2,
  /** @returns {Promise<{canonical: string[], other: string[]}>} see CTM.mapImportTags */
  async mapTags(tags) {
    if (!ctmStore.loaded) await ctmStore.load();
    return CTM.mapImportTags(tags, ctmStore.dict);
  },
  /**
   * mapTags for many cards at once (the dictionary lookup is built once).
   * @param {string[][]} list one tag array per card
   * @returns {Promise<Array<{canonical: string[], other: string[]}>>}
   */
  async mapTagsBatch(list) {
    if (!ctmStore.loaded) await ctmStore.load();
    const map = CTM.createImportMapper(ctmStore.dict);
    return (Array.isArray(list) ? list : []).map((tags) => map(tags));
  },
  /** @returns {Promise<string[]>} every canonical tag name, in dictionary order */
  async canonicalTags() {
    if (!ctmStore.loaded) await ctmStore.load();
    return [...CTM.canonicalNames(ctmStore.dict)];
  },
});
window.marinaraTagMerger = ctmShared;

marinara.onCleanup(() => {
  if (window.marinaraTagMerger === ctmShared) delete window.marinaraTagMerger;
});
