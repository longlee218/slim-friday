import { expect, test } from "bun:test";
import { R2FileStore } from "../src/r2-file-store";

/** A fake S3 client that records every call. */
const fakeClient = (statResult?: () => Promise<unknown>) => {
  const calls: { op: string; args: unknown[] }[] = [];
  const client = {
    write: async (...args: unknown[]) => {
      calls.push({ op: "write", args });
      return 0;
    },
    stat: async (...args: unknown[]) => {
      calls.push({ op: "stat", args });
      return statResult ? statResult() : { size: 3, type: "text/plain" };
    },
    file: (...args: unknown[]) => {
      calls.push({ op: "file", args });
      return {
        bytes: async () => new Uint8Array([1, 2, 3]),
        slice: (...s: unknown[]) => {
          calls.push({ op: "slice", args: s });
          return { bytes: async () => new Uint8Array([1]) };
        },
      };
    },
    delete: async (...args: unknown[]) => {
      calls.push({ op: "delete", args });
    },
    presign: (...args: unknown[]) => {
      calls.push({ op: "presign", args });
      return "https://signed";
    },
  };
  return { client: client as never, calls };
};

const cfg = { accountId: "acc1", accessKeyId: "k", secretAccessKey: "s", bucket: "b" };

test("stat of a missing key is undefined", async () => {
  const { client } = fakeClient(async () => {
    throw Object.assign(new Error("nope"), { code: "NoSuchKey" });
  });
  expect(await new R2FileStore(cfg, client).stat("x")).toBeUndefined();
});

test("stat rethrows other errors", async () => {
  const { client } = fakeClient(async () => {
    throw Object.assign(new Error("denied"), { code: "AccessDenied", status: 403 });
  });
  await expect(new R2FileStore(cfg, client).stat("x")).rejects.toThrow("denied");
});

test("stat maps size and type", async () => {
  const { client } = fakeClient();
  expect(await new R2FileStore(cfg, client).stat("x")).toEqual({
    size: 3,
    contentType: "text/plain",
  });
});

test("put passes the content type", async () => {
  const { client, calls } = fakeClient();
  await new R2FileStore(cfg, client).put("k", "hi", "text/plain");
  expect(calls[0]).toEqual({ op: "write", args: ["k", "hi", { type: "text/plain" }] });
});

test("presignPut passes method, expiry and type", () => {
  const { client, calls } = fakeClient();
  expect(new R2FileStore(cfg, client).presignPut("k", 600, "image/png")).toBe("https://signed");
  expect(calls[0]?.args).toEqual(["k", { method: "PUT", expiresIn: 600, type: "image/png" }]);
});

test("presignGet makes a safe download name", () => {
  const { client, calls } = fakeClient();
  new R2FileStore(cfg, client).presignGet("k", 900, { downloadName: 'a"b.pdf' });
  expect(calls[0]?.args).toEqual([
    "k",
    { expiresIn: 900, contentDisposition: 'attachment; filename="a_b.pdf"' },
  ]);
});

test("presignGet without a name sets no disposition", () => {
  const { client, calls } = fakeClient();
  new R2FileStore(cfg, client).presignGet("k", 900);
  expect(calls[0]?.args).toEqual(["k", { expiresIn: 900, contentDisposition: undefined }]);
});

test("readHead slices 0..n", async () => {
  const { client, calls } = fakeClient();
  await new R2FileStore(cfg, client).readHead("k", 12);
  expect(calls.find((c) => c.op === "slice")?.args).toEqual([0, 12]);
});

test("default client uses the account endpoint", () => {
  const store = new R2FileStore(cfg);
  expect(store.endpoint).toBe("https://acc1.r2.cloudflarestorage.com");
});
