// Character Tag Merger: a read-only API for other extensions on this page
// (Char Importer uses it to tidy tags on cards it imports). It reads the
// dictionary and never writes.

const ctmShared = Object.freeze({
  version: 1,
  /** @returns {Promise<{canonical: string[], other: string[]}>} see CTM.mapImportTags */
  async mapTags(tags) {
    if (!ctmStore.loaded) await ctmStore.load();
    return CTM.mapImportTags(tags, ctmStore.dict);
  },
});
window.marinaraTagMerger = ctmShared;

marinara.onCleanup(() => {
  if (window.marinaraTagMerger === ctmShared) delete window.marinaraTagMerger;
});
