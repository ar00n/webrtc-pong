import { MODE_CONFIG, PADDLE_CONFIG } from '../config/constants.js';
import { normalizeMatchSettings, resolvePaddleColor } from '../game/MatchSettings.js';
import {
  safeGetJsonItem,
  safeGetStorageItem,
  safeSetJsonItem,
  safeSetStorageItem
} from '../utils/storage.js';

export class PreferencesStore {
  #matchSettings;
  #paddleColorId;

  constructor() {
    const savedSettings = safeGetJsonItem(MODE_CONFIG.STORAGE_SETTINGS_KEY);
    this.#matchSettings = normalizeMatchSettings(savedSettings || undefined);

    const savedColorId = safeGetStorageItem(PADDLE_CONFIG.STORAGE_COLOR_KEY);
    this.#paddleColorId = resolvePaddleColor(savedColorId).id;
  }

  get matchSettings() {
    return { ...this.#matchSettings };
  }

  get paddleColorId() {
    return this.#paddleColorId;
  }

  saveMatchSettings(settings) {
    this.#matchSettings = normalizeMatchSettings(settings);
    safeSetJsonItem(MODE_CONFIG.STORAGE_SETTINGS_KEY, this.#matchSettings);
    return this.matchSettings;
  }

  savePaddleColor(colorId) {
    this.#paddleColorId = resolvePaddleColor(colorId).id;
    safeSetStorageItem(PADDLE_CONFIG.STORAGE_COLOR_KEY, this.#paddleColorId);
    return this.#paddleColorId;
  }
}
