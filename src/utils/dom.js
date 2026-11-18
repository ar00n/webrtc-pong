const flashTimers = new WeakMap();

export function flashButtonLabel(button, label, durationMs = 1400) {
  const existing = flashTimers.get(button);
  if (existing) {
    clearTimeout(existing.timerId);
  } else {
    flashTimers.set(button, { originalText: button.textContent, timerId: null });
  }

  const entry = flashTimers.get(button);
  button.textContent = label;
  entry.timerId = setTimeout(() => {
    button.textContent = entry.originalText;
    flashTimers.delete(button);
  }, durationMs);
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function isEditableElement(element) {
  if (!element) return false;
  const tag = element.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    element.isContentEditable
  );
}
