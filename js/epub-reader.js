/* ===================================================================
   epub-reader.js — EPUB rendering via epub.js.

   Exposes the shared reader interface used by app.js:
     open(blob, opts) · next() · prev() · setMode() · setTheme()
     setSize(dir) · goToPercent(p) · getState() · destroy()
   plus callbacks: onProgress, onToggleChrome, onActivity, onEscape,
                   onLocations, onReady.
   =================================================================== */
class EpubReader {
  constructor(surface) {
    this.surface = surface;
    this.type = "epub";
    this.book = null;
    this.rendition = null;
    this.host = null;

    this.mode = "paginated";
    this.theme = "light";
    this.fontPct = 110;
    this.spineCount = 1;

    this.lastLoc = null;
    this.locationsReady = false;
    this.currentHref = null;
    this._lastCfi = null;
    this._lastPct = 0;

    this.onProgress = () => {};
    this.onToggleChrome = () => {};
    this.onActivity = () => {};
    this.onEscape = () => {};
    this.onLocations = () => {};
    this.onReady = () => {};
  }

  async open(blob, opts = {}) {
    this.mode = opts.mode || "paginated";
    this.theme = opts.theme || "light";
    this.fontPct = opts.fontPct || 110;
    const startAt = opts.location && opts.location.cfi ? opts.location.cfi : null;

    const buffer = await blob.arrayBuffer();
    this.book = ePub(buffer);
    await this.book.ready;

    this.spineCount =
      (this.book.spine && this.book.spine.spineItems &&
        this.book.spine.spineItems.length) || 1;

    let title = "Untitled";
    try {
      const meta = await this.book.loaded.metadata;
      if (meta && meta.title) title = meta.title;
    } catch (_) {}
    this.title = title;

    this.host = document.createElement("div");
    this.host.className = "epub-host";
    this.surface.innerHTML = "";
    this.surface.removeAttribute("data-pdf-theme");
    this.surface.appendChild(this.host);

    await this._render(startAt);
    this.onReady({ title });

    /* Build a location index so progress and the slider are accurate.
       Runs in the background — large books take a moment. */
    this.book.locations
      .generate(1200)
      .then(() => {
        this.locationsReady = true;
        this.onLocations();
        this._emitProgress();
      })
      .catch(() => {});

    return { title };
  }

  async _render(target) {
    if (this.rendition) {
      try { this.rendition.destroy(); } catch (_) {}
    }
    const paginated = this.mode !== "scroll";

    this.rendition = this.book.renderTo(this.host, {
      width: "100%",
      height: "100%",
      flow: paginated ? "paginated" : "scrolled",
      manager: paginated ? "default" : "continuous",
      spread: "none",
      allowScriptedContent: false,
    });

    this._registerThemes();
    this.rendition.themes.select(this.theme);
    this.rendition.themes.fontSize(this.fontPct + "%");

    this.rendition.hooks.content.register((contents) => this._wireContent(contents));
    this.rendition.on("relocated", (loc) => {
      this.lastLoc = loc;
      if (loc && loc.start && loc.start.href) this.currentHref = loc.start.href;
      this._emitProgress();
    });

    try {
      await this.rendition.display(target || undefined);
    } catch (_) {
      await this.rendition.display();
    }
  }

  _registerThemes() {
    const r = this.rendition;
    const common = {
      img: { "max-width": "100% !important", height: "auto !important" },
      "p, li": { "line-height": "1.6 !important" },
      "html, body": { "scrollbar-width": "none !important" },
      "::-webkit-scrollbar": { display: "none !important", width: "0 !important" },
    };
    // Headings: many books hard-code a grey — force them to the theme so
    // chapter titles stay readable. opacity guards against faded styles.
    r.themes.register("light", Object.assign({}, common, {
      body: { background: "#ffffff !important", color: "#1f1f27 !important" },
      "h1, h2, h3, h4, h5, h6": { color: "#100f15 !important", opacity: "1 !important" },
      "a, a:visited": { color: "#6c5ce7 !important" },
    }));
    r.themes.register("sepia", Object.assign({}, common, {
      body: { background: "#f4ecd8 !important", color: "#473c28 !important" },
      "h1, h2, h3, h4, h5, h6": { color: "#332817 !important", opacity: "1 !important" },
      "a, a:visited": { color: "#a96a31 !important" },
    }));
    r.themes.register("dark", Object.assign({}, common, {
      body: { background: "#17171d !important", color: "#cdcdd8 !important" },
      "h1, h2, h3, h4, h5, h6": { color: "#f2f2f7 !important", opacity: "1 !important" },
      "a, a:visited": { color: "#9b8cf8 !important" },
    }));
  }

