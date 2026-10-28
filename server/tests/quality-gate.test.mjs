import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calculateQualityGate,scoreStandaloneHtmlPerformance,scoreStandaloneHtmlSecurity} from '../quality-gate.mjs';

test('quality gate uses weighted syntax, tests, security and performance signals',()=>{
 const result=calculateQualityGate({syntax:100,tests:90,security:80,performance:70});
 assert.equal(result.score,87);
 assert.equal(result.threshold,90);
 assert.equal(result.passed,false);
});
test('quality gate clamps invalid scores and passes only at threshold',()=>{
 const result=calculateQualityGate({syntax:120,tests:100,security:100,performance:100});
 assert.equal(result.syntax,100);
 assert.equal(result.score,100);
 assert.equal(result.passed,true);
 assert.equal(scoreStandaloneHtmlSecurity('<script>const value=1</script>'),100);
 assert.ok(scoreStandaloneHtmlSecurity('<script>eval("1")</script>')<90);
 assert.equal(scoreStandaloneHtmlPerformance(90000),100);
 assert.equal(scoreStandaloneHtmlPerformance(300000),75);
});
