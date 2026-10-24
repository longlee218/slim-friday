import type { FileStat, FileStore } from "@friday/core";

/** R2 credentials and bucket (read from env by the app, never here). */
export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** The slice of `Bun.S3Client` the store uses (a fake in tests). */
export type R2Client = Pick<Bun.S3Client, "write" | "stat" | "file" | "delete" | "presign">;

/** True when an S3 error means "the object is not there". */
const isMissing = (err: unknown): boolean => {
  const e = err as { code?: string; name?: string; status?: number; statusCode?: number };
  return (
    e?.code === "NoSuchKey" ||
    e?.code === "NotFound" ||
    e?.name === "NoSuchKey" ||
    e?.name === "NotFound" ||
    e?.status === 404 ||
    e?.statusCode === 404
  );
};

/** A header-safe file name: quotes, backslashes, control and non-ASCII chars become `_`. */
const safeName = (name: string): string => name.replace(/[^\x20-\x7e]|["\\]/g, "_");

/** FileStore over a private Cloudflare R2 bucket, using Bun's built-in S3 client. */
export class R2FileStore implements FileStore {
  /** The account's S3-compatible endpoint. */
  readonly endpoint: string;
  private readonly client: R2Client;

  constructor(cfg: R2Config, client?: R2Client) {
    this.endpoint = `https://${cfg.accountId}.r2.cloudflarestorage.com`;
    this.client =
      client ??
      new Bun.S3Client({
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
        bucket: cfg.bucket,
        endpoint: this.endpoint,
      });
  }

  async put(key: string, data: Blob | Uint8Array | string, contentType: string): Promise<void> {
    await this.client.write(key, data, { type: contentType });
  }

  async stat(key: string): Promise<FileStat | undefined> {
    try {
      const s = await this.client.stat(key);
      return { size: s.size, contentType: s.type };
    } catch (err) {
      if (isMissing(err)) return undefined;
      throw err;
    }
  }

  async readHead(key: string, bytes: number): Promise<Uint8Array> {
    return this.client.file(key).slice(0, bytes).bytes();
  }

  async read(key: string): Promise<Uint8Array> {
    return this.client.file(key).bytes();
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.delete(key);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }

  presignPut(key: string, expiresInSec: number, contentType: string): string {
    return this.client.presign(key, { method: "PUT", expiresIn: expiresInSec, type: contentType });
  }

  presignGet(key: string, expiresInSec: number, opts?: { downloadName?: string }): string {
    return this.client.presign(key, {
      expiresIn: expiresInSec,
      contentDisposition: opts?.downloadName
        ? `attachment; filename="${safeName(opts.downloadName)}"`
        : undefined,
    });
  }
}
