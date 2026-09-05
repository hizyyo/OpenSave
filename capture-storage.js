(function initializeCaptureStorage(globalScope) {
  'use strict';

  const DATABASE_NAME = 'opensave-capture-storage';
  const DATABASE_VERSION = 1;
  const DEFAULT_CHUNK_SIZE = 1024 * 1024;
  const QUOTA_CHECK_INTERVAL_BYTES = 16 * 1024 * 1024;
  const QUOTA_HEADROOM_BYTES = 16 * 1024 * 1024;
  const ACTIVE_MISSION_STATES = new Set(['capturing', 'capture-complete', 'exporting', 'cancelling']);

  class CaptureStorageError extends Error {
    constructor(message, code, details = {}) {
      super(message);
      this.name = 'CaptureStorageError';
      this.code = code;
      this.details = details;
    }
  }

  class CaptureQuotaError extends CaptureStorageError {
    constructor(requiredBytes, availableBytes, cause) {
      const required = formatBytes(requiredBytes);
      const available = formatBytes(Math.max(0, availableBytes));
      super(
        `Недостаточно локального места для захвата: требуется ещё ${required}, доступно ${available}. Освободите место и повторите экспорт; уже сохранённые метаданные миссии не повреждены.`,
        'quota-exhausted',
        { requiredBytes, availableBytes }
      );
      this.name = 'CaptureQuotaError';
      if (cause) this.cause = cause;
    }
  }

  function formatBytes(value) {
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    return `${(value / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  function cloneValue(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function sanitizeMissionRecord(record) {
    const mission = cloneValue(record);
    if (mission.graph && Array.isArray(mission.graph.bodies)) {
      for (const body of mission.graph.bodies) body.body = null;
    }
    return mission;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    });
  }

  function randomId() {
    if (globalScope.crypto && typeof globalScope.crypto.randomUUID === 'function') return globalScope.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError('Body chunks must be ArrayBuffer or Uint8Array values');
  }

  function normalizeHash(value) {
    const hash = String(value || '');
    if (!/^sha256:[a-f0-9]{64}$/.test(hash)) throw new CaptureStorageError('Body commit requires a SHA-256 content hash', 'invalid-content-hash');
    return hash;
  }

  class IndexedDbCaptureStorage {
    constructor(options = {}) {
      this.indexedDB = options.indexedDB || globalScope.indexedDB;
      this.storageManager = options.storageManager || (globalScope.navigator && globalScope.navigator.storage);
      this.databaseName = options.databaseName || DATABASE_NAME;
      this.chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
      this.quotaHeadroomBytes = options.quotaHeadroomBytes ?? QUOTA_HEADROOM_BYTES;
      this.databasePromise = null;
      this.missionIds = new Set();
    }

    async initialize() {
      await this._database();
      return this;
    }

    async _database() {
      if (!this.indexedDB) throw new CaptureStorageError('IndexedDB недоступен в этом контексте расширения', 'storage-unavailable');
      if (this.databasePromise) return this.databasePromise;
      this.databasePromise = new Promise((resolve, reject) => {
        const request = this.indexedDB.open(this.databaseName, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains('missions')) {
            const missions = database.createObjectStore('missions', { keyPath: 'id' });
            missions.createIndex('state', 'state', { unique: false });
            missions.createIndex('sourceTabId', 'sourceTabId', { unique: false });
          }
          if (!database.objectStoreNames.contains('bodies')) {
            const bodies = database.createObjectStore('bodies', { keyPath: 'contentHash' });
            bodies.createIndex('storageKey', 'storageKey', { unique: true });
          }
          if (!database.objectStoreNames.contains('bodyChunks')) {
            const chunks = database.createObjectStore('bodyChunks', { keyPath: ['storageKey', 'index'] });
            chunks.createIndex('storageKey', 'storageKey', { unique: false });
          }
          if (!database.objectStoreNames.contains('bodyOwners')) {
            const owners = database.createObjectStore('bodyOwners', { keyPath: ['missionId', 'contentHash'] });
            owners.createIndex('missionId', 'missionId', { unique: false });
            owners.createIndex('contentHash', 'contentHash', { unique: false });
          }
          if (!database.objectStoreNames.contains('temporaryBodies')) {
            const temporaryBodies = database.createObjectStore('temporaryBodies', { keyPath: 'storageKey' });
            temporaryBodies.createIndex('missionId', 'missionId', { unique: false });
          }
        };
        request.onsuccess = () => {
          request.result.onversionchange = () => request.result.close();
          resolve(request.result);
        };
        request.onerror = () => reject(request.error || new Error('Could not open capture storage'));
        request.onblocked = () => reject(new CaptureStorageError('Capture storage upgrade is blocked by another extension page', 'storage-upgrade-blocked'));
      });
      return this.databasePromise;
    }

    async _get(storeName, key) {
      const database = await this._database();
      return requestResult(database.transaction(storeName).objectStore(storeName).get(key));
    }

    async _put(storeName, value) {
      const database = await this._database();
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put(value);
      await transactionDone(transaction);
      return value;
    }

    async _delete(storeName, key) {
      const database = await this._database();
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).delete(key);
      await transactionDone(transaction);
    }

    async _getAll(storeName) {
      const database = await this._database();
      return requestResult(database.transaction(storeName).objectStore(storeName).getAll());
    }

    async _getAllByIndex(storeName, indexName, key) {
      const database = await this._database();
      return requestResult(database.transaction(storeName).objectStore(storeName).index(indexName).getAll(key));
    }

    async createMission(input) {
      if (!input || !input.id) throw new CaptureStorageError('A capture ID is required', 'invalid-mission');
      const now = Date.now();
      const mission = sanitizeMissionRecord({
        state: 'capturing',
        pendingWork: [],
        cancellation: { requested: false, reason: null, requestedAt: null },
        recovery: { recoverable: true, interruptedAt: null, reason: null },
        createdAt: now,
        updatedAt: now,
        ...input
      });
      await this._put('missions', mission);
      this.missionIds.add(mission.id);
      return mission;
    }

    async saveMission(missionId, patch) {
      const existing = await this.getMission(missionId);
      if (!existing) throw new CaptureStorageError(`Capture mission ${missionId} was not found`, 'mission-not-found');
      const mission = sanitizeMissionRecord({ ...existing, ...patch, id: missionId, updatedAt: Date.now() });
      await this._put('missions', mission);
      return mission;
    }

    async getMission(missionId) {
      const mission = await this._get('missions', missionId);
      if (mission) this.missionIds.add(missionId);
      return mission ? cloneValue(mission) : null;
    }

    async listMissions() {
      return (await this._getAll('missions')).map(cloneValue);
    }

    async getQuotaStatus(requiredBytes = 0) {
      if (!this.storageManager || typeof this.storageManager.estimate !== 'function') {
        return { supported: false, usage: null, quota: null, available: Infinity, requiredBytes, sufficient: true };
      }
      const estimate = await this.storageManager.estimate();
      const usage = Number(estimate.usage || 0);
      const quota = Number(estimate.quota || 0);
      const available = quota ? Math.max(0, quota - usage - this.quotaHeadroomBytes) : Infinity;
      return { supported: true, usage, quota, available, requiredBytes, sufficient: available >= requiredBytes };
    }

    async assertQuota(requiredBytes) {
      const status = await this.getQuotaStatus(requiredBytes);
      if (!status.sufficient) throw new CaptureQuotaError(requiredBytes, status.available);
      return status;
    }

    async beginBody(missionId, expectedSize = 0) {
      if (!this.missionIds.has(missionId) && !await this.getMission(missionId)) throw new CaptureStorageError(`Capture mission ${missionId} was not found`, 'mission-not-found');
      if (expectedSize >= QUOTA_CHECK_INTERVAL_BYTES) await this.assertQuota(expectedSize);
      const storageKey = `capture/${missionId}/body/${randomId()}`;
      const record = { storageKey, missionId, chunkCount: 0, size: 0, expectedSize: expectedSize || null, createdAt: Date.now(), updatedAt: Date.now() };
      return this._createWriter(record);
    }

    async _writeBodyChunk(record, bytes) {
      const database = await this._database();
      const transaction = database.transaction(['bodyChunks', 'temporaryBodies'], 'readwrite');
      transaction.objectStore('bodyChunks').put({
        storageKey: record.storageKey,
        index: record.chunkCount,
        bytes: bytes.slice().buffer
      });
      record.chunkCount += 1;
      record.size += bytes.byteLength;
      record.updatedAt = Date.now();
      transaction.objectStore('temporaryBodies').put(record);
      await transactionDone(transaction);
    }

    _createWriter(initialRecord) {
      const storage = this;
      const record = { ...initialRecord };
      let closed = false;
      let bytesSinceQuotaCheck = 0;
      return {
        storageKey: record.storageKey,
        async write(value) {
          if (closed) throw new CaptureStorageError('Body writer is already closed', 'writer-closed');
          const bytes = asBytes(value);
          if (!bytes.byteLength) return;
          bytesSinceQuotaCheck += bytes.byteLength;
          if (bytesSinceQuotaCheck >= QUOTA_CHECK_INTERVAL_BYTES) {
            await storage.assertQuota(bytesSinceQuotaCheck);
            bytesSinceQuotaCheck = 0;
          }
          try {
            await storage._writeBodyChunk(record, bytes);
          } catch (error) {
            if (error && (error.name === 'QuotaExceededError' || error.code === 22)) {
              const status = await storage.getQuotaStatus(bytes.byteLength);
              throw new CaptureQuotaError(bytes.byteLength, status.available, error);
            }
            throw error;
          }
        },
        async commit(contentHash, metadata = {}) {
          if (closed) throw new CaptureStorageError('Body writer is already closed', 'writer-closed');
          closed = true;
          return storage._commitBody(record, normalizeHash(contentHash), metadata);
        },
        async abort(reason = 'aborted') {
          if (closed) return;
          closed = true;
          await storage._cleanupTemporaryBody(record.storageKey);
          return { aborted: true, reason };
        }
      };
    }

    async _commitBody(record, contentHash, metadata) {
      if (metadata.size != null && metadata.size !== record.size) {
        await this._cleanupTemporaryBody(record.storageKey);
        throw new CaptureStorageError(`Body size mismatch: wrote ${record.size}, commit declared ${metadata.size}`, 'body-size-mismatch');
      }
      const database = await this._database();
      let bodyReference;
      let duplicateStorageKey = null;
      const transaction = database.transaction(['bodies', 'bodyOwners', 'temporaryBodies'], 'readwrite');
      const bodies = transaction.objectStore('bodies');
      const owners = transaction.objectStore('bodyOwners');
      const temporaryBodies = transaction.objectStore('temporaryBodies');
      const request = bodies.get(contentHash);
      request.onsuccess = () => {
        const existing = request.result;
        if (existing) {
          duplicateStorageKey = record.storageKey;
          bodyReference = existing;
        } else {
          bodyReference = {
            contentHash,
            storageKey: record.storageKey,
            size: record.size,
            chunkCount: record.chunkCount,
            mimeType: metadata.mimeType || '',
            createdAt: Date.now()
          };
          bodies.put(bodyReference);
        }
        owners.put({ missionId: record.missionId, contentHash, retainedAt: Date.now() });
        if (!existing) temporaryBodies.delete(record.storageKey);
      };
      await transactionDone(transaction);
      if (duplicateStorageKey) await this._cleanupTemporaryBody(duplicateStorageKey);
      return { ...bodyReference, duplicate: Boolean(duplicateStorageKey) };
    }

    async hasBody(contentHash) {
      return Boolean(await this._get('bodies', normalizeHash(contentHash)));
    }

    async retainBody(contentHash, missionId) {
      const body = await this._get('bodies', normalizeHash(contentHash));
      if (!body) throw new CaptureStorageError(`Body ${contentHash} was not found`, 'body-not-found');
      await this._put('bodyOwners', { missionId, contentHash, retainedAt: Date.now() });
      return body;
    }

    async getBodyReference(storageKey) {
      const database = await this._database();
      const body = await requestResult(database.transaction('bodies').objectStore('bodies').index('storageKey').get(storageKey));
      return body || null;
    }

    async openBody(reference) {
      const storageKey = typeof reference === 'string' ? reference : reference && reference.storageKey;
      const body = await this.getBodyReference(storageKey);
      if (!body) throw new CaptureStorageError(`Stored body ${storageKey || '<missing>'} was not found`, 'body-not-found');
      let index = 0;
      const storage = this;
      return new ReadableStream({
        async pull(controller) {
          if (index >= body.chunkCount) {
            controller.close();
            return;
          }
          try {
            const chunk = await storage._get('bodyChunks', [body.storageKey, index]);
            if (!chunk) throw new CaptureStorageError(`Stored body chunk ${index} is missing`, 'body-corrupt', { storageKey: body.storageKey, index });
            index += 1;
            controller.enqueue(new Uint8Array(chunk.bytes));
          } catch (error) {
            controller.error(error);
          }
        }
      });
    }

    async readBody(reference, mimeType = '') {
      const stream = await this.openBody(reference);
      const reader = stream.getReader();
      const parts = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
      }
      return new Blob(parts, { type: mimeType });
    }

    async recoverInterruptedMissions(reason = 'extension-restarted') {
      const missions = await this.listMissions();
      const recovered = [];
      for (const mission of missions) {
        if (!ACTIVE_MISSION_STATES.has(mission.state)) continue;
        const updated = await this.saveMission(mission.id, {
          state: 'interrupted',
          recovery: { recoverable: true, interruptedAt: Date.now(), reason }
        });
        await this.cleanupTemporaryBodies(mission.id);
        recovered.push(updated);
      }
      return recovered;
    }

    async cleanupTemporaryBodies(missionId) {
      const records = await this._getAllByIndex('temporaryBodies', 'missionId', missionId);
      for (const record of records) await this._cleanupTemporaryBody(record.storageKey);
      return records.length;
    }

    async _cleanupTemporaryBody(storageKey) {
      const committed = await this.getBodyReference(storageKey);
      if (!committed) await this._deleteChunks(storageKey);
      await this._delete('temporaryBodies', storageKey);
    }

    async _deleteChunks(storageKey) {
      const database = await this._database();
      const transaction = database.transaction('bodyChunks', 'readwrite');
      const index = transaction.objectStore('bodyChunks').index('storageKey');
      const request = index.openKeyCursor(globalScope.IDBKeyRange.only(storageKey));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        transaction.objectStore('bodyChunks').delete(cursor.primaryKey);
        cursor.continue();
      };
      await transactionDone(transaction);
    }

    async cleanupMission(missionId) {
      await this.cleanupTemporaryBodies(missionId);
      const allOwners = await this._getAll('bodyOwners');
      const owners = allOwners.filter((owner) => owner.missionId === missionId);
      const orphanedHashes = owners
        .map((owner) => owner.contentHash)
        .filter((contentHash) => !allOwners.some((owner) => owner.missionId !== missionId && owner.contentHash === contentHash));
      const orphanedBodies = (await Promise.all(orphanedHashes.map((contentHash) => this._get('bodies', contentHash)))).filter(Boolean);
      const database = await this._database();
      const transaction = database.transaction(['missions', 'bodies', 'bodyChunks', 'bodyOwners'], 'readwrite');
      const bodies = transaction.objectStore('bodies');
      const chunks = transaction.objectStore('bodyChunks');
      const chunkIndex = chunks.index('storageKey');
      const ownerStore = transaction.objectStore('bodyOwners');
      transaction.objectStore('missions').delete(missionId);
      for (const owner of owners) ownerStore.delete([missionId, owner.contentHash]);
      for (const body of orphanedBodies) {
        bodies.delete(body.contentHash);
        const request = chunkIndex.openKeyCursor(globalScope.IDBKeyRange.only(body.storageKey));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          chunks.delete(cursor.primaryKey);
          cursor.continue();
        };
      }
      await transactionDone(transaction);
      this.missionIds.delete(missionId);
      return { missionId, deletedBodies: orphanedBodies.length };
    }

    async cancelMission(missionId, reason = 'cancelled') {
      const mission = await this.getMission(missionId);
      if (!mission) return { missionId, cancelled: false };
      await this.saveMission(missionId, {
        state: 'cancelled',
        cancellation: { requested: true, reason, requestedAt: Date.now() }
      });
      await this.cleanupMission(missionId);
      return { missionId, cancelled: true };
    }
  }

  class MemoryCaptureStorage {
    constructor(options = {}) {
      this.chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
      this.quota = options.quota ?? Infinity;
      this.database = options.database || {
        missions: new Map(), bodies: new Map(), bodiesByStorageKey: new Map(), chunks: new Map(), owners: new Map(), temporaryBodies: new Map()
      };
    }

    async initialize() { return this; }

    async createMission(input) {
      const now = Date.now();
      const mission = sanitizeMissionRecord({ state: 'capturing', pendingWork: [], cancellation: { requested: false }, recovery: { recoverable: true }, createdAt: now, updatedAt: now, ...input });
      this.database.missions.set(mission.id, mission);
      return cloneValue(mission);
    }

    async saveMission(missionId, patch) {
      const existing = this.database.missions.get(missionId);
      if (!existing) throw new CaptureStorageError(`Capture mission ${missionId} was not found`, 'mission-not-found');
      const mission = sanitizeMissionRecord({ ...existing, ...patch, id: missionId, updatedAt: Date.now() });
      this.database.missions.set(missionId, mission);
      return cloneValue(mission);
    }

    async getMission(missionId) { return this.database.missions.has(missionId) ? cloneValue(this.database.missions.get(missionId)) : null; }
    async listMissions() { return [...this.database.missions.values()].map(cloneValue); }

    _usage() {
      let total = 0;
      for (const chunks of this.database.chunks.values()) for (const chunk of chunks) total += chunk.byteLength;
      return total;
    }

    async getQuotaStatus(requiredBytes = 0) {
      const usage = this._usage();
      const available = Math.max(0, this.quota - usage);
      return { supported: Number.isFinite(this.quota), usage, quota: this.quota, available, requiredBytes, sufficient: available >= requiredBytes };
    }

    async assertQuota(requiredBytes) {
      const status = await this.getQuotaStatus(requiredBytes);
      if (!status.sufficient) throw new CaptureQuotaError(requiredBytes, status.available);
      return status;
    }

    async beginBody(missionId, expectedSize = 0) {
      if (!this.database.missions.has(missionId)) throw new CaptureStorageError(`Capture mission ${missionId} was not found`, 'mission-not-found');
      if (expectedSize >= QUOTA_CHECK_INTERVAL_BYTES) await this.assertQuota(expectedSize);
      const storageKey = `capture/${missionId}/body/${randomId()}`;
      const record = { storageKey, missionId, chunkCount: 0, size: 0, expectedSize: expectedSize || null };
      this.database.temporaryBodies.set(storageKey, record);
      this.database.chunks.set(storageKey, []);
      let closed = false;
      const storage = this;
      return {
        storageKey,
        async write(value) {
          if (closed) throw new CaptureStorageError('Body writer is already closed', 'writer-closed');
          const bytes = asBytes(value).slice();
          await storage.assertQuota(bytes.byteLength);
          storage.database.chunks.get(storageKey).push(bytes);
          record.chunkCount += 1;
          record.size += bytes.byteLength;
        },
        async commit(contentHash, metadata = {}) {
          if (closed) throw new CaptureStorageError('Body writer is already closed', 'writer-closed');
          closed = true;
          const hash = normalizeHash(contentHash);
          if (metadata.size != null && metadata.size !== record.size) {
            storage.database.chunks.delete(storageKey);
            storage.database.temporaryBodies.delete(storageKey);
            throw new CaptureStorageError('Body size mismatch', 'body-size-mismatch');
          }
          let body = storage.database.bodies.get(hash);
          const duplicate = Boolean(body);
          if (body) storage.database.chunks.delete(storageKey);
          else {
            body = { contentHash: hash, storageKey, size: record.size, chunkCount: record.chunkCount, mimeType: metadata.mimeType || '' };
            storage.database.bodies.set(hash, body);
            storage.database.bodiesByStorageKey.set(storageKey, body);
          }
          storage.database.temporaryBodies.delete(storageKey);
          storage.database.owners.set(`${missionId}\n${hash}`, { missionId, contentHash: hash });
          return { ...body, duplicate };
        },
        async abort() {
          if (closed) return;
          closed = true;
          storage.database.chunks.delete(storageKey);
          storage.database.temporaryBodies.delete(storageKey);
        }
      };
    }

    async hasBody(contentHash) { return this.database.bodies.has(normalizeHash(contentHash)); }
    async getBodyReference(storageKey) { return this.database.bodiesByStorageKey.get(storageKey) || null; }

    async retainBody(contentHash, missionId) {
      const body = this.database.bodies.get(normalizeHash(contentHash));
      if (!body) throw new CaptureStorageError(`Body ${contentHash} was not found`, 'body-not-found');
      this.database.owners.set(`${missionId}\n${contentHash}`, { missionId, contentHash });
      return body;
    }

    async openBody(reference) {
      const storageKey = typeof reference === 'string' ? reference : reference.storageKey;
      const body = this.database.bodiesByStorageKey.get(storageKey);
      if (!body) throw new CaptureStorageError(`Stored body ${storageKey} was not found`, 'body-not-found');
      const chunks = this.database.chunks.get(storageKey) || [];
      let index = 0;
      return new ReadableStream({ pull(controller) { index < chunks.length ? controller.enqueue(chunks[index++].slice()) : controller.close(); } });
    }

    async readBody(reference, mimeType = '') {
      const storageKey = typeof reference === 'string' ? reference : reference.storageKey;
      const body = this.database.bodiesByStorageKey.get(storageKey);
      if (!body) throw new CaptureStorageError(`Stored body ${storageKey} was not found`, 'body-not-found');
      return new Blob((this.database.chunks.get(storageKey) || []).map((chunk) => chunk.slice()), { type: mimeType });
    }

    async cleanupTemporaryBodies(missionId) {
      let removed = 0;
      for (const [storageKey, record] of [...this.database.temporaryBodies]) {
        if (record.missionId !== missionId) continue;
        this.database.temporaryBodies.delete(storageKey);
        this.database.chunks.delete(storageKey);
        removed += 1;
      }
      return removed;
    }

    async recoverInterruptedMissions(reason = 'extension-restarted') {
      const recovered = [];
      for (const mission of await this.listMissions()) {
        if (!ACTIVE_MISSION_STATES.has(mission.state)) continue;
        recovered.push(await this.saveMission(mission.id, { state: 'interrupted', recovery: { recoverable: true, interruptedAt: Date.now(), reason } }));
        await this.cleanupTemporaryBodies(mission.id);
      }
      return recovered;
    }

    async cleanupMission(missionId) {
      await this.cleanupTemporaryBodies(missionId);
      const ownedHashes = [...this.database.owners.values()].filter((owner) => owner.missionId === missionId).map((owner) => owner.contentHash);
      for (const hash of ownedHashes) {
        this.database.owners.delete(`${missionId}\n${hash}`);
        if ([...this.database.owners.values()].some((owner) => owner.contentHash === hash)) continue;
        const body = this.database.bodies.get(hash);
        if (body) {
          this.database.chunks.delete(body.storageKey);
          this.database.bodiesByStorageKey.delete(body.storageKey);
          this.database.bodies.delete(hash);
        }
      }
      this.database.missions.delete(missionId);
      return { missionId, deletedBodies: ownedHashes.length };
    }

    async cancelMission(missionId, reason = 'cancelled') {
      if (!this.database.missions.has(missionId)) return { missionId, cancelled: false };
      await this.saveMission(missionId, { state: 'cancelled', cancellation: { requested: true, reason, requestedAt: Date.now() } });
      await this.cleanupMission(missionId);
      return { missionId, cancelled: true };
    }
  }

  function createCaptureStorage(options = {}) {
    return new IndexedDbCaptureStorage(options);
  }

  function createMemoryCaptureStorage(options = {}) {
    return new MemoryCaptureStorage(options);
  }

  const api = {
    DATABASE_NAME,
    DATABASE_VERSION,
    DEFAULT_CHUNK_SIZE,
    CaptureStorageError,
    CaptureQuotaError,
    IndexedDbCaptureStorage,
    MemoryCaptureStorage,
    createCaptureStorage,
    createMemoryCaptureStorage,
    formatBytes
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.OpenSaveCaptureStorage = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
