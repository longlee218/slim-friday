/* Live R2 smoke (not in the suite): bun scripts/smoke-r2.ts. Prints step names and ok only. */
import { R2FileStore } from "../packages/store-r2/src/index";

const need = (n: string): string => {
  const v = process.env[n];
  if (!v) {
    console.log(`missing env ${n}`);
    process.exit(1);
  }
  return v;
};

const store = new R2FileStore({
  accountId: need("R2_ACCOUNT_ID"),
  accessKeyId: need("R2_ACCESS_KEY_ID"),
  secretAccessKey: need("R2_SECRET_ACCESS_KEY"),
  bucket: need("R2_BUCKET"),
});
const a = `smoke/${crypto.randomUUID()}.txt`;
const b = `smoke/${crypto.randomUUID()}.txt`;
let step = "start";
try {
  step = "put";
  await store.put(a, new Uint8Array([1, 2, 3]), "application/octet-stream");
  step = "stat";
  if ((await store.stat(a))?.size !== 3) throw new Error("size");
  step = "readHead";
  if ((await store.readHead(a, 2)).length !== 2) throw new Error("head");
  step = "presignGet";
  const got = await fetch(store.presignGet(a, 60, { downloadName: "déjà.bin" }));
  if (!got.ok) throw new Error(`status ${got.status}`);
  if (!got.headers.get("content-disposition")?.includes("attachment")) {
    throw new Error("no content-disposition");
  }
  step = "presignPut";
  const put = await fetch(store.presignPut(b, 60, "text/plain"), { method: "PUT", body: "hi" });
  if (!put.ok) throw new Error(`status ${put.status}`);
  step = "delete";
  await store.delete(a);
  await store.delete(b);
  if (await store.stat(a)) throw new Error("still there");
  console.log("ok");
} catch (err) {
  await store.delete(a).catch(() => {});
  await store.delete(b).catch(() => {});
  // Only the step and an HTTP status: error text can carry signed URLs or credentials.
  const status = /^status (\d+)$/.exec((err as Error).message)?.[1];
  console.log(`failed at ${step}${status ? ` (HTTP ${status})` : ""}`);
  process.exit(1);
}
