# Port: FileStore

Object storage for every file the app shows: the owner's uploads, files and images a bot posts (`PostFile`) and bot and group avatars. Defined in `packages/core/src/ports/file-store.ts`. The shipped adapter is `packages/store-r2` (Cloudflare R2 over `Bun.S3Client`). Keys are made by the engine:
- `uploads/<conversationId>/<uploadId>/<name>`: the owner's files.
- `files/<conversationId>/<fileId>/<name>`: files a bot posted.
- `avatars/<bots|groups>/<id>/<uploadId>.<webp|jpg>`: uploaded avatars.

## Interface

```ts
interface FileStat { size: number; contentType?: string }

interface FileStore {
  put(key: string, data: Blob | Uint8Array | string, contentType: string): Promise<void>;
  stat(key: string): Promise<FileStat | undefined>;           // undefined: no such key
  readHead(key: string, bytes: number): Promise<Uint8Array>;   // the first bytes (type check)
  read(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  presignPut(key: string, expiresInSec: number, contentType: string): string;
  presignGet(key: string, expiresInSec: number, opts?: { downloadName?: string }): string;
}
```

- Presigning is local: a signature over the key, no network call, so `presignPut` and `presignGet` are synchronous and cannot fail on a down bucket.
- `stat` returns `undefined` for a missing key; it does not throw.
- Keys never come from a client. The engine makes every key from random ids and a sanitised name, and the API gives a URL only for a recorded upload or file, by id.
- The browser PUTs and GETs through the presigned URLs, so file bytes never pass the API. A presigned PUT cannot cap the size: the engine `stat`s the object after the upload and deletes it when it is too big.
- Images are served from an optional public custom domain on the bucket (engine env `CDN`, web build `VITE_CDN_ORIGIN`); every other file is presigned.

## Test with the fake

`packages/core/test/fakes/fake-file-store.ts` (`FakeFileStore`) keeps objects in memory, records `deleted` keys and can fail the next call of an async method (`failNext`). The adapter has its own tests in `packages/store-r2/test/`; `scripts/smoke-r2.ts` checks a real bucket and is owner-run.

## Add an adapter

1. Make `packages/store-<name>/` with `src/index.ts`; depend on `@friday/core` only, plus the storage client in one adapter file.
2. Implement `FileStore`; keep every call to the storage service inside the package.
3. Add a boundary test like `store-r2/test/boundary.test.ts` (core, node and own files only; no env, no console).
4. Compose it in `apps/friday` (the engine reads the settings from its env and passes them in).
