import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ALLOWED} from '../fs-tools.mjs';

test('Cargo verification commands are explicitly allowlisted for sandboxed Rust projects',()=>{
  const cargo=ALLOWED.find(entry=>entry.startsWith('cargo ('));
  assert.ok(cargo,'Cargo must be available to the project command runner');
  for(const command of ['test','build','check','clippy','fmt','metadata']) assert.ok(cargo.includes(command));
  for(const forbidden of ['install','update','publish','run']) assert.ok(!cargo.split('(')[1].split(')')[0].split('|').includes(forbidden));
});
