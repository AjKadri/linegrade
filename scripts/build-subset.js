#!/usr/bin/env node
// Build data/unspsc-subset.csv from the official UNDP UNSPSC workbook.
//
//   node scripts/build-subset.js [input.xlsx] [output.csv]
//
// Defaults: data/unspsc_english.xlsx -> data/unspsc-subset.csv
// Both files are gitignored (UNSPSC is (c) UNDP); only this script is committed.
// Every row written is copied from a commodity row of the input file; no code is invented.
//
// Needs the `unzip` binary (macOS/Linux) to read the .xlsx; no npm dependencies.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INPUT = process.argv[2] || path.join(ROOT, 'data', 'unspsc_english.xlsx');
const OUTPUT = process.argv[3] || path.join(ROOT, 'data', 'unspsc-subset.csv');

const EXPECTED_VERSION = 'UNv260801';

// Two-digit UNSPSC segments kept, and why. Edit here to widen/narrow the list.
const SEGMENTS = {
  '41': 'Laboratory and Measuring and Observing and Testing Equipment', // lab
  '42': 'Medical Equipment and Accessories and Supplies', // lab: exam gloves, syringes, sterile supplies
  '14': 'Paper Materials and Products', // office/janitorial: copy paper, sticky notes, paper towels, toilet tissue
  '44': 'Office Equipment and Accessories and Supplies', // office
  '47': 'Cleaning Equipment and Supplies', // janitorial
  '46': 'Law Enforcement and National Security and Security and Safety Equipment and Supplies', // safety
  '27': 'Tools and General Machinery', // industrial tools
  '31': 'Manufacturing Components and Supplies', // industrial small parts
};

// Header names we require, mapped by NAME (never by fixed position).
const WANT = ['Version', 'Segment', 'Segment Title', 'Class', 'Class Title', 'Commodity', 'Commodity Title'];

function unzipText(member) {
  return execFileSync('unzip', ['-p', INPUT, member], { maxBuffer: 1024 * 1024 * 1024 }).toString('utf8');
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function readSharedStrings() {
  const xml = unzipText('xl/sharedStrings.xml');
  const out = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const t of m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += t[1];
    out.push(decodeXml(text));
  }
  return out;
}

function colIndex(ref) {
  let n = 0;
  for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

function* readRows(strings) {
  const xml = unzipText('xl/worksheets/sheet1.xml');
  for (const rm of xml.matchAll(/<row [^>]*?r="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells = [];
    if (rm[2]) {
      for (const cm of rm[2].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /r="([A-Z]+\d+)"/.exec(cm[1]);
        const type = /t="(\w+)"/.exec(cm[1]);
        const v = cm[2] && /<v>([\s\S]*?)<\/v>/.exec(cm[2]);
        if (!ref || !v) continue;
        cells[colIndex(ref[1])] = type && type[1] === 's' ? strings[+v[1]] : decodeXml(v[1]);
      }
    }
    yield { rowNumber: +rm[1], cells };
  }
}

function csvField(s) {
  s = String(s ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function main() {
  if (!fs.existsSync(INPUT)) throw new Error(`Input not found: ${INPUT}`);
  const strings = readSharedStrings();

  let header = null; // name -> column index
  let headerRow = null;
  const rows = [];
  for (const { rowNumber, cells } of readRows(strings)) {
    if (!header) {
      // Find the header row by content, not by assumed row number.
      if (cells.includes('Commodity Title') && cells.includes('Segment')) {
        header = {};
        cells.forEach((name, i) => { if (name != null) header[String(name).trim()] = i; });
        headerRow = rowNumber;
        const missing = WANT.filter((n) => !(n in header));
        if (missing.length) throw new Error(`Missing expected columns: ${missing.join(', ')}`);
      }
      continue;
    }
    rows.push(cells);
  }
  if (!header) throw new Error('Header row (with "Commodity Title") not found');
  console.log(`Header on sheet row ${headerRow}; columns: ${Object.keys(header).join(' | ')}`);

  const get = (r, name) => String(r[header[name]] ?? '').trim();

  const versions = new Set(rows.map((r) => get(r, 'Version')).filter(Boolean));
  if (versions.size !== 1 || !versions.has(EXPECTED_VERSION)) {
    throw new Error(`Expected version ${EXPECTED_VERSION}, found: ${[...versions].join(', ')}`);
  }

  // Commodity rows only: 8-digit commodity code present.
  const commodities = rows.filter((r) => /^\d{8}$/.test(get(r, 'Commodity')));
  console.log(`Version ${EXPECTED_VERSION}: ${rows.length} data rows, ${commodities.length} commodity rows`);

  // Sanity: segment titles in the file must match what we claim to be selecting.
  const segTitles = new Map();
  for (const r of rows) {
    const seg = get(r, 'Segment').slice(0, 2);
    if (seg && !segTitles.has(seg)) segTitles.set(seg, get(r, 'Segment Title'));
  }
  for (const [seg, title] of Object.entries(SEGMENTS)) {
    if (segTitles.get(seg) !== title) {
      throw new Error(`Segment ${seg}: expected "${title}", file says "${segTitles.get(seg)}"`);
    }
  }

  const seen = new Set();
  const out = ['commodity_code,commodity_title,class_code,class_title'];
  const perSegment = {};
  for (const r of commodities) {
    const code = get(r, 'Commodity');
    if (!(code.slice(0, 2) in SEGMENTS) || seen.has(code)) continue;
    // Class code is derived from the row's own Class column and must agree with the code prefix.
    const cls = get(r, 'Class');
    if (cls.slice(0, 6) !== code.slice(0, 6)) throw new Error(`Class/commodity mismatch on ${code}: class ${cls}`);
    seen.add(code);
    perSegment[code.slice(0, 2)] = (perSegment[code.slice(0, 2)] || 0) + 1;
    out.push([code, get(r, 'Commodity Title'), cls, get(r, 'Class Title')].map(csvField).join(','));
  }

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, out.join('\n') + '\n');
  console.log(`Wrote ${out.length - 1} commodities to ${path.relative(process.cwd(), OUTPUT)}`);
  for (const [seg, n] of Object.entries(perSegment)) console.log(`  ${seg} ${SEGMENTS[seg]}: ${n}`);
}

if (require.main === module) main();
