/* ===================================================================
   storage.js — IndexedDB persistence for the library and progress.

   Two object stores:
     books     { id, type, title, author, cover, file(Blob),
                 fileName, size, addedAt, lastOpened }
     progress  { id, percentage, mode, cfi, page, scrollRatio, updatedAt }
   =================================================================== */
window.DB = (() => {
  const NAME = "readerx";
  const VERSION = 1;
  let connection = null;

  function conn() {
    if (connection) return connection;
    connection = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("books")) {
          db.createObjectStore("books", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("progress")) {
          db.createObjectStore("progress", { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return connection;
  }

  /** Resolve a single object store, ready for a request. */
  async function store(name, mode) {
    const db = await conn();
    return db.transaction(name, mode).objectStore(name);
  }

  /** Wrap an IDBRequest as a promise. */
  function wrap(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  return {
    async addBook(record) {
      return wrap((await store("books", "readwrite")).put(record));
    },
    async getBook(id) {
      return wrap((await store("books", "readonly")).get(id));
    },
    async allBooks() {
      return wrap((await store("books", "readonly")).getAll());
    },
    /** Read-modify-write a book record (two transactions — keeps it simple). */
    async updateBook(id, patch) {
      const record = await this.getBook(id);
      if (!record) return;
      Object.assign(record, patch);
      return this.addBook(record);
    },
    async deleteBook(id) {
      await wrap((await store("books", "readwrite")).delete(id));
      try {
        await wrap((await store("progress", "readwrite")).delete(id));
      } catch (_) {
        /* no progress stored — fine */
      }
    },
    async saveProgress(id, progress) {
      const record = Object.assign({ id }, progress, { updatedAt: Date.now() });
      return wrap((await store("progress", "readwrite")).put(record));
    },
    async getProgress(id) {
      return wrap((await store("progress", "readonly")).get(id));
    },
  };
})();
