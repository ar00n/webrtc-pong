import { joinRoom } from 'trystero';
import { NETWORK_CONFIG } from '../config/constants.js';
import { EventEmitter } from '../utils/EventEmitter.js';
import { MSG_TYPE, getAppId, isSequencedMessage } from './protocol.js';

export class NetworkManager extends EventEmitter {
  #room = null;
  #syncAction = null;
  #roomCode = '';
  #myUserId = '';
  #remoteUserId = null;
  #isHost = false;
  #connected = false;
  #connectionLost = false;
  #lastRemoteMsgTime = 0;

  #sendSeq = 0;
  #recvSeq = -1;
  #pingIntervalId = null;
  #halfRtt = NETWORK_CONFIG.DEFAULT_HALF_RTT;
  #abortController = new AbortController();

  constructor() {
    super();
    this.#bindOnlineEvents();
  }

  get inRoom() {
    return this.#room !== null;
  }

  get roomCode() {
    return this.#roomCode;
  }

  get myUserId() {
    return this.#myUserId;
  }

  get isHost() {
    return this.#isHost;
  }

  get connected() {
    return this.#connected;
  }

  get connectionLost() {
    return this.#connectionLost;
  }

  get halfRtt() {
    return this.#halfRtt;
  }

  get rttMs() {
    return Math.round(this.#halfRtt * 2000);
  }

  async connect(code, hostMode) {
    await this.disconnect();

    this.#roomCode = code;
    this.#isHost = hostMode;

    const room = joinRoom(
      { appId: getAppId(), maxUsers: NETWORK_CONFIG.MAX_USERS, identity: 'none' },
      code
    );
    this.#room = room;

    const self = await room.getSelf();
    // Guard against disconnect() having been called while awaiting getSelf()
    if (this.#room !== room) return;

    this.#myUserId = self.userId;
    this.#syncAction = room.makeAction('sync');

    room.onUserJoin(({ userId }) => {
      if (this.#remoteUserId && this.#remoteUserId !== userId) return;

      this.#remoteUserId = userId;
      this.#connected = true;
      this.#connectionLost = false;
      this.#lastRemoteMsgTime = performance.now();
      this.#recvSeq = -1;
      this.#sendSeq = 0;
      this.#halfRtt = NETWORK_CONFIG.DEFAULT_HALF_RTT;

      this.sendRaw(MSG_TYPE.HELLO, { host: this.#isHost });
      this.emit('peer-join', { userId });
    });

    room.onUserLeave(({ userId }) => {
      if (userId !== this.#remoteUserId) return;
      this.stopPingLoop();
      this.#remoteUserId = null;
      this.#connected = false;
      this.#connectionLost = true;
      this.emit('peer-leave', { userId });
    });

    room.onError((err) => {
      const peerCount = this.#room ? Object.keys(this.#room.getPeers()).length : 0;
      this.emit('error', { err, peerCount, code });
    });

    this.#syncAction.onMessage((msg, { userId }) => {
      this.#handleIncomingMessage(msg, userId);
    });
  }

  async disconnect() {
    this.stopPingLoop();
    this.#connected = false;
    this.#connectionLost = false;
    this.#remoteUserId = null;
    this.#roomCode = '';
    this.#myUserId = '';
    this.#recvSeq = -1;
    this.#sendSeq = 0;
    this.#halfRtt = NETWORK_CONFIG.DEFAULT_HALF_RTT;

    const room = this.#room;
    this.#room = null;
    this.#syncAction = null;

    if (room) {
      try {
        await room.leave();
      } catch {
        // Ignore leave errors during teardown
      }
    }
  }

  setHostRole(isHost) {
    this.#isHost = isHost;
    if (isHost && this.#connected) {
      this.startPingLoop();
    } else {
      this.stopPingLoop();
    }
  }

  markConnectionLost() {
    this.#connectionLost = true;
  }

  startPingLoop() {
    this.stopPingLoop();
    if (!this.#isHost) return;

    const sendPing = () => {
      if (this.#syncAction && this.#connected) {
        this.sendRaw(MSG_TYPE.PING, { ts: performance.now(), hrtt: this.#halfRtt });
      }
    };

    sendPing();
    this.#pingIntervalId = setInterval(sendPing, NETWORK_CONFIG.HEARTBEAT_INTERVAL_MS);
  }

  stopPingLoop() {
    if (this.#pingIntervalId) {
      clearInterval(this.#pingIntervalId);
      this.#pingIntervalId = null;
    }
  }

  send(type, payload = {}) {
    if (!this.#syncAction || !this.#connected) return;
    this.#syncAction.send({ ...payload, t: type, seq: ++this.#sendSeq }).catch(() => {});
  }

  sendRaw(type, payload = {}) {
    if (!this.#syncAction || !this.#connected) return;
    this.#syncAction.send({ ...payload, t: type }).catch(() => {});
  }

  checkTimeout(now) {
    if (
      this.#connected &&
      !this.#connectionLost &&
      now - this.#lastRemoteMsgTime > NETWORK_CONFIG.CONNECTION_TIMEOUT_MS
    ) {
      this.#connectionLost = true;
      this.emit('timeout');
    }
  }

  destroy() {
    this.#abortController.abort();
    this.disconnect();
    this.clear();
  }

  #bindOnlineEvents() {
    const { signal } = this.#abortController;
    window.addEventListener('offline', () => this.emit('offline'), { signal });
    window.addEventListener('online', () => this.emit('online'), { signal });
  }

  #handleIncomingMessage(msg, userId) {
    if (!msg || typeof msg.t !== 'string') return;
    if (!this.#remoteUserId) this.#remoteUserId = userId;
    this.#lastRemoteMsgTime = performance.now();

    if (this.#connectionLost && this.#connected) {
      this.#connectionLost = false;
      this.emit('connection-restored');
    }

    if (msg.t === MSG_TYPE.PING) {
      if (!this.#isHost) {
        if (typeof msg.hrtt === 'number') this.#halfRtt = msg.hrtt;
        this.sendRaw(MSG_TYPE.PONG, { ts: msg.ts });
        this.emit('rtt-update', this.rttMs);
      }
      return;
    }

    if (msg.t === MSG_TYPE.PONG) {
      if (this.#isHost && typeof msg.ts === 'number') {
        const sample = Math.min(
          Math.max((performance.now() - msg.ts) / 2000, 0),
          NETWORK_CONFIG.MAX_HALF_RTT_SAMPLE
        );
        const w = NETWORK_CONFIG.RTT_SMOOTHING;
        this.#halfRtt = this.#halfRtt * w + sample * (1 - w);
        this.emit('rtt-update', this.rttMs);
      }
      return;
    }

    if (isSequencedMessage(msg.t)) {
      if (typeof msg.seq !== 'number' || msg.seq <= this.#recvSeq) return;
      this.#recvSeq = msg.seq;
    }

    if (msg.t === MSG_TYPE.HELLO) {
      this.#connected = true;
      this.#connectionLost = false;
    }

    this.emit('message', { msg, userId });
  }
}
