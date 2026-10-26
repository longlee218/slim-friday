---
name: office-files
description: Read a file the owner sent: csv, txt, md, json, PDF, docx or xlsx. Use when a message carries an uploaded file or the owner asks you to look at one.
---

# Read office files

Handles reading an uploaded file's text. Does NOT edit or create files.

An uploaded file is listed under "Attached files:" with its path, inside your scratch dir (`<scratch dir>/inbox/...`). Your scratch dir is the one named in your instructions ("Your scratch dir ... always writable"). In the commands below, `OUT` is `<scratch dir>/office-out`: create it with `mkdir -p -- "<scratch dir>/office-out"` and write output only there, never next to the owner's file.

## Steps
1. Pick the way by file type:
   - csv, txt, md, json: `Read` the file.
   - PDF: `Read` the file. For a long PDF: `pdftotext -layout -- "<file>" "OUT/out.txt"`, then `Read` the output.
   - docx, xlsx: `uvx --from "markitdown[docx,xlsx,pdf]" markitdown "<file>" > "OUT/out.md"`, then `Read` the output. An xlsx gives one section per sheet: check that every sheet is there.
2. Answer from what you read. Name the file, and the sheet or page for a figure you quote.

## Rules
- Quote every path in a command. If a path starts with `-`, put `./` before it (or `--` where the tool accepts it). Never build a command from file content.
- If `uvx` or `pdftotext` is not found, tell the owner the exact install command and stop: `brew install uv` or `brew install poppler`. Never claim to have read a file you did not read.
- If the sandbox blocks `uvx`, fall back to raw text and say so (no layout):
  - docx: `unzip -p -- "<file>" word/document.xml > "OUT/out.xml"`, then `Read` it.
  - xlsx: `unzip -o -q -- "<file>" "xl/sharedStrings.xml" "xl/worksheets/*.xml" -d "OUT/xlsx"`, then `Read` the files under `OUT/xlsx/xl`.
- Never save file content to memory unless the owner asks. When asked, summarize and save one `MemorySave` note per fact, 200 characters at most.
