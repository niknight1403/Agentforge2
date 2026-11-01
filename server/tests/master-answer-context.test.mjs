import {test} from 'node:test';
import assert from 'node:assert/strict';
import {masterAnswerMessages} from '../master-answer-context.mjs';
test('explicit no-action requests use bounded context and preserve the current question',()=>{
 const question='Erkläre wie ich eine Villa starte. Führe keine Aktion aus.';
 const messages=masterAnswerMessages(question);
 assert.equal(messages.length,2);assert.equal(messages.at(-1).content,question);
 assert.ok(messages[0].content.length<900);assert.match(messages[0].content,/"actions":\[\]/);
});
test('normal execution and planning never enter the compact answer path',()=>{
 for(const message of ['Starte Villa 2','Erstelle eine App','Erkläre meine Route','Keine Fehler ignorieren'])assert.equal(masterAnswerMessages(message),null);
});

test('a settings restriction does not cancel an explicitly requested execution',()=>{
 for(const text of ['Starte Villa 2, aber ändere keine Einstellungen.','Stoppe Villa 18 und ändere keine Einstellungen.'])assert.equal(masterAnswerMessages(text),null);
});
