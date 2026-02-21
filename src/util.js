const storage = chrome.storage.session || chrome.storage.local

function debounce(fn, ms = 50) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export async function storedSet(key) {
  const got = await new Promise(res => storage.get({ [key]: [] }, v => res(v[key] || [])));
  const inner = new Set(got);
  const save = debounce(() => storage.set({ [key]: Array.from(inner) }));
  return {
    get size() { return inner.size; },
    has(v) { return inner.has(v); },
    add(v) {
      const n0 = inner.size;
      inner.add(v);
      if (inner.size !== n0) {
        save();
      }
      return this;
    },
    delete(v) {
      const ok = inner.delete(v);
      if (ok) {
        save();
      }
      return ok;
    },
    clear() {
      if (inner.size) {
        inner.clear();
        save();
      }
    },
    values() { return inner.values(); },
    [Symbol.iterator]() { return inner[Symbol.iterator](); },
    toJSON() { return Array.from(inner); }
  };
}

export async function storedMap(key) {
  const got = await new Promise(res => storage.get({ [key]: {} }, v => res(v[key] || {})));
  const inner = new Map(Object.entries(got).map(([k, v]) => [isFinite(+k) ? +k : k, v]));
  const save = debounce(() => {
    const obj = {};
    for (const [k, v] of inner) {
      obj[k] = v;
    }
    storage.set({ [key]: obj });
  });
  return {
    get size() { return inner.size; },
    has(k) { return inner.has(k); },
    get(k) { return inner.get(k); },
    set(k, v) {
      inner.set(k, v);
      save();
      return this;
    },
    delete(k) {
      const ok = inner.delete(k);
      if (ok) {
        save();
      }
      return ok;
    },
    clear() {
      if (inner.size) {
        inner.clear();
        save();
      }
    },
    keys() { return inner.keys(); },
    values() { return inner.values(); },
    entries() { return inner.entries(); },
    [Symbol.iterator]() { return inner[Symbol.iterator](); },
    toObject() {
      const o = {};
      for (const [k, v] of inner) {
        o[k] = v;
      }
      return o;
    }
  };
}
