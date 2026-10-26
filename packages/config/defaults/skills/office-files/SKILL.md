---
name: office-files
description: Read a file the owner sent: csv, txt, md, json, PDF, docx or xlsx. Use when a message carries an uploaded file or the owner asks you to look at one.
---

# Read office files

Handles reading an uploaded file's text. Does NOT edit or create files.

## Steps
1. Pick the way by file type:
   - csv, txt, md, json: `Read` the file.
   - PDF: `Read` the file. For a long PDF: `pdftotext -layout <file> <scratch>/out.txt`, then `Read` the output.
   - docx, xlsx: `uvx --from "markitdown[docx,xlsx,pdf]" markitdown <file> > <scratch>/out.md`, then `Read` the output. An xlsx gives one section per sheet: check that every sheet is there.
2. `<scratch>` is the run's scratch dir (`mcp__scratchpad`). Write output only there, never next to the owner's file.
3. Answer from what you read. Name the file, and the sheet or page for a figure you quote.

## Rules
- If `uvx` or `pdftotext` is not found, tell the owner the exact install command and stop: `brew install uv` or `brew install poppler`. Never claim to have read a file you did not read.
- If the sandbox blocks `uvx`, fall back: `unzip -p <file>.docx word/document.xml` for docx, `python3 -c "import zipfile..."` reading `xl/sharedStrings.xml` and `xl/worksheets/*.xml` for xlsx. Say the result is raw text, without layout.
- Never save file content to memory unless the owner asks. When asked, summarize and save one `MemorySave` note per fact, 200 characters at most.
