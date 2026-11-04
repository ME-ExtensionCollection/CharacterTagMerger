// Character Tag Merger: entry point. Full page extensions get no
// registerContribution, so a launcher button is placed in Marinara's top bar
// next to Settings and put back whenever React re-renders it away.

const CTM_NAV_SELECTOR = 'nav[data-tour="panel-buttons"]';
const CTM_SETTINGS_SELECTOR = '[data-tour="panel-settings"]';

// Same classes as Marinara's own top-bar panel buttons (TopBar.tsx), so it picks up the theme.
const ctmLauncher = document.createElement("button");
ctmLauncher.type = "button";
ctmLauncher.className =
  "ctm-launcher mari-topbar-action relative flex h-8 w-8 items-center justify-center rounded-lg p-0 transition-all duration-200 text-[var(--muted-foreground)] hover:bg-[var(--accent)]";
ctmLauncher.title = "Tag Merger";
ctmLauncher.setAttribute("aria-label", "Open Tag Merger");
ctmLauncher.dataset.ctmLauncher = "";
ctmLauncher.innerHTML =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5 6.3 6.3a2.4 2.4 0 0 1 0 3.4L17 19"/><path d="M9.586 5.586A2 2 0 0 0 8.172 5H3a1 1 0 0 0-1 1v5.172a2 2 0 0 0 .586 1.414L8.29 18.29a2.426 2.426 0 0 0 3.42 0l3.58-3.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="6.5" cy="9.5" r=".5" fill="currentColor"/></svg>';
ctmLauncher.addEventListener("click", () => {
  void ctmUi.open().catch((error) => marinara.log.error("Tag Merger failed to open", error));
});

let ctmFrame = 0;
function ctmMountLauncher() {
  ctmFrame = 0;
  const nav = document.querySelector(CTM_NAV_SELECTOR);
  if (!nav || ctmLauncher.parentElement === nav) return;
  const settings = nav.querySelector(CTM_SETTINGS_SELECTOR);
  if (settings) nav.insertBefore(ctmLauncher, settings);
  else nav.append(ctmLauncher);
}

const ctmObserver = new MutationObserver(() => {
  if (!ctmFrame) ctmFrame = requestAnimationFrame(ctmMountLauncher);
});
ctmObserver.observe(document.body, { childList: true, subtree: true });
ctmMountLauncher();

// Best effort: write a pending dictionary edit before the page goes away.
const ctmFlushOnHide = () => void ctmStore.flush();
window.addEventListener("pagehide", ctmFlushOnHide);

marinara.onCleanup(async () => {
  window.removeEventListener("pagehide", ctmFlushOnHide);
  ctmObserver.disconnect();
  if (ctmFrame) cancelAnimationFrame(ctmFrame);
  ctmLauncher.remove();
  await ctmUi.close();
});

marinara.log.info("Tag Merger loaded");
