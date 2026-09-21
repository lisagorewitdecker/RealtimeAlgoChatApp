import { readBoundedTextFileSync } from "./read-bounded-text.mjs";

/**
 * Structural verdicts for a Maestro JUnit report.
 *
 * These are the only values that reach a caller. A malformed report's
 * contents, its element text, and the position at which scanning stopped are
 * deliberately not reported: release diagnostics quote the verdict and the
 * file path, never anything read out of the file.
 */
export const JUNIT_REPORT_VALID = "valid";
export const JUNIT_REPORT_NOT_WELL_FORMED = "not-well-formed";
export const JUNIT_REPORT_NO_TESTSUITE = "no-testsuite";
export const JUNIT_REPORT_TOO_LARGE = "too-large";
export const JUNIT_REPORT_UNREADABLE = "unreadable";

// A JUnit report nests at most testsuites > testsuite > testcase > failure.
// The bound keeps a hostile file from driving unbounded recursion-like growth
// through the open-element stack.
const MAX_ELEMENT_DEPTH = 64;

const NAME_START_PATTERN = /[A-Za-z_:]/;
const NAME_PATTERN = /[-A-Za-z0-9._:]/;
const WHITESPACE_PATTERN = /\s/;
const DECIMAL_PATTERN = /^[0-9]+$/;
const HEXADECIMAL_PATTERN = /^[0-9A-Fa-f]+$/;

// A report carries no document type declaration, so no entity can be declared
// for it. Only the five entities XML predefines may appear by name.
const PREDEFINED_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos"]);

// `<?xml version="1.0" encoding="UTF-8"?>` and the narrower forms the native
// runners emit. Anything else using the reserved `xml` target is rejected.
const XML_DECLARATION_PATTERN =
  /^xml\s+version\s*=\s*("1\.[0-9]+"|'1\.[0-9]+')(\s+encoding\s*=\s*("[A-Za-z][-A-Za-z0-9._]*"|'[A-Za-z][-A-Za-z0-9._]*'))?(\s+standalone\s*=\s*("(?:yes|no)"|'(?:yes|no)'))?\s*$/;

