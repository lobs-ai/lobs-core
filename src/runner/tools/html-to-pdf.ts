/**
 * html_to_pdf — Convert HTML content or an HTML file to PDF using Chrome headless.
 * Saves the result to ~/.lobs/media/ and returns a download link.
 */

import type { ToolDefinition, ToolExecutorResult } from "../types.js";
import { writeFileSync, mkdirSync, existsSync, unlinkSync, statSync } from "fs";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import { execSync } from "child_process";
import { getLobsRoot } from "../../config/lobs.js";

const MEDIA_DIR = join(getLobsRoot(), "media");

// Chrome paths to try (macOS, Linux)
const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];

function findChrome(): string | null {
  for (const p of CHROME_PATHS) {
    try {
      execSync(`test -x "${p}"`, { stdio: "ignore" });
      return p;
    } catch {
      continue;
    }
  }
  return null;
}

export const htmlToPdfToolDefinition: ToolDefinition = {
  name: "html_to_pdf",
  description:
    "Convert HTML to a PDF file. Provide either an HTML file path or raw HTML content. Uses Chrome headless for high-fidelity rendering with full CSS support (gradients, fonts, flexbox, grid). The PDF is saved to the media directory and a download link is returned. Great for generating flyers, reports, invoices, or any printable document.",
  input_schema: {
    type: "object" as const,
    properties: {
      html: {
        type: "string",
        description: "Raw HTML content to convert. Provide this or `path`, not both.",
      },
      path: {
        type: "string",
        description: "Path to an HTML file to convert. Provide this or `html`, not both.",
      },
      filename: {
        type: "string",
        description:
          "Output filename for the PDF (e.g. 'flyer.pdf'). Defaults to 'document.pdf'. This is the name users see when downloading.",
      },
      margins: {
        type: "boolean",
        description: "Include default print margins (default: false, no margins).",
      },
    },
    required: [],
  },
};

export async function htmlToPdfTool(
  params: Record<string, unknown>,
  cwd: string,
): Promise<ToolExecutorResult> {
  const html = params.html as string | undefined;
  const filePath = params.path as string | undefined;
  const outputName = (params.filename as string) || "document.pdf";
  const margins = params.margins as boolean | undefined;

  if (!html && !filePath) {
    return "Error: provide either `html` (raw HTML string) or `path` (path to an HTML file).";
  }
  if (html && filePath) {
    return "Error: provide either `html` or `path`, not both.";
  }

  const chrome = findChrome();
  if (!chrome) {
    return "Error: Chrome/Chromium not found. Install Google Chrome to use this tool.";
  }

  // Ensure media dir exists
  if (!existsSync(MEDIA_DIR)) {
    mkdirSync(MEDIA_DIR, { recursive: true });
  }

  let inputPath: string;
  let tempFile = false;

  if (html) {
    // Write HTML to a temp file
    const tmpPath = join(MEDIA_DIR, `_tmp_${randomUUID()}.html`);
    writeFileSync(tmpPath, html);
    inputPath = tmpPath;
    tempFile = true;
  } else {
    // Resolve the file path relative to cwd
    inputPath = resolve(cwd, filePath!);
    if (!existsSync(inputPath)) {
      return `Error: file not found: ${inputPath}`;
    }
  }

  const mediaId = randomUUID();
  const pdfFilename = `${mediaId}.pdf`;
  const pdfPath = join(MEDIA_DIR, pdfFilename);

  try {
    const marginFlag = margins ? "" : "--no-margins";
    const cmd = `"${chrome}" --headless --disable-gpu --print-to-pdf="${pdfPath}" ${marginFlag} "${inputPath}"`;

    execSync(cmd, {
      timeout: 30000,
      stdio: "pipe",
    });

    // Clean up temp file
    if (tempFile) {
      try { unlinkSync(inputPath); } catch { /* ignore */ }
    }

    if (!existsSync(pdfPath)) {
      return "Error: Chrome ran but no PDF was generated.";
    }

    const { size } = statSync(pdfPath);
    const sizeKb = (size / 1024).toFixed(0);

    // Also save the HTML source if it was inline
    let htmlLink = "";
    if (html) {
      const htmlId = randomUUID();
      const htmlFilename = `${htmlId}.html`;
      writeFileSync(join(MEDIA_DIR, htmlFilename), html);
      const htmlName = outputName.replace(/\.pdf$/i, ".html");
      htmlLink = `\nHTML source: [${htmlName}](/api/media/${htmlFilename})`;
    }

    return [
      `PDF generated (${sizeKb} KB)`,
      ``,
      `[${outputName}](/api/media/${pdfFilename})`,
      htmlLink,
    ].filter(Boolean).join("\n");
  } catch (error) {
    // Clean up temp file on error too
    if (tempFile) {
      try { unlinkSync(inputPath); } catch { /* ignore */ }
    }
    const msg = error instanceof Error ? error.message : String(error);
    return `Error generating PDF: ${msg}`;
  }
}
