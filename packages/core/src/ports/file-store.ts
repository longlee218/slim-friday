/** Size and type of a stored object. */
export interface FileStat {
  size: number;
  contentType?: string;
}

/** Object storage for files (R2 in production). Keys are made by the engine, never by a client. */
export interface FileStore {
  put(key: string, data: Blob | Uint8Array | string, contentType: string): Promise<void>;
  /** `undefined` when the key does not exist. */
  stat(key: string): Promise<FileStat | undefined>;
  /** The first `bytes` bytes of the object. */
  readHead(key: string, bytes: number): Promise<Uint8Array>;
  read(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  /** A URL the browser can PUT the object to. */
  presignPut(key: string, expiresInSec: number, contentType: string): string;
  /** A URL the browser can GET the object from; `downloadName` forces a download under that name. */
  presignGet(key: string, expiresInSec: number, opts?: { downloadName?: string }): string;
}
