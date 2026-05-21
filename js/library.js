/* ===================================================================
   library.js — the book library: import, metadata, grid, search, sort.
   =================================================================== */
window.Library = (() => {
  const grid = document.getElementById("lib-grid");
  const empty = document.getElementById("lib-empty");

  let books = [];
  let progressMap = {};
  let query = "";
  let sortMode = "recent"; // recent | title | added
  let onOpen = () => {};

  /* ----------------------------- data ----------------------------- */
  async function refresh() {
    books = (await DB.allBooks()) || [];
    const progs = await Promise.all(
      books.map((b) => DB.getProgress(b.id).catch(() => null))
    );
    progressMap = {};
    progs.forEach((p) => { if (p) progressMap[p.id] = p; });
    render();
  }

  function filtered() {
    let list = books.slice();
    if (query) {
      const q = query.toLowerCase();
      list = list.filter(
        (b) =>
          (b.title || "").toLowerCase().includes(q) ||
          (b.author || "").toLowerCase().includes(q)
      );
    }
    if (sortMode === "title") {
      list.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    } else if (sortMode === "added") {
      list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    } else {
      list.sort(
        (a, b) =>
          (b.lastOpened || 0) - (a.lastOpened || 0) ||
          (b.addedAt || 0) - (a.addedAt || 0)
      );
    }
    return list;
  }

  /* ---------------------------- rendering -------------------------- */
  function render() {
    grid.innerHTML = "";
    if (!books.length) {
      empty.classList.remove("hidden");
      grid.classList.add("hidden");
      return;
    }
    empty.classList.add("hidden");
    grid.classList.remove("hidden");

    const visible = filtered();
    if (!visible.length) {
      const p = document.createElement("p");
      p.className = "grid-empty";
      p.textContent = 'No books match “' + query + '”.';
      grid.appendChild(p);
      return;
    }
    const frag = document.createDocumentFragment();
    visible.forEach((b, i) => frag.appendChild(cardEl(b, i)));
    grid.appendChild(frag);
  }

  function cardEl(book, index) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = book.id;
    card.style.animationDelay = Math.min(index * 26, 380) + "ms";

    const prog = progressMap[book.id];
    const pct = prog ? Math.round((prog.percentage || 0) * 100) : 0;

    const cover = document.createElement("div");
    cover.className = "card__cover";
    if (book.cover) {
      const img = document.createElement("img");
      img.src = book.cover;
      img.alt = "";
      img.loading = "lazy";
      cover.appendChild(img);
    } else {
      cover.classList.add("card__cover--gen");
      cover.style.background = gradientFor(book.title || book.fileName || "?");
      const t = document.createElement("div");
      t.className = "gen__title";
      t.textContent = book.title || "Untitled";
      const a = document.createElement("div");
      a.className = "gen__author";
      a.textContent = book.author || "";
      cover.appendChild(t);
      cover.appendChild(a);
    }

    const badge = document.createElement("span");
    badge.className = "card__badge";
    badge.textContent = (book.type || "").toUpperCase();
    cover.appendChild(badge);

    const del = document.createElement("button");
    del.className = "card__del";
    del.dataset.act = "del";
    del.title = "Remove from library";
    del.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M6 7h12M9 7V5h6v2M10 11v6M14 11v6M6 7l1 13h10l1-13"/></svg>';
    cover.appendChild(del);

    if (pct > 0) {
      const bar = document.createElement("div");
      bar.className = "card__bar";
      const span = document.createElement("span");
      span.style.width = pct + "%";
      bar.appendChild(span);
      cover.appendChild(bar);
    }

    const meta = document.createElement("div");
    meta.className = "card__meta";
    const title = document.createElement("div");
    title.className = "card__title";
    title.textContent = book.title || "Untitled";
    const sub = document.createElement("div");
    sub.className = "card__author";
    sub.textContent = book.author
      ? book.author
      : pct > 0
      ? pct + "% read"
      : "Not started";
    meta.appendChild(title);
    meta.appendChild(sub);

    card.appendChild(cover);
    card.appendChild(meta);
    return card;
  }

  function gradientFor(str) {
    const palettes = [
      ["#6c5ce7", "#a29bfe"], ["#0984e3", "#74b9ff"],
      ["#00b894", "#55efc4"], ["#e17055", "#fab1a0"],
      ["#d63031", "#ff7675"], ["#e84393", "#fd79a8"],
      ["#00897b", "#4db6ac"], ["#5f27cd", "#7d5fff"],
    ];
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    const p = palettes[h % palettes.length];
    return "linear-gradient(150deg," + p[0] + "," + p[1] + ")";
  }

  /* ----------------------------- import ---------------------------- */
  function detectType(file) {
    const name = (file.name || "").toLowerCase();
    if (name.endsWith(".epub") || file.type === "application/epub+zip") return "epub";
    if (name.endsWith(".pdf") || file.type === "application/pdf") return "pdf";
    return null;
  }

  async function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    App.toast(
      files.length > 1 ? "Adding " + files.length + " files…" : "Adding book…",
      true
    );

    let added = 0;
    for (const file of files) {
      const type = detectType(file);
      if (!type) {
        App.toast('Skipped “' + file.name + '” — not an EPUB or PDF');
        continue;
      }
      try {
        const meta =
          type === "epub"
            ? await extractEpubMeta(file)
            : await extractPdfMeta(file);
        const record = {
          id: uid(),
          type: type,
          title: meta.title,
          author: meta.author,
          cover: meta.cover,
          file: file,
          fileName: file.name,
          size: file.size,
          addedAt: Date.now(),
          lastOpened: 0,
        };
        await DB.addBook(record);
        added++;
      } catch (e) {
        console.error("Import failed:", file.name, e);
        App.toast('Could not read “' + file.name + '”');
      }
    }

    await refresh();
    if (added) {
      App.toast(added > 1 ? added + " books added" : "Book added");
    }
  }

  function uid() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : "b-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
  }

  async function extractEpubMeta(file) {
    const buffer = await file.arrayBuffer();
    const book = ePub(buffer);
    let title = file.name.replace(/\.epub$/i, "");
    let author = "";
    try {
      await book.ready;
      const m = await book.loaded.metadata;
      if (m && m.title) title = m.title;
      if (m && m.creator) author = m.creator;
    } catch (_) {}
    let cover = null;
    try {
      const url = await book.coverUrl();
      if (url) {
        cover = await imageUrlToThumb(url);
        URL.revokeObjectURL(url);
      }
    } catch (_) {}
    // Destroy late: epub.js still has async resource work in flight right
    // after coverUrl(), and tearing down mid-flight logs noisy errors.
    setTimeout(() => { try { book.destroy(); } catch (_) {} }, 3000);
    return { title: title, author: author, cover: cover };
  }

  async function extractPdfMeta(file) {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    let title = file.name.replace(/\.pdf$/i, "");
    let author = "";
    try {
      const info = (await pdf.getMetadata()).info;
      if (info && info.Title && info.Title.trim()) title = info.Title.trim();
      if (info && info.Author && info.Author.trim()) author = info.Author.trim();
    } catch (_) {}
    let cover = null;
    try { cover = await renderPdfThumb(pdf); } catch (_) {}
    try { pdf.destroy(); } catch (_) {}
    return { title: title, author: author, cover: cover };
  }

  function imageUrlToThumb(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 400 / (img.width || 400));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round((img.width || 400) * scale));
        c.height = Math.max(1, Math.round((img.height || 600) * scale));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        try { resolve(c.toDataURL("image/jpeg", 0.82)); }
        catch (_) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  async function renderPdfThumb(pdf) {
    const page = await pdf.getPage(1);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 400 / v1.width });
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    try { return c.toDataURL("image/jpeg", 0.82); }
    catch (_) { return null; }
  }

  /* --------------------------- interaction ------------------------- */
  function onGridClick(e) {
    const card = e.target.closest(".card");
    if (!card) return;
    const id = card.dataset.id;
    if (e.target.closest('[data-act="del"]')) {
      remove(id);
      return;
    }
    onOpen(id);
  }

  async function remove(id) {
    const book = books.find((b) => b.id === id);
    if (!book) return;
    if (!confirm('Remove “' + (book.title || "this book") + '” from your library?')) return;
    await DB.deleteBook(id);
    await refresh();
    App.toast("Book removed");
  }

  function cycleSort() {
    const order = ["recent", "title", "added"];
    sortMode = order[(order.indexOf(sortMode) + 1) % order.length];
    render();
    return sortLabel();
  }

  function sortLabel() {
    return sortMode === "recent"
      ? "Recent"
      : sortMode === "title"
      ? "Title A–Z"
      : "Date added";
  }

  /* ------------------------------ api ------------------------------ */
  return {
    async init() {
      grid.addEventListener("click", onGridClick);
      await refresh();
    },
    refresh,
    importFiles,
    cycleSort,
    sortLabel,
    setQuery(q) {
      query = q.trim();
      render();
    },
    setOnOpen(fn) {
      onOpen = fn;
    },
  };
})();
