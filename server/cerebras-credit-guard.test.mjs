import test from 'node:test';
import assert from 'node:assert/strict';
import {creditGate,prioritizeRoutes} from './cerebras-credit-guard.mjs';
test('unverified credits fail closed',()=>assert.equal(creditGate({requestUsd:0.01}).allowed,false));
test('verified credits allow request',()=>assert.equal(creditGate({balanceUsd:1,requestUsd:0.01}).allowed,true));
test('insufficient credits deny request',()=>assert.equal(creditGate({balanceUsd:0,requestUsd:0.01}).allowed,false));
test('paid budget denied',()=>assert.equal(creditGate({balanceUsd:1,requestUsd:0.01,paidBudgetUsd:1}).allowed,false));
test('fallback removes Cerebras when balance unknown',()=>assert.deepEqual(prioritizeRoutes([{provider:'cerebras'},{provider:'groq'}],{allowed:false}).map(r=>r.provider),['groq']));
