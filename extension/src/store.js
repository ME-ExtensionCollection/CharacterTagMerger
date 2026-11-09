// Character Tag Merger: the saved dictionary and options, kept in this
// extension's private Marinara storage (1,000,000-byte cap). Edits save
// automatically after a short pause.

const ctmStore = (() => {
  "use strict";

  const STORAGE_LIMIT = 1_000_000;
  const SAVE_DELAY = 400;
  const DEFAULT_SETTINGS = Object.freeze({
    autoRemoveLong: true,
    maxTagLength: CTM.DEFAULT_MAX_TAG_LENGTH,
    standardize: false,
    skipRemoved: false,
    splitCombined: true,
    shelfCanonicalOnly: true,
  });

  let dict = CTM.emptyDict();
  let settings = { ...DEFAULT_SETTINGS };
  let timer = 0;
  let saving = null;
  let loaded = false; // never write before the saved data has been read
  let dirty = false;
  let onError = () => {};

  function cleanSettings(raw) {
    const s = { ...DEFAULT_SETTINGS };
    if (raw && typeof raw === "object") {
      for (const key of ["autoRemoveLong", "standardize", "skipRemoved", "splitCombined", "shelfCanonicalOnly"]) {
        if (typeof raw[key] === "boolean") s[key] = raw[key];
      }
      const n = Math.round(Number(raw.maxTagLength));
      if (Number.isFinite(n) && n >= 1) s.maxTagLength = n;
    }
    return s;
  }

  async function load() {
    const saved = await marinara.storage.get();
    dict = CTM.sanitizeDict(saved?.dict);
    settings = cleanSettings(saved?.settings);
    loaded = true;
    dirty = false;
  }

  async function write() {
    const payload = { dict, settings, savedAt: new Date().toISOString() };
    const size = new TextEncoder().encode(JSON.stringify(payload)).length;
    if (size > STORAGE_LIMIT) throw new Error(`The dictionary is too big to save (${size} of ${STORAGE_LIMIT} bytes).`);
    await marinara.storage.patch(payload);
    // Tell other extensions (see share.js) that the dictionary changed.
    window.dispatchEvent(new CustomEvent("marinara-tag-merger:changed"));
  }

  function save() {
    if (!loaded) return;
    dirty = true;
    marinara.clearTimeout(timer);
    timer = marinara.setTimeout(() => void flush(), SAVE_DELAY);
  }

  /** Write any pending change now. Never throws; errors go to the error handler. */
  async function flush() {
    marinara.clearTimeout(timer);
    timer = 0;
    while (saving) await saving;
    if (!loaded || !dirty) return;
    dirty = false;
    saving = write()
      .catch((error) => {
        dirty = true; // keep it pending so the next save or flush retries
        onError(error);
      })
      .finally(() => {
        saving = null;
      });
    await saving;
  }

  return Object.freeze({
    load,
    get loaded() {
      return loaded;
    },
    save,
    flush,
    get dict() {
      return dict;
    },
    set dict(next) {
      if (!loaded) throw new Error("Dictionary not loaded yet");
      dict = CTM.sanitizeDict(next);
      save();
    },
    get settings() {
      return settings;
    },
    setSetting(key, value) {
      if (!loaded) return;
      settings = cleanSettings({ ...settings, [key]: value });
      save();
    },
    setErrorHandler(handler) {
      onError = handler;
    },
    /** Effective auto-remove cutoff: 0 when the option is off. */
    get maxTagLength() {
      return settings.autoRemoveLong ? settings.maxTagLength : 0;
    },
  });
})();
