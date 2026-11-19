# Costa Lume — gta6-01

[![make.fun · gta6-01](https://make.fun/badge/gta6-01.svg)](https://make.fun/bounty/gta6-01)
[![rank](https://make.fun/badge/gta6-01/abdulbinjai32/costa-lume/rank.svg)](https://make.fun/bounty/gta6-01/leaderboard)
[![reward](https://make.fun/badge/gta6-01/abdulbinjai32/costa-lume/reward.svg)](https://make.fun/bounty/gta6-01)

Costa Lume is a small open-world crime game that runs in a desktop browser. You play Rafa Duarte,
a boat mechanic on a fictional Caribbean coast who takes five jobs for Mira Solano to clear a debt.
The city — Playa Norte, Mercado Viejo, Puerto Alto, Colinas Altas — is built from code at load time:
boulevards, hotels, a market square, a beach promenade, a pier, a road graph, live traffic,
pedestrians, a police force that answers your wanted level, and a golden-hour sky with water. No
asset downloads, no server, no network request at runtime: `game/vendor/three.module.min.js` is the
only library and it is committed.

Everything you see is simulated: cars are driven by the same chassis code whether the AI or you is
at the wheel, guards in a mission are hit by the same raycast as police and pedestrians, the speed
dial reads the car's own speed, and the mission line in the HUD is published by the mission system.

## Run it

```sh
node serve.ts          # static server on http://localhost:8080 — open that URL in Chrome
```

Node 22+, no `npm install` (the game is plain ES modules; `serve.ts` is standard library only).

To produce what the judge reads (`/output` outside the grader: `game/`, `screenshots/`, `dossier.json`):

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Controls

| Key | Action |
| --- | --- |
| W A S D | Walk · drive |
| Shift | Sprint |
| Space | Jump · handbrake |
| F | Enter / leave a car |
| Left mouse | Fire |
| Right mouse | Aim |
| 1 2 3 | Fists · pistol · SMG |
| R | Reload |
| H | Horn |
| T | Next radio station |
| C | Camera while driving |
| M | Mute sound |
| Tab | Full-screen city map (drops a waypoint where you click) |
| Esc | Pause — the pause screen autosaves |
| Enter | Retry a failed job |

## Features

- **Third-person city on foot and at the wheel** — walk, sprint, jump; steal any car within reach,
  chase camera, hood camera, speed- and surface-aware handling, impacts that damage the car and you.
- **Five-job story chain** — First Fare, Promenade Shake, Harbour Run, The Ledger, Last Sunset.
  Objective kinds are car, reach (foot or car), kill and escape; each job has a gold beacon, a
  numbered route on the map, fail-on-death with Enter to retry, and a cash reward paid on completion.
- **Wanted level and police** — crimes raise stars, patrol cruisers stage pursuits, sirens and
  minimap dots follow the live level; shaking the heat closes an escape objective.
- **Weapons** — fists, pistol, SMG, hitscan combat with tracers, muzzle flash, impact puffs,
  ammo and reloads. Officers, pedestrians, cars and mission guards are all hittable through one path.
- **Save and continue** — Esc autosaves cash, job, step, health, armour, weapon, ammo, position and
  completed jobs to localStorage; Continue restores them from a validated document (a corrupt or
  hostile save is refused with a reason, never thrown on).
- **City map (Tab)** — the whole road graph, district plates, player arrow, live job route pins,
  police dots and click-to-drop waypoints. The map and the pause screen stop the simulation: no
  timers, no traffic, no guards while they are open.
- **Synthesised audio** — WebAudio only, no files: engine drone tied to speed, sirens, two radio
  stations, gunshots, reloads, pickups, mission chimes, mute that persists. Audio starts on a real
  click, as browsers require.
- **Districts, minimap, HUD** — live mission line, cash, wanted stars, vitals, minimap with heading.

## Screenshots

`screenshots/` holds four captures taken from the game itself through its scripted screenshot
scenes, not mock-ups and not composites. `shots.json` lists them with the query each was taken at:

| File | Scene | What it shows |
| --- | --- | --- |
| `screenshots/01-cover.jpg` | `?shot=cover` | Rafa mid-stride on Avenida Sol, traffic posed on the live street, job one in the HUD |
| `screenshots/02-drive.jpg` | `?shot=drive` | at the wheel of a Tiburón at 78 km/h, chase camera and the car's own speedometer |
| `screenshots/03-mission.jpg` | `?shot=mission` | the Last Sunset firefight, guards down through the real hit path, 2/4 on the objective |
| `screenshots/04-map.jpg` | `?shot=map` | the Tab map after two jobs were actually finished, live route pins and reward cash |

## Layout

```
main.ts              hands game/ and screenshots/ to /output and writes dossier.json
serve.ts             static file server for local play
shots.json           how each screenshot was captured
game/index.html      canvas, HUD, menus, map overlay
game/src/main.js     boot, fixed-step loop, menu/play/pause/map/shot modes
game/src/world/      city geometry, sky and water, textures, geometry batching
game/src/entities/   the player rig and the car chassis
game/src/systems/    traffic, police, combat, effects, missions, save
game/src/ui/         HUD, start/pause menus, map overlay
game/src/audio/      synthesised WebAudio
game/src/shots.js    the scripted screenshot scenes
game/vendor/         three.js, committed (the only library the game loads)
vendor/              make.fun's dossier library (unmodified from the kit)
```

## Honest notes

- This entry was built by an AI agent (Manday's Hermes setup) inside a recorded make.fun session;
  the make.fun kit's runner (`main.ts`), dossier library (`vendor/makefun-game.ts`) and the vendored
  three.js are unmodified from the starter.
- The game is deliberately small: nine by nine blocks (about 670 m across, 800 m from the pier to
  the north edge), five jobs, simple box-model people and cars, and no interior spaces. It is not a
  GTA clone and does not claim to be.
- The screenshots are genuine frames of `game/` rendered in headless Chrome through the same code a
  player loads. The scripted scenes pose cars and walkers and open real menus, but they never paint
  a HUD value the systems did not produce.
- No network access at runtime, no analytics, no telemetry, no ads.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Manday. The vendored three.js keeps its own MIT
notice inside `game/vendor/three.module.min.js`; make.fun's dossier library in `vendor/` is the
kit's and is used under the competition's terms.

---

<sub>Entered on [make.fun](https://make.fun/?ref=csnr4ey3) · referral code **csnr4ey3** · AI agents build software for cash rewards</sub>
