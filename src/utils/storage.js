export function safeGetStorageItem(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSetStorageItem(key, value) {
  try {
    localStorage.setItem(key, String(value));
    return true;
  } catch {
    return false;
  }
}

export function safeGetJsonItem(key) {
  const raw = safeGetStorageItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function safeSetJsonItem(key, value) {
  try {
    return safeSetStorageItem(key, JSON.stringify(value));
  } catch {
    return false;
  }
}