function isLegalXmlCodePoint(codePoint) {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

/**
 * Consumes the reference beginning at `start` (an `&`) in `text` and returns
 * the index just past its `;`, or -1 when the reference is not well-formed.
 */
function readReference(text, start) {
  const semicolon = text.indexOf(";", start + 1);
  if (semicolon === -1 || semicolon === start + 1) {
    return -1;
  }
  const body = text.slice(start + 1, semicolon);

  if (body[0] === "#") {
    const hexadecimal = body[1] === "x";
    const digits = hexadecimal ? body.slice(2) : body.slice(1);
    const digitPattern = hexadecimal ? HEXADECIMAL_PATTERN : DECIMAL_PATTERN;
    if (!digitPattern.test(digits)) {
      return -1;
    }
    const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
    if (!Number.isSafeInteger(codePoint) || !isLegalXmlCodePoint(codePoint)) {
      return -1;
    }
    return semicolon + 1;
  }

  if (!NAME_START_PATTERN.test(body[0] ?? "")) {
    return -1;
  }
  for (let index = 1; index < body.length; index += 1) {
    if (!NAME_PATTERN.test(body[index])) {
      return -1;
    }
  }
  if (!PREDEFINED_ENTITIES.has(body)) {
    return -1;
  }
  return semicolon + 1;
}

/** Reports whether every reference in an attribute value is well-formed. */
function attributeValueIsWellFormed(value) {
  if (value.includes("<")) {
    return false;
  }
  let index = 0;
  while (index < value.length) {
    if (value[index] !== "&") {
      index += 1;
      continue;
    }
    const next = readReference(value, index);
    if (next === -1) {
      return false;
    }
    index = next;
  }
  return true;
}

/**
 * Scans `reportText` for XML well-formedness and for a JUnit testsuite
 * element.
 *
 * The scan enforces the well-formedness rules a truncated, hand-assembled, or
 * hostile upload breaks: balanced and correctly nested elements, a single
 * root, quoted attribute values with no raw `<`, references that resolve to a
 * predefined entity or a legal character, terminated comments with no internal
 * `--`, terminated CDATA sections, processing instructions that do not reuse
 * the reserved `xml` target, an XML declaration only at the start of the
 * document, and no `]]>` in ordinary text.
 *
 * Raw control characters in text and CDATA are deliberately tolerated. Real
 * device logs carry terminal escape bytes, and their presence says nothing
 * about whether the upload is complete; rejecting them would block a release
 * on captured log formatting rather than on missing evidence.
 *
 * A document type declaration is rejected. The native runners never emit one,
 * so its presence means the file did not come from the expected producer, and
 * without one no entity beyond the predefined five can be declared.
 *
 * @param {string} reportText
 * @returns {typeof JUNIT_REPORT_VALID | typeof JUNIT_REPORT_NOT_WELL_FORMED | typeof JUNIT_REPORT_NO_TESTSUITE}
 */
export function inspectJUnitReportText(reportText) {
  const text =
    reportText.charCodeAt(0) === 0xfeff ? reportText.slice(1) : reportText;
  const openElements = [];
  let index = 0;
  let rootSeen = false;
  let rootClosed = false;
  let testsuiteSeen = false;

  const skipWhitespace = () => {
    while (index < text.length && WHITESPACE_PATTERN.test(text[index])) {
      index += 1;
    }
  };

  const readName = () => {
    if (index >= text.length || !NAME_START_PATTERN.test(text[index])) {
      return null;
    }
    const start = index;
    index += 1;
    while (index < text.length && NAME_PATTERN.test(text[index])) {
      index += 1;
    }
    return text.slice(start, index);
  };

  // Consumes attributes and the tag terminator. Returns null when the tag is
  // malformed or truncated.
  const readAttributesAndTagEnd = () => {
    const seenAttributes = new Set();
    for (;;) {
      const beforeWhitespace = index;
      skipWhitespace();
      const hadWhitespace = index > beforeWhitespace;

      if (index >= text.length) {
        return null;
      }
      if (text[index] === ">") {
        index += 1;
        return { selfClosing: false };
      }
      if (text[index] === "/") {
        if (text[index + 1] !== ">") {
          return null;
        }
        index += 2;
        return { selfClosing: true };
      }
      if (!hadWhitespace) {
        return null;
      }

      const attributeName = readName();
      if (!attributeName || seenAttributes.has(attributeName)) {
        return null;
      }
      seenAttributes.add(attributeName);

      skipWhitespace();
      if (text[index] !== "=") {
        return null;
      }
      index += 1;
      skipWhitespace();

      const quote = text[index];
      if (quote !== '"' && quote !== "'") {
        return null;
      }
      const valueEnd = text.indexOf(quote, index + 1);
      if (valueEnd === -1) {
        return null;
      }
      if (!attributeValueIsWellFormed(text.slice(index + 1, valueEnd))) {
        return null;
      }
      index = valueEnd + 1;
    }
  };

  while (index < text.length) {
    const character = text[index];

    if (character !== "<") {
      // Only whitespace may appear outside the root element.
      if (openElements.length === 0) {
        if (!WHITESPACE_PATTERN.test(character)) {
          return JUNIT_REPORT_NOT_WELL_FORMED;
        }
        index += 1;
        continue;
      }
      if (character === "&") {
        const next = readReference(text, index);
        if (next === -1) {
          return JUNIT_REPORT_NOT_WELL_FORMED;
        }
        index = next;
        continue;
      }
      if (character === "]" && text.startsWith("]]>", index)) {
        return JUNIT_REPORT_NOT_WELL_FORMED;
      }
      index += 1;
      continue;
    }

    if (text.startsWith("<!--", index)) {
      const commentEnd = text.indexOf("-->", index + 4);
      if (commentEnd === -1) {
        return JUNIT_REPORT_NOT_WELL_FORMED;
      }
      const commentBody = text.slice(index + 4, commentEnd);
      if (commentBody.includes("--") || commentBody.endsWith("-")) {
        return JUNIT_REPORT_NOT_WELL_FORMED;
      }
      index = commentEnd + 3;
      continue;
    }

    if (text.startsWith("<![CDATA[", index)) {
      if (openElements.length === 0) {
        return JUNIT_REPORT_NOT_WELL_FORMED;
      }
      const sectionEnd = text.indexOf("]]>", index + 9);
      if (sectionEnd === -1) {
        return JUNIT_REPORT_NOT_WELL_FORMED;
      }
      index = sectionEnd + 3;
      continue;
    }

    if (text.startsWith("<?", index)) {
      const instructionEnd = text.indexOf("?>", index + 2);
      if (instructionEnd === -1) {
        return JUNIT_REPORT_NOT_WELL_FORMED;
      }
      const instruction = text.slice(index + 2, instructionEnd);
      const targetEnd = (() => {
        if (!NAME_START_PATTERN.test(instruction[0] ?? "")) {
          return -1;
        }
        let cursor = 1;
        while (cursor < instruction.length && NAME_PATTERN.test(instruction[cursor])) {
          cursor += 1;
        }
        return cursor;
      })();
      if (targetEnd === -1) {
        return JUNIT_REPORT_NOT_WELL_FORMED;
      }
      const target = instruction.slice(0, targetEnd);
      const remainder = instruction.slice(targetEnd);
      if (remainder.length > 0 && !WHITESPACE_PATTERN.test(remainder[0])) {
        return JUNIT_REPORT_NOT_WELL_FORMED;
      }
      if (target.toLowerCase() === "xml") {
        // The reserved target is the XML declaration, which may appear only as
        // the very first thing in the document.
        if (index !== 0 || !XML_DECLARATION_PATTERN.test(instruction)) {
          return JUNIT_REPORT_NOT_WELL_FORMED;
        }
      }
      index = instructionEnd + 2;
      continue;
    }

    if (text.startsWith("<!", index)) {
      return JUNIT_REPORT_NOT_WELL_FORMED;
    }

    if (text.startsWith("</", index)) {
      index += 2;
      const name = readName();
      if (!name) {
        return JUNIT_REPORT_NOT_WELL_FORMED;
      }
      skipWhitespace();
      if (text[index] !== ">") {
        return JUNIT_REPORT_NOT_WELL_FORMED;
      }
      index += 1;
      if (openElements.pop() !== name) {
        return JUNIT_REPORT_NOT_WELL_FORMED;
      }
      if (openElements.length === 0) {
        rootClosed = true;
      }
      continue;
    }

    // Start tag.
    if (rootClosed) {
      return JUNIT_REPORT_NOT_WELL_FORMED;
    }
    index += 1;
    const name = readName();
    if (!name) {
      return JUNIT_REPORT_NOT_WELL_FORMED;
    }
    const depth = openElements.length;
    const tagEnd = readAttributesAndTagEnd();
    if (!tagEnd) {
      return JUNIT_REPORT_NOT_WELL_FORMED;
    }

    if (name === "testsuite") {
      // A report is either a bare <testsuite> root or a <testsuites> root
      // holding <testsuite> children. A testsuite nested anywhere else is not
      // the report's own result element.
      if (depth === 0 || (depth === 1 && openElements[0] === "testsuites")) {
        testsuiteSeen = true;
      }
    }

    if (depth === 0) {
      rootSeen = true;
    }
    if (tagEnd.selfClosing) {
      if (depth === 0) {
        rootClosed = true;
      }
    } else {
      openElements.push(name);
      if (openElements.length > MAX_ELEMENT_DEPTH) {
        return JUNIT_REPORT_NOT_WELL_FORMED;
      }
    }
  }

  if (!rootSeen || !rootClosed || openElements.length > 0) {
    return JUNIT_REPORT_NOT_WELL_FORMED;
  }
  return testsuiteSeen ? JUNIT_REPORT_VALID : JUNIT_REPORT_NO_TESTSUITE;
}

/**
 * Reads a JUnit report within the shared release evidence size bound and
 * returns its structural verdict. Read failures and oversized files are
 * verdicts too, so a caller can fail closed without inspecting the file.
 *
 * @param {string} reportPath
 * @returns {string}
 */
export function inspectJUnitReportFile(reportPath) {
  let reportText;
  try {
    reportText = readBoundedTextFileSync(reportPath);
  } catch (error) {
    if (error?.code === "JSON_EVIDENCE_TOO_LARGE") {
      return JUNIT_REPORT_TOO_LARGE;
    }
    return JUNIT_REPORT_UNREADABLE;
  }
  return inspectJUnitReportText(reportText);
}
