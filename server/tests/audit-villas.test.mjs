import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatAuditFailure} from '../../scripts/audit-villas.mjs';

test('reports the failed audit stage and HTTP status without exposing Villa IDs',()=>{
 assert.equal(formatAuditFailure(new Error('Audit endpoint /api/villas HTTP 401')),'Audit blocked at Villa inventory: HTTP 401.');
 assert.equal(formatAuditFailure(new Error('Audit endpoint /api/villas/34/product HTTP 503')),'Audit blocked at Villa product evidence: HTTP 503.');
});

test('keeps known local configuration errors actionable',()=>{
 assert.equal(formatAuditFailure(new Error('Audit credentials missing.')),'Audit credentials missing.');
});

test('suppresses unrecognized errors that could contain private data',()=>{
 const report=formatAuditFailure(new Error('token=secret villa 34 customer@example.test'));
 assert.equal(report,'Villa audit failed before completing. No credentials, raw responses or Villa details were logged.');
 assert.doesNotMatch(report,/secret|34|customer@example/);
});
