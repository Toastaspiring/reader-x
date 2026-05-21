/* ===================================================================
   app.js — bootstrap, view routing, reader chrome, preferences.
   =================================================================== */
window.App = (() => {
  const $ = (id) => document.getElementById(id);

  /* ----------------------------- refs ----------------------------- */
  const libraryView = $("library-view");
  const readerView = $("reader-view");
  const surface = $("reader-surface");
  const topBar = $("reader-top");
  const bottomBar = $("reader-bottom");
  const loader = $("reader-loading");
  const loaderText = $("loader-text");
  const titleEl = $("reader-title");
  const progLabel = $("progress-label");
  const progPct = $("progress-pct");
  const slider = $("progress-slider");
  const modePages = $("mode-pages");
  const modeScroll = $("mode-scroll");
  const tocBtn = $("toc-btn");
  const tocPanel = $("toc-panel");
  const tocList = $("toc-list");
  const fileInput = $("file-input");
  const dropOverlay = $("drop-overlay");
  const toastEl = $("toast");

  /* ----------------------------- state ---------------------------- */
  let reader = null;
  let currentBook = null;
  let prefs = loadPrefs();
  let chromeTimer = null;
  let saveTimer = null;
  let toastTimer = null;
  let scrubbing = false;
  let dragDepth = 0;

  /* -------------------------- preferences ------------------------- */
  function loadPrefs() {
    const get = (k, d) => {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : v;
      } catch (_) {
        return d;
      }
    };
    let theme = get("rx.theme", null);
    if (!theme) {
      theme =
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    }
    return {
      theme: theme,
      mode: get("rx.mode", "paginated"),
      fontPct: parseInt(get("rx.fontPct", "110"), 10) || 110,
      zoom: parseFloat(get("rx.zoom", "1")) || 1,
    };
  }
  function savePref(k, v) {
    try { localStorage.setItem(k, String(v)); } catch (_) {}
  }

  /* ----------------------------- theme ---------------------------- */
  function applyTheme(theme) {
    prefs.theme = theme;
    document.body.dataset.theme = theme;
    savePref("rx.theme", theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.content =
        theme === "dark" ? "#131318" : theme === "sepia" ? "#e9ddc7" : "#6c5ce7";
    }
    if (reader) reader.setTheme(theme);
  }
  function cycleTheme() {
    const order = ["light", "sepia", "dark"];
    const next = order[(order.indexOf(prefs.theme) + 1) % order.length];
    applyTheme(next);
    toast("Theme · " + next.charAt(0).toUpperCase() + next.slice(1));
  }

  /* ------------------------- open / close ------------------------- */
  async function openBook(id) {
    const book = await DB.getBook(id);
    if (!book) { toast("Could not find that book"); return; }
    currentBook = book;
    const progress = await DB.getProgress(id);

    libraryView.classList.remove("view--active");
    readerView.classList.add("view--active");
    showLoader("Opening “" + (book.title || "book") + "”…");
    titleEl.textContent = book.title || "Reading";
    document.title = (book.title || "Reader X") + " · Reader X";
    progLabel.textContent = "—";
    progPct.textContent = "0%";
    slider.value = 0;

    if (reader) { try { reader.destroy(); } catch (_) {} }
    reader = book.type === "epub" ? new EpubReader(surface) : new PdfReader(surface);
    wireReader();

    const location = progress
      ? { cfi: progress.cfi, page: progress.page, scrollRatio: progress.scrollRatio }
      : null;

    try {
      await reader.open(book.file, {
        mode: prefs.mode,
        theme: prefs.theme,
        fontPct: prefs.fontPct,
        zoom: prefs.zoom,
        location: location,
      });
    } catch (e) {
      console.error("Open failed:", e);
      hideLoader();
      toast("Sorry — this file could not be opened");
      await closeReader(true);
      return;
    }

    hideLoader();
    updateModeUI();
    pokeChrome();
    DB.updateBook(id, { lastOpened: Date.now() });
  }

  function wireReader() {
    reader.onReady = (info) => {
      if (info && info.title) {
        titleEl.textContent = info.title;
        document.title = info.title + " · Reader X";
      }
    };
    reader.onProgress = (p) => {
      if (!scrubbing) {
        slider.value = Math.round((p.percentage || 0) * 1000);
        progPct.textContent = Math.round((p.percentage || 0) * 100) + "%";
      }
      progLabel.textContent = p.label || "";
      scheduleSave();
    };
    reader.onToggleChrome = toggleChrome;
    reader.onEscape = () => closeReader();
    reader.onLocations = () => { slider.disabled = false; };
  }

  async function closeReader(skipSave) {
    closeToc();
    if (reader && !skipSave) await saveNow();
    if (reader) { try { reader.destroy(); } catch (_) {} reader = null; }
    currentBook = null;
    clearTimeout(chromeTimer);
    clearTimeout(saveTimer);
    readerView.classList.remove("view--active");
    libraryView.classList.add("view--active");
    document.title = "Reader X";
    try { await Library.refresh(); } catch (_) {}
  }

  /* --------------------------- progress --------------------------- */
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 700);
  }
  async function saveNow() {
    if (!reader || !currentBook) return;
    try {
      const st = reader.getState();
      await DB.saveProgress(currentBook.id, {
        percentage: st.percentage || 0,
        cfi: st.cfi || null,
        page: st.page || 1,
        scrollRatio: st.scrollRatio || 0,
        mode: prefs.mode,
      });
    } catch (e) {
      console.error("Progress save failed:", e);
    }
  }

  /* ------------------------ reader controls ----------------------- */
  async function setReaderMode(next) {
    if (next === prefs.mode) return;
    prefs.mode = next;
    savePref("rx.mode", next);
    updateModeUI();
    if (reader) {
      showLoader(next === "scroll" ? "Switching to scroll…" : "Switching to pages…");
      try { await reader.setMode(next); } catch (e) { console.error(e); }
      hideLoader();
    }
    pokeChrome();
  }

  function changeSize(dir) {
    if (!reader) return;
    reader.setSize(dir);
    if (currentBook && currentBook.type === "epub") {
      prefs.fontPct = reader.fontPct;
      savePref("rx.fontPct", reader.fontPct);
    } else if (reader) {
      prefs.zoom = reader.zoom;
      savePref("rx.zoom", reader.zoom);
    }
    pokeChrome();
  }

  function updateModeUI() {
    const paged = prefs.mode === "paginated";
    modePages.classList.toggle("seg-opt--on", paged);
    modeScroll.classList.toggle("seg-opt--on", !paged);
  }

  /* ---------------------------- chrome ---------------------------- */
  function revealChrome() {
    topBar.classList.remove("rbar--hidden");
    bottomBar.classList.remove("rbar--hidden");
  }
  function hideChrome() {
    topBar.classList.add("rbar--hidden");
    bottomBar.classList.add("rbar--hidden");
  }
  function scheduleChromeHide() {
    clearTimeout(chromeTimer);
    chromeTimer = setTimeout(hideChrome, 3400);
  }
  function pokeChrome() {
    revealChrome();
    scheduleChromeHide();
  }
  function toggleChrome() {
    if (topBar.classList.contains("rbar--hidden")) pokeChrome();
    else { hideChrome(); clearTimeout(chromeTimer); }
  }

  /* --------------------------- contents --------------------------- */
  function tocOpen() {
    return tocPanel.classList.contains("toc-panel--open");
  }
  function closeToc() {
    tocPanel.classList.remove("toc-panel--open");
  }
  async function openToc() {
    if (!reader) return;
    tocList.innerHTML = '<p class="toc-empty">Loading…</p>';
    tocPanel.classList.add("toc-panel--open");
    let toc = [];
    try { toc = await reader.getToc(); } catch (_) {}
    if (!tocOpen()) return; // closed again while loading

    tocList.innerHTML = "";
    if (!toc.length) {
      const p = document.createElement("p");
      p.className = "toc-empty";
      p.textContent = "No table of contents in this book.";
      tocList.appendChild(p);
      return;
    }
    const activeIdx = reader.markActiveToc(toc);
    toc.forEach((entry, i) => {
      const el = document.createElement("button");
      el.className = "toc-entry" + (i === activeIdx ? " toc-entry--active" : "");
      el.style.paddingLeft = 18 + entry.level * 16 + "px";
      el.textContent = entry.label;
      el.addEventListener("click", () => {
        if (reader) reader.goToToc(entry.target);
        closeToc();
        pokeChrome();
        scheduleSave();
      });
      tocList.appendChild(el);
    });
    const activeEl = tocList.querySelector(".toc-entry--active");
    if (activeEl) {
      requestAnimationFrame(() => activeEl.scrollIntoView({ block: "center" }));
    }
  }

  /* ----------------------------- loader --------------------------- */
  function showLoader(text) {
    loaderText.textContent = text || "Loading…";
    loader.classList.remove("hidden");
  }
  function hideLoader() {
    loader.classList.add("hidden");
  }

  /* ----------------------------- toast ---------------------------- */
  function toast(msg, sticky) {
    clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.classList.add("toast--show");
    if (!sticky) {
      toastTimer = setTimeout(
        () => toastEl.classList.remove("toast--show"),
        2800
      );
    }
  }

  /* --------------------------- global UI -------------------------- */
  function wireGlobalUI() {
    $("add-btn").addEventListener("click", () => fileInput.click());
    $("empty-add-btn").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files.length) {
        Library.importFiles(fileInput.files);
      }
      fileInput.value = "";
    });

    $("search-input").addEventListener("input", (e) =>
      Library.setQuery(e.target.value)
    );
    $("sort-btn").addEventListener("click", () => {
      $("sort-label").textContent = Library.cycleSort();
    });
    $("theme-btn").addEventListener("click", cycleTheme);
    $("reader-theme-btn").addEventListener("click", cycleTheme);

    $("reader-back").addEventListener("click", () => closeReader());
    tocBtn.addEventListener("click", openToc);
    $("toc-close").addEventListener("click", closeToc);
    $("toc-scrim").addEventListener("click", closeToc);
    modePages.addEventListener("click", () => setReaderMode("paginated"));
    modeScroll.addEventListener("click", () => setReaderMode("scroll"));
    $("size-down").addEventListener("click", () => changeSize(-1));
    $("size-up").addEventListener("click", () => changeSize(1));

    slider.addEventListener("input", () => {
      scrubbing = true;
      progPct.textContent = Math.round(slider.value / 10) + "%";
    });
    slider.addEventListener("change", () => {
      if (reader) reader.goToPercent(slider.value / 1000);
      scrubbing = false;
      pokeChrome();
    });

    document.addEventListener("keydown", onKeyDown);
    wireDragDrop();

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) saveNow();
    });
    window.addEventListener("pagehide", () => saveNow());
  }

  function onKeyDown(e) {
    if (!readerView.classList.contains("view--active")) return;
    if (e.key === "Escape") {
      tocOpen() ? closeToc() : closeReader();
      return;
    }
    if (tocOpen()) return;
    if (e.target === slider) return;
    const onControl = /^(INPUT|BUTTON|SELECT|TEXTAREA)$/.test(e.target.tagName || "");
    switch (e.key) {
      case "ArrowRight":
      case "PageDown":
        if (reader) reader.next();
        e.preventDefault();
        break;
      case "ArrowLeft":
      case "PageUp":
        if (reader) reader.prev();
        e.preventDefault();
        break;
      case " ":
        if (onControl) return;
        if (reader && prefs.mode === "paginated") {
          e.shiftKey ? reader.prev() : reader.next();
          e.preventDefault();
        }
        break;
      case "+":
      case "=":
        changeSize(1);
        break;
      case "-":
      case "_":
        changeSize(-1);
        break;
    }
  }

  function wireDragDrop() {
    const hasFiles = (e) =>
      e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf("Files") > -1;

    window.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dragDepth++;
      if (hasFiles(e) && libraryView.classList.contains("view--active")) {
        dropOverlay.classList.remove("hidden");
      }
    });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dropOverlay.classList.add("hidden");
    });
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      dropOverlay.classList.add("hidden");
      if (!libraryView.classList.contains("view--active")) return;
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        Library.importFiles(e.dataTransfer.files);
      }
    });
  }

  function registerSW() {
    if ("serviceWorker" in navigator && location.protocol.indexOf("http") === 0) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  /* ----------------------------- init ----------------------------- */
  async function init() {
    applyTheme(prefs.theme);
    updateModeUI();
    Library.setOnOpen(openBook);
    wireGlobalUI();
    try {
      await Library.init();
    } catch (e) {
      console.error("Library init failed:", e);
      toast("Storage is unavailable in this browser");
    }
    registerSW();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return { toast: toast, openBook: openBook };
})();
