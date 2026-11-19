// The gta6-01 entry: Costa Lume, a small open-world crime game that runs in a desktop browser.
//
// game/ is the whole game — plain static files, ES modules and one vendored three.js, loaded offline
// by game/index.html with no network request and no build step. Costa Lume is a nine-by-nine-block
// Caribbean city generated from code at load: boulevards, hotels, a market square, a beach
// promenade, a pier and a road graph, live traffic and pedestrians, a police force that answers the
// wanted level, hitscan combat, a five-job story chain with beacons and cash rewards, a localStorage
// save with Continue, a full city map on Tab, synthesised WebAudio and a golden-hour sky with water.
// Rafa walks, sprints and jumps on foot, steals cars and drives them; every number the HUD shows is
// published by the system that owns it rather than painted by the screen.
//
// This program is only the hand-off: it copies game/ and screenshots/ from beside this file to
// /output and writes /output/dossier.json, the summary the judge reads, through the vendored
// make.fun library. screenshots/ holds four captures of the game itself (the first by name is the
// cover) and shots.json records the scene query each one was taken at.
//
// Serve it locally with `node serve.ts`, then open http://localhost:8080 (Node 22, standard library
// only, nothing to install).
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });
if (existsSync(join(here, 'screenshots'))) cpSync(join(here, 'screenshots'), join(out, 'screenshots'), { recursive: true });

// The scorer's own caps (reference/gate.json): only text_max_bytes shapes the bytes; the others refuse an entry the
// scorer would refuse (more than 4 screenshots or one over 256 KiB; more than 993 files in game/ or 48 MiB of game
// files, in all, or a path under game/ over 1000 bytes: game/ counts beside /output's own 1000-entry cap, its
// screenshots/ and dossier.json).
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
    game_path_max_bytes: 1000,
  }),
);
