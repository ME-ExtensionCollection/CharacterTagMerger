// Character Tag Merger: Marinara HTTP calls. Every request goes through
// marinara.fetch so Settings > Addons can attribute the traffic to this extension.

const ctmApi = (() => {
  "use strict";

  const PAGE_SIZE = 100; // the catalog caps pages at 100
  const WRITE_HEADERS = { "Content-Type": "application/json", "x-marinara-csrf": "1" };

  async function request(path, init) {
    const response = await marinara.fetch(path, init);
    if (!response.ok) {
      let message = "";
      try {
        message = (await response.json())?.error ?? "";
      } catch {
        // not JSON
      }
      throw new Error(message || `${init?.method ?? "GET"} ${path} failed (${response.status})`);
    }
    return response.json();
  }

  /**
   * Every character (no built-ins) as { id, name, tags }. Restarts when the
   * catalog changes mid-read, like Marinara's own useAllCharacterCatalog.
   */
  async function loadCharacters(onProgress) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const cards = [];
      let generation;
      let offset = 0;
      let restarted = false;
      for (;;) {
        const page = await request(`/api/characters/catalog?limit=${PAGE_SIZE}&offset=${offset}`);
        generation ??= page.catalogGeneration;
        if (page.catalogGeneration !== generation) {
          restarted = true;
          break;
        }
        for (const item of page.items ?? []) {
          cards.push({
            id: item.id,
            name: typeof item.name === "string" ? item.name : "",
            tags: Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === "string") : [],
          });
        }
        onProgress?.(cards.length);
        if (!page.hasMore || !page.items?.length) break;
        offset += page.items.length;
      }
      if (!restarted) return cards;
    }
    throw new Error("The character library kept changing while loading. Try again.");
  }

  /** One POST /api/characters/bulk-tags call. Returns { updatedIds, unchangedIds, failedIds }. */
  function bulkTags(ids, edit) {
    return request("/api/characters/bulk-tags", {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ ids, rename: edit.rename, remove: edit.remove, add: edit.add }),
    });
  }

  /** Replace one card's tags (used by Restore). */
  function setTags(id, tags) {
    return request(`/api/characters/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ data: { tags }, versionSource: "manual", versionReason: "Tag Merger restore" }),
    });
  }

  return Object.freeze({ loadCharacters, bulkTags, setTags });
})();
