import type { FileStat, FileStore } from "../../src";

/** An in-memory FileStore; records deletes and can be told to fail the next call of a method. */
export class FakeFileStore implements FileStore {
  objects = new Map<string, { data: Uint8Array; contentType: string }>();
  deleted: string[] = [];
  private failing = new Set<keyof FileStore>();

  /** The next call of `method` rejects once. */
  failNext(method: keyof FileStore): void {
    this.failing.add(method);
  }
  private check(method: keyof FileStore): void {
    if (this.failing.delete(method)) throw new Error(`FakeFileStore: ${method} failed`);
  }

  async put(key: string, data: Blob | Uint8Array | string, contentType: string): Promise<void> {
    this.check("put");
    const bytes =
      data instanceof Blob
        ? new Uint8Array(await data.arrayBuffer())
        : typeof data === "string"
          ? new TextEncoder().encode(data)
          : data;
    this.objects.set(key, { data: bytes, contentType });
  }
  async stat(key: string): Promise<FileStat | undefined> {
    this.check("stat");
    const o = this.objects.get(key);
    return o && { size: o.data.length, contentType: o.contentType };
  }
  async readHead(key: string, bytes: number): Promise<Uint8Array> {
    this.check("readHead");
    return (await this.read(key)).slice(0, bytes);
  }
  async read(key: string): Promise<Uint8Array> {
    const o = this.objects.get(key);
    if (!o) throw new Error(`FakeFileStore: no object ${key}`);
    return o.data;
  }
  async delete(key: string): Promise<void> {
    this.check("delete");
    this.objects.delete(key);
    this.deleted.push(key);
  }
  presignPut(key: string, expiresInSec: number, contentType: string): string {
    return `fake://put/${key}?exp=${expiresInSec}&type=${contentType}`;
  }
  presignGet(key: string, expiresInSec: number, opts?: { downloadName?: string }): string {
    const dl = opts?.downloadName ? `&dl=${opts.downloadName}` : "";
    return `fake://get/${key}?exp=${expiresInSec}${dl}`;
  }
}
