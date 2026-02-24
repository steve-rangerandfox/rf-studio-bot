/**
 * Script file parser for Cloudflare Workers.
 *
 * Supports:
 * - .txt: Direct text extraction
 * - .docx: ZIP-based XML extraction using fflate
 * - .pdf: Not supported on edge — returns error asking user to use .txt or .docx
 */

import { unzipSync } from "fflate";

/**
 * Parses a script from either a file (ArrayBuffer + metadata) or raw text.
 *
 * @param {object} input - Either { buffer, mimeType, fileName } or { text }
 * @param {ArrayBuffer} [input.buffer] - File content as ArrayBuffer
 * @param {string} [input.mimeType] - MIME type of the file
 * @param {string} [input.fileName] - Original filename
 * @param {string} [input.text] - Raw pasted text
 * @returns {Promise<string>} The extracted plain text
 */
export async function parseScript(input) {
  if (input.text) {
    return cleanText(input.text);
  }

  const { buffer, mimeType, fileName } = input;

  // Determine type by MIME type first, then by extension
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    fileName.toLowerCase().endsWith(".docx")
  ) {
    return parseDocx(buffer);
  }

  if (mimeType === "text/plain" || fileName.toLowerCase().endsWith(".txt")) {
    return cleanText(new TextDecoder("utf-8").decode(buffer));
  }

  if (mimeType === "application/pdf" || fileName.toLowerCase().endsWith(".pdf")) {
    throw new Error(
      "PDF parsing is not supported in this environment. " +
      "Please paste your script text directly, or upload a .docx or .txt file instead."
    );
  }

  // Try to infer from extension
  const ext = fileName.toLowerCase().split(".").pop();
  if (ext === "docx") return parseDocx(buffer);
  if (ext === "txt") return cleanText(new TextDecoder("utf-8").decode(buffer));

  throw new Error(
    `Unsupported file type: ${mimeType} (${fileName}). Supported formats: .docx, .txt`
  );
}

/**
 * Extracts plain text from a .docx file (which is a ZIP containing XML).
 * Uses fflate to decompress and parses word/document.xml for text content.
 *
 * @param {ArrayBuffer} buffer - The .docx file content
 * @returns {string} The extracted text
 */
function parseDocx(buffer) {
  // Decompress the ZIP
  const uint8 = new Uint8Array(buffer);
  let entries;
  try {
    entries = unzipSync(uint8);
  } catch (err) {
    throw new Error(`Failed to decompress .docx file: ${err.message}`);
  }

  // Find word/document.xml
  const docXmlBytes = entries["word/document.xml"];
  if (!docXmlBytes) {
    throw new Error(
      "Invalid .docx file: word/document.xml not found in archive."
    );
  }

  // Decode the XML as UTF-8
  const xmlString = new TextDecoder("utf-8").decode(docXmlBytes);

  // Extract text from the XML
  // The document.xml contains <w:t> elements with the actual text content.
  // We also respect <w:p> (paragraph) boundaries to insert line breaks.
  const paragraphs = [];
  // Split by paragraph tags
  const paraRegex = /<w:p[\s>][^]*?<\/w:p>/g;
  let paraMatch;

  while ((paraMatch = paraRegex.exec(xmlString)) !== null) {
    const paraXml = paraMatch[0];

    // Extract all <w:t> text content within this paragraph
    const textParts = [];
    const textRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    let textMatch;

    while ((textMatch = textRegex.exec(paraXml)) !== null) {
      textParts.push(textMatch[1]);
    }

    // Join text parts for this paragraph (w:t elements within the same
    // paragraph are contiguous text runs)
    const paraText = textParts.join("");
    paragraphs.push(paraText);
  }

  // If no paragraphs found via regex, try a simpler fallback: just extract all <w:t> tags
  if (paragraphs.length === 0) {
    const allTextRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    let allMatch;
    const allParts = [];
    while ((allMatch = allTextRegex.exec(xmlString)) !== null) {
      allParts.push(allMatch[1]);
    }
    if (allParts.length > 0) {
      return cleanText(allParts.join(" "));
    }
    throw new Error(
      "Could not extract text from .docx file. The document may be empty or use an unsupported format."
    );
  }

  // Decode XML entities
  const rawText = paragraphs.map(decodeXmlEntities).join("\n");
  return cleanText(rawText);
}

/**
 * Decodes basic XML entities.
 */
function decodeXmlEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Cleans extracted text by normalizing whitespace and trimming.
 */
function cleanText(raw) {
  return (
    raw
      // Normalize line endings
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      // Collapse 3+ consecutive newlines into 2
      .replace(/\n{3,}/g, "\n\n")
      // Trim leading/trailing whitespace from each line
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      // Trim the entire string
      .trim()
  );
}
