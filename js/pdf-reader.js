/* ===================================================================
   pdf-reader.js — PDF rendering via pdf.js.

   Paginated mode renders one fitted page to a canvas.
   Scroll mode lays out one holder per page and renders them lazily
   with an IntersectionObserver (infinite loading), unloading pages
   that scroll far away to keep memory in check.

   Implements the same interface as EpubReader.
   =================================================================== */
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
}

class PdfReader {
  constructor(surface) {
    this.surface = surface;
    this.type = "pdf";
    this.pdf = null;
    this.numPages = 0;
    this.aspect = 1.4142;

    this.mode = "paginated";
    this.theme = "light";
    this.zoom = 1;

    this.page = 1;
    this.currentPage = 1;
    this._restoreRatio = 0;

    this.holders = null;
    this.io = null;
    this._pagedTask = null;

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
    this.zoom = opts.zoom || 1;

    const data = new Uint8Array(await blob.arrayBuffer());
    this.pdf = await pdfjsLib.getDocument({ data }).promise;
    this.numPages = this.pdf.numPages;

    const first = await this.pdf.getPage(1);
    const v = first.getViewport({ scale: 1 });
    this.aspect = v.height / v.width;

    const loc = opts.location || {};
    this.page = Math.min(Math.max(1, loc.page || 1), this.numPages);
    this.currentPage = this.page;
    this._restoreRatio = loc.scrollRatio || 0;

    this.setTheme(this.theme);

    this._resizeHandler = this._debounce(() => {
      if (!this.pdf) return;
      if (this.mode === "scroll") this._rebuild();
      else this._renderPagedPage(null);
    }, 220);
    window.addEventListener("resize", this._resizeHandler);

    await this._build();
    this.onReady({ title: null });
    this.onLocations();
    return { title: null };
  }

  /* ---------------------------- building --------------------------- */
  async _build() {
    this._teardownView();
    if (this.mode === "scroll") await this._buildScroll();
    else await this._buildPaged();
    this._emitProgress();
  }

  async _rebuild() {
    const pos = this.getState();
    this.page = pos.page;
    this._restoreRatio = pos.scrollRatio || 0;
    await this._build();
  }

  async _buildPaged() {
    const cont = document.createElement("div");
    cont.className = "pdf-paged";
    const stage = document.createElement("div");
    stage.className = "pdf-stage";
    const canvas = document.createElement("canvas");
    stage.appendChild(canvas);
    cont.appendChild(stage);
    this.surface.appendChild(cont);

    this.pagedContainer = cont;
    this.pagedStage = stage;
    this.pagedCanvas = canvas;

    cont.addEventListener("click", (e) => this._pagedClick(e));
    this._wireSwipe(cont);

    await this._renderPagedPage(null);
  }

