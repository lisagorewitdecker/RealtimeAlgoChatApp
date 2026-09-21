import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  JUNIT_REPORT_NOT_WELL_FORMED,
  JUNIT_REPORT_NO_TESTSUITE,
  JUNIT_REPORT_TOO_LARGE,
  JUNIT_REPORT_UNREADABLE,
  JUNIT_REPORT_VALID,
  inspectJUnitReportFile,
  inspectJUnitReportText,
} from "../validate-junit-xml.mjs";

const ESCAPE = String.fromCharCode(0x1b);

// The exact documents the native runners and the release fixtures produce. A
// change that rejects any of these blocks a real release.
const producerReports = {
  "the Maestro fixture form": '<testsuite tests="1" failures="0"></testsuite>\n',
  "the self-closing summary-regression form":
    '<testsuite name="native-large-text"/>\n',
  "a full Maestro document": [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!-- Maestro JUnit output -->",
    '<testsuites name="maestro" tests="2" failures="0">',
    '  <testsuite name="native-large-text" tests="2" failures="0" time="12.5">',
    '    <testcase name="opens the room" classname="flow" time="6.25"/>',
    '    <testcase name="sends a message" classname="flow" time="6.25">',
    "      <system-out><![CDATA[log line with <brackets> & an ampersand]]></system-out>",
    "    </testcase>",
    "  </testsuite>",
    "</testsuites>",
    "",
  ].join("\n"),
  "escaped text and attributes":
    '<testsuite name="a &amp; b">\n  <testcase name="1 &lt; 2">&#10;&#x41;</testcase>\n</testsuite>\n',
  "CRLF line endings": '<testsuite tests="1">\r\n</testsuite>\r\n',
  "a byte order mark": '\ufeff<testsuite tests="1"/>\n',
  "single-quoted attributes": "<testsuite name='sentry-probe'/>\n",
  "a trailing comment": '<testsuite tests="1"/>\n<!-- uploaded -->\n',
  "a lower-case UTF-8 declaration":
    '<?xml version="1.0" encoding="utf-8"?><testsuite/>',
  "a standalone declaration":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><testsuite/>',
  "device log text with tabs and non-ASCII characters":
    '<testsuite name="x"><system-out>\tlaunched \u2713 caf\u00e9 \ud83d\ude80</system-out></testsuite>',
};

for (const [description, reportText] of Object.entries(producerReports)) {
  test("accepts " + description, () => {
    assert.equal(inspectJUnitReportText(reportText), JUNIT_REPORT_VALID);
  });
}

// Each entry is a document that an XML parser rejects. A release gate that
// accepts any of them lets unparseable evidence reach review.
const notWellFormedReports = {
  "an empty file": "",
  "whitespace only": "\n  \n",
  "a truncated upload": [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites name="maestro">',
    '  <testsuite name="native-large-text">',
    '    <testcase name="opens the room">',
    "",
  ].join("\n"),
  "a log dump that merely mentions a testsuite":
    'Maestro aborted. Raw log: <testsuite tests="1">\n',
  "text after the root element": '<testsuite tests="1"/> trailing text\n',
  "a second root element": '<testsuite tests="1"/><testsuite tests="1"/>\n',
  "mismatched end tags": "<testsuite><testcase></testsuite></testcase>",
  "an unclosed attribute value": '<testsuite name="x>\n',
  "an unquoted attribute value": "<testsuite name=x/>\n",
  "a duplicate attribute": '<testsuite name="a" name="b"/>\n',
  "a raw left angle bracket inside an attribute value": '<testsuite name="a<b"/>\n',
  "attributes with no separating space": '<testsuite a="1"b="2"/>\n',
  "an undeclared entity": "<testsuite>&bogus;</testsuite>",
  "a raw ampersand in text": "<testsuite>Chat & Rooms</testsuite>",
  "a raw ampersand in an attribute value": '<testsuite name="a&b"/>',
  "an unterminated reference": "<testsuite>&amp</testsuite>",
  "an empty character reference": "<testsuite>&#;</testsuite>",
  "a non-hexadecimal character reference": "<testsuite>&#xZZ;</testsuite>",
  "a character reference to a forbidden character": "<testsuite>&#0;</testsuite>",
  "a double hyphen inside a comment": "<testsuite><!-- a -- b --></testsuite>",
  "a comment ending in a hyphen": "<testsuite><!-- a ---></testsuite>",
  "an unterminated comment": "<testsuite><!-- a </testsuite>",
  "an unterminated CDATA section": "<testsuite><![CDATA[a</testsuite>",
  "a CDATA section outside the root": "<![CDATA[a]]><testsuite/>",
  "a CDATA terminator in ordinary text": "<testsuite>a]]>b</testsuite>",
  "a reserved xml processing instruction inside the root":
    '<testsuite><?xml version="1.0"?></testsuite>',
  "a second XML declaration":
    '<?xml version="1.0"?><?xml version="1.0"?><testsuite/>',
  "an XML declaration after content":
    '<!-- lead --><?xml version="1.0"?><testsuite/>',
  "a malformed XML declaration": "<?xml foo?><testsuite/>",
  "a processing instruction with no target": "<testsuite><? nothing ?></testsuite>",
  "an unterminated processing instruction": '<?xml version="1.0"\n<testsuite/>',
  "a document type declaration": "<!DOCTYPE testsuite>\n<testsuite/>",
  "nesting past the supported depth":
    "<a>".repeat(70) + "</a>".repeat(70),
  // XML markup whitespace is only space, tab, carriage return, and line feed.
  "a no-break space after the root": "<testsuite/>\u00a0",
  "a no-break space inside a tag": "<testsuite\u00a0/>",
  "a vertical tab between attributes": '<testsuite a="1"\u000bb="2"/>',
  "a form feed inside an end tag": "<testsuite>x</testsuite\u000c>",
  // Characters XML forbids anywhere in a document. A conforming parser refuses
  // the whole file over them, including raw terminal escapes captured from a
  // device log, so evidence carrying one cannot be read at review time.
  "a NUL byte in text": "<testsuite>\u0000</testsuite>",
  "a NUL byte in an attribute value": '<testsuite name="a\u0000b"/>',
  "a non-character in text": "<testsuite>\uffff</testsuite>",
  "an unpaired surrogate in text": "<testsuite>\ud800</testsuite>",
  "a terminal escape byte in element text":
    "<testsuite><system-out>" + ESCAPE + "[31mred</system-out></testsuite>",
  "a terminal escape byte inside CDATA":
    "<testsuite><system-out><![CDATA[" +
    ESCAPE +
    "[31mred]]></system-out></testsuite>",
  "a terminal escape byte in an attribute value":
    '<testsuite><failure message="' + ESCAPE + '[31mexpected"/></testsuite>',
  "a terminal escape byte inside a comment":
    "<testsuite><!-- " + ESCAPE + "[31m --></testsuite>",
  "a terminal escape byte inside a processing instruction":
    "<testsuite><?maestro " + ESCAPE + "?></testsuite>",
  // Release evidence is decoded as UTF-8, so no other encoding may be declared.
  "a declared encoding other than UTF-8":
    '<?xml version="1.0" encoding="ISO-8859-1"?><testsuite/>',
  // A namespace-aware parser rejects an unbound prefix, and JUnit reports use
  // no namespaces, so prefixed names are not accepted here either.
  "an attribute with an unbound namespace prefix": '<testsuite a:b="1"/>',
  "an element with an unbound namespace prefix": "<testsuite><a:b/></testsuite>",
  "a malformed qualified attribute name": '<testsuite a:="1"/>',
};