  /* Listeners injected into every chapter iframe. */
  _wireContent(contents) {
    const doc = contents.document;
    const win = contents.window;

    doc.addEventListener("click", (e) => {
      if (e.target.closest && e.target.closest("a")) return;
      if (this.mode === "scroll") { this.onToggleChrome(); return; }
      // The paginated iframe is much wider than the screen and is shifted
      // per page, so map the tap into on-screen surface coordinates.
      let screenX = e.clientX;
      try {
        const frame = win.frameElement;
        if (frame) screenX = frame.getBoundingClientRect().left + e.clientX;
      } catch (_) {}
      const w = this.surface.clientWidth || 1;
      if (screenX < w * 0.3) this.prev();
      else if (screenX > w * 0.7) this.next();
      else this.onToggleChrome();
    });

    doc.addEventListener("keydown", (e) => this._key(e));

    let sx = 0, sy = 0, st = 0;
    doc.addEventListener("touchstart", (e) => {
      const t = e.changedTouches[0];
      sx = t.clientX; sy = t.clientY; st = Date.now();
    }, { passive: true });
    doc.addEventListener("touchend", (e) => {
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Date.now() - st < 600 && Math.abs(dx) > 45 &&
          Math.abs(dx) > Math.abs(dy) * 1.8 && this.mode !== "scroll") {
        dx < 0 ? this.next() : this.prev();
      }
    }, { passive: true });
  }

  _key(e) {
    switch (e.key) {
      case "ArrowRight":
      case "PageDown":
        this.next(); e.preventDefault(); break;
      case "ArrowLeft":
      case "PageUp":
        this.prev(); e.preventDefault(); break;
      case " ":
        if (this.mode !== "scroll") {
          e.shiftKey ? this.prev() : this.next();
          e.preventDefault();
        }
        break;
      case "Escape":
        this.onEscape(); break;
    }
  }

  _emitProgress() {
    if (!this.rendition) return;
    const loc = this.lastLoc;
    if (!loc || !loc.start) return;

    const cfi = loc.start.cfi;
    const d = loc.start.displayed;

    // Spine position + page-within-section. Instant, monotonic and
    // reliable for every EPUB — including image-only ones, where the
    // character-location index is degenerate.
    let pct = 0;
    if (this.spineCount > 0) {
      const idx = loc.start.index || 0;
      const within = d && d.total ? (Math.max(1, d.page) - 1) / d.total : 0;
      pct = (idx + within) / this.spineCount;
    }
    pct = Math.max(0, Math.min(1, pct));

    let label;
    if (d && d.page && d.total && this.mode !== "scroll") {
      label = "Page " + d.page + " of " + d.total;
    } else {
      label = Math.round(pct * 100) + "%";
    }

    this._lastCfi = cfi || this._lastCfi;
    this._lastPct = pct;
    this.onProgress({ percentage: pct, label: label });
  }

  next() { if (this.rendition) this.rendition.next(); }
  prev() { if (this.rendition) this.rendition.prev(); }

  async setMode(mode) {
    if (mode === this.mode || !this.book) return;
    const target = this._lastCfi ||
      (this.lastLoc && this.lastLoc.start && this.lastLoc.start.cfi) || null;
    this.mode = mode;
    await this._render(target);
  }

  async setTheme(theme) {
    if (theme === this.theme) return;
    this.theme = theme;
    // epub.js's themes.select() does not reliably re-theme content that is
    // already rendered (especially after cycling themes), so re-render the
    // book at the current location with the new theme applied from the start.
    if (this.rendition) {
      const target =
        this._lastCfi ||
        (this.lastLoc && this.lastLoc.start && this.lastLoc.start.cfi) ||
        null;
      await this._render(target);
    }
  }

  setSize(dir) {
    this.fontPct = Math.max(80, Math.min(240, this.fontPct + dir * 10));
    if (this.rendition) this.rendition.themes.fontSize(this.fontPct + "%");
    return this.fontPct;
  }

  goToPercent(p) {
    if (!this.rendition) return;
    p = Math.max(0, Math.min(1, p));
    // The location index gives a precise jump, but only when it is
    // genuinely fine-grained (a real text book, not an image-only one).
    if (
      this.locationsReady &&
      this.book.locations.length() > this.spineCount * 4
    ) {
      const cfi = this.book.locations.cfiFromPercentage(p);
      if (cfi) { this.rendition.display(cfi); return; }
    }
    // Otherwise jump by chapter.
    if (this.spineCount > 1) {
      const idx = Math.min(this.spineCount - 1, Math.round(p * (this.spineCount - 1)));
      const item = this.book.spine.get(idx);
      if (item && item.href) this.rendition.display(item.href);
    }
  }

  /* --------------------------- contents ---------------------------- */
  async getToc() {
    try {
      const nav = await this.book.loaded.navigation;
      const flat = [];
      const walk = (items, level) => {
        (items || []).forEach((it) => {
          flat.push({
            label: (it.label || "").replace(/\s+/g, " ").trim() || "Untitled",
            target: it.href,
            level: level,
          });
          if (it.subitems && it.subitems.length) walk(it.subitems, level + 1);
        });
      };
      if (nav && nav.toc) walk(nav.toc, 0);
      return flat;
    } catch (_) {
      return [];
    }
  }

  goToToc(href) {
    if (this.rendition && href) {
      try { this.rendition.display(href); } catch (_) {}
    }
  }

  /** Index of the TOC entry for the current section, or -1. */
  markActiveToc(toc) {
    const base = (s) => (s || "").split("#")[0].split("/").pop();
    const cur = base(this.currentHref);
    if (!cur) return -1;
    let found = -1;
    for (let i = 0; i < toc.length; i++) {
      if (base(toc[i].target) === cur) { found = i; break; }
    }
    return found;
  }

  getState() {
    return { percentage: this._lastPct || 0, cfi: this._lastCfi || null };
  }

  destroy() {
    try { if (this.rendition) this.rendition.destroy(); } catch (_) {}
    try { if (this.book) this.book.destroy(); } catch (_) {}
    this.rendition = null;
    this.book = null;
    this.surface.innerHTML = "";
  }
}
window.EpubReader = EpubReader;
