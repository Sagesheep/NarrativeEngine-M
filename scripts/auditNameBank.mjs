import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const D = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data');
const names = JSON.parse(readFileSync(join(D, 'nameBank.json'), 'utf8'));
const block = JSON.parse(readFileSync(join(D, 'nameBlocklist.json'), 'utf8'));

const famousSet = new Set(['hitler','stalin','napoleon','mussolini','putin','trump','obama','mao','lenin','gandhi','jesus','muhammad','buddha','frodo','gandalf','aragorn','naruto','sasuke','goku','vegeta','voldemort','daenerys','sauron','pikachu','mario','luigi','sonic','batman','superman','thanos','yoda','vader','sephiroth','geralt','kratos','zelda','beyonce','rihanna','madonna','eminem','elvis','lincoln','churchill','caesar','cleopatra','einstein','tesla','darwin']);
const famous = names.filter(n => famousSet.has(n.n.toLowerCase()));
console.log('=== famous person/character leakage ===');
console.log(famous.map(f => `${f.n} (${f.c})`).join(', ') || '(none)');

const multi = names.filter(n => /\s/.test(n.n.trim()));
console.log(`\n=== multi-word names (${multi.length}) ===`);
console.log(multi.slice(0, 30).map(n => n.n).join(', '));

const weird = names.filter(n => !/^[A-Za-z][A-Za-z'’-]*$/.test(n.n));
console.log(`\n=== names with odd chars (${weird.length}) ===`);
console.log(weird.slice(0, 40).map(n => `${JSON.stringify(n.n)}/${n.c}`).join(', '));

const lensus = names.filter(n => n.n.length < 2 || n.n.length > 14);
console.log(`\n=== too short/long (${lensus.length}) ===`);
console.log(lensus.slice(0, 30).map(n => `${n.n}(${n.n.length})`).join(', '));

const likely = new Set(['hope','grace','faith','mercy','hunter','dawn','sky','sage','rose','ash','summer','autumn','crystal','jade','ruby','pearl','melody','harmony','destiny','serenity','angel','heaven','trinity','justice','star','robin','raven','river','brook','stone','reed','glen','dale','rain','wren','fern','iris','lily','daisy','violet','scarlet']);
const blockNames = block.filter(w => likely.has(w));
console.log(`\n=== blocklist words that are plausible given names (${blockNames.length}) ===`);
console.log(blockNames.join(', ') || '(none)');

// duplicate display names across cultures count (informational)
const counts = {};
for (const n of names) counts[n.n.toLowerCase()] = (counts[n.n.toLowerCase()] || 0) + 1;
const crossMax = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,5);
console.log(`\n=== most cross-cultural names (informational) ===`);
console.log(crossMax.map(([n,c]) => `${n}×${c}`).join(', '));
