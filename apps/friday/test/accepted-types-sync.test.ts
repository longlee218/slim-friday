import { expect, test } from "bun:test";
import { ACCEPTED_FILE_TYPES as web } from "@friday/contracts";
import { ACCEPTED_FILE_TYPES as surface } from "../../../packages/surface-web/src/accepted-types";

test("the surface and contracts accepted-type tables are the same", () => {
  expect(surface).toEqual(web);
});
