export class LspDiagnosticsBroker {
  constructor() {
    this.cache = new Map();
    this.waiters = new Map();
  }

  publish(params = {}) {
    if (!params.uri) return;
    const entry = {
      uri: params.uri,
      version: Number.isInteger(params.version) ? params.version : null,
      diagnostics: Array.isArray(params.diagnostics) ? params.diagnostics : [],
      collectedAt: new Date().toISOString()
    };
    const current = this.cache.get(params.uri);
    if (
      current &&
      current.version !== null &&
      entry.version !== null &&
      entry.version < current.version
    ) {
      return;
    }
    this.cache.set(params.uri, entry);
    const waiters = this.waiters.get(params.uri) || [];
    for (const waiter of waiters) {
      if (entry.version === null || entry.version >= waiter.minimumVersion) {
        clearTimeout(waiter.timer);
        waiter.resolve(entry);
      }
    }
    this.waiters.set(
      params.uri,
      waiters.filter((waiter) =>
        entry.version !== null && entry.version < waiter.minimumVersion
      )
    );
  }

  latest(uri) {
    return this.cache.get(uri) || null;
  }

  waitFor(uri, minimumVersion, timeoutMs) {
    const cached = this.latest(uri);
    if (cached && (cached.version === null || cached.version >= minimumVersion)) {
      return Promise.resolve(cached);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        minimumVersion,
        resolve,
        reject,
        timer: setTimeout(() => {
          const waiters = this.waiters.get(uri) || [];
          this.waiters.set(uri, waiters.filter((candidate) => candidate !== waiter));
          resolve(null);
        }, timeoutMs)
      };
      const waiters = this.waiters.get(uri) || [];
      waiters.push(waiter);
      this.waiters.set(uri, waiters);
    });
  }

  clear(uri) {
    this.cache.delete(uri);
    const waiters = this.waiters.get(uri) || [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.waiters.delete(uri);
  }

  clearAll() {
    for (const uri of new Set([...this.cache.keys(), ...this.waiters.keys()])) {
      this.clear(uri);
    }
  }

  abort(error) {
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.waiters.clear();
    this.cache.clear();
  }
}
