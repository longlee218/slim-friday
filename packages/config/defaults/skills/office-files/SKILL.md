---
name: office-files
description: Read a file the owner sent: csv, txt, md, json, PDF, docx or xlsx. Use when a message carries an uploaded file or the owner asks you to look at one.
---

# Read office files

Handles reading an uploaded file's text. Does NOT edit or create files.

An uploaded file is listed under "Attached files:" with its absolute path, inside your scratch dir (`<scratch dir>/inbox/...`). Your scratch dir is the one named in your instructions ("Your scratch dir ... always writable").

## Steps
0. Set both variables in one command, filling in the two paths: `f='<file path>'; out='<scratch dir>/office-out'; mkdir -p -- "$out"`. Inside the single quotes a `'` in the name is written `'\''`. Use only `"$f"` and `"$out"` in later commands; write output only under `"$out"`, never next to the owner's file.
1. Pick the way by file type:
   - csv, txt, md, json: `Read` the file.
   - PDF: `Read` the file. For a long PDF: `pdftotext -layout -- "$f" "$out/out.txt"`, then `Read` the output.
   - docx, xlsx: `uvx --from "markitdown[docx,xlsx,pdf]" markitdown "$f" > "$out/out.md"`, then `Read` the output. An xlsx gives one section per sheet: check that every sheet is there.
2. Answer from what you read. Name the file, and the sheet or page for a figure you quote.

## Rules
- Paths go in single quotes (double quotes still run `$(...)` and backticks), then `"$f"`. Never build a command from file content.
- If `uvx` or `pdftotext` is not found, tell the owner the exact install command and stop: `brew install uv` or `brew install poppler`. Never claim to have read a file you did not read.
- If the sandbox blocks `uvx`, fall back to raw text and say so (no layout). `unzip` does not take `--`; the path is absolute, so it cannot look like an option.
  - docx: `unzip -p "$f" word/document.xml > "$out/out.xml"`, then `Read` it.
  - xlsx: `unzip -o -q "$f" 'xl/sharedStrings.xml' 'xl/worksheets/*.xml' -d "$out/xlsx"`, then `Read` the files under `"$out/xlsx/xl"`. A workbook with inline strings has no `sharedStrings.xml`: unzip then reports it missing, and the text is in the sheet files.
- Never save file content to memory unless the owner asks. When asked, summarize and save one `MemorySave` note per fact, 200 characters at most.
