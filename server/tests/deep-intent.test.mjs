import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyDeepDevelopmentIntent as classify} from '../deep-intent.mjs';
test('new project idea starts autonomous development',()=>{
 assert.equal(classify('Eine Android App zur lokalen Inventarverwaltung',{projectCreation:true}).action,'AUTO_BUILD');
});
test('explicit follow-up development command starts work',()=>{
 assert.equal(classify('Entwickle eine Web-App mit Login').action,'AUTO_BUILD');
});
test('questions and explicit opt-outs never start work',()=>{
 assert.equal(classify('Wie erstelle ich eine Android App?').action,'CHAT_ONLY');
 assert.equal(classify('Bitte nicht entwickeln, nur diskutieren: eine App').action,'CHAT_ONLY');
 assert.equal(classify('Was ist der beste Stack?').action,'CHAT_ONLY');
});
test('unrelated short chat stays chat-only',()=>{
 assert.equal(classify('Danke fuer die Erklaerung').action,'CHAT_ONLY');
});
