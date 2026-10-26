import { expect, test } from "bun:test";
import { ACCEPTED_FILE_TYPES, acceptedMimeForName } from "../src/accepted-types";

const TABLE: Record<string, string> = {
  "a.jpg": "image/jpeg",
  "a.jpeg": "image/jpeg",
  "a.png": "image/png",
  "a.gif": "image/gif",
  "a.webp": "image/webp",
  "a.pdf": "application/pdf",
  "a.csv": "text/csv",
  "a.txt": "text/plain",
  "a.md": "text/markdown",
  "a.json": "application/json",
  "a.docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "a.xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

test("every accepted extension resolves to its mime, case-insensitively", () => {
  for (const [name, mime] of Object.entries(TABLE)) {
    expect(acceptedMimeForName(name)).toBe(mime);
    expect(acceptedMimeForName(name.toUpperCase())).toBe(mime);
  }
  expect(Object.keys(ACCEPTED_FILE_TYPES)).toHaveLength(Object.keys(TABLE).length);
});

test("other names are refused", () => {
  for (const name of ["a.tar.gz", "noext", "x.exe", ".png", "", "a.", "a.png.exe"]) {
    expect(acceptedMimeForName(name)).toBeUndefined();
  }
});
