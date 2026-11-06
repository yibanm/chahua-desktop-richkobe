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

  /**
   * 归档一条消息。文字总是入档；媒体仅在 withMedia 时入档——
   * 历史加载一页几十条媒体消息若立即全拉，会占满 plugin-http 的 Rust 连接池，
   * 饿死启动必需的 users/me 与 WS 握手（用户实测「一直转进不去」），
   * 故历史路径只存文字，实时新消息才拉媒体。
   */
  ingest(message: MessageResponse, withMedia = false): void {
    if (message.isDeleted || (!message.message && !message.attachments.length)) return;
    void this.db
      .then((db) => put(db, MESSAGES, message))
      .catch(() => {});
    if (!withMedia) return;
    for (const attachment of message.attachments) {
      if (!attachment.url) continue;
      void this.fetchMedia(attachment.url);
    }
  }

  // 媒体入档并发上限：避免突发下载挤占网络与连接池
  private mediaInFlight = 0;
  private readonly mediaQueue: string[] = [];

  /** 拉取媒体二进制入档。走 WebView 原生 XHR（附件本就是 CORS * 直连 S3 的通道），
   * 不经被 monkey-patch 的 fetch，即不占 plugin-http 的 Rust 连接池。 */
  private fetchMedia(url: string): void {
    if (this.objectUrls.has(url) || this.mediaQueue.includes(url)) return;
    if (this.mediaInFlight >= 2) {
      this.mediaQueue.push(url);
      return;
    }
    this.mediaInFlight++;
    const done = () => {
      this.mediaInFlight--;
      const next = this.mediaQueue.shift();
      if (next) this.fetchMedia(next);
    };
    void this.db
      .then((db) => get(db, MEDIA, url))
      .then((existing) => {
        if (existing) return undefined;
        return xhrBlob(url);
      })
      .then(async (blob) => {
        if (blob) {
          const db = await this.db;
          await put(db, MEDIA, { url, blob, at: Date.now() });
        }
      })
      .catch(() => {})
      .finally(done);
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

/** 原生 XHR 取二进制：不经 window.fetch（壳内被 monkey-patch 到 plugin-http 的 Rust 池）。 */
function xhrBlob(url: string): Promise<Blob | undefined> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'blob';
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300 ? (xhr.response as Blob) : undefined);
    xhr.onerror = () => resolve(undefined);
    xhr.send();
  });
}
