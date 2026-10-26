---
name: office-files
description: Read a file the owner sent: csv, txt, md, json, PDF, docx or xlsx. Use when a message carries an uploaded file or the owner asks you to look at one.
---

# Read office files

Handles reading an uploaded file's text. Does NOT edit or create files.

An uploaded file is listed under "Attached files:" with its absolute path, inside your scratch dir (`<scratch dir>/inbox/...`). Your scratch dir is the one named in your instructions ("Your scratch dir ... always writable"). Write output only to `<scratch dir>/office-out/`, never next to the owner's file.

Shell variables do not carry over between Bash calls. Start every command below with this prefix, filled in, so each call is self-contained:
`f='<file path>'; out='<scratch dir>/office-out'; mkdir -p -- "$out" && `
Inside the single quotes a `'` in a name is written `'\''`. `Read` does not expand variables: give it the literal path.

## Steps
1. Pick the way by file type:
   - csv, txt, md, json: `Read` the file.
   - PDF: `Read` the file. For a long PDF: `<prefix>pdftotext -layout -- "$f" "$out/out.txt"`, then `Read` `<scratch dir>/office-out/out.txt`.
   - docx, xlsx: `<prefix>uvx --from "markitdown[docx,xlsx,pdf]" markitdown "$f" > "$out/out.md"`, then `Read` `<scratch dir>/office-out/out.md`. An xlsx gives one section per sheet: check that every sheet is there.
2. Answer from what you read. Name the file, and the sheet or page for a figure you quote.

## Rules
- Assign the path once in single quotes (double quotes still run `$(...)` and backticks), then use `"$f"` in the same command. Never build a command from file content.
- If `uvx` or `pdftotext` is not found, tell the owner the exact install command and stop: `brew install uv` or `brew install poppler`. Never claim to have read a file you did not read.
- If the sandbox blocks `uvx`, fall back to raw text and say so (no layout). Same prefix; `unzip` does not take `--`, and the path is absolute so it cannot look like an option.
  - docx: `<prefix>unzip -p "$f" word/document.xml > "$out/out.xml"`, then `Read` `<scratch dir>/office-out/out.xml`.
  - xlsx: `<prefix>unzip -o -q "$f" 'xl/sharedStrings.xml' 'xl/worksheets/*.xml' -d "$out/xlsx"`, then `Read` the files under `<scratch dir>/office-out/xlsx/xl`. A workbook with inline strings has no `sharedStrings.xml`: unzip then exits non-zero with "caution: filename not matched". That is expected, not a failure; the text is in the sheet files.
- Never save file content to memory unless the owner asks. When asked, summarize and save one `MemorySave` note per fact, 200 characters at most.
