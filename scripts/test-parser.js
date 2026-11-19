#!/usr/bin/env node
/**
 * Automated Verification Script for EPC Parser & Search
 */
const assert = require('assert');
const { parseBulletsAndMeta } = require('../parsers/komatsu');
const { parseCsvText } = require('../parsers/generic-csv');
const { normalizePartNumber } = require('../db');

console.log('Running EPC Parser Unit Tests...');

// 1. Part number normalization
assert.strictEqual(normalizePartNumber('6251-11-5440'), '6251115440');
assert.strictEqual(normalizePartNumber('(2A8-03-11881)'), '2A80311881');
assert.strictEqual(normalizePartNumber('voe 20976003'), 'VOE20976003');

// 2. Bullet BOM hierarchy + Kit ref + Refer to Page
const m1 = parseBulletsAndMeta('• • RING, BACK-UP (Kit : K26)');
assert.strictEqual(m1.indentLevel, 2);
assert.strictEqual(m1.kitRef, 'K26');
assert.strictEqual(m1.description, 'RING, BACK-UP (Kit : K26)');

const m2 = parseBulletsAndMeta('• HOSE, PILOT LINE (Refer to Page 125)');
assert.strictEqual(m2.indentLevel, 1);
assert.strictEqual(m2.referToPage, '125');

// 3. CSV parser
const rows = parseCsvText('a,b,c\n1,"VALVE, RELIEF",3\n');
assert.strictEqual(rows.length, 2);
assert.strictEqual(rows[1][1], 'VALVE, RELIEF');

console.log('All unit assertions passed!');
