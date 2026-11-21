import { IDENTITY_CONFIG } from '../config/constants.js';
import { safeGetStorageItem, safeSetStorageItem } from '../utils/storage.js';
import { fromBase64Url, toBase64Url } from './BinaryCodec.js';
import {
  derivePlayerId,
  derivePlayerIdBytes,
  formatPlayerTag,
  generateIdentityKeyPair,
  getShortId,
  importPrivateKey,
  importPublicKey,
  normalizeCompressedKeyB64,
  signBytes,
  verifyBytes
} from './IdentityCrypto.js';
import {
  packReceipt,
  packVouch,
  sanitizeNickname,
  unpackReceipt,
  unpackVouch
} from './RecordCodec.js';

const MAX_TRANSIENT_KEYS = 256;

export class IdentityStore {
  #identity = null;
  #myReceipts = [];
  #graphReceipts = [];
  #trustedAnchors = new Map();
  #vouches = new Map();
  #keyRing = new Map();

  get ready() {
    return this.#identity !== null;
  }

  get identity() {
    return this.#identity;
  }

  get myPlayerId() {
    return this.#identity?.playerId || '';
  }

  get myPlayerIdBytes() {
    return this.#identity?.playerIdBytes || null;
  }

  get myShortId() {
    return this.#identity?.shortId || '';
  }

  get myNickname() {
    return this.#identity?.nickname || IDENTITY_CONFIG.DEFAULT_NICKNAME;
  }

  get myDisplayTag() {
    return this.#identity
      ? formatPlayerTag(this.#identity.nickname, this.#identity.playerId)
      : 'Player#------';
  }

  get myCompressedKeyB64() {
    return this.#identity?.compressedKeyB64 || '';
  }

  get myPrivateKey() {
    return this.#identity?.privateKey || null;
  }

  get myReceipts() {
    return this.#myReceipts;
  }

  get graphReceipts() {
    return this.#graphReceipts;
  }

  get trustedAnchors() {
    return this.#trustedAnchors;
  }

  get vouches() {
    return this.#vouches;
  }

  get keyRing() {
    return this.#keyRing;
  }

  async init() {
    let loaded = false;
    try {
      const raw = safeGetStorageItem(IDENTITY_CONFIG.STORAGE_KEY);
      if (raw) {
        loaded = await this.#loadFromObject(JSON.parse(raw), { verifySignatures: false });
      }
    } catch {
      loaded = false;
    }

    if (!loaded) {
      const kp = await generateIdentityKeyPair();
      const playerIdBytes = await derivePlayerIdBytes(kp.compressedKey);
      const playerId = toBase64Url(playerIdBytes);
      this.#identity = {
        playerId,
        playerIdBytes,
        shortId: getShortId(playerId),
        nickname: IDENTITY_CONFIG.DEFAULT_NICKNAME,
        compressedKey: kp.compressedKey,
        compressedKeyB64: kp.compressedKeyB64,
        privateD: kp.privateD,
        publicKey: kp.publicKey,
        privateKey: kp.privateKey
      };
      this.#myReceipts = [];
      this.#graphReceipts = [];
      this.#trustedAnchors.clear();
      this.#vouches.clear();
      this.#keyRing.clear();
      this.#keyRing.set(playerId, kp.compressedKeyB64);
      this.persist();
    }
  }

