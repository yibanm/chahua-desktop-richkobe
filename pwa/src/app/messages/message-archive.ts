import { Injectable } from '@angular/core';
import type { MessageResponse } from '../../generated/models';
import type { SnowflakeID } from '../api/snowflake-id';

const DB_NAME = 'chahua-archive';
const DB_VERSION = 1;
const MESSAGES = 'messages';
const MEDIA = 'media';

/**
 * 本地消息归档：文字与媒体写入 IndexedDB，卸载应用（不清数据）后仍在。
 * 用途=防撤回的持久层：上游不存本地、重拉即得已撤回的空内容，
 * 故收到消息时立即归档，读取时若服务器返回已删除则用归档还原。
 * 写入全部 fire-and-forget 且失败静默：归档是增强，不能拖慢或弄坏主链路。
 */
@Injectable({ providedIn: 'root' })
export class MessageArchive {
  private readonly db = openDatabase();
  private readonly objectUrls = new Map<string, string>();

  /** 归档一条消息的文字与附件元信息（含 url/fileName/kind，供还原）。整条存，不做字段裁剪。 */
  ingest(message: MessageResponse): void {
    if (message.isDeleted || (!message.message && !message.attachments.length)) return;
    void this.db
      .then((db) => put(db, MESSAGES, message))
      .catch(() => {});
    for (const attachment of message.attachments) {
      if (!attachment.url) continue;
      void this.fetchMedia(attachment.url);
    }
  }

  /** 拉取媒体二进制入档；已入档或正在拉取则跳过。presigned url 有时效，收到即拉。 */
  private async fetchMedia(url: string): Promise<void> {
    if (this.objectUrls.has(url)) return;
    const db = await this.db;
    const existing = await get(db, MEDIA, url).catch(() => undefined);
    if (existing) return;
    try {
      const response = await fetch(url);
      if (!response.ok) return;
      const blob = await response.blob();
      await put(db, MEDIA, { url, blob, at: Date.now() });
    } catch {
      // 媒体拉取失败不入档，展示时回退原 url
    }
  }

  /** 服务器返回已删除的消息时，用归档还原文字与附件元信息；无归档返回 undefined。 */
  async restore(id: SnowflakeID): Promise<MessageResponse | undefined> {
    try {
      const db = await this.db;
      return (await get(db, MESSAGES, String(id))) as MessageResponse | undefined;
    } catch {
      return undefined;
    }
  }

  /** 媒体展示地址：优先本地归档 blob 的 objectURL（presigned url 会过期），无则 undefined 由调用方回退。 */
  async mediaObjectUrl(url: string): Promise<string | undefined> {
    const cached = this.objectUrls.get(url);
    if (cached) return cached;
    try {
      const db = await this.db;
      const record = (await get(db, MEDIA, url)) as { blob: Blob } | undefined;
      if (!record) return undefined;
      const objectUrl = URL.createObjectURL(record.blob);
      this.objectUrls.set(url, objectUrl);
      return objectUrl;
    } catch {
      return undefined;
    }
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MESSAGES)) db.createObjectStore(MESSAGES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(MEDIA)) db.createObjectStore(MEDIA, { keyPath: 'url' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(db: IDBDatabase, store: string, mode: IDBTransactionMode): IDBTransaction {
  return db.transaction(store, mode);
}

function get(db: IDBDatabase, store: string, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = tx(db, store, 'readonly').objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function put(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = tx(db, store, 'readwrite').objectStore(store).put(value);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
