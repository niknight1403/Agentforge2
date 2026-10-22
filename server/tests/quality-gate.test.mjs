import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calculateQualityGate,staticPerformanceScore,staticSecurityScore,QUALITY_THRESHOLD} from '../quality-gate.mjs';
test('Quality Gate nutzt 30/30/20/20 und blockiert unter 85',()=>{
 const pass=calculateQualityGate({syntax:100,tests:90,security:80,performance:70});
 assert.equal(pass.score,87);assert.equal(pass.passed,true);assert.equal(pass.threshold,QUALITY_THRESHOLD);
 const fail=calculateQualityGate({syntax:100,tests:50,security:50,performance:50});
 assert.equal(fail.score,65);assert.equal(fail.passed,false);
});
test('statische Security- und Performance-Signale sind konservativ',()=>{
 assert.equal(staticSecurityScore([]),100);assert.equal(staticSecurityScore(['secret']),70);
 assert.equal(staticPerformanceScore(900_000),100);assert.equal(staticPerformanceScore(12_000_000),70);
});
