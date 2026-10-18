#!/usr/bin/env node
// Stop the Hub before --apply so no in-flight job is archived.
// Default invocation only previews; no project content is deleted.
import { db } from '../db.mjs';
import { duplicateGroups, archiveDuplicates } from '../duplicates.mjs';
const counts = () => Object.fromEntries(['villas','agents','tasks','messages','memories','reports'].map(t=>[t,db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
const before=counts();
const result=process.argv.includes('--apply')?archiveDuplicates():{groups:duplicateGroups(),dryRun:true};
const after=counts();
if (JSON.stringify(before)!==JSON.stringify(after)) throw new Error('Project content counts changed unexpectedly');
console.log(JSON.stringify({result,before,after,remaining:duplicateGroups().length}));
db.close();