for (const [description, reportText] of Object.entries(notWellFormedReports)) {
  test("rejects " + description, () => {
    assert.equal(
      inspectJUnitReportText(reportText),
      JUNIT_REPORT_NOT_WELL_FORMED,
    );
  });
}

// Well-formed XML that is not a testsuite report keeps its own verdict, so the
// checker can tell an unparseable upload from the wrong file.
const noTestsuiteReports = {
  "a well-formed non-report": "<junit><failure>boom</failure></junit>\n",
  "a testsuites root with no testsuite child": "<testsuites></testsuites>\n",
  "a testsuite nested below the report level":
    "<report><results><testsuite/></results></report>\n",
};

for (const [description, reportText] of Object.entries(noTestsuiteReports)) {
  test("reports " + description + " as no testsuite", () => {
    assert.equal(inspectJUnitReportText(reportText), JUNIT_REPORT_NO_TESTSUITE);
  });
}

test("verdicts never carry report content", () => {
  const verdicts = new Set([
    JUNIT_REPORT_VALID,
    JUNIT_REPORT_NOT_WELL_FORMED,
    JUNIT_REPORT_NO_TESTSUITE,
    JUNIT_REPORT_TOO_LARGE,
    JUNIT_REPORT_UNREADABLE,
  ]);
  const marker = "private-report-marker";
  for (const reportText of [
    "<testsuite><failure>" + marker + "</failure>",
    marker + "<testsuite/>",
    '<testsuite name="' + marker + '"',
    "<junit>" + marker + "</junit>",
    "<testsuite>&" + marker + ";</testsuite>",
  ]) {
    const verdict = inspectJUnitReportText(reportText);
    assert.ok(
      verdicts.has(verdict),
      "the scanner must only ever return a fixed verdict",
    );
    assert.ok(
      !verdict.includes(marker),
      "a verdict must not repeat report content",
    );
  }
});

test("file verdicts fail closed without inspecting the file", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "junit-xml-"));
  try {
    const validPath = path.join(directory, "maestro-results.xml");
    writeFileSync(validPath, '<testsuite tests="1" failures="0"></testsuite>\n');
    assert.equal(inspectJUnitReportFile(validPath), JUNIT_REPORT_VALID);

    const truncatedPath = path.join(directory, "sentry-maestro-results.xml");
    writeFileSync(truncatedPath, '<testsuite tests="1">\n');
    assert.equal(
      inspectJUnitReportFile(truncatedPath),
      JUNIT_REPORT_NOT_WELL_FORMED,
    );

    // The shared 256 KiB release evidence bound applies to JUnit reports too.
    const oversizedPath = path.join(directory, "oversized-results.xml");
    writeFileSync(
      oversizedPath,
      '<testsuite name="' + "x".repeat(262145) + '"/>\n',
    );
    assert.equal(inspectJUnitReportFile(oversizedPath), JUNIT_REPORT_TOO_LARGE);

    // Bytes that are not valid UTF-8 are corruption, not content: a lenient
    // decode would hide them behind replacement characters.
    const invalidUtf8Path = path.join(directory, "invalid-utf8-results.xml");
    writeFileSync(
      invalidUtf8Path,
      Buffer.concat([
        Buffer.from('<testsuite name="'),
        Buffer.from([0xff, 0xfe]),
        Buffer.from('"/>\n'),
      ]),
    );
    assert.equal(
      inspectJUnitReportFile(invalidUtf8Path),
      JUNIT_REPORT_NOT_WELL_FORMED,
    );

    assert.equal(
      inspectJUnitReportFile(path.join(directory, "absent.xml")),
      JUNIT_REPORT_UNREADABLE,
    );
    assert.equal(inspectJUnitReportFile(directory), JUNIT_REPORT_UNREADABLE);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
