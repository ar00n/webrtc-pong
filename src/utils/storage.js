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
  } catch {
    // Ignore storage quota or private browsing errors
  }
}