  setNickname(rawName) {
    if (!this.#identity) return '';
    this.#identity.nickname = sanitizeNickname(rawName);
    this.persist();
    return this.#identity.nickname;
  }

  updateAnchorNicknameByKey(cleanKeyB64, cleanNickname) {
    let changed = false;
    for (const anchor of this.#trustedAnchors.values()) {
      if (anchor.compressedKeyB64 === cleanKeyB64 && anchor.nickname !== cleanNickname) {
        anchor.nickname = cleanNickname;
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
    return changed;
  }

  setKey(playerId, compressedKeyB64) {
    this.#keyRing.set(playerId, compressedKeyB64);
  }

  isTrustedAnchor(playerId) {
    return this.#trustedAnchors.has(playerId);
  }

  setTrustedAnchor(playerId, entry) {
    this.#trustedAnchors.set(playerId, entry);
  }

  deleteTrustedAnchor(playerId) {
    const existing = this.#trustedAnchors.get(playerId) || null;
    this.#trustedAnchors.delete(playerId);
    return existing;
  }

  getVouch(voucherId, subjectId) {
    return this.#vouches.get(`${voucherId}:${subjectId}`) || null;
  }

  storeVouch(vouch) {
    const key = `${vouch.parsed.voucher.id}:${vouch.parsed.subject.id}`;
    const existing = this.#vouches.get(key);
    if (!existing || vouch.parsed.timestamp > existing.parsed.timestamp) {
      this.#vouches.delete(key);
      this.#vouches.set(key, vouch);
      return true;
    }
    return false;
  }

  storeMyReceipt(receipt) {
    if (this.#myReceipts.some((r) => r.parsed.matchId === receipt.parsed.matchId)) return false;
    this.#myReceipts.unshift(receipt);
    this.#myReceipts.sort((a, b) => b.parsed.timestamp - a.parsed.timestamp);
    if (this.#myReceipts.length > IDENTITY_CONFIG.MAX_STORED_RECEIPTS) {
      this.#myReceipts.length = IDENTITY_CONFIG.MAX_STORED_RECEIPTS;
    }
    return true;
  }

  storeGraphReceipt(receipt) {
    if (this.#graphReceipts.some((r) => r.parsed.matchId === receipt.parsed.matchId)) return false;
    this.#graphReceipts.unshift(receipt);
    this.#graphReceipts.sort((a, b) => b.parsed.timestamp - a.parsed.timestamp);
    if (this.#graphReceipts.length > IDENTITY_CONFIG.MAX_STORED_RECEIPTS) {
      this.#graphReceipts.length = IDENTITY_CONFIG.MAX_STORED_RECEIPTS;
    }
    return true;
  }

  pruneKeyRing(maxTransientKeys = MAX_TRANSIENT_KEYS) {
    if (this.#keyRing.size <= maxTransientKeys) return;
    const usedIds = this.#collectUsedKeyIds();
    const transient = [];
    for (const id of this.#keyRing.keys()) {
      if (!usedIds.has(id)) {
        transient.push(id);
      }
    }
    const excess = transient.length - maxTransientKeys;
    for (let i = 0; i < excess; i++) {
      this.#keyRing.delete(transient[i]);
    }
  }

  pruneVouches(maxCap = Math.max(IDENTITY_CONFIG.MAX_SHARED_VOUCHES * 2, 100)) {
    if (this.#vouches.size <= maxCap) return;
    const myId = this.#identity?.playerId;

    const oneHopFriends = new Set();
    for (const v of this.#vouches.values()) {
      if (v.parsed.active && this.#trustedAnchors.has(v.parsed.voucher.id)) {
        oneHopFriends.add(v.parsed.subject.id);
      }
    }

    const tierFor = (v) => {
      const voucherId = v.parsed.voucher.id;
      if (voucherId === myId) return 3;
      if (this.#trustedAnchors.has(voucherId)) return 2;
      if (oneHopFriends.has(voucherId)) return 1;
      return 0;
    };

    const entries = Array.from(this.#vouches.entries()).sort(([, a], [, b]) => {
      const tierDiff = tierFor(b) - tierFor(a);
      if (tierDiff !== 0) return tierDiff;
      return b.parsed.timestamp - a.parsed.timestamp;
    });

    this.#vouches.clear();
    for (const [k, v] of entries.slice(0, maxCap)) {
      this.#vouches.set(k, v);
    }
  }

  exportBackupJson() {
    const obj = this.#serializeState();
    return obj ? JSON.stringify(obj) : '';
  }

  async importBackupJson(rawText) {
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return { ok: false, error: 'Invalid JSON backup.' };
    }

    const ok = await this.#loadFromObject(parsed, { verifySignatures: true });
    if (!ok) {
      return { ok: false, error: 'Invalid or corrupted identity keypair in backup.' };
    }

    this.persist();
    return { ok: true, displayTag: this.myDisplayTag };
  }

  persist() {
    if (!this.#identity) return;
    if (safeSetStorageItem(IDENTITY_CONFIG.STORAGE_KEY, this.exportBackupJson())) {
      return;
    }

    // Retry with trimmed cache on storage quota limits
    this.#graphReceipts.length = Math.min(this.#graphReceipts.length, 20);
    this.pruneVouches(40);
    this.pruneKeyRing();
    safeSetStorageItem(IDENTITY_CONFIG.STORAGE_KEY, this.exportBackupJson());
  }

  #collectUsedKeyIds() {
    const usedIds = new Set();
    if (this.#identity) {
      usedIds.add(this.#identity.playerId);
    }
    for (const r of this.#myReceipts) {
      usedIds.add(r.parsed.host.id);
      usedIds.add(r.parsed.guest.id);
    }
    for (const r of this.#graphReceipts) {
      usedIds.add(r.parsed.host.id);
      usedIds.add(r.parsed.guest.id);
    }
    for (const id of this.#trustedAnchors.keys()) {
      usedIds.add(id);
    }
    for (const v of this.#vouches.values()) {
      usedIds.add(v.parsed.voucher.id);
      usedIds.add(v.parsed.subject.id);
    }
    return usedIds;
  }

  #serializeState() {
    if (!this.#identity) return null;

    const usedIds = this.#collectUsedKeyIds();
    const keys = {};
    for (const id of usedIds) {
      const k = this.#keyRing.get(id);
      if (k) keys[id] = k;
    }

    return {
      v: 2,
      id: {
        k: this.#identity.compressedKeyB64,
        d: this.#identity.privateD,
        n: this.#identity.nickname
      },
      keys,
      r: this.#myReceipts.map(packReceipt),
      g: this.#graphReceipts.map(packReceipt),
      a: Array.from(this.#trustedAnchors.values()).map((a) => [a.playerId, a.nickname, a.addedAt]),
      vo: Array.from(this.#vouches.values()).map(packVouch)
    };
  }

  async #loadFromObject(data, { verifySignatures }) {
    if (!data || data.v !== 2 || !data.id) return false;

    const compKeyB64 = normalizeCompressedKeyB64(data.id.k);
    if (!compKeyB64 || typeof data.id.d !== 'string') return false;

    let nextIdentity;
    try {
      const compressedKey = fromBase64Url(compKeyB64);
      const publicKey = await importPublicKey(compressedKey);
      const privateKey = await importPrivateKey(compressedKey, data.id.d);

      const probe = new Uint8Array([1, 2, 3, 4]);
      const sig = await signBytes(privateKey, probe);
      const valid = await verifyBytes(compKeyB64, probe, sig);
      if (!valid) return false;

      const playerIdBytes = await derivePlayerIdBytes(compressedKey);
      const playerId = toBase64Url(playerIdBytes);
      nextIdentity = {
        playerId,
        playerIdBytes,
        shortId: getShortId(playerId),
        nickname: sanitizeNickname(data.id.n),
        compressedKey,
        compressedKeyB64: compKeyB64,
        privateD: data.id.d,
        publicKey,
        privateKey
      };
    } catch {
      return false;
    }

    const nextMyReceipts = [];
    const nextGraphReceipts = [];
    const nextTrustedAnchors = new Map();
    const nextVouches = new Map();
    const nextKeyRing = new Map();
    nextKeyRing.set(nextIdentity.playerId, nextIdentity.compressedKeyB64);

    if (data.keys && typeof data.keys === 'object') {
      for (const [id, kB64] of Object.entries(data.keys)) {
        if (id === nextIdentity.playerId) continue;
        const cleanKey = normalizeCompressedKeyB64(kB64);
        if (!cleanKey) continue;
        if (verifySignatures) {
          const derived = await derivePlayerId(cleanKey);
          if (derived !== id) continue;
        }
        nextKeyRing.set(id, cleanKey);
      }
    }

    if (Array.isArray(data.a)) {
      for (const entry of data.a) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const [id, nick, addedAt] = entry;
        if (typeof id !== 'string') continue;
        const compKey = nextKeyRing.get(id);
        if (!compKey || id === nextIdentity.playerId) continue;
        nextTrustedAnchors.set(id, {
          playerId: id,
          shortId: getShortId(id),
          nickname: sanitizeNickname(nick),
          compressedKeyB64: compKey,
          addedAt: Number.isFinite(addedAt) && addedAt >= 0 ? addedAt : Date.now()
        });
      }
    }

    const decodeStoredReceipt = async (b64) => {
      const receipt = unpackReceipt(b64);
      if (!receipt) return null;
      if (verifySignatures) {
        const hKey = nextKeyRing.get(receipt.parsed.host.id);
        const gKey = nextKeyRing.get(receipt.parsed.guest.id);
        if (!hKey || !gKey) return null;
        const [vh, vg] = await Promise.all([
          verifyBytes(hKey, receipt.bodyBytes, receipt.hostSigBytes),
          verifyBytes(gKey, receipt.bodyBytes, receipt.guestSigBytes)
        ]);
        if (!vh || !vg) return null;
      }
      return receipt;
    };

    const insertReceipt = (list, receipt) => {
      if (list.some((r) => r.parsed.matchId === receipt.parsed.matchId)) return;
      list.unshift(receipt);
      list.sort((a, b) => b.parsed.timestamp - a.parsed.timestamp);
      if (list.length > IDENTITY_CONFIG.MAX_STORED_RECEIPTS) {
        list.length = IDENTITY_CONFIG.MAX_STORED_RECEIPTS;
      }
    };

    if (Array.isArray(data.r)) {
      for (const b64 of data.r.slice(0, IDENTITY_CONFIG.MAX_STORED_RECEIPTS)) {
        const receipt = await decodeStoredReceipt(b64);
        if (
          receipt &&
          (receipt.parsed.host.id === nextIdentity.playerId ||
            receipt.parsed.guest.id === nextIdentity.playerId)
        ) {
          insertReceipt(nextMyReceipts, receipt);
        }
      }
    }

    if (Array.isArray(data.g)) {
      for (const b64 of data.g.slice(0, IDENTITY_CONFIG.MAX_STORED_RECEIPTS)) {
        const receipt = await decodeStoredReceipt(b64);
        if (receipt) insertReceipt(nextGraphReceipts, receipt);
      }
    }

    const maxImportVouches = Math.max(IDENTITY_CONFIG.MAX_SHARED_VOUCHES * 4, 200);
    if (Array.isArray(data.vo)) {
      for (const b64 of data.vo.slice(0, maxImportVouches)) {
        const vouch = unpackVouch(b64);
        if (!vouch) continue;

        if (verifySignatures) {
          const vKey = nextKeyRing.get(vouch.parsed.voucher.id);
          if (!vKey) continue;
          const valid = await verifyBytes(vKey, vouch.bodyBytes, vouch.sigBytes);
          if (!valid) continue;
        }

        const vKey = `${vouch.parsed.voucher.id}:${vouch.parsed.subject.id}`;
        const existing = nextVouches.get(vKey);
        if (!existing || vouch.parsed.timestamp > existing.parsed.timestamp) {
          nextVouches.delete(vKey);
          nextVouches.set(vKey, vouch);
        }
      }
    }

    this.#identity = nextIdentity;
    this.#myReceipts = nextMyReceipts;
    this.#graphReceipts = nextGraphReceipts;
    this.#trustedAnchors = nextTrustedAnchors;
    this.#vouches = nextVouches;
    this.#keyRing = nextKeyRing;
    this.pruneVouches();
    this.pruneKeyRing();

    return true;
  }
}