  async _renderPagedPage(dir) {
    const n = this.page;
    if (this._pagedTask) {
      try { this._pagedTask.cancel(); } catch (_) {}
      this._pagedTask = null;
    }
    let page;
    try { page = await this.pdf.getPage(n); } catch (_) { return; }
    if (n !== this.page || !this.pagedCanvas) return;

    const vp1 = page.getViewport({ scale: 1 });
    const cont = this.pagedContainer;
    const availW = Math.max(80, cont.clientWidth - 48);
    const availH = Math.max(80, cont.clientHeight - 48);
    const fit = Math.min(availW / vp1.width, availH / vp1.height);
    const cssScale = Math.max(0.05, fit * this.zoom);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: cssScale * dpr });

    const canvas = this.pagedCanvas;
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = Math.floor(vp1.width * cssScale) + "px";
    canvas.style.height = Math.floor(vp1.height * cssScale) + "px";

    const task = page.render({ canvasContext: canvas.getContext("2d"), viewport: vp });
    this._pagedTask = task;
    try { await task.promise; } catch (_) { return; }
    this._pagedTask = null;

    if (dir) {
      this.pagedStage.classList.remove("turn-next", "turn-prev");
      void this.pagedStage.offsetWidth;
      this.pagedStage.classList.add(dir === "prev" ? "turn-prev" : "turn-next");
    }
    this._emitProgress();
  }

  async _buildScroll() {
    const cont = document.createElement("div");
    cont.className = "pdf-scroll";
    this.surface.appendChild(cont);
    this.scrollContainer = cont;
    this.holders = [];

    const baseW = Math.min(820, Math.floor(window.innerWidth * 0.94));
    const w = Math.floor(baseW * this.zoom);

    for (let n = 1; n <= this.numPages; n++) {
      const holder = document.createElement("div");
      holder.className = "pdf-holder";
      holder.dataset.page = String(n);
      holder.style.width = w + "px";
      holder.style.height = Math.floor(w * this.aspect) + "px";
      const tag = document.createElement("div");
      tag.className = "pdf-holder__num";
      tag.textContent = String(n);
      holder.appendChild(tag);
      cont.appendChild(holder);
      this.holders.push(holder);
    }

    this.io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) this._renderHolder(en.target);
        else this._unloadHolder(en.target);
      }
    }, { root: cont, rootMargin: "1400px 0px" });
    this.holders.forEach((h) => this.io.observe(h));

    this._scrollHandler = this._debounce(() => this._onScroll(), 90);
    cont.addEventListener("scroll", this._scrollHandler, { passive: true });
    cont.addEventListener("click", () => this.onToggleChrome());

    const holder = this.holders[Math.min(this.page, this.numPages) - 1];
    if (holder) {
      cont.scrollTop = holder.offsetTop + (this._restoreRatio || 0) * holder.offsetHeight;
      this.currentPage = this.page;
      await this._renderHolder(holder);
    }
  }

  async _renderHolder(holder) {
    if (!holder || holder.dataset.rendered === "1" || holder._rendering) return;
    holder._rendering = true;
    const n = parseInt(holder.dataset.page, 10);
    let page;
    try { page = await this.pdf.getPage(n); }
    catch (_) { holder._rendering = false; return; }
    if (!this.scrollContainer || !holder.isConnected) {
      holder._rendering = false;
      return;
    }

    const vp1 = page.getViewport({ scale: 1 });
    const cssW = parseFloat(holder.style.width);
    holder.style.height = Math.round(cssW * vp1.height / vp1.width) + "px";
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: (cssW / vp1.width) * dpr });

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const task = page.render({ canvasContext: canvas.getContext("2d"), viewport: vp });
    holder._task = task;
    try { await task.promise; }
    catch (_) { holder._rendering = false; return; }
    holder._task = null;
    holder._rendering = false;

    if (!holder.isConnected) return;
    holder.insertBefore(canvas, holder.querySelector(".pdf-holder__num"));
    holder.dataset.rendered = "1";
  }

  _unloadHolder(holder) {
    if (holder._task) {
      try { holder._task.cancel(); } catch (_) {}
      holder._task = null;
    }
    if (holder.dataset.rendered !== "1") return;
    const c = holder.querySelector("canvas");
    if (c) c.remove();
    holder.dataset.rendered = "0";
    holder._rendering = false;
  }

  _onScroll() {
    const cont = this.scrollContainer;
    if (!cont || !this.holders) return;
    const probe = cont.scrollTop + cont.clientHeight * 0.35;
    for (const h of this.holders) {
      if (h.offsetTop <= probe && probe < h.offsetTop + h.offsetHeight) {
        this.currentPage = parseInt(h.dataset.page, 10);
        break;
      }
    }
    this._emitProgress();
  }

  /* ---------------------------- interaction ------------------------ */
  _pagedClick(e) {
    const rect = this.pagedContainer.getBoundingClientRect();
    const w = rect.width || 1;
    const x = e.clientX - rect.left;
    if (x < w * 0.3) this.prev();
    else if (x > w * 0.7) this.next();
    else this.onToggleChrome();
  }

  _wireSwipe(el) {
    let sx = 0, sy = 0, st = 0;
    el.addEventListener("touchstart", (e) => {
      const t = e.changedTouches[0];
      sx = t.clientX; sy = t.clientY; st = Date.now();
    }, { passive: true });
    el.addEventListener("touchend", (e) => {
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Date.now() - st < 600 && Math.abs(dx) > 45 &&
          Math.abs(dx) > Math.abs(dy) * 1.8) {
        dx < 0 ? this.next() : this.prev();
      }
    }, { passive: true });
  }

  next() {
    if (this.mode === "scroll") {
      if (this.scrollContainer) {
        this.scrollContainer.scrollBy({ top: this.scrollContainer.clientHeight * 0.9, behavior: "smooth" });
      }
    } else if (this.page < this.numPages) {
      this.page++;
      this._renderPagedPage("next");
    }
  }

  prev() {
    if (this.mode === "scroll") {
      if (this.scrollContainer) {
        this.scrollContainer.scrollBy({ top: -this.scrollContainer.clientHeight * 0.9, behavior: "smooth" });
      }
    } else if (this.page > 1) {
      this.page--;
      this._renderPagedPage("prev");
    }
  }

  async setMode(mode) {
    if (mode === this.mode) return;
    const pos = this.getState();
    this.mode = mode;
    this.page = pos.page;
    this._restoreRatio = pos.scrollRatio || 0;
    await this._build();
  }

  setTheme(theme) {
    this.theme = theme;
    if (theme === "light") this.surface.removeAttribute("data-pdf-theme");
    else this.surface.setAttribute("data-pdf-theme", theme);
  }

  async setSize(dir) {
    this.zoom = Math.max(0.5, Math.min(3, +(this.zoom + dir * 0.15).toFixed(2)));
    await this._rebuild();
    return Math.round(this.zoom * 100);
  }

  goToPercent(p) {
    p = Math.max(0, Math.min(1, p));
    if (this.mode === "scroll") {
      const cont = this.scrollContainer;
      if (cont) cont.scrollTop = p * (cont.scrollHeight - cont.clientHeight);
    } else {
      this.page = Math.max(1, Math.min(this.numPages, Math.round(p * (this.numPages - 1)) + 1));
      this._renderPagedPage(null);
    }
  }

  _emitProgress() {
    let pct, label;
    if (this.mode === "scroll" && this.scrollContainer) {
      const cont = this.scrollContainer;
      const max = cont.scrollHeight - cont.clientHeight;
      pct = max > 0 ? cont.scrollTop / max : 0;
      label = "Page " + this.currentPage + " of " + this.numPages;
    } else {
      pct = this.numPages > 1 ? (this.page - 1) / (this.numPages - 1) : 0;
      label = "Page " + this.page + " of " + this.numPages;
    }
    pct = Math.max(0, Math.min(1, pct));
    this.onProgress({ percentage: pct, label: label });
  }

  /* --------------------------- contents ---------------------------- */
  async getToc() {
    try {
      const outline = await this.pdf.getOutline();
      if (!outline || !outline.length) return [];
      const flat = [];
      const walk = async (items, level) => {
        for (const it of items) {
          let page = null;
          try {
            let dest = it.dest;
            if (typeof dest === "string") dest = await this.pdf.getDestination(dest);
            if (Array.isArray(dest) && dest[0]) {
              page = (await this.pdf.getPageIndex(dest[0])) + 1;
            }
          } catch (_) {}
          flat.push({
            label: (it.title || "").replace(/\s+/g, " ").trim() || "Untitled",
            target: page,
            level: level,
          });
          if (it.items && it.items.length) await walk(it.items, level + 1);
        }
      };
      await walk(outline, 0);
      return flat;
    } catch (_) {
      return [];
    }
  }

  goToToc(page) {
    if (typeof page !== "number") return;
    page = Math.max(1, Math.min(this.numPages, page));
    if (this.mode === "scroll") {
      const holder = this.holders && this.holders[page - 1];
      if (holder && this.scrollContainer) {
        this.scrollContainer.scrollTop = holder.offsetTop;
        this.currentPage = page;
        this._emitProgress();
      }
    } else {
      this.page = page;
      this._renderPagedPage(null);
    }
  }

  /** Index of the last TOC entry at or before the current page, or -1. */
  markActiveToc(toc) {
    const cur = this.mode === "scroll" ? this.currentPage : this.page;
    let found = -1;
    for (let i = 0; i < toc.length; i++) {
      if (typeof toc[i].target === "number" && toc[i].target <= cur) found = i;
    }
    return found;
  }

  getState() {
    if (this.mode === "scroll" && this.scrollContainer) {
      const cont = this.scrollContainer;
      const max = cont.scrollHeight - cont.clientHeight;
      const pct = max > 0 ? cont.scrollTop / max : 0;
      let frac = 0;
      const holder = this.holders && this.holders[this.currentPage - 1];
      if (holder) {
        frac = (cont.scrollTop - holder.offsetTop) / (holder.offsetHeight || 1);
      }
      return {
        percentage: Math.max(0, Math.min(1, pct)),
        page: this.currentPage,
        scrollRatio: Math.max(0, Math.min(1, frac)),
      };
    }
    const pct = this.numPages > 1 ? (this.page - 1) / (this.numPages - 1) : 0;
    return { percentage: pct, page: this.page, scrollRatio: 0 };
  }

  _teardownView() {
    if (this.io) { try { this.io.disconnect(); } catch (_) {} this.io = null; }
    if (this._pagedTask) { try { this._pagedTask.cancel(); } catch (_) {} this._pagedTask = null; }
    if (this.holders) {
      this.holders.forEach((h) => {
        if (h._task) { try { h._task.cancel(); } catch (_) {} }
      });
    }
    this.holders = null;
    this.scrollContainer = null;
    this.pagedContainer = this.pagedStage = this.pagedCanvas = null;
    this.surface.innerHTML = "";
  }

  destroy() {
    this._teardownView();
    if (this._resizeHandler) window.removeEventListener("resize", this._resizeHandler);
    try { if (this.pdf) this.pdf.destroy(); } catch (_) {}
    this.pdf = null;
    this.surface.removeAttribute("data-pdf-theme");
  }

  _debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }
}
window.PdfReader = PdfReader;
