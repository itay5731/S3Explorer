import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { toast } from "../store/toasts";
import { createRaidSound } from "./raidSound";
import { RaidLoadingScreen } from "./RaidLoading";

// A second hidden game on the start screen (started by typing "secret", see TransferBackdrop):
// a first-person raid on a five-floor glass headquarters at night. Every floor has its own look and
// a job to do before its elevator opens; cameras sweep, tripwires cross the corridors, keypad doors
// hide what you need and guards walk their rounds. On the top floor the secrets go up from a rack,
// the building locks down, and the way out is the elevator to the roof, where a helicopter waits.
// Built on Three.js, loaded with this file only when the word is typed. Everything is made in code:
// no image, no model, no sound file.

const BEST_KEY = "s3x.raidBest";

// One map per floor (40 x 28 cells of 2 m), one character per cell. Built and checked by a script:
// every objective is reachable, every door code can be found before its door, every elevator opens
// onto the floor.
//   #  wall: solid on the outside, a glass partition inside      X  solid interior wall
//   W  window      .  floor      P  the elevator you arrive by (the way to the roof on the top floor)
//   U  the elevator up           d  workstation (adjacent ones form pods)     e  executive desk
//   M  meeting table   Q  reception counter   o  sofa   c  coffee table   j  kitchen counter
//   t  security gate   V  video wall   k  server rack   p  plant
//   G  patrolling guard   H  guard on a post   B  head of security
//   T  terminal (the floor's job)   Y  terminal with a door code   N  sticky note with a door code
//   D  security door with a keypad (the n-th code source, in reading order, opens the n-th door)
//   C  security camera on the wall next to it    =  laser tripwire    F  fuse cabinet
//   K  keycard   R  the rack with the secrets   S  server-room wall   L  keycard door
//   I  intel (optional)   +  medkit
//   O  column   f  filing cabinets   h  shelving   n  printer   b  whiteboard   a  water cooler   z  toilet stall
const FLOORS = [
  [
    "#WWWWWWW#WWW################WWWW#WWWWWW#",
    "W........ff.Xp......U.....pX#f...f#.nn.W",
    "W.T..dd.....X..............X#fT...#....W",
    "W....dd.....D..O........O..X#.....#I..hW",
    "W.......b...X....H.........X#...d.#....W",
    "W##.#####.##X..............X###.####.##W",
    "Wh....#j....XttttttttttttttX#.........aW",
    "#h....#j.Gh.X.............CX#.b..G.....#",
    "Wh..f.#j..h.....XXXXXXXX...............W",
    "W##.#####.##.......H........#####.#####W",
    "W.........a#.p...QQQQQQN..p.#a....jjjjj#",
    "W.ooo.c....#................#..........#",
    "W..c...+c....O............O....c...c...#",
    "W.ooo......#......p..p...H..#..........#",
    "######.#####C...............#####.######",
    "#....G....p#....p......p...C#.........pW",
    "#p.........#......oooo......#pG........W",
    "###.####.###.O............O.###.####.##W",
    "#.....#.........oo....oo..........#....W",
    "#zz.z.#h.hh#.p............p.#nn..f#hhh.W",
    "W####.########.##########.########.####W",
    "#.......G.......O.......O.......O......#",
    "Wp..................G.................pW",
    "W###.#####.#######.#####.#####.#####.##W",
    "W.....a#....f.#b....f#.....#.....#...+.W",
    "W......#.dd...#......#.....#.....#.....W",
    "W.P....#.dd...#.nn...#kkkk.#zz.z.#.hhh.W",
    "#####WWW#WWWWWWW#WWWW#############WWWWW#",
  ],
  [
    "#####WWW#WWWWWWW#WWWWW#######WWW#WWWWWW#",
    "W.U...#.........ap#.C#......#b....#jjjjW",
    "W.....#.dd.dd.dd..#..#......#.....#....W",
    "W.....#.dd.dd.dd.....#.MMMM.#.MMM.#.c..W",
    "W##.##............#..#......#.....#....W",
    "#...G............O#..#.....I#.....#...aW",
    "#.dd.dd.dd.dd.dd..#..###.######.####.##W",
    "#.dd.dd.dd.dd.dd..#......G.............#",
    "#.........G.....b..............H.......W",
    "#.dd.dd.dd.dd.dd.O#..###.#####.#####.##W",
    "#.dd.dd.dd.dd.dd..#..#a....#.....#.....W",
    "#f...............f#..#nn..f#zz.z.#hh.h.W",
    "####.#####.#####.##..####.#####.#####.#W",
    "#....O.....................O...........#",
    "#...........O.....................O...C#",
    "#XXXXXXX######.####..###.#####.####.####",
    "#kkkkk.X..#.....a.#..#p.........O#.....#",
    "#......X..#.ooo...#..#.dd.dd.dd..#.dd..#",
    "#kkkk..D..#..c....#....dd.dd.dd.......Y#",
    "#......X..#..........#.....G.....#.....#",
    "#.T....X..=.+....p#..#.dd.dd.dd..#.....W",
    "#......X.H###.#####..#.dd.dd.dd......h.#",
    "#XXXXXXX..#.......#..#p.........p#f...hW",
    "W......#..#...G..h#..####.####.#####.##W",
    "W.........#......h...#..c...#...p#.p...W",
    "W......#..........#.........#....#..+..W",
    "Wzz.z..#C.#hhh.nf.#..#jjjj..#ooo.#...P.W",
    "#########WWWWWWW#WWWWWWW#WWWWWWW#WWWWWW#",
  ],
  [
    "########################################",
    "#...kk.#..VVVVVVVVVVVVVVVVVVVV..#....U.#",
    "#......#C.....O..........O......#..hh..#",
    "#F..hh.#.......................f#......#",
    "#.....f....ddddd.dddddd.ddddd...#.....f#",
    "#......#...............................#",
    "###.####.O....................O.#..G...#",
    "#h.....#...ddddd.dddddd.ddddd...#......#",
    "#h.k...#H......................H#......#",
    "#..k.G.#........................#h.....#",
    "#..k...#.O.ddddd.dddddd.ddddd.O.#h....F#",
    "#I.k................N...........#......#",
    "#.....h#......O....G.....O.......hh....#",
    "#......XXXXX.XXXXXXXXXXXXXX.XXXXX......#",
    "#XX.XXXXXXXX=XXXXXXXXXXXXXX.XXXXXXXX.XX#",
    "#......O............a.........O........#",
    "#.........G......O....................C#",
    "WXXXX=XXXXXXXXX.XXXXXXXX=XXXXXXXX.XXXXXW",
    "W........X...................X.....hhh.W",
    "Wp.....+.X.kkkkkk..kkkkkkkk..X.+.......W",
    "W...dd...X...................X.........W",
    "#f.......X........G..........X...fff...#",
    "Wf.......=.kkkkkk..kkkkkkkk..D.........W",
    "Wf.....b.X...................X.........W",
    "W........X...................X...fff..FW",
    "W......a.X.kkkkkk..kkkkkkkk..X.........W",
    "W.P.ff...X.........C.........X.f.....hhW",
    "#WWWWWWW#WWWWWW########W#WWWWWWW#WWWWWW#",
  ],
  [
    "#WWWWWWW#WW##################WWW#WWWWWW#",
    "Wf.......pXfjjjj....U..#.....Xph.......W",
    "W.........X............#MMMM.X.......I.W",
    "W...e.....XG..O..O...........X....e....W",
    "Wh................H....#H....D........hW",
    "Whc.......X............######X......c.hW",
    "W.oo....h.X.###.########.###.X.....ooo.W",
    "#.........X.#p............p#.X.........#",
    "#XXXXXXXXXX.#.......B......#.XXXXXXXXXX#",
    "#C....G.....#..............#.#XXX.XXXXX#",
    "#......jjj.....MMMMMMMMMM....#.h...h.h.#",
    "#...........#..............#...h...h.h.#",
    "#.ooo...b...#..............#.#.h...h.h.#",
    "#..c........#p............p#.#...G.....#",
    "#.ooo.......#######.########.######.####",
    "#..........H........G........#.p......C#",
    "#....Ooo.O...dd.dd....dd.dd.....MMMMO..#",
    "#a...........dd.dd.O..dd.dX.X#.......+.#",
    "#.+...................p...X=X#........p#",
    "WXXXXX.XXXX...............X.XXXXX.XXXXXW",
    "W.........X..XXXXXXDXXXXXXX.XX.........W",
    "#...eN....X..Xp..........pX.XX.........#",
    "Wh........X..X............X=XXp...e...hW",
    "Wh........X..X.......QQQ..X.XX........hW",
    "W..c......X..X..Y.........X.XX......c..W",
    "W.ooo.....X..X..............XX.....ooo.W",
    "W.......hpX..X.a...P......X.XX.f.......W",
    "#WWWWWWW#WWWW##############WWWWW#WWWWWW#",
  ],
  [
    "####WWWW#WWWWWWW#W#####W#WWWWWWW#WWWWWW#",
    "#P..................C..................W",
    "#.....................................+W",
    "#####.#####..kkkkkk..kkkkkk..kkkkkkkkk.W",
    "#b.......f#.....=......................W",
    "#..dd.dd..#..kkkkkk..kkkkkk..kkkkkkkkk.W",
    "#..dd.dd..#.....=......................W",
    "#...N........kkkkkk..kkkkkk..kkkkkkkkk.#",
    "#.........#.........G..................W",
    "#.H.....I.#..kkkkkk..kkkkkk..kkkkkkkkk.W",
    "#.........#.....................=......W",
    "####.######..kkkkkk..kkkkkk..kkkkkkkkk.W",
    "#XXXXXXXXXXp...........................W",
    "#f........X..kkkkkk..kkkkkk..kkkkkkkkk.W",
    "#f...dd...X.................G..........#",
    "#.........X.a.......#.O......H......O..W",
    "#..K......D........p#...SSSSSLSSSSS....W",
    "#.........X.h..O........S.........S..O.#",
    "#.........XCh.......#...S.kkk.kkk.S....#",
    "#.......h.X.h..G....#...S.........S....#",
    "#XXXXXXXXXX.....fff.#...S....R....S.O.C#",
    "#ffff..G..#..ff.....#.O.S.........S....#",
    "#..............O........S.kkk.kkk.S....#",
    "#####.##.##.+.......#...S.........S..O.#",
    "#.....#...#......h..#.H.SSSSSSSSSSS....W",
    "#.....#...#......h..#...............G..W",
    "#zz.z.#.hh#hhh....n.#..................W",
    "#WWWWWWW#WWWWWWW#WWWWWWW#WWWWWWW#WWWWWW#",
  ],
];
const MAP_W = 40;
const MAP_H = 28;
const LAST = FLOORS.length - 1;

type FloorKind = "stone" | "carpet" | "dark" | "wood" | "raised";
type SolidKind = "marble" | "panel" | "concrete" | "stone" | "metal";
/** What makes each floor recognisable: height, light, materials. */
interface Theme {
  name: string;
  h: number; // ceiling height in metres
  lamp: number;
  lampPower: number;
  sky: number;
  ground: number;
  hemi: number;
  exposure: number;
  fog: number;
  fogNear: number;
  fogFar: number;
  wall: [string, string, string]; // panel, seam, accent line
  solid: SolidKind;
  floor: FloorKind;
  ceiling: number;
  strip: number;
  stripPower: number;
  frame: number; // partition posts and rails
  desk: number;
  table: number;
  tile: number; // the dropped ceiling over corridors and small rooms
}
const THEMES: Theme[] = [
  { name: "Lobby", h: 6, lamp: 0xffd2a0, lampPower: 46, sky: 0xffe2c4, ground: 0x2a2016, hemi: 0.55, exposure: 1.1, fog: 0x0b0a10, fogNear: 34, fogFar: 170, wall: ["#ebe5da", "#d6cdbd", "#c99a55"], solid: "marble", floor: "stone", ceiling: 0x2b2620, strip: 0xffe9cc, stripPower: 1.3, frame: 0xb59160, desk: 0xf2efe8, table: 0xf2efe8, tile: 0xe8e2d6 },
  { name: "Open office", h: 3.2, lamp: 0xeaf2ff, lampPower: 24, sky: 0xdfe9ff, ground: 0x1c2028, hemi: 0.5, exposure: 1.05, fog: 0x080b14, fogNear: 26, fogFar: 150, wall: ["#e6e9ee", "#cdd2da", "#4fd6aa"], solid: "panel", floor: "carpet", ceiling: 0x1d2026, strip: 0xf0f6ff, stripPower: 1.3, frame: 0xaab0bb, desk: 0xf4f4f2, table: 0xf4f4f2, tile: 0xdfe2e6 },
  { name: "Operations", h: 3.6, lamp: 0x6f8cff, lampPower: 14, sky: 0x4a5f9a, ground: 0x0a0c14, hemi: 0.32, exposure: 1.0, fog: 0x05070f, fogNear: 18, fogFar: 110, wall: ["#262c39", "#1b202b", "#3fa0ff"], solid: "concrete", floor: "dark", ceiling: 0x0c0e14, strip: 0x7aa2ff, stripPower: 0.6, frame: 0x2f3746, desk: 0x2c313c, table: 0x2c313c, tile: 0x1a1e27 },
  { name: "Executive floor", h: 3.2, lamp: 0xffc48a, lampPower: 22, sky: 0xffd2a8, ground: 0x1a1210, hemi: 0.38, exposure: 1.0, fog: 0x0a0808, fogNear: 24, fogFar: 140, wall: ["#3b3633", "#2d2926", "#c9a46a"], solid: "stone", floor: "wood", ceiling: 0x15110e, strip: 0xffd9a8, stripPower: 0.8, frame: 0x6b5233, desk: 0x6b4a2f, table: 0x5a3d26, tile: 0x2a211b },
  { name: "Server floor", h: 3.0, lamp: 0xbfe6ff, lampPower: 16, sky: 0x9fd0ff, ground: 0x0a1018, hemi: 0.36, exposure: 1.0, fog: 0x0b1622, fogNear: 5, fogFar: 46, wall: ["#2a323c", "#20262e", "#4fd6ff"], solid: "metal", floor: "raised", ceiling: 0x1c232c, strip: 0xd8f0ff, stripPower: 1.0, frame: 0x3d4652, desk: 0x2c313c, table: 0x2c313c, tile: 0x2a3038 },
];
const ROOF_THEME: Theme = { ...THEMES[LAST], name: "Roof", h: 3.2 };

const DIFFICULTIES = [
  { name: "Easy", health: 150, accuracy: 0.7, damage: 0.7, score: 0.8 },
  { name: "Normal", health: 100, accuracy: 1, damage: 1, score: 1 },
  { name: "Hard", health: 80, accuracy: 1.2, damage: 1.35, score: 1.3 },
];

/** The handler on the radio. */
const INTRO = [
  "You're in the garage lift. Comms check... I hear you.",
  "Five floors. The secrets sit on one rack in the server room, top floor.",
  "Every floor locks its elevator behind something. Break it and ride up.",
  "Cameras sweep, tripwires cross the corridors, guards walk their rounds. Quiet is faster.",
];
const ARRIVE = [
  "Lobby. Hack both security terminals to drop the cameras and open the gates, or find the staff door code.",
  "Open office. The access codes are in the server closet. Its door code is on the IT terminal.",
  "Operations. Three fuses feed the laser grid on the lift. Tripwires in the corridors: jump them.",
  "Executive floor. The head of security carries the badge for the lift. He won't go quietly.",
  "Server floor. The keycard is in the security office; its code is somewhere in the NOC. Then the rack.",
];

/** World units (metres) per map cell. */
const U = 2;
const EYE = 1.65;
const CAR_H = 2.9; // the elevator car's ceiling
const DROP_H = 2.9; // dropped ceilings over corridors and small rooms (light panels sit flush in them)

const WALK = 3.0; // cells per second
const SPRINT = 1.6;
const TURN_SPEED = 2.2; // radians per second (arrow keys)
const MOUSE_TURN = 0.0022;
const PITCH_LIMIT = 1.2;
const PLAYER_RADIUS = 0.22; // cells
const JUMP_SPEED = 3.33; // m/s: about 0.5 m high and 0.6 s in the air
const GRAVITY = 11.1;
const WIRE_HEIGHT = 0.3; // a tripwire's height; your feet must be above it
const FLOOR_HEAL = 25;
const MEDKIT_HEAL = 35;
const CHECKPOINT_HEALTH = 70;
const MAX_DEATHS = 3;
const MAG = 12;
const SHOT_EVERY = 0.16;
const RELOAD_SECONDS = 1.2;
const GUARD_HEALTH = 3; // body hits; one to the head is enough
const BOSS_HEALTH = 12; // twelve body hits or three to the head
const BOSS_HEADSHOTS = 3;
const GUARD_SPEED = 1.3; // cells per second
const PATROL_SPEED = 0.75;
const GUARD_SEES = 10;
const GUARD_KEEPS = 3;
const GUARD_FIRES_EVERY: [number, number] = [0.9, 1.6];
const BOSS_FIRES_EVERY: [number, number] = [0.45, 0.85];
const GUARD_DAMAGE: [number, number] = [6, 11];
const ALERT_RADIUS = 6;
const HEARS_SHOT = 8;
const CHASE_SECONDS = 8;
const GRACE_SECONDS = 1.6;
const AI_FAR = 22; // calm guards further than this think four times a second
const CAM_RANGE = 6; // cells
const CAM_FOV = 0.36; // half-angle, radians
const CAM_NOTICE = 0.5; // seconds in view before the alarm
const REACH = 0.7;
const USE_REACH = 1.15;
const HOLD_SECONDS = 1.5;
const READ_SECONDS = 1.0;
const DOWNLOAD_SECONDS = 14;
const BACKUP_SECONDS = 32;
const UPLOAD_SECONDS = 8;
const STAY_RANGE = 2.5;
const REINFORCE_EVERY = 3.5;
const REINFORCE_MAX = 3;
const CALL_SECONDS = 6; // the elevator takes this long to come when the alarm is up
const FINALE_SECONDS = 60;
const FINALE_WAVES = [2, 24];
const WAVE_SIZE = 3;
const PARTITION = 0.05;
const DOOR_SECONDS = 0.6;
const RIDE_SECONDS = 2.2;
const ROOF_SECONDS = 8;
const HEADSHOT_SECONDS = 0.7;
const MAX_PIXEL_RATIO = 1.25;
/** Point lights that follow you between the floor's light positions; a fixed number keeps every shader the same. */
const LIGHT_POOL = 4;

const ACCENT = 0xffb81f;
const CORAL = 0xff6b57;
const MINT = 0x4fd6aa;
const GOLD = 0xffc94a;
const ALARM = 0xff3324;
const NIGHT = 0x070912;

const SOLID_CH = "#XWSVdeMQojkpTYFRcPUOfhnbaz";
const WALLISH = "#XWSV";

type Spot = { x: number; y: number };
interface Guard {
  kind: "patrol" | "post" | "boss" | "hunter";
  x: number;
  y: number;
  node: THREE.Group;
  head: THREE.Object3D[];
  visor: THREE.MeshStandardMaterial;
  flash: THREE.Mesh;
  legs: THREE.Object3D[];
  skin: THREE.MeshStandardMaterial[];
  health: number;
  alert: boolean;
  sees: boolean;
  suspicion: number;
  chase: number;
  heading: number;
  postAngle: number;
  look: number;
  route: number[];
  routeAt: number;
  path: number[];
  wait: number;
  cover: Spot | null;
  coverFor: number;
  stagger: number;
  reload: number;
  hurt: number;
  dying: number; // 0 alive, > 0 falling, -1 down
  walk: number;
  strafe: number;
  strafeFor: number;
  skip: number;
  calledBackup: boolean;
}
/** Office staff: they ignore you until shooting or an alarm, then run and cower. */
interface Civ extends Spot {
  node: THREE.Group;
  head: THREE.Object3D;
  arms: THREE.Object3D[];
  legs: THREE.Object3D[];
  sit: boolean;
  act: "type" | "sip" | "talk" | "work";
  yaw: number;
  t: number;
  state: "calm" | "flee" | "cower" | "down";
  fleeFor: number;
  witness: number; // > 0: saw you shoot and is deciding to call security; -1 done
  dying: number;
}
/** A place a light shines from; the nearest few get one of the pooled point lights. */
interface LightSpot {
  pos: THREE.Vector3;
  color: THREE.Color;
  base: number;
  intensity: number;
  distance: number;
  decay: number;
  lamp: boolean; // a ceiling lamp (turns red in the lockdown)
}
interface Station extends Spot {
  kind: "T" | "F" | "Y";
  done: boolean;
  door: number; // for Y: the door whose code it shows
  screen: THREE.Mesh | null;
  lamp: THREE.Mesh | null;
}
interface Note extends Spot {
  door: number;
  read: boolean;
}
interface Door extends Spot {
  cell: number;
  code: string;
  known: boolean;
  open: boolean;
  t: number;
  leaves: THREE.Mesh[];
  lamp: THREE.MeshBasicMaterial;
  wrong: number;
}
interface Cam {
  mx: number; // the mount on the wall, in cells
  my: number;
  sx: number; // where it looks from, just off the wall
  sy: number;
  base: number;
  yaw: number;
  amp: number;
  speed: number;
  phase: number;
  t: number;
  head: THREE.Group;
  cone: THREE.Mesh;
  led: THREE.Mesh;
  seen: number;
  sees: boolean;
  dead: boolean;
}
interface Wire extends Spot {
  alongX: boolean;
  beam: THREE.Mesh;
  flash: number;
}
interface Car extends Spot {
  cell: number;
  dir: [number, number];
  up: boolean;
  roof: boolean;
  node: THREE.Group;
  doors: THREE.Mesh[];
  open: number;
  arrow: THREE.MeshBasicMaterial;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  shown: string;
  call: number;
  walls: number[];
  closed: number[];
}
interface Pickup {
  kind: "medkit" | "intel";
  at: Spot;
  node: THREE.Object3D;
  taken: boolean;
  spot: LightSpot | null;
}
interface Run {
  at: Spot;
  t: number;
  total: number;
  spawned: number;
  spawnClock: number;
  label: string;
  finish(): void;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = (t: number) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};
const hash = (x: number, y: number) => ((x * 73856093) ^ (y * 19349663)) >>> 0;
const N4: [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
// An elevator car's walls in its own cell frame (u across, v from the back wall to the doors at v = 1).
const CAR_WALLS = [0, 0, 1, 0.05, 0, 0, 0.05, 1, 0.95, 0, 1, 1, 0, 0.95, 0.225, 1, 0.775, 0.95, 1, 1];
const CAR_DOOR = [0.225, 0.93, 0.775, 0.97];

// ---- textures, drawn once per game (and the floor's own ones per floor) ----
/** While set, textures are drawn later, a few per frame, so loading never freezes the page. */
let textureQueue: (() => void)[] | null = null;
function canvasTexture(w: number, h: number, draw: (c: CanvasRenderingContext2D, w: number, h: number) => void, srgb = true): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const t = new THREE.CanvasTexture(canvas);
  if (textureQueue)
    textureQueue.push(() => {
      draw(canvas.getContext("2d")!, w, h);
      t.needsUpdate = true;
    });
  else draw(canvas.getContext("2d")!, w, h);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
function speckle(c: CanvasRenderingContext2D, w: number, h: number, colors: string[], alpha: number, count: number, size = 2) {
  for (let i = 0; i < count; i++) {
    c.fillStyle = colors[i % colors.length];
    c.globalAlpha = alpha * Math.random();
    c.fillRect(Math.random() * w, Math.random() * h, size, size);
  }
  c.globalAlpha = 1;
}
function veins(c: CanvasRenderingContext2D, w: number, h: number, color: string, count: number) {
  c.strokeStyle = color;
  c.lineWidth = 1.2;
  for (let i = 0; i < count; i++) {
    c.globalAlpha = rand(0.15, 0.4);
    c.beginPath();
    let x = Math.random() * w;
    let y = Math.random() * h;
    c.moveTo(x, y);
    for (let k = 0; k < 6; k++) {
      x += rand(-40, 40);
      y += rand(10, 50);
      c.lineTo(x, y);
    }
    c.stroke();
  }
  c.globalAlpha = 1;
}
function drawFloor(kind: FloorKind) {
  return (c: CanvasRenderingContext2D, w: number, h: number) => {
    if (kind === "stone") {
      c.fillStyle = "#cdbfa8";
      c.fillRect(0, 0, w, h);
      veins(c, w, h, "#f4ecdc", 6);
      veins(c, w, h, "#a99a82", 3);
      c.fillStyle = "#b0a28a";
      for (const p of [0, 128]) {
        c.fillRect(0, p, w, 2);
        c.fillRect(p, 0, 2, h);
      }
    } else if (kind === "carpet") {
      c.fillStyle = "#596070";
      c.fillRect(0, 0, w, h);
      speckle(c, w, h, ["#6a7182", "#4a505d", "#7a8192"], 0.6, 900, 3);
      c.fillStyle = "#4b515e";
      for (const p of [0, 128]) {
        c.fillRect(0, p, w, 1);
        c.fillRect(p, 0, 1, h);
      }
    } else if (kind === "dark") {
      c.fillStyle = "#151920";
      c.fillRect(0, 0, w, h);
      speckle(c, w, h, ["#1c212a", "#10131a"], 0.7, 900, 3);
      c.fillStyle = "#0a0c10";
      for (const p of [0, 128]) {
        c.fillRect(0, p, w, 2);
        c.fillRect(p, 0, 2, h);
      }
      c.fillStyle = "#1d3a6b";
      c.fillRect(0, 64, w, 1);
    } else if (kind === "wood") {
      for (let y = 0; y < h; y += 32) {
        const tone = rand(-12, 12);
        c.fillStyle = `rgb(${110 + tone}, ${74 + tone * 0.7}, ${46 + tone * 0.5})`;
        c.fillRect(0, y, w, 32);
        c.strokeStyle = "rgba(40, 24, 12, 0.25)";
        c.lineWidth = 1;
        for (let k = 0; k < 4; k++) {
          c.beginPath();
          c.moveTo(0, y + rand(4, 28));
          c.bezierCurveTo(w * 0.3, y + rand(4, 28), w * 0.6, y + rand(4, 28), w, y + rand(4, 28));
          c.stroke();
        }
        c.fillStyle = "#2d1d12";
        c.fillRect(0, y, w, 1.5);
        c.fillRect((y * 37) % w, y, 1.5, 32);
      }
    } else {
      c.fillStyle = "#3b414a";
      c.fillRect(0, 0, w, h);
      c.fillStyle = "#2b3037";
      for (const [ox, oy] of [[0, 0], [128, 0], [0, 128], [128, 128]]) {
        for (let y = 20; y < 108; y += 9) for (let x = 20; x < 108; x += 9) c.fillRect(ox + x, oy + y, 3, 3);
      }
      c.fillStyle = "#22262c";
      for (const p of [0, 128]) {
        c.fillRect(0, p, w, 3);
        c.fillRect(p, 0, 3, h);
      }
    }
  };
}
function drawWall([panel, seam, accent]: [string, string, string]) {
  return (c: CanvasRenderingContext2D) => {
    c.fillStyle = panel;
    c.fillRect(0, 0, 256, 256);
    c.fillStyle = seam;
    c.fillRect(0, 0, 2, 256);
    c.fillRect(127, 0, 2, 256);
    c.fillRect(0, 214, 256, 42);
    c.fillStyle = accent;
    c.fillRect(0, 212, 256, 2);
  };
}
function drawSolid(kind: SolidKind, wall: [string, string, string]) {
  return (c: CanvasRenderingContext2D, w: number, h: number) => {
    if (kind === "marble") {
      c.fillStyle = "#e9e3d8";
      c.fillRect(0, 0, w, h);
      veins(c, w, h, "#b9ad9b", 7);
      veins(c, w, h, "#d8ccb6", 5);
      c.fillStyle = "#d3c9b8";
      c.fillRect(0, 0, w, 1);
      c.fillRect(0, 0, 1, h);
    } else if (kind === "panel") drawWall(wall)(c);
    else if (kind === "concrete") {
      c.fillStyle = "#2a2f37";
      c.fillRect(0, 0, w, h);
      speckle(c, w, h, ["#353b45", "#20242b"], 0.8, 1800, 3);
      c.fillStyle = "#1b1f25";
      for (const y of [0, 85, 170]) c.fillRect(0, y, w, 2);
      c.fillStyle = "#3fa0ff";
      c.fillRect(0, 230, w, 2);
    } else if (kind === "stone") {
      c.fillStyle = "#2f2b29";
      c.fillRect(0, 0, w, h);
      veins(c, w, h, "#4e4743", 8);
      veins(c, w, h, "#1d1a19", 4);
      c.fillStyle = "#c9a46a";
      c.fillRect(0, 222, w, 2);
    } else {
      c.fillStyle = "#28303a";
      c.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 32) {
        c.fillStyle = "#323b47";
        c.fillRect(x, 0, 14, h);
        c.fillStyle = "#1e242c";
        c.fillRect(x + 14, 0, 2, h);
      }
    }
  };
}
function drawCeiling(index: number) {
  return (c: CanvasRenderingContext2D) => {
    c.fillStyle = "#000";
    c.fillRect(0, 0, 256, 256);
    c.fillStyle = "#fff";
    if (index === 0) {
      for (const x of [40, 152]) for (const y of [40, 152]) c.fillRect(x, y, 64, 64);
    } else if (index === 1) c.fillRect(24, 120, 208, 16);
    else if (index === 2) c.fillRect(0, 124, 256, 6);
    else if (index === 3) {
      for (const [x, y] of [[64, 64], [192, 192]]) {
        c.beginPath();
        c.arc(x, y, 14, 0, Math.PI * 2);
        c.fill();
      }
    } else {
      c.fillRect(0, 60, 256, 6);
      c.fillRect(0, 190, 256, 6);
    }
  };
}
/** An analytics dashboard: KPI tiles, a line chart, a bar chart. Drawn at any width. */
function drawDashboard(c: CanvasRenderingContext2D, w: number, h: number) {
  const s = w / 256;
  c.fillStyle = "#0a0f1e";
  c.fillRect(0, 0, w, h);
  c.fillStyle = "#131b31";
  c.fillRect(0, 0, w, 14 * s);
  c.fillStyle = "#ffb81f";
  c.fillRect(6 * s, 4 * s, 6 * s, 6 * s);
  c.fillStyle = "#3a4562";
  c.fillRect(16 * s, 5.5 * s, 42 * s, 3 * s);
  ["#4fd6aa", "#ffb81f", "#6cc4ff"].forEach((color, i) => {
    const x = (6 + i * 58) * s;
    c.fillStyle = "#121a2f";
    c.fillRect(x, 20 * s, 52 * s, 30 * s);
    c.fillStyle = "#3a4562";
    c.fillRect(x + 5 * s, 25 * s, 22 * s, 3 * s);
    c.fillStyle = color;
    c.fillRect(x + 5 * s, 33 * s, rand(18, 40) * s, 10 * s);
  });
  const top = 56 * s;
  const bottom = h - 6 * s;
  const left = 6 * s;
  const right = 176 * s;
  c.fillStyle = "#0f172b";
  c.fillRect(left, top, right - left, bottom - top);
  c.fillStyle = "#1b2542";
  for (let y = top + 10 * s; y < bottom; y += 14 * s) c.fillRect(left, y, right - left, Math.max(1, s));
  const pts: [number, number][] = [];
  let v = 0.5;
  for (let x = left + 4 * s; x <= right - 4 * s; x += 8 * s) {
    v = Math.min(0.9, Math.max(0.1, v + rand(-0.18, 0.18)));
    pts.push([x, bottom - 6 * s - v * (bottom - top - 16 * s)]);
  }
  c.beginPath();
  c.moveTo(pts[0][0], bottom);
  for (const [x, y] of pts) c.lineTo(x, y);
  c.lineTo(pts[pts.length - 1][0], bottom);
  c.closePath();
  c.fillStyle = "rgba(79, 214, 170, 0.18)";
  c.fill();
  c.beginPath();
  pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.strokeStyle = "#4fd6aa";
  c.lineWidth = 2 * s;
  c.stroke();
  const bx = 182 * s;
  c.fillStyle = "#0f172b";
  c.fillRect(bx, 20 * s, w - bx - 6 * s, bottom - 20 * s);
  for (let i = 0; i < 6; i++) {
    const bh = rand(0.2, 0.9) * (bottom - 34 * s);
    c.fillStyle = i % 2 ? "#ffb81f" : "#6cc4ff";
    c.fillRect(bx + (6 + i * 10) * s, bottom - 6 * s - bh, 6 * s, bh);
  }
}
/** An editor full of code. */
function drawCode(c: CanvasRenderingContext2D, w: number, h: number) {
  const s = w / 256;
  c.fillStyle = "#0d1117";
  c.fillRect(0, 0, w, h);
  c.fillStyle = "#161b22";
  c.fillRect(0, 0, w, 12 * s);
  c.fillStyle = "#0d1117";
  c.fillRect(4 * s, 2 * s, 50 * s, 10 * s);
  c.fillStyle = "#ffb81f";
  c.fillRect(4 * s, 10.5 * s, 50 * s, 1.5 * s);
  const palette = ["#ff7b72", "#79c0ff", "#d2a8ff", "#a5d6ff", "#8b949e", "#ffa657", "#7ee787"];
  let indent = 0;
  for (let y = 18 * s; y < h - 6 * s; y += 8 * s) {
    c.fillStyle = "#30363d";
    c.fillRect(4 * s, y, 8 * s, 3 * s);
    indent = Math.max(0, Math.min(4, indent + (Math.random() < 0.3 ? 1 : Math.random() < 0.35 ? -1 : 0)));
    let x = (20 + indent * 10) * s;
    const n = 1 + Math.floor(Math.random() * 4);
    for (let k = 0; k < n && x < w - 10 * s; k++) {
      const len = rand(8, 38) * s;
      c.fillStyle = palette[Math.floor(Math.random() * palette.length)];
      c.fillRect(x, y, len, 3 * s);
      x += len + 4 * s;
    }
  }
}
/** The security desk: four camera feeds. */
function drawSecurity(c: CanvasRenderingContext2D, w: number, h: number) {
  const s = w / 256;
  c.fillStyle = "#0a0d14";
  c.fillRect(0, 0, w, h);
  c.fillStyle = "#2a1013";
  c.fillRect(0, 0, w, 14 * s);
  c.fillStyle = "#ff6b57";
  c.fillRect(0, 13 * s, w, 1.5 * s);
  c.beginPath();
  c.arc(9 * s, 7 * s, 3 * s, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "#f2f2f3";
  c.font = `600 ${8 * s}px sans-serif`;
  c.textBaseline = "middle";
  c.fillText("SECURITY · LIVE", 16 * s, 7.5 * s);
  const gw = (w - 18 * s) / 2;
  const gh = (h - 26 * s) / 2;
  for (let i = 0; i < 4; i++) {
    const x = 6 * s + (i % 2) * (gw + 6 * s);
    const y = 20 * s + Math.floor(i / 2) * (gh + 6 * s);
    const g = c.createLinearGradient(0, y, 0, y + gh);
    g.addColorStop(0, "#1c2533");
    g.addColorStop(1, "#0e131c");
    c.fillStyle = g;
    c.fillRect(x, y, gw, gh);
    c.fillStyle = "#2a3446";
    c.fillRect(x + rand(0.15, 0.6) * gw, y + gh * 0.45, gw * 0.25, gh * 0.55);
    c.fillStyle = "#c9d3e0";
    c.font = `600 ${6 * s}px monospace`;
    c.fillText(`CAM 0${i + 1}`, x + 4 * s, y + 7 * s);
    c.fillStyle = "#ff6b57";
    c.fillRect(x + gw - 8 * s, y + 4 * s, 4 * s, 4 * s);
  }
}
/** The operations map: a dotted world with routes. */
function drawOpsMap(c: CanvasRenderingContext2D, w: number, h: number) {
  c.fillStyle = "#06101f";
  c.fillRect(0, 0, w, h);
  c.fillStyle = "#0e2240";
  for (let x = 0; x < w; x += w / 16) c.fillRect(x, 0, 1, h);
  for (let y = 0; y < h; y += h / 9) c.fillRect(0, y, w, 1);
  const blobs = [[0.22, 0.35, 0.12, 0.2], [0.3, 0.7, 0.07, 0.18], [0.5, 0.32, 0.08, 0.13], [0.53, 0.62, 0.08, 0.2], [0.72, 0.35, 0.16, 0.2], [0.82, 0.72, 0.07, 0.1]];
  c.fillStyle = "#3fa0ff";
  for (let y = 4; y < h; y += 7) {
    for (let x = 4; x < w; x += 7) {
      if (blobs.some(([bx, by, rx, ry]) => ((x / w - bx) / rx) ** 2 + ((y / h - by) / ry) ** 2 < 1)) c.fillRect(x, y, 3, 3);
    }
  }
  c.strokeStyle = "#ffb81f";
  c.lineWidth = 2;
  for (let i = 0; i < 5; i++) {
    const [ax, ay] = blobs[i];
    const [bx, by] = blobs[(i + 2) % blobs.length];
    c.beginPath();
    c.moveTo(ax * w, ay * h);
    c.quadraticCurveTo(((ax + bx) / 2) * w, Math.min(ay, by) * h - 40, bx * w, by * h);
    c.stroke();
  }
  c.fillStyle = "#ff6b57";
  for (const [x, y] of blobs) {
    c.beginPath();
    c.arc(x * w, y * h, 5, 0, Math.PI * 2);
    c.fill();
  }
}
/** A terminal's screen. */
function drawKiosk(c: CanvasRenderingContext2D, w: number, h: number, title: string, status: string, color: string, done: boolean) {
  const s = w / 192;
  c.fillStyle = done ? "#06231c" : "#0b1020";
  c.fillRect(0, 0, w, h);
  c.fillStyle = color;
  c.fillRect(0, 0, w, 6 * s);
  c.fillStyle = "#c9d3e0";
  c.font = `700 ${12 * s}px sans-serif`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(title, w / 2, 22 * s);
  c.strokeStyle = color;
  c.lineWidth = 4 * s;
  c.beginPath();
  c.arc(w / 2, 52 * s, 10 * s, Math.PI, done ? Math.PI * 1.7 : Math.PI * 2);
  c.stroke();
  c.fillStyle = color;
  c.fillRect(w / 2 - 15 * s, 52 * s, 30 * s, 22 * s);
  c.font = `800 ${14 * s}px sans-serif`;
  c.fillText(status, w / 2, 94 * s);
  c.fillStyle = "#2a3446";
  c.fillRect(20 * s, 110 * s, w - 40 * s, 4 * s);
  c.fillStyle = color;
  c.fillRect(20 * s, 110 * s, done ? w - 40 * s : 30 * s, 4 * s);
}
function makeTextures(queue: (() => void)[]) {
  textureQueue = queue;
  const server = canvasTexture(128, 256, (c) => {
    c.fillStyle = "#0e1016";
    c.fillRect(0, 0, 128, 256);
    for (let i = 0; i < 14; i++) {
      c.fillStyle = "#171a22";
      c.fillRect(10, 8 + i * 17, 108, 13);
      for (let j = 0; j < 6; j++) {
        c.fillStyle = Math.random() < 0.15 ? "#ff6b57" : Math.random() < 0.6 ? "#4fd6aa" : "#ffb81f";
        if (Math.random() < 0.8) c.fillRect(84 + j * 5, 13 + i * 17, 3, 3);
      }
    }
  });
  const rack = canvasTexture(128, 256, (c) => {
    c.fillStyle = "#0b0c11";
    c.fillRect(0, 0, 128, 256);
    for (let i = 0; i < 11; i++) {
      c.fillStyle = "#191c25";
      c.fillRect(8, 8 + i * 21, 112, 16);
      for (let j = 0; j < 8; j++) {
        c.fillStyle = j % 3 ? "#ffb81f" : "#4fd6aa";
        c.fillRect(70 + j * 6, 14 + i * 21, 3, 3);
      }
    }
    c.fillStyle = "#ffb81f";
    c.font = "bold 18px sans-serif";
    c.textAlign = "center";
    c.fillText("SECRETS", 64, 246);
  });
  // Server racks in rows: cyan and red status lights, vents.
  const rackRow = canvasTexture(128, 256, (c) => {
    c.fillStyle = "#0c0f14";
    c.fillRect(0, 0, 128, 256);
    for (let i = 0; i < 16; i++) {
      c.fillStyle = i % 4 === 0 ? "#141922" : "#181d27";
      c.fillRect(6, 6 + i * 15.5, 116, 12);
      c.fillStyle = "#0a0c10";
      for (let k = 0; k < 7; k++) c.fillRect(12 + k * 6, 9 + i * 15.5, 3, 6);
      for (let j = 0; j < 5; j++) {
        if (Math.random() < 0.75) {
          c.fillStyle = Math.random() < 0.18 ? "#ff3b30" : "#4fe0ff";
          c.fillRect(84 + j * 7, 11 + i * 15.5, 3, 3);
        }
      }
    }
  });
  const screens = [drawDashboard, drawCode, drawSecurity].map((d) => canvasTexture(256, 144, d));
  const wallScreens = [drawDashboard, drawSecurity].map((d) => canvasTexture(512, 288, d));
  const opsMap = canvasTexture(512, 288, drawOpsMap);
  const kiosk = canvasTexture(192, 128, (c, w, h) => drawKiosk(c, w, h, "SECURITY TERMINAL", "LOCKED", "#ff6b57", false));
  const kioskDone = canvasTexture(192, 128, (c, w, h) => drawKiosk(c, w, h, "SECURITY TERMINAL", "ACCESS GRANTED", "#4fd6aa", true));
  const codeKiosk = canvasTexture(192, 128, (c, w, h) => drawKiosk(c, w, h, "IT HELPDESK", "DOOR CODES", "#6cc4ff", false));
  const logo = canvasTexture(1024, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.strokeStyle = "#c99a55";
    c.lineWidth = 14;
    c.beginPath();
    c.arc(128, 128, 82, 0, Math.PI * 2);
    c.stroke();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      c.beginPath();
      c.moveTo(128 + Math.cos(a) * 26, 128 + Math.sin(a) * 26);
      c.lineTo(128 + Math.cos(a) * 62, 128 + Math.sin(a) * 62);
      c.stroke();
    }
    c.fillStyle = "#2b2722";
    c.font = "700 112px sans-serif";
    c.textBaseline = "middle";
    c.fillText("VAULTLINE", 250, 112);
    c.fillStyle = "#8a7a62";
    c.font = "600 34px sans-serif";
    c.fillText("D A T A   H O L D I N G S", 256, 196);
  });
  const brushed = canvasTexture(128, 256, (c) => {
    c.fillStyle = "#aeb4bd";
    c.fillRect(0, 0, 128, 256);
    for (let i = 0; i < 260; i++) {
      c.fillStyle = Math.random() < 0.5 ? "#c4c9d1" : "#9aa1ab";
      c.globalAlpha = rand(0.2, 0.6);
      c.fillRect(Math.random() * 128, 0, 1, 256);
    }
    c.globalAlpha = 1;
  });
  const hazard = canvasTexture(128, 256, (c) => {
    c.fillStyle = "#3a3f47";
    c.fillRect(0, 0, 128, 256);
    for (let i = 0; i < 120; i++) {
      c.fillStyle = Math.random() < 0.5 ? "#454b54" : "#30343b";
      c.fillRect(0, Math.random() * 256, 128, 1);
    }
    for (const y0 of [24, 212]) {
      c.save();
      c.beginPath();
      c.rect(0, y0, 128, 20);
      c.clip();
      for (let x = -40; x < 160; x += 20) {
        c.fillStyle = "#ffb81f";
        c.beginPath();
        c.moveTo(x, y0 + 20);
        c.lineTo(x + 10, y0 + 20);
        c.lineTo(x + 30, y0);
        c.lineTo(x + 20, y0);
        c.fill();
      }
      c.restore();
    }
    c.fillStyle = "#1c1f24";
    c.fillRect(0, 0, 3, 256);
  });
  const mesh = canvasTexture(64, 64, (c) => {
    c.fillStyle = "#3a404c";
    c.fillRect(0, 0, 64, 64);
    c.fillStyle = "#16191f";
    for (let i = 0; i < 64; i += 4) {
      c.fillRect(i, 0, 1, 64);
      c.fillRect(0, i, 64, 1);
    }
  });
  mesh.repeat.set(6, 8);
  const note = canvasTexture(64, 64, (c) => {
    c.fillStyle = "#ffd84a";
    c.fillRect(0, 0, 64, 64);
    c.strokeStyle = "#1d3a8a";
    c.lineWidth = 3;
    for (const y of [18, 32, 46]) {
      c.beginPath();
      c.moveTo(10, y);
      for (let x = 10; x < 54; x += 6) c.lineTo(x, y + rand(-3, 3));
      c.stroke();
    }
  });
  const whiteboard = canvasTexture(256, 160, (c) => {
    c.fillStyle = "#f6f7f8";
    c.fillRect(0, 0, 256, 160);
    c.lineWidth = 3;
    for (const color of ["#2f5d8a", "#c0392b", "#2e8b57"]) {
      c.strokeStyle = color;
      c.beginPath();
      let x = rand(20, 80);
      let y = rand(20, 140);
      c.moveTo(x, y);
      for (let i = 0; i < 5; i++) c.lineTo((x += rand(15, 40)), (y = rand(20, 140)));
      c.stroke();
    }
    c.strokeStyle = "#2f5d8a";
    c.strokeRect(150, 24, 80, 40);
    c.strokeRect(150, 90, 80, 40);
  });
  const helipad = canvasTexture(512, 512, (c) => {
    c.fillStyle = "#24272d";
    c.fillRect(0, 0, 512, 512);
    speckle(c, 512, 512, ["#2c3036", "#1d2025"], 0.8, 900, 5);
    c.strokeStyle = "#ffb81f";
    c.lineWidth = 22;
    c.beginPath();
    c.arc(256, 256, 200, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = "#f2f2f3";
    c.fillRect(176, 136, 40, 240);
    c.fillRect(296, 136, 40, 240);
    c.fillRect(216, 236, 80, 40);
  });
  const roof = canvasTexture(256, 256, (c) => {
    c.fillStyle = "#43464c";
    c.fillRect(0, 0, 256, 256);
    speckle(c, 256, 256, ["#50545a", "#363940", "#5b5f66"], 0.9, 1500, 3);
  });
  const mist = canvasTexture(256, 256, (c) => {
    c.clearRect(0, 0, 256, 256);
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      const r = rand(30, 90);
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgba(200, 230, 255, 0.22)");
      g.addColorStop(1, "rgba(200, 230, 255, 0)");
      c.fillStyle = g;
      c.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
  mist.repeat.set(5, 4);
  // Lit windows for the city outside, a few patterns to share between towers.
  const towers = [0, 1, 2].map(() =>
    canvasTexture(64, 128, (c) => {
      c.fillStyle = "#0b0e1a";
      c.fillRect(0, 0, 64, 128);
      for (let y = 2; y < 128; y += 6) {
        for (let x = 3; x < 64; x += 7) {
          if (Math.random() < 0.35) {
            c.fillStyle = Math.random() < 0.8 ? "#ffd99a" : "#9fd4ff";
            c.globalAlpha = rand(0.35, 1);
            c.fillRect(x, y, 4, 3);
          }
        }
      }
      c.globalAlpha = 1;
    }),
  );
  const sky = canvasTexture(4, 256, (c) => {
    const g = c.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, "#04050c");
    g.addColorStop(0.55, "#0c1030");
    g.addColorStop(0.8, "#2a1d3c");
    g.addColorStop(1, "#43273a");
    c.fillStyle = g;
    c.fillRect(0, 0, 4, 256);
  });
  const all = [whiteboard, server, rack, rackRow, opsMap, kiosk, kioskDone, codeKiosk, logo, brushed, hazard, mesh, note, helipad, roof, mist, sky, ...screens, ...wallScreens, ...towers];
  textureQueue = null;
  return { whiteboard, server, rack, rackRow, screens, wallScreens, opsMap, kiosk, kioskDone, codeKiosk, logo, brushed, hazard, mesh, note, helipad, roof, mist, towers, sky, all };
}

/** A guard in tactical gear: helmet with a glowing visor, vest, pistol. Faces +z. */
function makeGuard(geo: (w: number, h: number, d: number) => THREE.BoxGeometry, flashGeo: THREE.BufferGeometry, boss: boolean) {
  const suit = new THREE.MeshStandardMaterial({ color: boss ? 0x1a1c22 : 0x23262e, roughness: 0.8 });
  const vest = new THREE.MeshStandardMaterial({ color: boss ? 0x2a2620 : 0x343844, roughness: 0.6, metalness: 0.2 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc89878, roughness: 0.7 });
  const black = new THREE.MeshStandardMaterial({ color: 0x0f1014, roughness: 0.4, metalness: 0.5 });
  const visor = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: boss ? GOLD : 0x6cc4ff, emissiveIntensity: 2, roughness: 0.2 });
  const badge = new THREE.MeshStandardMaterial({ color: boss ? GOLD : ACCENT, emissive: boss ? GOLD : ACCENT, emissiveIntensity: boss ? 1 : 0.4 });
  const flashMat = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const part = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geo(w, h, d), m);
    mesh.position.set(x, y, z);
    return mesh;
  };
  const node = new THREE.Group();
  node.rotation.order = "YXZ"; // turn first, then lean back when hit or falling
  const legs = [-0.12, 0.12].map((x) => {
    const leg = new THREE.Group();
    leg.position.set(x, 0.92, 0);
    leg.add(part(0.19, 0.9, 0.22, suit, 0, -0.45, 0));
    leg.add(part(0.2, 0.12, 0.28, black, 0, -0.86, 0.03)); // boot
    node.add(leg);
    return leg;
  });
  node.add(part(0.48, 0.66, 0.28, suit, 0, 1.25, 0)); // torso
  node.add(part(0.5, 0.48, 0.32, vest, 0, 1.3, 0)); // vest
  node.add(part(0.3, 0.1, 0.04, badge, 0, 1.42, 0.17)); // badge strip
  const head = part(0.24, 0.26, 0.24, skin, 0, 1.73, 0);
  const helmet = part(0.3, 0.17, 0.3, black, 0, 1.86, -0.01);
  const visorMesh = part(0.26, 0.08, 0.04, visor, 0, 1.76, 0.13);
  node.add(head, helmet, visorMesh);
  node.add(part(0.13, 0.58, 0.14, suit, -0.31, 1.25, 0)); // left arm
  const arm = new THREE.Group(); // right arm, raised with the pistol
  arm.position.set(0.31, 1.47, 0.02);
  arm.add(part(0.13, 0.13, 0.52, suit, 0, 0, 0.2));
  arm.add(part(0.07, 0.11, 0.26, black, 0, 0.0, 0.55));
  const flash = new THREE.Mesh(flashGeo, flashMat);
  flash.position.set(0, 0, 0.75);
  arm.add(flash);
  node.add(arm);
  if (boss) node.scale.setScalar(1.2);
  return { node, head: [head, helmet, visorMesh], visor, flash, legs, skin: [suit, vest, skin], own: [suit, vest, skin, black, visor, badge, flashMat] };
}

/** Office staff: the guards' low-poly style in office clothes, no helmet. Faces +z. */
function makeCivilian(
  geo: (w: number, h: number, d: number) => THREE.BoxGeometry,
  m: { shirt: THREE.Material; trousers: THREE.Material; skin: THREE.Material; hair: THREE.Material; shoe: THREE.Material },
) {
  const part = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geo(w, h, d), mat);
    mesh.position.set(x, y, z);
    return mesh;
  };
  const node = new THREE.Group();
  node.rotation.order = "YXZ";
  const legs = [-0.11, 0.11].map((x) => {
    const leg = new THREE.Group();
    leg.position.set(x, 0.92, 0);
    leg.add(part(0.18, 0.9, 0.2, m.trousers, 0, -0.45, 0));
    leg.add(part(0.19, 0.1, 0.27, m.shoe, 0, -0.87, 0.03));
    node.add(leg);
    return leg;
  });
  node.add(part(0.44, 0.62, 0.25, m.shirt, 0, 1.24, 0));
  node.add(part(0.2, 0.08, 0.2, m.skin, 0, 1.58, 0));
  const head = new THREE.Group();
  head.position.set(0, 1.73, 0);
  head.add(part(0.23, 0.25, 0.23, m.skin, 0, 0, 0));
  head.add(part(0.25, 0.08, 0.25, m.hair, 0, 0.14, -0.01));
  head.add(part(0.25, 0.16, 0.05, m.hair, 0, 0.04, -0.11));
  node.add(head);
  const arms = [-1, 1].map((side) => {
    const arm = new THREE.Group();
    arm.position.set(side * 0.29, 1.5, 0);
    arm.add(part(0.12, 0.56, 0.13, m.shirt, 0, -0.26, 0));
    arm.add(part(0.1, 0.1, 0.1, m.skin, 0, -0.58, 0));
    node.add(arm);
    return arm;
  });
  return { node, head, arms, legs };
}

/** Your pistol, in front of the camera. */
function makePistol() {
  const body = new THREE.MeshStandardMaterial({ color: 0x2a2d35, roughness: 0.35, metalness: 0.6 });
  const grip = new THREE.MeshStandardMaterial({ color: 0x15161b, roughness: 0.8 });
  const node = new THREE.Group();
  const slide = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.05, 0.24), body);
  slide.position.set(0, 0.02, -0.06);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.13, 0.055), grip);
  handle.position.set(0, -0.06, 0.04);
  handle.rotation.x = 0.25;
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.016, 0.012), new THREE.MeshBasicMaterial({ color: ACCENT }));
  sight.position.set(0, 0.052, -0.16);
  const line = new THREE.Mesh(new THREE.BoxGeometry(0.047, 0.006, 0.18), new THREE.MeshBasicMaterial({ color: ACCENT }));
  line.position.set(0, 0.0, -0.06);
  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.2, 0.2),
    new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  flash.position.set(0, 0.025, -0.22);
  const light = new THREE.PointLight(0xffc24a, 0, 8, 2);
  light.position.set(0, 0.1, -0.35);
  const port = new THREE.Object3D(); // where the spent casings fly out
  port.position.set(0.03, 0.045, -0.05);
  node.add(slide, handle, sight, line, flash, light, port);
  return { node, flash, light, port };
}

/** The extraction helicopter: low poly, with spinning rotors, navigation lights and a searchlight. */
function makeHelicopter() {
  const body = new THREE.MeshStandardMaterial({ color: 0x1d2433, roughness: 0.45, metalness: 0.5 });
  const stripe = new THREE.MeshStandardMaterial({ color: ACCENT, emissive: ACCENT, emissiveIntensity: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x8fc8ff, roughness: 0.05, metalness: 0.6, transparent: true, opacity: 0.55 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0c0e12, roughness: 0.6 });
  const red = new THREE.MeshBasicMaterial({ color: 0xff3b30 });
  const green = new THREE.MeshBasicMaterial({ color: 0x3bff7a });
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xfff3d0, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const geos: THREE.BufferGeometry[] = [];
  const b = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D) => {
    const g = new THREE.BoxGeometry(w, h, d);
    geos.push(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };
  const node = new THREE.Group();
  b(1.9, 1.5, 3.0, body, 0, 1.55, 0, node); // cabin
  b(1.6, 1.1, 1.1, body, 0, 1.35, 2.0, node); // nose
  b(1.66, 0.75, 1.25, glass, 0, 1.95, 1.75, node); // windscreen
  b(1.92, 0.12, 3.02, stripe, 0, 1.3, 0, node);
  b(0.4, 0.4, 4.6, body, 0, 1.9, -3.6, node); // tail boom
  b(0.08, 1.1, 0.7, body, 0, 2.4, -5.7, node); // fin
  b(1.2, 0.06, 0.5, body, 0, 1.95, -5.5, node); // stabiliser
  for (const x of [-0.85, 0.85]) {
    b(0.08, 0.08, 3.4, dark, x, 0.06, 0.3, node); // skids
    for (const z of [-0.8, 1.2]) b(0.06, 0.75, 0.06, dark, x * 0.92, 0.45, z, node);
  }
  b(0.16, 0.45, 0.16, dark, 0, 2.5, 0, node); // mast
  const rotor = new THREE.Group();
  rotor.position.set(0, 2.75, 0);
  node.add(rotor);
  b(10, 0.04, 0.26, dark, 0, 0, 0, rotor);
  b(0.26, 0.04, 10, dark, 0, 0, 0, rotor);
  const tail = new THREE.Group();
  tail.position.set(0.12, 2.45, -5.7);
  node.add(tail);
  b(0.03, 1.5, 0.12, dark, 0, 0, 0, tail);
  b(0.03, 0.12, 1.5, dark, 0, 0, 0, tail);
  b(0.08, 0.08, 0.08, red, -0.98, 1.6, 0.5, node);
  b(0.08, 0.08, 0.08, green, 0.98, 1.6, 0.5, node);
  const strobe = b(0.1, 0.1, 0.1, white, 0, 2.95, -5.9, node);
  const spot = new THREE.SpotLight(0xfff3d0, 120, 60, 0.3, 0.5, 1.2);
  spot.position.set(0, 0.9, 2.2);
  node.add(spot);
  const coneGeo = new THREE.ConeGeometry(3, 14, 24, 1, true);
  coneGeo.translate(0, -7, 0);
  coneGeo.rotateX(-Math.PI / 2); // apex at the light, opening along +z, so lookAt aims it
  geos.push(coneGeo);
  const beam = new THREE.Mesh(coneGeo, beamMat);
  beam.position.copy(spot.position);
  node.add(beam);
  const dispose = () => {
    for (const g of geos) g.dispose();
    for (const m of [body, stripe, glass, dark, red, green, white, beamMat]) m.dispose();
  };
  return { node, rotor, tail, spot, beam, strobe, dispose };
}

/** Builds and runs the game in the host; returns what tears it all down. */
function runRaid(
  host: HTMLDivElement,
  hud: HTMLDivElement,
  onExit: () => void,
  report: (step: string, progress: number, built: number) => void,
  onReady: () => void,
  onError: (e: Error) => void,
): () => void {
  document.documentElement.classList.add("playing-game");
  const texJobs: (() => void)[] = [];
  const tex = makeTextures(texJobs);
  const sound = createRaidSound();

  // ---- renderer, scene, camera ----
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO)); // lowered further when frames run long
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  host.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = tex.sky;
  const fog = new THREE.Fog(NIGHT, 26, 170);
  scene.fog = fog;
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envMap: THREE.Texture | null = null;
  scene.environmentIntensity = 0.35;
  const hemi = new THREE.HemisphereLight(0xbfd2ff, 0x1a1c24, 0.35);
  scene.add(hemi);
  const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.03, 400);
  camera.rotation.order = "YXZ";
  scene.add(camera);
  const pistol = makePistol();
  camera.add(pistol.node);

  // Shared geometry and materials, made once and disposed at the end.
  const geoCache = new Map<string, THREE.BoxGeometry>();
  const box = (w: number, h: number, d: number) => {
    const k = `${w},${h},${d}`;
    let g = geoCache.get(k);
    if (!g) geoCache.set(k, (g = new THREE.BoxGeometry(w, h, d)));
    return g;
  };
  const arrowShape = new THREE.Shape();
  arrowShape.moveTo(0, 0.05);
  arrowShape.lineTo(0.045, -0.03);
  arrowShape.lineTo(-0.045, -0.03);
  arrowShape.closePath();
  const unitCone = new THREE.ConeGeometry(1, 1, 20, 1, true);
  unitCone.translate(0, -0.5, 0);
  unitCone.rotateX(Math.PI / 2); // apex at the camera, opening along -z
  const shapes = {
    screen: new THREE.PlaneGeometry(0.52, 0.29),
    laptopScreen: new THREE.PlaneGeometry(0.29, 0.18),
    wallScreen: new THREE.PlaneGeometry(1.5, 0.84),
    videoWall: new THREE.PlaneGeometry(0.94, 0.56),
    kioskScreen: new THREE.PlaneGeometry(0.54, 0.36),
    indicator: new THREE.PlaneGeometry(0.44, 0.15),
    logo: new THREE.PlaneGeometry(7, 1.75),
    note: new THREE.PlaneGeometry(0.16, 0.16),
    pole: new THREE.CylinderGeometry(0.025, 0.025, 0.36, 6),
    lampBase: new THREE.CylinderGeometry(0.07, 0.08, 0.02, 10),
    mug: new THREE.CylinderGeometry(0.042, 0.036, 0.1, 10),
    potSmall: new THREE.CylinderGeometry(0.07, 0.055, 0.12, 8),
    leavesSmall: new THREE.IcosahedronGeometry(0.12, 0),
    pot: new THREE.CylinderGeometry(0.26, 0.2, 0.55, 10),
    leaves: new THREE.IcosahedronGeometry(0.46, 0),
    leavesTop: new THREE.IcosahedronGeometry(0.3, 0),
    card: new THREE.BoxGeometry(0.34, 0.22, 0.02),
    flash: new THREE.PlaneGeometry(0.3, 0.3),
    spark: new THREE.SphereGeometry(0.05, 6, 6),
    casing: new THREE.BoxGeometry(0.012, 0.012, 0.03),
    arrow: new THREE.ShapeGeometry(arrowShape),
    cone: unitCone,
    helipad: new THREE.CircleGeometry(7, 48),
    bottle: new THREE.CylinderGeometry(0.14, 0.14, 0.45, 12),
    mist: new THREE.PlaneGeometry(MAP_W * U, MAP_H * U),
  };
  const glow = (color: number) => new THREE.MeshBasicMaterial({ color, toneMapped: false });
  const std = (color: number, roughness = 0.5, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const mats = {
    server: new THREE.MeshStandardMaterial({ map: tex.server, emissiveMap: tex.server, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.5 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0.3, depthWrite: false, side: THREE.DoubleSide }),
    partition: new THREE.MeshStandardMaterial({ color: 0x8fb8d8, transparent: true, opacity: 0.2, roughness: 0.05, metalness: 0.4, depthWrite: false }),
    frost: new THREE.MeshStandardMaterial({ color: 0xe8eef5, transparent: true, opacity: 0.42, roughness: 0.9, depthWrite: false }),
    metal: std(0xaab0bb, 0.3, 0.85),
    frame: std(0x14161c, 0.4, 0.7),
    steel: new THREE.MeshStandardMaterial({ map: tex.brushed, roughness: 0.35, metalness: 0.85 }),
    carDoor: new THREE.MeshStandardMaterial({ map: tex.brushed, color: 0xdfe3ea, roughness: 0.28, metalness: 0.9 }),
    carFloor: std(0x23262c, 0.5, 0.3),
    ledCool: glow(0x6cc4ff),
    ledWarm: glow(0xfff0d8),
    door: new THREE.MeshStandardMaterial({ color: 0xff6b57, transparent: true, opacity: 0.35, emissive: CORAL, emissiveIntensity: 0.4, depthWrite: false }),
    chair: std(0x1d2028, 0.85),
    chairMesh: new THREE.MeshStandardMaterial({ map: tex.mesh, roughness: 0.8, transparent: true, opacity: 0.88 }),
    leather: std(0x2a1c16, 0.45),
    caster: std(0x0d0e11, 0.6),
    keyboard: std(0x1c1f26, 0.5),
    laptop: std(0xb8bcc4, 0.35, 0.7),
    mug: std(0xf3f1ec, 0.4),
    monitor: std(0x111318, 0.3, 0.4),
    screens: tex.screens.map((t) => new THREE.MeshBasicMaterial({ map: t })),
    wallScreens: [...tex.wallScreens, tex.opsMap].map((t) => new THREE.MeshBasicMaterial({ map: t })),
    logo: new THREE.MeshBasicMaterial({ map: tex.logo, transparent: true }),
    kioskBody: std(0xd4d8e0, 0.35, 0.5),
    kiosk: new THREE.MeshBasicMaterial({ map: tex.kiosk }),
    kioskDone: new THREE.MeshBasicMaterial({ map: tex.kioskDone }),
    codeKiosk: new THREE.MeshBasicMaterial({ map: tex.codeKiosk }),
    cabinet: std(0x262a33, 0.45, 0.65),
    cabinetDoor: std(0x313642, 0.5, 0.6),
    filing: std(0x8c939e, 0.4, 0.6),
    cardboard: std(0xb48a5a, 0.9),
    binder: std(0x2f5d8a, 0.6),
    printer: std(0xe6e8ec, 0.4),
    printerTop: std(0x3a3f47, 0.5),
    whiteboard: new THREE.MeshStandardMaterial({ map: tex.whiteboard, roughness: 0.25 }),
    bottle: new THREE.MeshStandardMaterial({ color: 0x7fc4ff, transparent: true, opacity: 0.55, roughness: 0.1 }),
    stall: std(0x9aa3ad, 0.5, 0.2),
    porcelain: std(0xf4f4f2, 0.15),
    panel: glow(0xeef3ff),
    lampOff: glow(CORAL),
    lampOn: glow(MINT),
    pot: std(0xe9e7e2, 0.6),
    leaves: new THREE.MeshStandardMaterial({ color: 0x2f7d4f, roughness: 0.8, flatShading: true }),
    laser: glow(0xff2a1a),
    rack: new THREE.MeshStandardMaterial({ map: tex.rack, emissiveMap: tex.rack, emissive: 0xffffff, emissiveIntensity: 1, roughness: 0.4 }),
    rackRow: new THREE.MeshStandardMaterial({ map: tex.rackRow, emissiveMap: tex.rackRow, emissive: 0xffffff, emissiveIntensity: 1.1, roughness: 0.45, metalness: 0.3 }),
    tray: std(0x8a8f98, 0.4, 0.8),
    cables: std(0x14161a, 0.7),
    card: new THREE.MeshStandardMaterial({ color: ACCENT, emissive: ACCENT, emissiveIntensity: 1.2 }),
    medkit: new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.4, emissive: 0x1a3a30, emissiveIntensity: 0.6 }),
    cross: glow(MINT),
    intel: new THREE.MeshStandardMaterial({ color: 0xd2452f, roughness: 0.6, emissive: 0x3a0d08, emissiveIntensity: 0.8 }),
    brass: std(0xd9a53f, 0.3, 0.9),
    fabric: std(0x3c4a55, 0.9),
    cushion: std(0x4a5a66, 0.95),
    pillow: std(0xc99a55, 0.9),
    counter: std(0xf3f0ea, 0.2, 0.1),
    counterTop: std(0x23262c, 0.15, 0.3),
    cabinetWhite: std(0xefefec, 0.4),
    gateLamp: glow(CORAL),
    flap: new THREE.MeshStandardMaterial({ color: 0xbfe0ff, transparent: true, opacity: 0.35, roughness: 0.05, depthWrite: false }),
    secDoor: new THREE.MeshStandardMaterial({ map: tex.hazard, roughness: 0.4, metalness: 0.7 }),
    keypad: std(0x1a1d24, 0.5, 0.4),
    note: new THREE.MeshBasicMaterial({ map: tex.note, side: THREE.DoubleSide }),
    camBody: std(0xd9dde3, 0.4, 0.3),
    camLed: glow(0xff3b30),
    camLedOff: std(0x222222, 0.6),
    coneIdle: new THREE.MeshBasicMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    coneHot: new THREE.MeshBasicMaterial({ color: 0xff4433, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    mist: new THREE.MeshBasicMaterial({ map: tex.mist, transparent: true, opacity: 0.4, depthWrite: false }),
    roof: new THREE.MeshStandardMaterial({ map: tex.roof, roughness: 0.95 }),
    helipad: new THREE.MeshStandardMaterial({ map: tex.helipad, roughness: 0.8 }),
    parapet: std(0x3a3d42, 0.8),
    towers: tex.towers.map((t) => new THREE.MeshBasicMaterial({ map: t })),
    spark: new THREE.MeshBasicMaterial({ color: 0xffe2a0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    civShirts: [0x3d6fb6, 0xd9d4c7, 0x8b3a3a, 0x2f6e5a, 0x6b4f8a, 0xc98a3a, 0xe8e8e8].map((c) => std(c, 0.85)),
    civTrousers: [0x23262e, 0x4a4f5a, 0x6b5a45].map((c) => std(c, 0.85)),
    civSkin: [0xc89878, 0x8d5a3b, 0xe6c2a3, 0xb07a55].map((c) => std(c, 0.7)),
    civHair: [0x1d1612, 0x5a3a22, 0xc9a25a, 0x7a7a7a].map((c) => std(c, 0.9)),
    civShoe: std(0x141414, 0.6),
  };
  tex.roof.repeat.set(16, 12);
  tex.brushed.repeat.set(3, 1);

  // ---- the city outside, built once; it sinks as you go up ----
  const city = new THREE.Group();
  scene.add(city);
  const cx = (MAP_W * U) / 2;
  const cz = (MAP_H * U) / 2;
  for (let i = 0; i < 180; i++) {
    const angle = rand(0, Math.PI * 2);
    const dist = rand(80, 230);
    const w = rand(10, 26);
    const h = rand(30, 130);
    const tower = new THREE.Mesh(box(w, h, w), mats.towers[i % 3]);
    tower.position.set(cx + Math.cos(angle) * dist, h / 2 - 70, cz + Math.sin(angle) * dist);
    city.add(tower);
  }
  for (const t of tex.towers) t.repeat.set(2, 6);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshBasicMaterial({ color: 0x05060b }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(cx, -70, cz);
  city.add(ground);
  const floorBase = (index: number) => THEMES.slice(0, index).reduce((sum, t) => sum + t.h + 0.6, 0);

  // ---- one floor at a time ----
  let floorIndex = 0;
  let theme = THEMES[0];
  let map: string[] = FLOORS[0];
  let level = new THREE.Group();
  scene.add(level);
  const blockers: THREE.Object3D[] = []; // what a bullet stops at
  const perFloorDisposables: { dispose(): void }[] = [];
  let guards: Guard[] = [];
  let civs: Civ[] = [];
  let seats: { m: THREE.Matrix4; kind: "desk" | "exec" | "meeting" | "reception" }[] = [];
  let stations: Station[] = [];
  let notes: Note[] = [];
  let doors: Door[] = [];
  let cams: Cam[] = [];
  let wires: Wire[] = [];
  let cars: Car[] = [];
  let pickups: Pickup[] = [];
  let flaps: THREE.Mesh[] = [];
  let levelLights: LightSpot[] = [];
  let keycardSpot: LightSpot | null = null;
  let floorMats: Record<"wall" | "solid" | "floor" | "ceiling" | "frame" | "desk" | "table" | "tile", THREE.MeshStandardMaterial> | null = null;
  const camBodies = new Map<THREE.Object3D, Cam>();
  const carByCell = new Map<number, Car>();
  const doorByCell = new Map<number, Door>();
  let keycardNode: THREE.Object3D | null = null;
  let keyDoorNode: THREE.Object3D | null = null;
  let badgeNode: THREE.Object3D | null = null;
  let lasers: THREE.Object3D | null = null;
  let keycardAt: Spot | null = null;
  let badgeAt: Spot | null = null;
  let rackAt: Spot | null = null;
  let boss: Guard | null = null;
  let hasKey = false;
  let keyDoorOpen = false;
  let gatesOpen = false;
  let camsOff = false;
  let floorDone = false;
  let alarm = false;
  let spottedOnce = false;
  let holdAt: Station | null = null;
  let hold = 0;
  let run: Run | null = null;
  let backupT = 0;
  let finale = 0;
  let finaleWave = 0;
  let floorClock = 0;
  const codes: string[][] = FLOORS.map(() => []);
  let heli: ReturnType<typeof makeHelicopter> | null = null;
  let heliTarget: THREE.Object3D | null = null;

  // What blocks walking, per cell, as rectangles in cell coordinates (x0, y0, x1, y1, ...).
  const FULL = [0, 0, 1, 1];
  const NONE: number[] = [];
  const SMALL = [0.28, 0.28, 0.72, 0.72];
  const MID = [0.18, 0.18, 0.82, 0.82];
  const arms = new Uint8Array(MAP_W * MAP_H); // glass partitions: N 1, E 2, S 4, W 8
  const rects: number[][] = new Array(MAP_W * MAP_H).fill(NONE);
  const flow = new Int16Array(MAP_W * MAP_H);
  let flowFrom = -1;

  const player = { x: 1.5, y: 1.5, z: 0, vz: 0, land: 0, yaw: 0, pitch: 0, health: 100, ammo: MAG, reload: 0, reloading: 0, hurt: 0, walk: 0, px: 1.5, py: 1.5 };
  let difficulty = 1;
  let maxHealth = DIFFICULTIES[1].health;
  let kills = 0;
  let headshots = 0;
  let shots = 0;
  let hits = 0;
  let alarms = 0;
  let intel = 0;
  let deaths = 0;
  let civiliansHit = 0;
  let elapsed = 0;
  let testUsed = false; // dev builds only: a test run never saves a best score
  let god = false;

  const inside = (x: number, y: number) => x > 0 && y > 0 && x < MAP_W - 1 && y < MAP_H - 1;
  const cellAt = (x: number, y: number): string => (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H ? "#" : map[y][x]);
  const rectsAt = (x: number, y: number): number[] => {
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return FULL;
    const i = y * MAP_W + x;
    const ch = map[y][x];
    if (ch === "L") return keyDoorOpen ? NONE : FULL;
    if (ch === "D") return doorByCell.get(i)?.open ? NONE : FULL;
    if (ch === "t") return gatesOpen ? rects[i] : FULL;
    const car = carByCell.get(i);
    if (car) return car.open > 0.9 ? car.walls : car.closed;
    return rects[i];
  };
  const walkCell = (x: number, y: number) => rectsAt(x, y).length === 0;
  /** Whether a square of half-size r around (x, y) is clear of everything solid. */
  const fits = (x: number, y: number, r: number) => {
    for (let cy = Math.floor(y - r); cy <= Math.floor(y + r); cy++) {
      for (let cx = Math.floor(x - r); cx <= Math.floor(x + r); cx++) {
        const list = rectsAt(cx, cy);
        for (let i = 0; i < list.length; i += 4) {
          if (x + r > cx + list[i] && x - r < cx + list[i + 2] && y + r > cy + list[i + 1] && y - r < cy + list[i + 3]) return false;
        }
      }
    }
    return true;
  };
  /** Moves in small steps, so a long frame can never carry anyone through a thin wall. */
  const move = (p: { x: number; y: number }, dx: number, dy: number, r: number) => {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 0.15));
    for (let i = 0; i < n; i++) {
      if (fits(p.x + dx / n, p.y, r)) p.x += dx / n;
      if (fits(p.x, p.y + dy / n, r)) p.y += dy / n;
    }
  };
  const inArms = (m: number, fx: number, fy: number, t: number) => {
    const midX = Math.abs(fx - 0.5) < t;
    const midY = Math.abs(fy - 0.5) < t;
    return (midX && midY) || (!!(m & 1) && midX && fy < 0.5) || (!!(m & 4) && midX && fy > 0.5) || (!!(m & 2) && midY && fx > 0.5) || (!!(m & 8) && midY && fx < 0.5);
  };
  /** Blocks sight: solid walls, frosted partitions, closed doors, racks, elevator shafts. */
  const opaque = (x: number, y: number): boolean => {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    const ch = cellAt(cx, cy);
    if ("XSVkPUzh".includes(ch)) return true;
    if (ch === "O") return Math.abs(x - cx - 0.5) < 0.22 && Math.abs(y - cy - 0.5) < 0.22;
    if (ch === "D") return !doorByCell.get(cy * MAP_W + cx)?.open;
    if (ch !== "#") return false;
    const m = inside(cx, cy) ? arms[cy * MAP_W + cx] : 0;
    return !m || inArms(m, x - cx, y - cy, 0.22);
  };
  const seesFrom = (fx: number, fy: number, x: number, y: number): boolean => {
    const steps = Math.ceil(Math.hypot(x - fx, y - fy) * 4);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (opaque(fx + (x - fx) * t, fy + (y - fy) * t)) return false;
    }
    return true;
  };
  /** Steps from every walkable cell to yours, refreshed when you change cell. */
  const updateFlow = () => {
    const start = Math.floor(player.y) * MAP_W + Math.floor(player.x);
    if (start === flowFrom) return;
    flowFrom = start;
    flow.fill(-1);
    flow[start] = 0;
    const queue = [start];
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      const x = i % MAP_W;
      const y = (i - x) / MAP_W;
      for (const [dx, dy] of N4) {
        const n = (y + dy) * MAP_W + x + dx;
        if (walkCell(x + dx, y + dy) && flow[n] < 0) {
          flow[n] = flow[i] + 1;
          queue.push(n);
        }
      }
    }
  };
  /** Steps from one cell to every other, for patrol routes. */
  const distances = (from: number) => {
    const d = new Int16Array(MAP_W * MAP_H).fill(-1);
    d[from] = 0;
    const queue = [from];
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      const x = i % MAP_W;
      const y = (i - x) / MAP_W;
      for (const [dx, dy] of N4) {
        const n = (y + dy) * MAP_W + x + dx;
        if (walkCell(x + dx, y + dy) && d[n] < 0) {
          d[n] = d[i] + 1;
          queue.push(n);
        }
      }
    }
    return d;
  };
  /** The cells from one cell to another (not including the start), or [] when there is no way. */
  const pathTo = (from: number, to: number): number[] => {
    if (from === to) return [];
    const d = distances(to);
    if (d[from] < 0) return [];
    const out: number[] = [];
    let at = from;
    while (at !== to && out.length < 400) {
      const x = at % MAP_W;
      const y = (at - x) / MAP_W;
      let best = -1;
      for (const [dx, dy] of N4) {
        const n = (y + dy) * MAP_W + x + dx;
        if (n >= 0 && n < d.length && d[n] >= 0 && d[n] < d[at] && walkCell(x + dx, y + dy)) best = n;
      }
      if (best < 0) break;
      out.push(best);
      at = best;
    }
    return out;
  };
  const cellOf = (p: Spot) => Math.floor(p.y) * MAP_W + Math.floor(p.x);

  // Orientation in a cell: a frame with its front (v = 1) toward f.
  const fromLocal = (f: [number, number], u: number, v: number): [number, number] =>
    f[1] === 1 ? [u, v] : f[1] === -1 ? [1 - u, 1 - v] : f[0] === 1 ? [v, 1 - u] : [1 - v, u];
  const orientRects = (list: number[], f: [number, number]) => {
    const out: number[] = [];
    for (let i = 0; i < list.length; i += 4) {
      const [ax, ay] = fromLocal(f, list[i], list[i + 1]);
      const [bx, by] = fromLocal(f, list[i + 2], list[i + 3]);
      out.push(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by));
    }
    return out;
  };
  const carLocal = (car: Car, px: number, py: number): [number, number] => {
    const rx = px - Math.floor(car.x);
    const ry = py - Math.floor(car.y);
    const [dx, dy] = car.dir;
    if (dy === 1) return [rx, ry];
    if (dy === -1) return [1 - rx, 1 - ry];
    if (dx === 1) return [1 - ry, rx];
    return [ry, 1 - rx];
  };
  const carYaw = (car: Car) => Math.atan2(car.dir[1], car.dir[0]);
  const inCar = (car: Car) => {
    if (Math.floor(player.x) !== Math.floor(car.x) || Math.floor(player.y) !== Math.floor(car.y)) return false;
    const [u, v] = carLocal(car, player.x, player.y);
    return v <= 0.62 && u > 0.15 && u < 0.85;
  };
  /** The side an elevator opens to: open, with a wall opposite (same rule as the map check). */
  const carDir = (x: number, y: number): [number, number] => {
    for (const [dx, dy] of N4) {
      const n = cellAt(x + dx, y + dy);
      if (!SOLID_CH.includes(n) && !"tDL".includes(n) && WALLISH.includes(cellAt(x - dx, y - dy))) return [dx, dy];
    }
    return [0, 1];
  };

  const computeRects = () => {
    const wallAt = (x: number, y: number) => WALLISH.includes(cellAt(x, y)) || cellAt(x, y) === "D";
    const a = 0.5 - PARTITION;
    const b = 0.5 + PARTITION;
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const i = y * MAP_W + x;
        const ch = map[y][x];
        let m = 0;
        if (ch === "#" && inside(x, y)) {
          if (wallAt(x, y - 1)) m |= 1;
          if (wallAt(x + 1, y)) m |= 2;
          if (wallAt(x, y + 1)) m |= 4;
          if (wallAt(x - 1, y)) m |= 8;
          if (!m) m = 15;
        }
        arms[i] = m;
        if (m) {
          const r = [a, a, b, b];
          if (m & 1) r.push(a, 0, b, b);
          if (m & 2) r.push(a, a, 1, b);
          if (m & 4) r.push(a, a, b, 1);
          if (m & 8) r.push(0, a, b, b);
          rects[i] = r;
        } else if (ch === "k") {
          rects[i] = cellAt(x - 1, y) === "k" || cellAt(x + 1, y) === "k" ? [0, 0.2, 1, 0.8] : cellAt(x, y - 1) === "k" || cellAt(x, y + 1) === "k" ? [0.2, 0, 0.8, 1] : MID;
        } else if (ch === "j") rects[i] = orientRects([0, 0, 1, 0.45], frontAway(x, y));
        else if (ch === "t") {
          const alongX = "t#XW".includes(cellAt(x - 1, y)) || "t#XW".includes(cellAt(x + 1, y));
          const r = alongX ? [0, 0.17, 0.14, 0.83] : [0.17, 0, 0.83, 0.14];
          const next = alongX ? cellAt(x + 1, y) : cellAt(x, y + 1);
          if (next !== "t") r.push(...(alongX ? [0.86, 0.17, 1, 0.83] : [0.17, 0.86, 0.83, 1]));
          rects[i] = r;
        } else if (ch === "f" || ch === "h") rects[i] = orientRects([0, 0, 1, ch === "f" ? 0.45 : 0.4], frontAway(x, y));
        else if (ch === "O") rects[i] = [0.33, 0.33, 0.67, 0.67];
        else rects[i] = "#XWSVdeMQoPUz".includes(ch) ? FULL : "TYa".includes(ch) ? SMALL : "FRcpnb".includes(ch) ? MID : NONE;
      }
    }
  };
  /** The front of something that stands with its back to a wall. */
  const frontAway = (x: number, y: number): [number, number] => {
    for (const [dx, dy] of N4) if (WALLISH.includes(cellAt(x + dx, y + dy))) return [-dx, -dy];
    return [0, 1];
  };

  // ---- building a floor: shared parts as one InstancedMesh per geometry and material ----
  type Batch = { geo: THREE.BufferGeometry; mat: THREE.Material; list: THREE.Matrix4[]; block: boolean };
  let batches = new Map<string, Batch>();
  const put = (geo: THREE.BufferGeometry, mat: THREE.Material, m: THREE.Matrix4, block = false) => {
    const key = geo.uuid + mat.uuid;
    let b = batches.get(key);
    if (!b) batches.set(key, (b = { geo, mat, list: [], block }));
    b.list.push(m);
  };
  /** All the parts that share a material, baked into one geometry: one draw call per material. */
  const mergeParts = (parts: [THREE.BufferGeometry, THREE.Matrix4][]) => {
    let verts = 0;
    let count = 0;
    for (const [g] of parts) {
      verts += g.attributes.position.count;
      count += g.index ? g.index.count : g.attributes.position.count;
    }
    const pos = new Float32Array(verts * 3);
    const nor = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const index = verts > 65535 ? new Uint32Array(count) : new Uint16Array(count);
    const v = new THREE.Vector3();
    const nm = new THREE.Matrix3();
    let vo = 0;
    let io = 0;
    for (const [g, m] of parts) {
      nm.getNormalMatrix(m);
      const ps = g.attributes.position;
      const ns = g.attributes.normal;
      const us = g.attributes.uv;
      for (let k = 0; k < ps.count; k++) {
        const i3 = (vo + k) * 3;
        v.fromBufferAttribute(ps, k).applyMatrix4(m);
        pos[i3] = v.x;
        pos[i3 + 1] = v.y;
        pos[i3 + 2] = v.z;
        v.fromBufferAttribute(ns, k).applyMatrix3(nm).normalize();
        nor[i3] = v.x;
        nor[i3 + 1] = v.y;
        nor[i3 + 2] = v.z;
        if (us) {
          uv[(vo + k) * 2] = us.getX(k);
          uv[(vo + k) * 2 + 1] = us.getY(k);
        }
      }
      if (g.index) for (let k = 0; k < g.index.count; k++) index[io++] = g.index.getX(k) + vo;
      else for (let k = 0; k < ps.count; k++) index[io++] = vo + k;
      vo += ps.count;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    out.setIndex(new THREE.BufferAttribute(index, 1));
    out.computeBoundingSphere();
    return out;
  };
  /** Turns the collected parts into one mesh per material, yielding now and then so loading stays smooth. */
  function* flushSteps(): Generator<[string, number], void, unknown> {
    const groups = new Map<string, { mat: THREE.Material; block: boolean; parts: [THREE.BufferGeometry, THREE.Matrix4][] }>();
    for (const b of batches.values()) {
      const key = b.mat.uuid + (b.block ? "b" : "");
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { mat: b.mat, block: b.block, parts: [] }));
      for (const m of b.list) g.parts.push([b.geo, m]);
    }
    batches = new Map();
    let i = 0;
    for (const g of groups.values()) {
      const geo = mergeParts(g.parts);
      perFloorDisposables.push(geo);
      const mesh = new THREE.Mesh(geo, g.mat);
      level.add(mesh);
      if (g.block) blockers.push(mesh);
      if (++i % 3 === 0) yield ["Putting it together", 0.86 + (0.05 * i) / groups.size];
    }
  }
  const flushBatches = () => {
    for (const step of flushSteps()) void step;
  };
  const tmpV = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const tmpE = new THREE.Euler(0, 0, 0, "YXZ");
  const ONE = new THREE.Vector3(1, 1, 1);
  const cellBase = (x: number, y: number, angle: number) => new THREE.Matrix4().makeRotationY(angle).setPosition((x + 0.5) * U, 0, (y + 0.5) * U);
  const local = (base: THREE.Matrix4, x: number, y: number, z: number, ry = 0, rx = 0) =>
    base.clone().multiply(new THREE.Matrix4().compose(tmpV.set(x, y, z), tmpQ.setFromEuler(tmpE.set(rx, ry, 0, "YXZ")), ONE));
  const placed = (geometry: THREE.BufferGeometry, material: THREE.Material, m: THREE.Matrix4, parent: THREE.Object3D = level) => {
    const mesh = new THREE.Mesh(geometry, material);
    m.decompose(mesh.position, mesh.quaternion, mesh.scale);
    parent.add(mesh);
    return mesh;
  };
  const angleOf = (f: [number, number]) => Math.atan2(f[0], f[1]);
  /** Which way a thing in this cell should face: toward the most open side. */
  const openDir = (x: number, y: number): [number, number] => {
    let best: [number, number] = [0, 1];
    let bestRoom = -1;
    for (const [dx, dy] of N4) {
      let n = 0;
      while (n < 6 && walkCell(x + dx * (n + 1), y + dy * (n + 1))) n++;
      if (n > bestRoom) {
        bestRoom = n;
        best = [dx, dy];
      }
    }
    return best;
  };

  /** An office chair facing -z: five spokes with casters, gas lift, seat, armrests, mesh or leather back. */
  const addChair = (c: THREE.Matrix4, exec: boolean) => {
    for (let k = 0; k < 5; k++) {
      const spoke = local(c, 0, 0.07, 0, (k * Math.PI * 2) / 5);
      put(box(0.035, 0.03, 0.3), mats.frame, local(spoke, 0, 0, -0.15));
      put(box(0.045, 0.05, 0.045), mats.caster, local(spoke, 0, -0.04, -0.29));
    }
    put(shapes.pole, mats.metal, local(c, 0, 0.25, 0));
    const seat = exec ? mats.leather : mats.chair;
    put(box(0.48, 0.07, 0.46), seat, local(c, 0, 0.45, 0), true);
    for (const side of [-1, 1]) {
      put(box(0.03, 0.18, 0.03), mats.frame, local(c, side * 0.25, 0.57, 0.04));
      put(box(0.06, 0.025, 0.24), seat, local(c, side * 0.25, 0.67, 0.02));
    }
    const back = local(c, 0, 0.5, 0.22, 0, 0.12);
    if (exec) put(box(0.5, 0.82, 0.09), mats.leather, local(back, 0, 0.43, 0), true);
    else {
      for (const side of [-1, 1]) put(box(0.03, 0.58, 0.03), mats.frame, local(back, side * 0.22, 0.31, 0));
      put(box(0.47, 0.035, 0.035), mats.frame, local(back, 0, 0.6, 0));
      put(box(0.42, 0.54, 0.008), mats.chairMesh, local(back, 0, 0.31, 0), true);
    }
  };
  const addMonitor = (m: THREE.Matrix4, screen: THREE.Material) => {
    put(box(0.55, 0.33, 0.022), mats.monitor, m, true);
    put(shapes.screen, screen, local(m, 0, 0.005, 0.0115));
  };
  const addDeskLamp = (d: THREE.Matrix4, x: number, z: number) => {
    put(shapes.lampBase, mats.frame, local(d, x, 0.76, z));
    put(box(0.015, 0.42, 0.015), mats.frame, local(d, x, 0.97, z, 0, 0.25));
    put(box(0.16, 0.04, 0.08), mats.frame, local(d, x, 1.17, z + 0.1));
    put(box(0.14, 0.005, 0.06), mats.ledWarm, local(d, x, 1.148, z + 0.1));
  };

  /**
   * Builds a floor in small steps (each yield is a point where the loader may wait for the next frame),
   * into a new group that replaces the shown one only at the end; onSwap runs in that same frame.
   */
  function* floorSteps(index: number, placePlayer: boolean, onSwap?: () => void): Generator<[string, number], void, unknown> {
    const old = beginLevel();
    floorIndex = index;
    theme = THEMES[index];
    map = FLOORS[index];
    const h = theme.h;
    computeRects();

    // The floor's own look.
    const wallTex = canvasTexture(256, 256, drawWall(theme.wall));
    const solidTex = canvasTexture(256, 256, drawSolid(theme.solid, theme.wall));
    const floorTex = canvasTexture(256, 256, drawFloor(theme.floor));
    const ceilTex = canvasTexture(256, 256, drawCeiling(index), false);
    floorTex.repeat.set(MAP_W, MAP_H);
    ceilTex.repeat.set(MAP_W, MAP_H);
    const roughness: Record<FloorKind, number> = { stone: 0.18, carpet: 0.95, dark: 0.35, wood: 0.45, raised: 0.55 };
    const fm = {
      wall: new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.7 }),
      solid: new THREE.MeshStandardMaterial({ map: solidTex, roughness: theme.solid === "marble" ? 0.22 : 0.7, metalness: theme.solid === "metal" ? 0.5 : 0 }),
      floor: new THREE.MeshStandardMaterial({ map: floorTex, roughness: roughness[theme.floor], metalness: theme.floor === "raised" ? 0.3 : 0.1 }),
      ceiling: new THREE.MeshStandardMaterial({ color: theme.ceiling, emissiveMap: ceilTex, emissive: theme.strip, emissiveIntensity: theme.stripPower, roughness: 0.9 }),
      frame: std(theme.frame, 0.3, 0.8),
      desk: std(theme.desk, 0.4),
      table: std(theme.table, 0.3),
      tile: std(theme.tile, 0.85),
    };
    floorMats = fm;
    perFloorDisposables.push(wallTex, solidTex, floorTex, ceilTex, ...Object.values(fm));
    const pending: [number, number, Guard["kind"]][] = [];
    yield [`Building floor ${index + 1}: materials`, 0.04];

    const sources: { x: number; y: number; kind: string }[] = [];
    for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) if ("NY".includes(map[y][x])) sources.push({ x, y, kind: map[y][x] });
    if (!codes[index].length) {
      let n = 0;
      for (const row of map) for (const ch of row) if (ch === "D") n++;
      codes[index] = Array.from({ length: n }, () => String(Math.floor(1000 + Math.random() * 9000)));
    }

    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const ch = map[y][x];
        const c = cellBase(x, y, 0);
        const m = arms[y * MAP_W + x];
        const px = (x + 0.5) * U;
        const pz = (y + 0.5) * U;
        if (ch === "#" && !m) put(box(U, h, U), fm.wall, local(c, 0, h / 2, 0), true);
        else if (ch === "#") {
          // A glass partition: a post in the middle and an arm toward each neighbouring wall,
          // each with a kick plate, a top rail, LED lines, tinted glass and a frosted band.
          const glassH = h - 0.2;
          put(box(0.07, h, 0.07), fm.frame, local(c, 0, h / 2, 0), true);
          N4.forEach(([dx, dz], k) => {
            if (!(m & (1 << k))) return;
            const base = local(c, (dx * U) / 4, 0, (dz * U) / 4, dx ? 0 : Math.PI / 2);
            put(box(U / 2, 0.12, 0.08), fm.frame, local(base, 0, 0.06, 0), true);
            put(box(U / 2, 0.012, 0.085), mats.ledCool, local(base, 0, 0.126, 0));
            put(box(U / 2, 0.08, 0.08), fm.frame, local(base, 0, h - 0.04, 0), true);
            put(box(U / 2, 0.012, 0.085), mats.ledWarm, local(base, 0, h - 0.086, 0));
            put(box(U / 2, glassH, 0.024), mats.partition, local(base, 0, 0.12 + glassH / 2, 0), true);
            put(box(U / 2, 0.5, 0.03), mats.frost, local(base, 0, 1.25, 0));
          });
        } else if (ch === "X") put(box(U, h, U), fm.solid, local(c, 0, h / 2, 0), true);
        else if (ch === "S") put(box(U, h, U), mats.server, local(c, 0, h / 2, 0), true);
        else if (ch === "W") {
          put(box(U, 0.5, U), mats.frame, local(c, 0, 0.25, 0), true);
          put(box(U, 0.35, U), mats.frame, local(c, 0, h - 0.175, 0), true);
          put(box(U * 0.98, h - 0.85, U * 0.98), mats.glass, local(c, 0, 0.5 + (h - 0.85) / 2, 0));
          put(box(0.08, h, 0.08), mats.frame, local(c, 0, h / 2, 0));
        } else if (ch === "d") addDesk(x, y, fm.desk);
        else if (ch === "e") addExecDesk(x, y, fm.desk);
        else if (ch === "M") addMeetingTable(x, y, fm.table);
        else if (ch === "Q") addReception(x, y, fm.desk);
        else if (ch === "o") addSofa(x, y);
        else if (ch === "c") {
          const t = cellBase(x, y, 0);
          put(box(1.2, 0.04, 0.7), fm.table, local(t, 0, 0.42, 0), true);
          for (const lx of [-0.55, 0.55]) for (const lz of [-0.3, 0.3]) put(box(0.03, 0.4, 0.03), mats.metal, local(t, lx, 0.2, lz));
          put(box(0.3, 0.04, 0.22), mats.pillow, local(t, 0.25, 0.46, 0.1, 0.3));
          put(shapes.potSmall, mats.pot, local(t, -0.3, 0.5, -0.1));
          put(shapes.leavesSmall, mats.leaves, local(t, -0.3, 0.62, -0.1));
        } else if (ch === "j") addKitchen(x, y);
        else if (ch === "t") addGate(x, y);
        else if (ch === "V") addVideoWall(x, y);
        else if (ch === "k") {
          const alongX = cellAt(x - 1, y) === "k" || cellAt(x + 1, y) === "k";
          const r = cellBase(x, y, alongX ? 0 : Math.PI / 2);
          put(box(U * 0.98, 2.1, 1.1), mats.rackRow, local(r, 0, 1.05, 0), true);
          put(box(U, 0.05, 0.45), mats.tray, local(r, 0, h - 0.35, 0));
          put(box(U, 0.05, 0.28), mats.cables, local(r, 0, h - 0.3, 0));
        } else if (ch === "p") {
          put(shapes.pot, mats.pot, local(c, 0, 0.27, 0));
          put(shapes.leaves, mats.leaves, local(c, 0, 0.9, 0, rand(0, 3)));
          put(shapes.leavesTop, mats.leaves, local(c, 0.05, 1.3, -0.03, rand(0, 3)));
        } else if (ch === "O") {
          // A structural column.
          put(box(0.6, h, 0.6), fm.solid, local(c, 0, h / 2, 0), true);
          put(box(0.66, 0.1, 0.66), fm.frame, local(c, 0, 0.05, 0));
        } else if (ch === "f") {
          // Filing cabinets against the wall: three drawers each, with handles.
          const f = cellBase(x, y, angleOf(frontAway(x, y)));
          put(box(U * 0.92, 1.32, 0.62), mats.filing, local(f, 0, 0.66, -0.66), true);
          for (const dy of [0.44, 0.88]) put(box(U * 0.9, 0.012, 0.01), mats.keyboard, local(f, 0, dy, -0.345));
          for (const hx of [-0.45, 0.45]) for (const hy of [0.25, 0.69, 1.13]) put(box(0.12, 0.02, 0.03), mats.metal, local(f, hx, hy, -0.34));
          if (hash(x, y) % 3 === 0) put(box(0.3, 0.26, 0.24), mats.cardboard, local(f, rand(-0.5, 0.5), 1.45, -0.66, rand(-0.3, 0.3)));
        } else if (ch === "h") {
          // Shelving with boxes and binders.
          const s = cellBase(x, y, angleOf(frontAway(x, y)));
          for (const sx of [-1, 1]) put(box(0.04, 2.1, 0.45), mats.metal, local(s, sx * (U / 2 - 0.05), 1.05, -0.75), true);
          for (const sy of [0.1, 0.55, 1.0, 1.45, 1.9]) put(box(U * 0.95, 0.03, 0.45), mats.metal, local(s, 0, sy, -0.75), true);
          const hsh = hash(x, y);
          [0.12, 0.57, 1.02, 1.47].forEach((sy, k) => {
            if ((hsh >> k) & 1) put(box(0.42, 0.3, 0.36), mats.cardboard, local(s, -0.45 + ((hsh >> (k + 3)) & 1) * 0.2, sy + 0.16, -0.75, rand(-0.15, 0.15)));
            else for (let b = 0; b < 5; b++) put(box(0.07, 0.3, 0.26), mats.binder, local(s, 0.1 + b * 0.09, sy + 0.17, -0.75));
          });
        } else if (ch === "n") {
          // A copier.
          const n = cellBase(x, y, angleOf(openDir(x, y)));
          put(box(0.9, 0.85, 0.65), mats.printer, local(n, 0, 0.425, 0), true);
          put(box(0.9, 0.12, 0.6), mats.printerTop, local(n, 0, 0.91, -0.02), true);
          put(box(0.28, 0.02, 0.14), mats.screens[0], local(n, 0.22, 0.98, 0.18, 0, -0.4));
          put(box(0.5, 0.04, 0.3), mats.porcelain, local(n, -0.6, 0.62, 0));
        } else if (ch === "b") {
          // A whiteboard on wheels.
          const b = cellBase(x, y, angleOf(openDir(x, y)));
          for (const sx of [-0.82, 0.82]) {
            put(box(0.04, 1.85, 0.04), mats.metal, local(b, sx, 0.93, 0));
            put(box(0.05, 0.04, 0.55), mats.metal, local(b, sx, 0.03, 0));
          }
          put(box(1.7, 1.0, 0.03), mats.whiteboard, local(b, 0, 1.35, 0), true);
          put(box(1.7, 0.03, 0.08), mats.metal, local(b, 0, 0.84, 0.03));
        } else if (ch === "a") {
          // A water cooler.
          put(box(0.32, 1.0, 0.32), mats.porcelain, local(c, 0, 0.5, 0), true);
          put(shapes.bottle, mats.bottle, local(c, 0, 1.23, 0));
          put(box(0.1, 0.06, 0.04), mats.ledCool, local(c, 0, 0.82, 0.17));
        } else if (ch === "z") {
          // A toilet stall: side panels, a door left ajar, the toilet.
          const z = cellBase(x, y, angleOf(frontAway(x, y)));
          for (const sx of [-1, 1]) put(box(0.04, 1.8, 1.5), mats.stall, local(z, sx * (U / 2 - 0.05), 1.0, -0.2), true);
          put(box(0.8, 1.6, 0.04), mats.stall, local(z, -0.35, 0.95, 0.6, 0.6), true);
          put(box(0.4, 0.4, 0.55), mats.porcelain, local(z, 0, 0.2, -0.55), true);
          put(box(0.45, 0.4, 0.18), mats.porcelain, local(z, 0, 0.55, -0.88));
        } else if (ch === "T" || ch === "Y") {
          const k = cellBase(x, y, angleOf(openDir(x, y)));
          put(box(0.56, 0.05, 0.44), mats.frame, local(k, 0, 0.025, 0));
          put(box(0.16, 1.0, 0.12), mats.kioskBody, local(k, 0, 0.55, -0.05), true);
          const head = local(k, 0, 1.18, 0, 0, -0.45);
          put(box(0.62, 0.44, 0.06), mats.kioskBody, head, true);
          const screen = placed(shapes.kioskScreen, ch === "T" ? mats.kiosk : mats.codeKiosk, local(head, 0, 0, 0.031));
          const door = ch === "Y" ? sources.findIndex((s) => s.x === x && s.y === y) : -1;
          stations.push({ x: x + 0.5, y: y + 0.5, kind: ch as "T" | "Y", done: false, door, screen, lamp: null });
        } else if (ch === "F") {
          const f = cellBase(x, y, angleOf(openDir(x, y)));
          put(box(0.9, 1.9, 0.45), mats.cabinet, local(f, 0, 0.95, 0), true);
          put(box(0.8, 1.7, 0.02), mats.cabinetDoor, local(f, 0, 0.95, 0.23));
          put(box(0.04, 0.3, 0.04), mats.metal, local(f, 0.3, 1.0, 0.26));
          put(box(0.4, 0.06, 0.012), mats.card, local(f, 0, 1.42, 0.245));
          const lamp = placed(box(0.12, 0.12, 0.03), mats.lampOff, local(f, 0, 1.68, 0.25));
          stations.push({ x: x + 0.5, y: y + 0.5, kind: "F", done: false, door: -1, screen: null, lamp });
        } else if (ch === "N") {
          const door = sources.findIndex((s) => s.x === x && s.y === y);
          notes.push({ x: x + 0.5, y: y + 0.5, door, read: false });
          addNote(x, y);
        } else if (ch === "D") addDoor(x, y);
        else if (ch === "C") addCamera(x, y);
        else if (ch === "=") addWire(x, y);
        else if (ch === "+" || ch === "I") addPickup(x, y, ch === "+" ? "medkit" : "intel");
        else if (ch === "G") pending.push([x + 0.5, y + 0.5, "patrol"]);
        else if (ch === "H") pending.push([x + 0.5, y + 0.5, "post"]);
        else if (ch === "B") pending.push([x + 0.5, y + 0.5, "boss"]);
        else if (ch === "P" || ch === "U") {
          const car = makeCar(x, y, ch === "U", carDir(x, y), false);
          if (ch === "U" && index === 2) {
            // The laser grid the fuses feed, across the elevator doors.
            lasers = new THREE.Group();
            lasers.position.set(0, 0, 1.12);
            for (const hy of [0.35, 0.75, 1.15, 1.55, 1.95]) {
              const beam = new THREE.Mesh(box(1.2, 0.012, 0.012), mats.laser);
              beam.position.y = hy;
              lasers.add(beam);
            }
            for (const r of [0.95, -0.95]) {
              const beam = new THREE.Mesh(box(2.3, 0.012, 0.012), mats.laser);
              beam.position.y = 1.15;
              beam.rotation.z = r;
              lasers.add(beam);
            }
            car.node.add(lasers);
          }
        } else if (ch === "K") {
          keycardAt = { x: x + 0.5, y: y + 0.5 };
          const card = new THREE.Mesh(shapes.card, mats.card);
          card.position.set(px, 1.1, pz);
          keycardSpot = addSpot(ACCENT, 8, 6, px, 1.3, pz, 2);
          level.add(card);
          keycardNode = card;
        } else if (ch === "L") {
          const door = new THREE.Mesh(box(U, h, U * 0.2), mats.door);
          door.position.set(px, h / 2, pz);
          level.add(door);
          keyDoorNode = door;
          blockers.push(door);
        } else if (ch === "R") {
          rackAt = { x: x + 0.5, y: y + 0.5 };
          const rack = new THREE.Mesh(box(U * 0.7, 2.3, U * 0.6), mats.rack);
          rack.position.set(px, 1.15, pz);
          addSpot(ACCENT, 14, 8, px, h - 0.3, pz, 1.6);
          level.add(rack);
          blockers.push(rack);
        }
        // Cable trays over the operations desks.
        if (ch === "d" && index === 2) {
          put(box(U, 0.05, 0.4), mats.tray, local(c, 0, h - 0.32, 0));
          put(box(U, 0.06, 0.24), mats.cables, local(c, 0, h - 0.27, 0));
        }
      }
      yield [`Building floor ${index + 1}: ${y < 9 ? "walls and partitions" : y < 19 ? "desks and rooms" : "props and doors"}`, 0.05 + (0.6 * (y + 1)) / MAP_H];
    }

    // Guards (their patrol routes need the doors and elevators in place), then the staff.
    for (let i = 0; i < pending.length; i++) {
      const [gx, gy, kind] = pending[i];
      const g = spawnGuard(gx, gy, kind);
      if (kind === "boss") boss = g;
      yield ["Placing guards", 0.66 + (0.08 * (i + 1)) / pending.length];
    }
    placeCivilians(index);
    yield ["Seating the staff", 0.76];

    // Dashboards on walls facing into rooms; near meeting tables first. The lobby gets its logo.
    const meeting: [number, number][] = [];
    let logoAt: [number, number] | null = null;
    for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) if (map[y][x] === "M") meeting.push([x, y]);
    const reception = map.flatMap((row, y) => [...row].map((ch, x) => [ch, x, y] as const)).filter(([ch]) => ch === "Q");
    if (index === 0 && reception.length) {
      const midX = reception.reduce((s, [, x]) => s + x, 0) / reception.length;
      const ry = reception[0][2];
      for (let y = ry - 1; y > 0; y--) {
        if (map[y][Math.round(midX)] === "X") {
          logoAt = [Math.round(midX), y];
          const logo = placed(shapes.logo, mats.logo, new THREE.Matrix4().setPosition((midX + 0.5) * U, h * 0.55, (y + 1) * U + 0.03));
          logo.renderOrder = 1;
          put(box(7.4, 0.02, 0.04), mats.ledWarm, new THREE.Matrix4().setPosition((midX + 0.5) * U, h * 0.55 + 1.05, (y + 1) * U + 0.03));
          break;
        }
      }
    }
    const candidates: [number, number, [number, number]][] = [];
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const ch = map[y][x];
        if (!(ch === "X" || (ch === "#" && !inside(x, y)))) continue;
        const f = N4.find(([dx, dy]) => cellAt(x + dx, y + dy) === "." && inside(x + dx, y + dy));
        if (!f) continue;
        if (logoAt && Math.abs(logoAt[0] - x) + Math.abs(logoAt[1] - y) < 6) continue;
        candidates.push([x, y, f]);
      }
    }
    const nearMeeting = (x: number, y: number) => (meeting.length ? Math.min(...meeting.map(([mx, my]) => Math.hypot(mx - x, my - y))) : 99);
    candidates.sort((a, b) => nearMeeting(a[0], a[1]) - nearMeeting(b[0], b[1]) || hash(a[0], a[1]) % 7 - (hash(b[0], b[1]) % 7));
    const screensAt: [number, number][] = [];
    for (const [x, y, f] of candidates) {
      if (screensAt.length >= 6) break;
      if (screensAt.some(([sx, sy]) => Math.abs(sx - x) + Math.abs(sy - y) < 8)) continue;
      screensAt.push([x, y]);
      const base = local(cellBase(x, y, angleOf(f)), 0, 0, U / 2);
      const at = Math.min(1.9, h - 1);
      put(box(1.62, 0.96, 0.05), mats.monitor, local(base, 0, at, 0.025), true);
      put(shapes.wallScreen, mats.wallScreens[(screensAt.length + index) % mats.wallScreens.length], local(base, 0, at, 0.052));
    }
    // Dropped ceilings with light panels over corridors and small rooms; open zones, the lobby atrium
    // and the video wall keep the full height.
    yield [`Building floor ${index + 1}: screens`, 0.78];
    const dropped = new Set<number>();
    // The lobby's dropped ceilings sit high under its double-height atrium; elsewhere they are 2.9 m.
    const dropH = index === 0 ? 4.4 : DROP_H;
    if (h > dropH + 0.1) {
      for (let y = 1; y < MAP_H - 1; y++) {
        for (let x = 1; x < MAP_W - 1; x++) {
          if ("#XWSVPUDLt".includes(map[y][x])) continue;
          let open = 0;
          let screen = false;
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const n = cellAt(x + dx, y + dy);
              if (n === "V") screen = true;
              if (!WALLISH.includes(n)) open++;
            }
          }
          if (screen || open >= 20) continue;
          const c = cellBase(x, y, 0);
          dropped.add(y * MAP_W + x);
          put(box(U, 0.06, U), fm.tile, local(c, 0, dropH + 0.03, 0), true);
          if ((x + y) % 2 === 0) put(box(1.2, 0.006, 0.6), mats.panel, local(c, 0, dropH - 0.002, 0));
        }
        if (y % 7 === 0) yield [`Building floor ${index + 1}: ceilings`, 0.8];
      }
    }

    yield [`Building floor ${index + 1}: ceilings and screens`, 0.84];
    yield* flushSteps();
    yield [`Building floor ${index + 1}: lights`, 0.92];

    // Floor and ceiling.
    const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(MAP_W * U, MAP_H * U), fm.floor);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.set(cx, 0, cz);
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(MAP_W * U, MAP_H * U), fm.ceiling);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(cx, h, cz);
    level.add(floorMesh, ceiling);
    blockers.push(floorMesh, ceiling);
    perFloorDisposables.push(floorMesh.geometry, ceiling.geometry);

    // Lights spread over the open floor, plus each floor's own accents.
    const spots: [number, number][] = [];
    for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) if (walkCell(x, y) && x % 7 === 3 && y % 6 === 3) spots.push([x, y]);
    const every = Math.max(1, Math.ceil(spots.length / 9));
    const addLight = (color: number, power: number, distance: number, x: number, y: number, at: number) => {
      addSpot(color, power, distance, x * U, at, y * U, 1.4).lamp = true;
    };
    // Lights sit just under whichever ceiling is above them, well over head height.
    spots
      .filter((_, i) => i % every === 0)
      .slice(0, 9)
      .forEach(([x, y]) => addLight(theme.lamp, theme.lampPower, h * 5, x + 0.5, y + 0.5, dropped.has(y * MAP_W + x) ? dropH - 0.12 : h - 0.3));
    if (index === 2) for (const x of [14, 26]) addLight(0x3f7bff, 34, 16, x, 3, h - 0.5);
    if (index === 4) {
      addLight(0x4fe0ff, 18, 14, 20, 8, h - 0.3);
      addLight(0x4fe0ff, 18, 14, 33, 8, h - 0.3);
      addLight(0xff3b30, 7, 8, 29, 20, h - 0.35);
      // Cold mist low over the raised floor.
      const mist = new THREE.Mesh(shapes.mist, mats.mist);
      mist.rotation.x = -Math.PI / 2;
      mist.position.set(cx, 0.18, cz);
      mist.renderOrder = 2;
      level.add(mist);
    }

    floorDone = index === 0;
    // The rest happens when the built floor replaces the shown one (see swapIn).
    const t = theme;
    pendingSwap = {
      old,
      apply: () => {
        // Arrive in the elevator, doors shut, facing out.
        const arrival = cars.find((car) => !car.up);
        if (placePlayer && arrival) {
          const [x, y] = fromLocal(arrival.dir, 0.5, 0.42);
          player.x = Math.floor(arrival.x) + x;
          player.y = Math.floor(arrival.y) + y;
          player.yaw = carYaw(arrival);
          player.pitch = 0;
        }
        player.px = player.x;
        player.py = player.y;
        fog.color.setHex(t.fog);
        fog.near = t.fogNear;
        fog.far = t.fogFar;
        renderer.toneMappingExposure = t.exposure;
        hemi.color.setHex(t.sky);
        hemi.groundColor.setHex(t.ground);
        hemi.intensity = t.hemi + 0.12; // a little more sky light, as only the nearest lamps are lit
        city.position.y = -floorBase(index);
        onSwap?.();
      },
    };
  }

  type OldLevel = { group: THREE.Group; disposables: { dispose(): void }[]; heli: ReturnType<typeof makeHelicopter> | null };
  const addSpot = (color: number, intensity: number, distance: number, x: number, y: number, z: number, decay: number): LightSpot => {
    const spot: LightSpot = { pos: new THREE.Vector3(x, y, z), color: new THREE.Color(color), base: intensity, intensity, distance, decay, lamp: false };
    levelLights.push(spot);
    return spot;
  };
  // The pooled lights live in the scene, not the level, so every floor has the same number of lights.
  const pool = Array.from({ length: LIGHT_POOL }, () => {
    const light = new THREE.PointLight(0xffffff, 0, 10, 1.4);
    scene.add(light);
    return { light, spot: null as LightSpot | null, w: 0 };
  });
  let activeSpots: LightSpot[] = [];
  const ranked: LightSpot[] = [];
  /** Gives the pooled lights to the spots nearest you, fading between them so nothing pops. */
  const updateLightPool = (dt: number, instant = false) => {
    const px = player.x * U;
    const pz = player.y * U;
    ranked.length = 0;
    for (const sp of activeSpots) if (sp.intensity > 0) ranked.push(sp);
    const score = (sp: LightSpot) => (sp.pos.x - px) ** 2 + (sp.pos.z - pz) ** 2 - sp.distance * sp.distance * 0.2;
    ranked.sort((a, b) => score(a) - score(b));
    if (ranked.length > LIGHT_POOL) ranked.length = LIGHT_POOL;
    for (const slot of pool) {
      const keep = slot.spot !== null && ranked.includes(slot.spot);
      slot.w = instant ? (keep ? 1 : 0) : keep ? Math.min(1, slot.w + dt * 4) : Math.max(0, slot.w - dt * 4);
      if (!keep && slot.w === 0) {
        slot.spot = null;
        for (const sp of ranked) {
          if (pool.some((o) => o.spot === sp)) continue;
          slot.spot = sp;
          slot.light.position.copy(sp.pos);
          slot.light.distance = sp.distance;
          slot.light.decay = sp.decay;
          if (instant) slot.w = 1;
          break;
        }
      }
      if (slot.spot) {
        slot.light.color.copy(slot.spot.color);
        slot.light.intensity = slot.spot.intensity * slot.w;
      } else slot.light.intensity = 0;
    }
  };

  /** A built level waiting to be shown, and what to do in the frame it is. */
  let pendingSwap: { old: OldLevel; apply: () => void } | null = null;
  const swapIn = () => {
    const p = pendingSwap;
    pendingSwap = null;
    if (!p) return;
    endLevel(p.old);
    p.apply();
    activeSpots = levelLights;
    for (const slot of pool) {
      slot.spot = null;
      slot.w = 0;
    }
    updateLightPool(0, true);
  };
  /** Starts a new level group (not shown yet) and resets the floor's state; the old group stays on screen. */
  const beginLevel = (): OldLevel => {
    const old: OldLevel = { group: level, disposables: perFloorDisposables.splice(0), heli };
    heli = null;
    level = new THREE.Group();
    blockers.length = 0;
    camBodies.clear();
    carByCell.clear();
    doorByCell.clear();
    guards = [];
    civs = [];
    seats = [];
    stations = [];
    notes = [];
    doors = [];
    cams = [];
    wires = [];
    cars = [];
    pickups = [];
    flaps = [];
    levelLights = [];
    keycardSpot = null;
    keycardNode = keyDoorNode = badgeNode = lasers = heliTarget = null;
    keycardAt = badgeAt = rackAt = null;
    boss = null;
    hasKey = keyDoorOpen = gatesOpen = camsOff = floorDone = alarm = spottedOnce = false;
    holdAt = null;
    hold = 0;
    run = null;
    backupT = 0;
    finale = 0;
    finaleWave = 0;
    floorClock = 0;
    flowFrom = -1;
    return old;
  };
  /** Shows the new level and throws the old one away. */
  const endLevel = (old: OldLevel) => {
    scene.remove(old.group);
    old.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) o.dispose();
    });
    for (const d of old.disposables) d.dispose();
    old.heli?.dispose();
    scene.add(level);
  };

  // ---- loading in slices, so the page keeps its frame rate ----
  let disposed = false;
  let loading = false;
  const ABORT = new Error("raid: stopped");
  const SLICE_MS = 6;
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const swallow = (e: unknown) => {
    if (e !== ABORT) console.error(e);
  };
  const drive = async (gen: Generator<[string, number], void, unknown>, onStep: (label: string, f: number) => void) => {
    let t0 = performance.now();
    for (;;) {
      const r = gen.next();
      if (r.done) return;
      onStep(r.value[0], r.value[1]);
      if (performance.now() - t0 > SLICE_MS) {
        await nextFrame();
        if (disposed) throw ABORT;
        t0 = performance.now();
      }
    }
  };
  /**
   * Compiles the shaders of the shown level and uploads its textures a piece at a time, so the first
   * frames after loading do not stutter. Each material is compiled once, on a mesh of its own: compiling
   * a group that holds a light would count that light twice and build the wrong shader.
   */
  const uploaded = new WeakSet<THREE.Texture>();
  /** Takes something off the floor without removing its light: a light coming or going would recompile every shader. */
  const stow = (node: THREE.Object3D) => {
    node.scale.setScalar(0.001);
    node.traverse((o) => {
      if ((o as THREE.PointLight).isLight) (o as THREE.PointLight).intensity = 0;
    });
  };
  const compileLevel = async (onStep?: (f: number) => void, extra: THREE.Object3D[] = [], target: THREE.Scene = scene) => {
    // Per call: the same material needs another shader when a floor has a different number of lights.
    const compiled = new Set<string>();
    const meshes: THREE.Object3D[] = [];
    for (const part of [...extra, ...level.children]) {
      part.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh && !(o as THREE.Line).isLine) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const key = materials.map((m) => m.uuid).join() + ((o as THREE.InstancedMesh).isInstancedMesh ? "i" : (o as THREE.Line).isLine ? "l" : "m");
        if (compiled.has(key)) return;
        compiled.add(key);
        meshes.push(o.children.length && mesh.isMesh ? new THREE.Mesh(mesh.geometry, mesh.material) : o);
      });
    }
    let t0 = performance.now();
    const pause = async () => {
      if (performance.now() - t0 <= SLICE_MS) return;
      await nextFrame();
      if (disposed) throw ABORT;
      t0 = performance.now();
    };
    for (let i = 0; i < meshes.length; i++) {
      const material = (meshes[i] as THREE.Mesh).material;
      for (const m of Array.isArray(material) ? material : [material]) {
        for (const key of ["map", "emissiveMap", "alphaMap"] as const) {
          const t = (m as THREE.MeshStandardMaterial)[key];
          if (t && !uploaded.has(t)) {
            uploaded.add(t);
            renderer.initTexture(t);
            await pause();
          }
        }
      }
      await renderer.compileAsync(meshes[i], camera, target);
      if (disposed) throw ABORT;
      onStep?.((i + 1) / meshes.length);
      await pause();
    }
  };
  /**
   * Compiles the level that is built but not shown yet, on a stage with the same lights the scene will
   * have (the level's own, plus stand-ins for the sky light and the pistol's flash), so that showing it
   * compiles nothing.
   */
  const compileStaged = async (onStep?: (f: number) => void, extra: THREE.Object3D[] = []) => {
    const stage = new THREE.Scene();
    stage.fog = scene.fog;
    stage.environment = scene.environment;
    const standIns = [new THREE.HemisphereLight(), new THREE.PointLight(), ...pool.map(() => new THREE.PointLight())];
    stage.add(level, ...standIns);
    try {
      await compileLevel(onStep, extra, stage);
    } finally {
      stage.remove(level, ...standIns);
    }
  };
  const loadFloor = async (index: number, placePlayer: boolean, onSwap?: () => void) => {
    loading = true;
    try {
      await drive(floorSteps(index, placePlayer, onSwap), () => {});
      await compileStaged();
      swapIn();
    } finally {
      loading = false;
    }
  };

  // ---- the pieces of a floor ----
  /** A workstation; desks next to each other face across a low frosted divider. */
  const addDesk = (x: number, y: number, deskMat: THREE.Material) => {
    let partner: [number, number] | null = null;
    if (floorIndex !== 2) {
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as [number, number][]) {
        if (cellAt(x + dx, y + dy) === "d") {
          partner = [dx, dy];
          break;
        }
      }
    }
    let angle = 0; // operations: every desk faces the video wall to the north
    if (partner) angle = Math.atan2(-partner[0], -partner[1]);
    else if (floorIndex !== 2) {
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        if (walkCell(x + dx, y + dy)) {
          angle = Math.atan2(dx, dy);
          break;
        }
      }
    }
    const d = cellBase(x, y, angle);
    const hsh = hash(x, y + floorIndex * 97);
    put(box(1.6, 0.03, 0.8), deskMat, local(d, 0, 0.735, -0.55), true);
    for (const lx of [-0.76, 0.76]) for (const lz of [-0.9, -0.2]) put(box(0.035, 0.72, 0.035), mats.metal, local(d, lx, 0.36, lz));
    const laptop = hsh % 3 === 0;
    for (const side of [-1, 1]) {
      if (laptop && side === 1) continue;
      addMonitor(local(d, side * 0.29, 1.2, -0.8, -side * 0.18), mats.screens[(hsh + side + 3) % mats.screens.length]);
      put(box(0.03, 0.3, 0.02), mats.metal, local(d, side * 0.29, 0.9, -0.83));
      put(box(0.2, 0.012, 0.16), mats.metal, local(d, side * 0.29, 0.756, -0.82));
    }
    if (laptop) {
      put(box(0.32, 0.015, 0.22), mats.laptop, local(d, 0.42, 0.757, -0.42));
      const lid = local(local(d, 0.42, 0.765, -0.53, 0, -0.3), 0, 0.105, 0);
      put(box(0.32, 0.21, 0.008), mats.laptop, lid);
      put(shapes.laptopScreen, mats.screens[hsh % mats.screens.length], local(lid, 0, 0, 0.005));
    }
    put(box(0.44, 0.015, 0.14), mats.keyboard, local(d, laptop ? -0.15 : 0, 0.758, -0.38));
    put(box(0.06, 0.02, 0.1), mats.keyboard, local(d, laptop ? 0.15 : 0.32, 0.76, -0.36));
    const extra = hsh % 4;
    if (extra === 1 && floorIndex !== 0) addDeskLamp(d, -0.66, -0.85);
    else if (extra === 2) put(shapes.mug, mats.mug, local(d, -0.62, 0.8, -0.3));
    else if (extra === 3) {
      put(shapes.potSmall, mats.pot, local(d, -0.64, 0.81, -0.75));
      put(shapes.leavesSmall, mats.leaves, local(d, -0.64, 0.93, -0.75));
    }
    if (partner && (partner[0] > 0 || partner[1] > 0)) {
      put(box(1.6, 0.4, 0.025), mats.frost, local(d, 0, 0.95, -0.99));
      put(box(1.6, 0.02, 0.04), mats.metal, local(d, 0, 1.16, -0.99));
    }
    if (floorIndex === 2) put(box(U, 0.012, 0.03), mats.ledCool, local(d, 0, 0.01, 0.98)); // tier edge
    const seat = local(d, rand(-0.12, 0.12), 0, 0.22, rand(-0.35, 0.35));
    addChair(seat, false);
    seats.push({ m: seat, kind: "desk" });
  };
  /** An executive desk facing the room, a leather chair behind it, two visitor chairs. */
  const addExecDesk = (x: number, y: number, wood: THREE.Material) => {
    const d = cellBase(x, y, angleOf(openDir(x, y)));
    put(box(1.9, 0.05, 0.95), wood, local(d, 0, 0.75, 0), true);
    put(box(1.9, 0.7, 0.04), wood, local(d, 0, 0.37, 0.44), true);
    for (const side of [-1, 1]) put(box(0.04, 0.7, 0.9), wood, local(d, side * 0.93, 0.37, 0));
    addMonitor(local(d, 0, 1.12, 0.12, Math.PI), mats.screens[0]);
    put(box(0.03, 0.3, 0.02), mats.metal, local(d, 0, 0.92, 0.15));
    put(box(0.44, 0.015, 0.14), mats.keyboard, local(d, 0, 0.783, -0.2));
    addDeskLamp(d, 0.7, -0.1);
    const seat = local(d, 0, 0, -0.85, Math.PI + rand(-0.2, 0.2));
    addChair(seat, true);
    seats.push({ m: seat, kind: "exec" });
    for (const side of [-1, 1]) addChair(local(d, side * 0.45, 0, 0.82, rand(-0.3, 0.3)), false);
  };
  const addMeetingTable = (x: number, y: number, top: THREE.Material) => {
    const alongX = cellAt(x - 1, y) === "M" || cellAt(x + 1, y) === "M";
    const m = cellBase(x, y, alongX ? Math.PI / 2 : 0);
    put(box(1.3, 0.05, U), top, local(m, 0, 0.74, 0), true);
    put(box(0.12, 0.7, 0.8), mats.metal, local(m, 0, 0.36, 0));
    const exec = floorIndex === 3;
    for (const side of [-1, 1]) {
      const seat = local(m, side * 0.88, 0, 0, (side * Math.PI) / 2 + rand(-0.2, 0.2));
      addChair(seat, exec);
      seats.push({ m: seat, kind: "meeting" });
    }
    const front = alongX ? cellAt(x + 1, y) : cellAt(x, y + 1);
    const back = alongX ? cellAt(x - 1, y) : cellAt(x, y - 1);
    if (front !== "M") addChair(local(m, 0, 0, 0.88, rand(-0.2, 0.2)), exec);
    if (back !== "M") addChair(local(m, 0, 0, -0.88, Math.PI + rand(-0.2, 0.2)), exec);
    if (hash(x, y) % 2) put(box(0.3, 0.01, 0.22), mats.note, local(m, rand(-0.3, 0.3), 0.768, 0, rand(-0.5, 0.5)));
  };
  /** The reception counter: white front with a light line, a work desk behind, a screen and a chair in the middle. */
  const addReception = (x: number, y: number, deskMat: THREE.Material) => {
    const front: [number, number] = y < MAP_H / 2 ? [0, 1] : [0, -1];
    const q = cellBase(x, y, angleOf(front));
    put(box(U, 1.05, 0.55), mats.counter, local(q, 0, 0.525, 0.1), true);
    put(box(U, 0.04, 0.78), mats.counterTop, local(q, 0, 1.07, 0.06));
    put(box(U, 0.03, 0.012), mats.brass, local(q, 0, 0.9, 0.38));
    put(box(U, 0.03, 0.45), deskMat, local(q, 0, 0.74, -0.42));
    const sideX = Math.round(Math.cos(angleOf(front)));
    for (const s of [-1, 1]) if (cellAt(x + s * sideX, y) !== "Q") put(box(0.04, 1.05, 0.6), mats.counter, local(q, s * (U / 2 - 0.02) * (sideX || 1), 0.525, 0.1));
    let a = x;
    let b = x;
    while (cellAt(a - 1, y) === "Q") a--;
    while (cellAt(b + 1, y) === "Q") b++;
    if (x === Math.floor((a + b) / 2) || (x === a && b - a > 3)) {
      addMonitor(local(q, 0, 1.0, -0.36, Math.PI), mats.screens[2]);
      const seat = local(q, 0.2, 0, -0.85, Math.PI + rand(-0.3, 0.3));
      addChair(seat, false);
      seats.push({ m: seat, kind: "reception" });
    }
  };
  /** A sofa cell; a run of them faces its coffee table, or away from the wall behind it. */
  const addSofa = (x: number, y: number) => {
    const alongX = cellAt(x - 1, y) === "o" || cellAt(x + 1, y) === "o";
    const runCells: [number, number][] = [];
    if (alongX) {
      let a = x;
      while (cellAt(a - 1, y) === "o") a--;
      for (let i = a; cellAt(i, y) === "o"; i++) runCells.push([i, y]);
    } else {
      let a = y;
      while (cellAt(x, a - 1) === "o") a--;
      for (let i = a; cellAt(x, i) === "o"; i++) runCells.push([x, i]);
    }
    const options: [number, number][] = alongX ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
    const score = ([dx, dy]: [number, number]) =>
      runCells.reduce((s, [rx, ry]) => s + (cellAt(rx + dx, ry + dy) === "c" ? 10 : 0) + (WALLISH.includes(cellAt(rx - dx, ry - dy)) ? 3 : 0) + (walkCell(rx + dx, ry + dy) ? 1 : 0), 0);
    const f = score(options[0]) >= score(options[1]) ? options[0] : options[1];
    const a = angleOf(f);
    const s = cellBase(x, y, a);
    const fabric = floorIndex === 3 ? mats.leather : mats.fabric;
    put(box(U, 0.36, 0.86), fabric, local(s, 0, 0.2, 0), true);
    put(box(U * 0.98, 0.1, 0.66), floorIndex === 3 ? mats.leather : mats.cushion, local(s, 0, 0.42, 0.08));
    put(box(U, 0.48, 0.2), fabric, local(s, 0, 0.62, -0.33), true);
    const lx = Math.round(Math.cos(a));
    const ly = Math.round(-Math.sin(a));
    if (cellAt(x + lx, y + ly) !== "o") put(box(0.16, 0.6, 0.86), fabric, local(s, U / 2 - 0.08, 0.3, 0), true);
    if (cellAt(x - lx, y - ly) !== "o") put(box(0.16, 0.6, 0.86), fabric, local(s, -U / 2 + 0.08, 0.3, 0), true);
    if (hash(x, y) % 2) put(box(0.42, 0.34, 0.12), mats.pillow, local(s, rand(-0.5, 0.5), 0.62, -0.18, rand(-0.3, 0.3), -0.25));
  };
  const addKitchen = (x: number, y: number) => {
    const k = cellBase(x, y, angleOf(frontAway(x, y)));
    put(box(U, 0.86, 0.62), mats.cabinetWhite, local(k, 0, 0.43, -0.66), true);
    put(box(U, 0.04, 0.68), mats.counterTop, local(k, 0, 0.88, -0.66));
    put(box(U, 0.7, 0.36), mats.cabinetWhite, local(k, 0, 1.95, -0.81));
    if (floorIndex !== 0) put(box(U, 0.01, 0.03), mats.ledWarm, local(k, 0, 1.595, -0.7));
    const v = x % 3;
    if (v === 0) {
      put(box(0.3, 0.42, 0.32), mats.frame, local(k, 0.4, 1.11, -0.75));
      put(box(0.06, 0.06, 0.01), mats.card, local(k, 0.4, 1.2, -0.585));
    } else if (v === 1) {
      put(box(0.5, 0.02, 0.36), mats.keyboard, local(k, -0.2, 0.905, -0.66));
      put(box(0.03, 0.25, 0.03), mats.metal, local(k, -0.2, 1.02, -0.86));
    } else put(box(0.5, 0.3, 0.36), mats.metal, local(k, 0.3, 1.05, -0.75));
  };
  /** A security gate: a steel pedestal with a status light, and glass flaps that fold away once open. */
  const addGate = (x: number, y: number) => {
    const alongX = "t#XW".includes(cellAt(x - 1, y)) || "t#XW".includes(cellAt(x + 1, y));
    const g = cellBase(x, y, alongX ? 0 : Math.PI / 2);
    const pedestal = (px: number) => {
      put(box(0.26, 1.0, 1.3), mats.steel, local(g, px, 0.5, 0), true);
      put(box(0.26, 0.012, 1.0), mats.gateLamp, local(g, px, 1.006, 0));
    };
    pedestal(-U / 2 + 0.13);
    const next = alongX ? cellAt(x + 1, y) : cellAt(x, y + 1);
    if (next !== "t") pedestal(U / 2 - 0.13);
    for (const px of [-U / 2 + 0.26 + 0.35, U / 2 - 0.26 - 0.35]) flaps.push(placed(box(0.7, 0.7, 0.02), mats.flap, local(g, px, 0.65, 0)));
  };
  /** A video wall: a dark frame full of screens, facing the room. */
  const addVideoWall = (x: number, y: number) => {
    const f = N4.find(([dx, dy]) => walkCell(x + dx, y + dy) || cellAt(x + dx, y + dy) === "d") ?? [0, 1];
    const v = cellBase(x, y, angleOf(f as [number, number]));
    const h = theme.h;
    put(box(U, h - 0.5, 0.12), mats.monitor, local(v, 0, 0.25 + (h - 0.5) / 2, U / 2 - 0.06), true);
    const rows = Math.floor((h - 0.9) / 0.62);
    const all = [...mats.screens, ...mats.wallScreens];
    for (let r = 0; r < rows; r++) {
      for (const col of [-0.5, 0.5]) put(shapes.videoWall, all[(x * 3 + r * 5 + (col > 0 ? 1 : 0)) % all.length], local(v, col, 0.75 + r * 0.62, U / 2 + 0.002));
    }
  };
  /** A sticky note on the desk or counter next to the cell, or on the wall. */
  const addNote = (x: number, y: number) => {
    const tops: Record<string, number> = { d: 0.752, e: 0.777, Q: 1.092, j: 0.902, M: 0.767 };
    const desk = N4.find(([dx, dy]) => cellAt(x + dx, y + dy) in tops);
    const note = new THREE.Mesh(shapes.note, mats.note);
    if (desk) {
      const [dx, dy] = desk;
      note.position.set((x + 0.5 + dx * 0.72) * U, tops[cellAt(x + dx, y + dy)], (y + 0.5 + dy * 0.72) * U);
      note.rotation.set(-Math.PI / 2, 0, rand(-0.4, 0.4));
    } else {
      const [dx, dy] = N4.find(([ddx, ddy]) => WALLISH.includes(cellAt(x + ddx, y + ddy))) ?? [0, -1];
      note.position.set((x + 0.5 + dx * 0.49) * U, 1.45, (y + 0.5 + dy * 0.49) * U);
      note.rotation.y = Math.atan2(-dx, -dy);
    }
    level.add(note);
  };
  /** A security door with a keypad on each side; its leaves slide into the wall once the code is right. */
  const addDoor = (x: number, y: number) => {
    const alongX = WALLISH.includes(cellAt(x - 1, y)) && WALLISH.includes(cellAt(x + 1, y));
    const g = cellBase(x, y, alongX ? 0 : Math.PI / 2);
    const h = theme.h;
    put(box(U, h - 2.3, U), floorMats?.solid ?? mats.frame, local(g, 0, 2.3 + (h - 2.3) / 2, 0), true);
    for (const s of [-1, 1]) put(box(0.1, 2.3, U), mats.steel, local(g, s * (U / 2 - 0.05), 1.15, 0), true);
    const node = new THREE.Group();
    g.decompose(node.position, node.quaternion, node.scale);
    level.add(node);
    const leaves = [-1, 1].map((s) => {
      const leaf = new THREE.Mesh(box(0.95, 2.3, 0.08), mats.secDoor);
      leaf.position.set(s * 0.475, 1.15, 0);
      node.add(leaf);
      blockers.push(leaf);
      return leaf;
    });
    const lamp = new THREE.MeshBasicMaterial({ color: CORAL, toneMapped: false });
    perFloorDisposables.push(lamp);
    for (const s of [-1, 1]) {
      const pad = new THREE.Mesh(box(0.16, 0.24, 0.04), mats.keypad);
      pad.position.set(s * 1.3, 1.3, s * 1.02);
      const light = new THREE.Mesh(box(0.06, 0.03, 0.02), lamp);
      light.position.set(s * 1.3, 1.46, s * 1.03);
      node.add(pad, light);
    }
    const i = doors.length;
    const door: Door = { x: x + 0.5, y: y + 0.5, cell: y * MAP_W + x, code: codes[floorIndex][i] ?? "0000", known: false, open: false, t: 0, leaves, lamp, wrong: 0 };
    doors.push(door);
    doorByCell.set(door.cell, door);
  };
  /** A camera on the wall next to the cell: it sweeps, and its cone shows where it looks. */
  const addCamera = (x: number, y: number) => {
    const [dx, dy] = N4.find(([ddx, ddy]) => WALLISH.includes(cellAt(x + ddx, y + ddy))) ?? [0, -1];
    const mx = x + 0.5 + dx * 0.45;
    const my = y + 0.5 + dy * 0.45;
    const mountH = Math.min(theme.h - 0.35, DROP_H - 0.2);
    const base = Math.atan2(-dy, -dx);
    const head = new THREE.Group();
    head.position.set(mx * U, mountH, my * U);
    level.add(head);
    const arm = new THREE.Mesh(box(0.05, 0.05, 0.3), mats.frame);
    arm.position.set(dx * 0.12 * U, 0.05, dy * 0.12 * U);
    arm.rotation.y = Math.atan2(dx, dy);
    level.add(arm);
    arm.position.add(head.position);
    const body = new THREE.Mesh(box(0.16, 0.13, 0.34), mats.camBody);
    const lens = new THREE.Mesh(box(0.09, 0.09, 0.03), mats.keyboard);
    lens.position.z = -0.18;
    const led = new THREE.Mesh(box(0.025, 0.025, 0.025), mats.camLed);
    led.position.set(0.05, 0.08, -0.1);
    const pitch = new THREE.Group();
    const reach = CAM_RANGE * U * 0.85;
    pitch.rotation.x = -Math.atan(mountH / reach);
    const cone = new THREE.Mesh(shapes.cone, mats.coneIdle);
    const len = Math.hypot(mountH, reach);
    cone.scale.set(Math.tan(CAM_FOV) * len, Math.tan(CAM_FOV) * len, len);
    pitch.add(cone);
    head.add(body, lens, led, pitch);
    blockers.push(body);
    const cam: Cam = { mx, my, sx: x + 0.5, sy: y + 0.5, base, yaw: base, amp: 0.75, speed: rand(0.45, 0.7), phase: rand(0, 6), t: 0, head, cone, led, seen: 0, sees: false, dead: false };
    cams.push(cam);
    camBodies.set(body, cam);
  };
  const addWire = (x: number, y: number) => {
    const blocks = (cx2: number, cy2: number) => !walkCell(cx2, cy2);
    const alongX = blocks(x - 1, y) && blocks(x + 1, y);
    const g = cellBase(x, y, alongX ? 0 : Math.PI / 2);
    const beam = placed(box(U, 0.014, 0.014), mats.laser, local(g, 0, WIRE_HEIGHT, 0));
    for (const s of [-1, 1]) put(box(0.08, 0.14, 0.08), mats.frame, local(g, s * (U / 2 - 0.04), WIRE_HEIGHT, 0));
    wires.push({ x, y, alongX, beam, flash: 0 });
  };
  const addPickup = (x: number, y: number, kind: Pickup["kind"]) => {
    const node = new THREE.Group();
    node.position.set((x + 0.5) * U, 0.45, (y + 0.5) * U);
    if (kind === "medkit") {
      node.add(new THREE.Mesh(box(0.42, 0.26, 0.3), mats.medkit));
      for (const [w, d] of [[0.22, 0.07], [0.07, 0.22]]) {
        const top = new THREE.Mesh(box(w, 0.012, d), mats.cross);
        top.position.y = 0.136;
        node.add(top);
      }
      for (const z of [0.156, -0.156]) {
        for (const [w, hh] of [[0.16, 0.05], [0.05, 0.16]]) {
          const side = new THREE.Mesh(box(w, hh, 0.012), mats.cross);
          side.position.z = z;
          node.add(side);
        }
      }
    } else {
      node.add(new THREE.Mesh(box(0.34, 0.05, 0.26), mats.intel));
      const stripe = new THREE.Mesh(box(0.34, 0.052, 0.04), mats.card);
      node.add(stripe);
    }
    level.add(node);
    const spot = kind === "intel" ? addSpot(0xff8a5a, 4, 4, (x + 0.5) * U, 0.6, (y + 0.5) * U, 2) : null;
    pickups.push({ kind, at: { x: x + 0.5, y: y + 0.5 }, node, taken: false, spot });
  };

  /** An elevator: a steel shaft in the wall, sliding doors, a call panel and a floor indicator. */
  const makeCar = (x: number, y: number, up: boolean, dir: [number, number], roof: boolean): Car => {
    const angle = angleOf(dir);
    const base = cellBase(x, y, angle);
    const h = theme.h;
    put(box(2, h, 0.1), mats.steel, local(base, 0, h / 2, -0.95), true);
    for (const s of [-1, 1]) {
      put(box(0.1, h, 2), mats.steel, local(base, s * 0.95, h / 2, 0), true);
      put(box(0.45, h, 0.1), mats.steel, local(base, s * 0.775, h / 2, 0.95), true);
      put(box(0.04, 0.04, 1.5), mats.metal, local(base, s * 0.86, 0.95, -0.05));
    }
    put(box(1.1, h - 2.3, 0.1), mats.steel, local(base, 0, 2.3 + (h - 2.3) / 2, 0.95), true);
    put(box(1.9, 0.02, 1.9), mats.carFloor, local(base, 0, 0.01, 0));
    put(box(1.9, 0.05, 1.9), mats.carFloor, local(base, 0, CAR_H, 0), true);
    put(box(1.3, 0.02, 1.3), mats.ledWarm, local(base, 0, CAR_H - 0.035, 0));
    put(box(1.6, 0.04, 0.04), mats.metal, local(base, 0, 0.95, -0.86));
    const node = new THREE.Group();
    base.decompose(node.position, node.quaternion, node.scale);
    level.add(node);
    const doorsM = [-1, 1].map((s) => {
      const leaf = new THREE.Mesh(box(0.56, 2.3, 0.04), mats.carDoor);
      leaf.position.set(s * 0.28, 1.15, 0.88);
      node.add(leaf);
      blockers.push(leaf);
      return leaf;
    });
    const arrow = new THREE.MeshBasicMaterial({ color: CORAL, toneMapped: false });
    const plate = new THREE.Mesh(box(0.14, 0.26, 0.02), mats.frame);
    plate.position.set(0.78, 1.2, 1.01);
    const arrowMesh = new THREE.Mesh(shapes.arrow, arrow);
    arrowMesh.position.set(0.78, 1.22, 1.022);
    if (!up && !roof) arrowMesh.rotation.z = Math.PI;
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 48;
    const ctx = canvas.getContext("2d")!;
    const indicatorTex = new THREE.CanvasTexture(canvas);
    indicatorTex.colorSpace = THREE.SRGBColorSpace;
    const indicatorMat = new THREE.MeshBasicMaterial({ map: indicatorTex, toneMapped: false });
    perFloorDisposables.push(arrow, indicatorTex, indicatorMat);
    const frame = new THREE.Mesh(box(0.52, 0.2, 0.02), mats.frame);
    frame.position.set(0, 2.55, 1.01);
    const outside = new THREE.Mesh(shapes.indicator, indicatorMat);
    outside.position.set(0, 2.55, 1.022);
    const within = new THREE.Mesh(shapes.indicator, indicatorMat);
    within.position.set(0, 2.55, 0.895);
    within.rotation.y = Math.PI;
    addSpot(0xfff0dc, 1.6, 2.6, (x + 0.5) * U, CAR_H - 0.25, (y + 0.5) * U, 2);
    node.add(plate, arrowMesh, frame, outside, within);
    const car: Car = {
      x: x + 0.5,
      y: y + 0.5,
      cell: y * MAP_W + x,
      dir,
      up,
      roof,
      node,
      doors: doorsM,
      open: 0,
      arrow,
      ctx,
      tex: indicatorTex,
      shown: "",
      call: -1,
      walls: orientRects(CAR_WALLS, dir),
      closed: orientRects([...CAR_WALLS, ...CAR_DOOR], dir),
    };
    if (!roof) carByCell.set(car.cell, car);
    cars.push(car);
    return car;
  };
  const drawIndicator = (car: Car, text: string, moving: boolean) => {
    const key = `${text}${moving}`;
    if (car.shown === key) return;
    car.shown = key;
    const c = car.ctx;
    c.fillStyle = "#07080c";
    c.fillRect(0, 0, 128, 48);
    c.fillStyle = "#ffb81f";
    c.font = "700 30px monospace";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text, 76, 26);
    if (moving) {
      c.beginPath();
      c.moveTo(30, 12);
      c.lineTo(42, 32);
      c.lineTo(18, 32);
      c.closePath();
      c.fill();
    }
    car.tex.needsUpdate = true;
  };

  const spawnCiv = (x: number, y: number, yaw: number, sit: boolean, act: Civ["act"]) => {
    const pickMat = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];
    const c = makeCivilian(box, { shirt: pickMat(mats.civShirts), trousers: pickMat(mats.civTrousers), skin: pickMat(mats.civSkin), hair: pickMat(mats.civHair), shoe: mats.civShoe });
    level.add(c.node);
    civs.push({ x, y, node: c.node, head: c.head, arms: c.arms, legs: c.legs, sit, act, yaw, t: rand(0, 10), state: "calm", fleeFor: 0, witness: 0, dying: 0 });
  };
  /** Staff at the reception, an executive, a few at their desks, a meeting, someone at the water, an IT tech. */
  const placeCivilians = (index: number) => {
    const max = index === LAST ? 4 : 8;
    const take = <T,>(list: T[]) => list.splice(Math.floor(Math.random() * list.length), 1)[0];
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const euler = new THREE.Euler(0, 0, 0, "YXZ");
    const seated = (m: THREE.Matrix4, act: Civ["act"]) => {
      m.decompose(pos, quat, scale);
      euler.setFromQuaternion(quat, "YXZ");
      spawnCiv(pos.x / U, pos.z / U, euler.y + Math.PI, true, act);
    };
    const of = (kind: string) => seats.filter((st) => st.kind === kind);
    const reception = of("reception");
    if (reception.length) seated(reception[0].m, "type");
    const exec = of("exec");
    if (exec.length) seated(take(exec).m, "type");
    const meeting = of("meeting");
    if (meeting.length >= 2) {
      const a = take(meeting);
      const at = new THREE.Vector3().setFromMatrixPosition(a.m);
      meeting.sort((p, q) => new THREE.Vector3().setFromMatrixPosition(p.m).distanceTo(at) - new THREE.Vector3().setFromMatrixPosition(q.m).distanceTo(at));
      seated(a.m, "talk");
      seated(meeting[0].m, "talk");
    }
    const desks = of("desk");
    for (let i = 0; i < 3 && desks.length && civs.length < max - 2; i++) seated(take(desks).m, "type");
    // Standing next to something: the water cooler or the kitchen, and a rack.
    const standBy = (chars: string, act: Civ["act"]) => {
      const spots: [number, number, number][] = [];
      for (let y = 1; y < MAP_H - 1; y++) {
        for (let x = 1; x < MAP_W - 1; x++) {
          if (!chars.includes(map[y][x])) continue;
          for (const [dx, dy] of N4) if (map[y + dy][x + dx] === ".") spots.push([x + dx + 0.5, y + dy + 0.5, Math.atan2(-dx, -dy)]);
        }
      }
      if (!spots.length || civs.length >= max) return;
      const [x, y, yaw] = take(spots);
      spawnCiv(x, y, yaw, false, act);
    };
    standBy("a", "sip");
    if (!civs.some((c) => c.act === "sip")) standBy("j", "sip");
    standBy("k", "work");
  };
  const spawnGuard = (x: number, y: number, kind: Guard["kind"]) => {
    const g = makeGuard(box, shapes.flash, kind === "boss");
    g.node.position.set(x * U, 0, y * U);
    level.add(g.node);
    perFloorDisposables.push(...g.own);
    const start = Math.floor(y) * MAP_W + Math.floor(x);
    const route: number[] = [];
    if (kind === "patrol") {
      const d = distances(start);
      const far: number[] = [];
      for (let i = 0; i < d.length; i++) if (d[i] >= 5 && d[i] <= 14) far.push(i);
      for (let k = 0; k < 2 && far.length; k++) route.push(far.splice(Math.floor(Math.random() * far.length), 1)[0]);
      route.push(start);
    }
    const facing = angleOf(openDir(Math.floor(x), Math.floor(y)));
    const hunter = kind === "hunter";
    const guard: Guard = {
      kind,
      x,
      y,
      node: g.node,
      head: g.head,
      visor: g.visor,
      flash: g.flash,
      legs: g.legs,
      skin: g.skin,
      health: kind === "boss" ? BOSS_HEALTH : GUARD_HEALTH,
      alert: hunter,
      sees: false,
      suspicion: 0,
      chase: hunter ? Infinity : 0,
      heading: facing,
      postAngle: facing,
      look: rand(0, 6),
      route,
      routeAt: 0,
      path: [],
      wait: rand(0, 2),
      cover: null,
      coverFor: 0,
      stagger: 0,
      reload: hunter ? rand(1, 2) : rand(0.4, 1.4),
      hurt: 0,
      dying: 0,
      walk: 0,
      strafe: 1,
      strafeFor: 0,
      skip: 0,
      calledBackup: false,
    };
    g.node.rotation.y = facing;
    guards.push(guard);
    return guard;
  };

  // ---- the roof: the end of the run ----
  const buildRoof = () => {
    const old = beginLevel();
    theme = ROOF_THEME;
    map = Array.from({ length: MAP_H }, () => ".".repeat(MAP_W));
    computeRects();
    const slab = new THREE.Mesh(box(64, 0.5, 48), mats.roof);
    slab.position.set(32, -0.25, 22);
    level.add(slab);
    for (const [w, d, x, z] of [[64, 0.4, 32, -2], [64, 0.4, 32, 46], [0.4, 48, 0, 22], [0.4, 48, 64, 22]]) {
      const wall = new THREE.Mesh(box(w, 1.1, d), mats.parapet);
      wall.position.set(x, 0.55, z);
      level.add(wall);
    }
    const pad = new THREE.Mesh(shapes.helipad, mats.helipad);
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(40, 0.02, 22);
    level.add(pad);
    for (const [x, z] of [[18, 6], [24, 38], [54, 8], [56, 38]]) {
      const unit = new THREE.Mesh(box(3, 1.6, 2.2), mats.cabinet);
      unit.position.set(x, 0.8, z);
      const fan = new THREE.Mesh(box(1.4, 0.05, 1.4), mats.frame);
      fan.position.set(x, 1.63, z);
      level.add(unit, fan);
    }
    const mast = new THREE.Mesh(box(0.15, 9, 0.15), mats.metal);
    mast.position.set(8, 4.5, 6);
    const beacon = new THREE.Mesh(box(0.25, 0.25, 0.25), mats.camLed);
    beacon.position.set(8, 9.1, 6);
    level.add(mast, beacon);
    for (const [x, z] of [[14, 20], [40, 12], [40, 32]]) {
      addSpot(0xffd9a8, 16, 18, x, 3, z, 1.6);
    }
    makeCar(5, 10, false, [1, 0], true);
    flushBatches();
    const h = makeHelicopter();
    heli = h;
    level.add(h.node);
    heliTarget = new THREE.Object3D();
    level.add(heliTarget);
    h.spot.target = heliTarget;
    pendingSwap = {
      old,
      apply: () => {
        fog.color.setHex(NIGHT);
        fog.near = 40;
        fog.far = 260;
        renderer.toneMappingExposure = 1.05;
        hemi.color.setHex(0x8fa4d8);
        hemi.groundColor.setHex(0x101018);
        hemi.intensity = 0.45;
        city.position.y = -floorBase(FLOORS.length) - 2;
        const [x, y] = fromLocal([1, 0], 0.5, 0.42);
        player.x = 5 + x;
        player.y = 10 + y;
        player.yaw = 0;
        player.pitch = 0.05;
        player.z = 0;
      },
    };
  };

  // ---- the HUD ----
  hud.innerHTML = `
    <div class="raid-top">
      <div class="raid-floor"><span></span><strong></strong><b class="raid-alarm">Alarm</b></div>
      <div class="raid-objective"><span>Objective</span><strong></strong><em></em></div>
    </div>
    <div class="raid-timer"><span></span><b></b></div>
    <div class="raid-banner"></div>
    <div class="raid-radio"><span>Handler</span><p></p></div>
    <div class="raid-arc"></div><div class="raid-arc"></div><div class="raid-arc"></div>
    <div class="raid-crosshair"><i></i></div>
    <div class="raid-hitmarker"></div>
    <div class="raid-headshot">Headshot</div>
    <div class="raid-prompt"><p><kbd></kbd><span></span></p><div><i></i></div></div>
    <div class="raid-keypad"><span>Security door</span><div class="raid-digits"><i></i><i></i><i></i><i></i></div><p>Type the code · <kbd>Backspace</kbd> deletes · <kbd>E</kbd> closes</p></div>
    <div class="raid-health"><span>Health <em></em></span><div><i></i></div><b></b></div>
    <div class="raid-ammo"><b></b><span></span></div>
    <div class="raid-fps"></div>
    <div class="raid-hurt"></div>
    <div class="raid-alarmglow"></div>
    <div class="raid-fade"></div>${import.meta.env.DEV ? `<div class="raid-testbadge" style="top:14px;right:18px;padding:2px 8px;border-radius:6px;background:#ff3324;font:700 11px var(--mono);letter-spacing:0.1em;display:none">TEST</div>` : ""}
    <div class="raid-intro"><div><p></p><p></p><p></p><p></p></div><span>Click or press E to skip</span></div>
    <div class="raid-down"><h2></h2><p></p></div>
    <div class="raid-card raid-start">
      <span class="raid-kicker">Hidden level</span>
      <h2>Raid the HQ</h2>
      <p>Five floors of a glass headquarters at night, each with a job to do before its elevator opens. Take the secrets off the top floor and get out by the roof.</p>
      <div class="raid-diff">
        <button type="button" data-diff="0">Easy<small>150 health</small></button>
        <button type="button" data-diff="1">Normal<small>100 health</small></button>
        <button type="button" data-diff="2">Hard<small>80 health, sharper guards</small></button>
      </div>
      <ul>
        <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move</li>
        <li><kbd>Mouse</kbd> look</li>
        <li><kbd>Click</kbd> shoot</li>
        <li><kbd>Space</kbd> jump</li>
        <li><kbd>E</kbd> use</li>
        <li><kbd>R</kbd> reload</li>
        <li><kbd>Shift</kbd> run</li>
        <li><kbd>M</kbd> mute</li>
        <li><kbd>Esc</kbd> pause</li>
      </ul>
      ${
          import.meta.env.DEV
            ? `<label style="display:flex;gap:8px;align-items:center;justify-content:center;margin-top:12px;font-size:12px;pointer-events:auto">Test: start on floor <select data-test-floor style="pointer-events:auto">${FLOORS.map((_, i) => `<option value="${i}">${i + 1}</option>`).join("")}</select></label>
        <p style="font-size:11.5px">Test keys: F9 next floor · Shift+F9 previous · F10 finish the objective · F11 god mode</p>`
            : ""
        }
      <button type="button" class="btn btn-primary" data-start>Start the raid</button>
      <p class="raid-best"></p>
    </div>
    <div class="raid-card raid-paused"><h2>Paused</h2><p>Click to keep going. <kbd>Esc</kbd> again leaves the game.</p></div>
    <div class="raid-card raid-results"><span class="raid-kicker"></span><h2></h2><div class="raid-rank"><b></b><span></span></div><dl></dl><p class="raid-best"></p><button type="button" class="btn btn-primary" data-leave>Leave</button></div>`;
  hud.classList.add("hud-off"); // nothing of the HUD shows behind the loading screen
  const el = <T extends HTMLElement = HTMLElement>(s: string) => hud.querySelector<T>(s)!;
  const floorEl = el(".raid-floor span");
  const floorName = el(".raid-floor strong");
  const alarmEl = el(".raid-alarm");
  const objectiveEl = el(".raid-objective strong");
  const codesEl = el(".raid-objective em");
  const timerEl = el(".raid-timer");
  const timerLabel = el(".raid-timer span");
  const timerNum = el(".raid-timer b");
  const bannerEl = el(".raid-banner");
  const radioEl = el(".raid-radio");
  const radioText = el(".raid-radio p");
  const arcEls = [...hud.querySelectorAll<HTMLElement>(".raid-arc")];
  const promptEl = el(".raid-prompt");
  const promptKey = el(".raid-prompt kbd");
  const promptText = el(".raid-prompt span");
  const promptBar = el(".raid-prompt i");
  const keypadEl = el(".raid-keypad");
  const digitEls = [...hud.querySelectorAll<HTMLElement>(".raid-digits i")];
  const healthBar = el(".raid-health i");
  const healthNum = el(".raid-health b");
  const livesEl = el(".raid-health em");
  const ammoNum = el(".raid-ammo b");
  const ammoNote = el(".raid-ammo span");
  const hurtEl = el(".raid-hurt");
  const alarmGlow = el(".raid-alarmglow");
  const fadeEl = el(".raid-fade");
  const introEl = el(".raid-intro");
  const introLines = [...hud.querySelectorAll<HTMLElement>(".raid-intro p")];
  const downEl = el(".raid-down");
  const hitEl = el(".raid-hitmarker");
  const headshotEl = el(".raid-headshot");
  const startEl = el(".raid-start");
  const diffButtons = [...hud.querySelectorAll<HTMLElement>("[data-diff]")];
  const pausedEl = el(".raid-paused");
  const resultsEl = el(".raid-results");
  const testBadge = import.meta.env.DEV ? hud.querySelector<HTMLElement>(".raid-testbadge") : null;
  let testFloor = 0;
  if (import.meta.env.DEV) {
    hud.querySelector<HTMLSelectElement>("[data-test-floor]")?.addEventListener("change", (e) => {
      testFloor = Number((e.target as HTMLSelectElement).value);
    });
  }
  /** Writes a style only when it changes, so the HUD does not restyle every frame. */
  const styleCache = new WeakMap<HTMLElement, Record<string, string>>();
  const css = (node: HTMLElement, prop: "opacity" | "transform" | "width" | "display", value: string) => {
    let c = styleCache.get(node);
    if (!c) styleCache.set(node, (c = {}));
    if (c[prop] === value) return;
    c[prop] = value;
    node.style[prop] = value;
  };
  const op = (v: number) => (Math.round(Math.min(1, Math.max(0, v)) * 50) / 50).toString();
  let cullT = 0;
  /** Whether you could see a spot: not too far, and no solid wall, closed door or elevator in between (glass is fine). */
  const inView = (x: number, y: number) => {
    const dx = x - player.x;
    const dy = y - player.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 30) return false;
    if (dist < 2) return true;
    const steps = Math.ceil(dist * 2);
    for (let i = 1; i < steps; i++) {
      const sx = player.x + (dx * i) / steps;
      const sy = player.y + (dy * i) / steps;
      const cx = Math.floor(sx);
      const cy = Math.floor(sy);
      const ch = cellAt(cx, cy);
      if ("XSVPU".includes(ch)) return false;
      if (ch === "D" && !doorByCell.get(cy * MAP_W + cx)?.open) return false;
      if (ch === "#" && (!inside(cx, cy) || arms[cy * MAP_W + cx] === 0)) return false;
    }
    return true;
  };
  const setText = (node: HTMLElement, text: string) => {
    if (node.textContent !== text) node.textContent = text;
  };
  const readBest = () => {
    try {
      return Number(localStorage.getItem(BEST_KEY) ?? 0) || 0;
    } catch {
      return 0;
    }
  };
  startEl.querySelector<HTMLElement>(".raid-best")!.textContent = readBest() ? `Best score ${readBest()}` : "";

  // ---- state ----
  let phase: "menu" | "intro" | "play" | "roof" | "results" = "menu";
  let locked = false;
  let everLocked = false;
  let ride: { car: Car; phase: "closing" | "moving"; t: number; swapped: boolean; loading: boolean; exit: boolean } | null = null;
  let roofT = 0;
  let downT = 0;
  let failT = 0;
  let failReason = "";
  let introLine = 0;
  let introChars = 0;
  let introHold = 0;
  let hitmark = 0;
  let hitKind: "hit" | "head" | "kill" = "hit";
  let headshotFlash = 0;
  let banner = 0;
  let shake = 0;
  let stepClock = 0;
  let tickClock = 0;
  let spotCooldown = 0;
  let alarmSoundT = 0;
  let ePressed = false;
  let muted = false;
  let keypad: { door: Door; input: string; flash: number; ok: boolean } | null = null;
  let prompt: { key: string; text: string; bar: number | null; warn: boolean } | null = null;
  const radioQueue: string[] = [];
  let radioLine = "";
  let radioShown = 0;
  let radioHold = 0;
  const arcs = arcEls.map((node) => ({ node, angle: 0, life: 0 }));
  let nextArc = 0;
  const keys = new Set<string>();
  const sparks: { mesh: THREE.Mesh; life: number; max: number; vel: THREE.Vector3 | null }[] = [];
  const tracers: { line: THREE.Line; life: number }[] = [];
  const casings: { mesh: THREE.Mesh; life: number; vel: THREE.Vector3; spin: THREE.Vector3 }[] = [];
  const tracerMat = new THREE.LineBasicMaterial({ color: CORAL, transparent: true });
  const myTracerMat = new THREE.LineBasicMaterial({ color: 0xffd27a, transparent: true });
  const raycaster = new THREE.Raycaster();
  const centre = new THREE.Vector2(0, 0);

  const paused = () => phase === "play" && everLocked && !locked;
  const near = (p: Spot, r: number) => Math.hypot(p.x - player.x, p.y - player.y) < r;
  /** Where something is relative to where you look: 0 ahead, positive to the right. */
  const relAngle = (x: number, y: number) => wrap(Math.atan2(y - player.y, x - player.x) - player.yaw);
  const showBanner = (text: string) => {
    bannerEl.textContent = text;
    banner = 3;
  };
  const radio = (line: string) => {
    if (line && radioLine !== line && !radioQueue.includes(line) && radioQueue.length < 4) radioQueue.push(line);
  };

  const addTracer = (from: THREE.Vector3, to: THREE.Vector3, material: THREE.LineBasicMaterial) => {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([from, to]), material.clone());
    scene.add(line);
    tracers.push({ line, life: 0.08 });
  };
  const addSpark = (at: THREE.Vector3, color = 0xffe2a0, vel: THREE.Vector3 | null = null, life = 0.25) => {
    const material = mats.spark.clone();
    material.color.setHex(color);
    const mesh = new THREE.Mesh(shapes.spark, material);
    mesh.position.copy(at);
    if (vel) mesh.scale.setScalar(rand(0.5, 1));
    scene.add(mesh);
    sparks.push({ mesh, life, max: life, vel });
  };
  const addCasing = () => {
    const mesh = new THREE.Mesh(shapes.casing, mats.brass);
    pistol.port.getWorldPosition(mesh.position);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const vel = right.multiplyScalar(rand(1.2, 1.9)).add(new THREE.Vector3(0, rand(1.4, 2.0), 0));
    scene.add(mesh);
    casings.push({ mesh, life: 0.9, vel, spin: new THREE.Vector3(rand(10, 20), rand(5, 15), rand(-10, 10)) });
  };

  const reload = () => {
    if (player.reloading > 0 || player.ammo === MAG || phase !== "play") return;
    player.reloading = RELOAD_SECONDS;
    sound.reload();
  };

  /** The floor's job is done: its elevator opens. */
  const unlockFloor = (note: string) => {
    if (floorDone) return;
    floorDone = true;
    if (lasers) lasers.visible = false;
    sound.done();
    showBanner(note);
    radio("Good. The elevator's yours.");
  };
  const finishStation = (s: Station) => {
    s.done = true;
    if (s.screen) s.screen.material = mats.kioskDone;
    if (s.lamp) s.lamp.material = mats.lampOn;
    sound.done();
  };
  const learnCode = (door: number) => {
    const d = doors[door];
    if (!d) return;
    d.known = true;
    sound.pickup();
    showBanner(`Door code ${d.code}`);
  };

  /** The whole floor knows: every guard hunts you, two more come, the elevator takes longer. */
  const raiseAlarm = (why: string) => {
    for (const g of guards) {
      if (g.dying !== 0) continue;
      g.alert = true;
      g.chase = Infinity;
    }
    if (alarm) return;
    alarm = true;
    alarms++;
    sound.spotted();
    sound.alarm(true);
    alarmSoundT = 4;
    for (let i = 0; i < 2; i++) reinforce();
    radio(`${why} The alarm is up: they're all coming.`);
    showBanner("Alarm");
  };
  /** A guard has seen you: he and the guards near him join in. */
  const spot = (g: Guard) => {
    g.alert = true;
    g.suspicion = 0;
    g.chase = Math.max(g.chase, CHASE_SECONDS);
    g.reload = Math.max(g.reload, rand(0.5, 1.1));
    for (const o of guards) {
      if (o === g || o.dying !== 0 || o.alert || Math.hypot(o.x - g.x, o.y - g.y) > ALERT_RADIUS) continue;
      o.alert = true;
      o.chase = CHASE_SECONDS;
      o.reload = rand(0.8, 1.8);
    }
    if (!spottedOnce) {
      spottedOnce = true;
      radio("You've been spotted. Fight, or lose them.");
    }
    if (spotCooldown <= 0) {
      sound.spotted();
      spotCooldown = 3;
    }
  };
  /** Brings a guard in at a free cell far from you and out of your sight, already hunting. */
  const reinforce = (): boolean => {
    updateFlow();
    const far: [number, number][] = [];
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        if (map[y][x] !== "." || flow[y * MAP_W + x] < 0) continue;
        const d = Math.hypot(x + 0.5 - player.x, y + 0.5 - player.y);
        if (d > 9 && d < 26 && !seesFrom(x + 0.5, y + 0.5, player.x, player.y)) far.push([x, y]);
      }
    }
    if (!far.length) return false;
    const [x, y] = far[Math.floor(Math.random() * far.length)];
    spawnGuard(x + 0.5, y + 0.5, "hunter");
    return true;
  };
  const startRun = (at: Spot, total: number, label: string, finish: () => void) => {
    run = { at, t: 0, total, spawned: 0, spawnClock: 0, label, finish };
    sound.progressTick();
  };
  const startFinale = () => {
    finale = FINALE_SECONDS;
    finaleWave = 0;
    floorDone = true;
    sound.alarm(true);
    showBanner("Upload done");
    radio("Lockdown! Sixty seconds. The elevator you came up in goes to the roof. Move!");
  };

  const popHead = (g: Guard) => {
    const at = new THREE.Vector3();
    g.head[0].getWorldPosition(at);
    for (const part of g.head) part.visible = false;
    for (let i = 0; i < 14; i++) addSpark(at, i % 3 ? 0xffc94a : 0xff6b57, new THREE.Vector3(rand(-1.6, 1.6), rand(0.6, 2.6), rand(-1.6, 1.6)), rand(0.35, 0.6));
  };
  const dropBadge = (g: Guard) => {
    badgeAt = { x: g.x, y: g.y };
    const card = new THREE.Mesh(shapes.card, mats.card);
    card.position.set(g.x * U, 0.6, g.y * U);

    level.add(card);
    badgeNode = card;
    showBanner("Head of security down");
    radio("He's down. Grab his badge, it calls the lift.");
  };

  const shoot = () => {
    if (phase !== "play" || paused() || ride || downT > 0 || failT > 0 || keypad || player.reload > 0 || player.reloading > 0) return;
    if (player.ammo <= 0) {
      sound.empty();
      return reload();
    }
    player.ammo -= 1;
    player.reload = SHOT_EVERY;
    shots++;
    shake = Math.max(shake, 0.006);
    sound.shot();
    addCasing();
    const flash = pistol.flash.material as THREE.MeshBasicMaterial;
    flash.opacity = 1;
    pistol.flash.rotation.z = Math.random() * Math.PI;
    pistol.light.intensity = 40;
    for (const g of guards) {
      if (g.dying !== 0 || Math.hypot(g.x - player.x, g.y - player.y) > HEARS_SHOT) continue;
      if (!g.alert) g.reload = Math.max(g.reload, rand(0.6, 1.4));
      g.alert = true;
      g.chase = Math.max(g.chase, CHASE_SECONDS);
    }
    for (const c of civs) {
      if (c.state === "down" || Math.hypot(c.x - player.x, c.y - player.y) > 10) continue;
      if (c.witness === 0 && seesFrom(c.x, c.y, player.x, player.y)) c.witness = 2.5;
      panicCiv(c);
    }
    raycaster.setFromCamera(centre, camera);
    const targets = [...blockers, ...guards.filter((g) => g.dying === 0).map((g) => g.node), ...civs.filter((c) => c.state !== "down").map((c) => c.node)];
    const hit = raycaster.intersectObjects(targets, true)[0];
    const muzzle = new THREE.Vector3();
    pistol.flash.getWorldPosition(muzzle);
    addTracer(muzzle, hit ? hit.point : raycaster.ray.at(60, new THREE.Vector3()), myTracerMat);
    if (!hit) return;
    addSpark(hit.point);
    const cam = camBodies.get(hit.object);
    if (cam && !cam.dead) {
      // A shot camera goes dark and droops.
      cam.dead = true;
      cam.cone.visible = false;
      cam.led.material = mats.camLedOff;
      cam.head.rotation.x = -0.6;
      for (let i = 0; i < 8; i++) addSpark(hit.point, 0xbfe4ff, new THREE.Vector3(rand(-1, 1), rand(0, 1.5), rand(-1, 1)), 0.4);
      sound.hit(false);
      return;
    }
    const within = (node: THREE.Object3D) => {
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) if (o === node) return true;
      return false;
    };
    const civ = civs.find((c) => c.state !== "down" && within(c.node));
    if (civ) {
      civ.state = "down";
      civ.dying = 0.6;
      civiliansHit++;
      hitmark = 0.18;
      hitKind = "hit";
      sound.hit(false);
      showBanner("Civilian hit · -500");
      radio("Civilians aren't the target.");
      return;
    }
    const guard = guards.find((g) => within(g.node));
    if (!guard) return;
    hits++;
    const headshot = guard.head.includes(hit.object);
    guard.health -= headshot ? (guard.kind === "boss" ? BOSS_HEALTH / BOSS_HEADSHOTS : GUARD_HEALTH) : 1;
    guard.hurt = 0.12;
    guard.stagger = 0.2;
    if (!guard.alert) spot(guard);
    guard.chase = Math.max(guard.chase, CHASE_SECONDS);
    const killed = guard.health <= 0;
    hitmark = 0.18;
    hitKind = headshot ? "head" : killed ? "kill" : "hit";
    if (headshot) {
      headshotFlash = HEADSHOT_SECONDS;
      headshots++;
    }
    sound.hit(headshot);
    if (guard.kind === "boss" && !killed && !guard.calledBackup && guard.health <= BOSS_HEALTH / 2) {
      guard.calledBackup = true;
      for (let i = 0; i < 3; i++) reinforce();
      radio("He's calling for backup. More of them on the way.");
    }
    if (killed) {
      guard.dying = 0.6;
      kills++;
      sound.kill();
      if (headshot) popHead(guard);
      if (guard.kind === "boss") dropBadge(guard);
    }
    if (player.ammo === 0) reload();
  };

  const hurtPlayer = (from: Guard) => {
    if (import.meta.env.DEV && god) return;
    const diff = DIFFICULTIES[difficulty];
    player.health -= rand(...GUARD_DAMAGE) * diff.damage * (from.kind === "boss" ? 1.2 : 1);
    player.hurt = 0.4;
    shake = Math.max(shake, 0.035);
    sound.hurt();
    const arc = arcs[nextArc++ % arcs.length];
    arc.angle = relAngle(from.x, from.y);
    arc.life = 1;
    if (player.health <= 0) die();
  };
  /** Down: back to the start of the floor with 70 health, until the third time. */
  const die = () => {
    player.health = 0;
    deaths++;
    keypad = null;
    sound.alarm(false);
    if (deaths >= MAX_DEATHS) {
      failReason = "Caught";
      failT = 2.6;
      setText(downEl.querySelector("h2")!, "Caught.");
      setText(downEl.querySelector("p")!, `Security got you on floor ${floorIndex + 1}.`);
      sound.lose();
      return;
    }
    downT = 2.4;
    const left = MAX_DEATHS - deaths;
    setText(downEl.querySelector("h2")!, "Down.");
    setText(downEl.querySelector("p")!, `Back to the start of floor ${floorIndex + 1} · ${left} ${left === 1 ? "try" : "tries"} left`);
  };
  let restarting = false;
  const restartFloor = () => {
    restarting = true;
    loadFloor(floorIndex, true).then(() => {
      restarting = false;
      player.health = Math.min(maxHealth, CHECKPOINT_HEALTH);
      player.ammo = MAG;
      player.reloading = 0;
      player.z = player.vz = 0;
      radio("Back on your feet. Again, and quieter.");
    }, swallow);
  };

  const objectiveText = (): string => {
    const pct = run ? ` ${Math.floor((run.t / run.total) * 100)}%` : "";
    const done = (kind: Station["kind"]) => stations.filter((s) => s.kind === kind && s.done).length;
    const count = (kind: Station["kind"]) => stations.filter((s) => s.kind === kind).length;
    switch (floorIndex) {
      case 0:
        if (gatesOpen || doors[0]?.open) return "Take the elevator up";
        return `Get past security: hack the terminals ${done("T")}/${count("T")}, or use the staff door`;
      case 1:
        if (floorDone) return "Take the elevator up";
        if (run) return `Downloading the access codes${pct}`;
        if (!doors[0]?.open) return doors[0]?.known ? "Open the server closet" : "Find the server closet code at the IT terminal";
        return "Download the access codes in the server closet";
      case 2:
        return floorDone ? "Take the elevator up" : `Pull the fuses to cut the laser grid ${done("F")}/${count("F")}`;
      case 3: {
        if (floorDone) return "Take the elevator up";
        if (boss && boss.dying === 0) {
          const inLobby = player.y > 20 && player.x > 13 && player.x < 26;
          return inLobby && !doors[1]?.open ? (doors[1]?.known ? "Get into the executive wing" : "Get into the executive wing: the code is at the front desk") : "Take down the head of security";
        }
        return "Pick up his badge";
      }
      default:
        if (finale > 0) return "Reach the elevator to the roof";
        if (!hasKey) return doors[0]?.open ? "Take the keycard" : doors[0]?.known ? "Open the security office" : "Find the security office code in the NOC";
        return run ? `Uploading the secrets${pct}` : "Upload the secrets at the rack";
    }
  };

  const findCover = (g: Guard): Spot | null => {
    let best: Spot | null = null;
    let bestD = 3.2;
    const gx = Math.floor(g.x);
    const gy = Math.floor(g.y);
    for (let y = gy - 3; y <= gy + 3; y++) {
      for (let x = gx - 3; x <= gx + 3; x++) {
        if (!walkCell(x, y)) continue;
        const cxp = x + 0.5;
        const cyp = y + 0.5;
        if (g.kind === "boss" && g.cover && Math.floor(g.cover.x) === x && Math.floor(g.cover.y) === y) continue;
        const px = player.x - cxp;
        const py = player.y - cyp;
        const pl = Math.hypot(px, py);
        if (pl < 2.5 || pl > GUARD_SEES - 1) continue;
        const covered = N4.some(([dx, dy]) => {
          const ch = cellAt(x + dx, y + dy);
          const cover = "deMQojtckXfhnbazO".includes(ch) || (ch === "#" && inside(x + dx, y + dy));
          return cover && (dx * px + dy * py) / pl > 0.6;
        });
        if (!covered) continue;
        const d = Math.hypot(cxp - g.x, cyp - g.y);
        if (d >= bestD) continue;
        if (guards.some((o) => o !== g && o.cover && Math.floor(o.cover.x) === x && Math.floor(o.cover.y) === y)) continue;
        if (!seesFrom(cxp, cyp, player.x, player.y) || !seesFrom(g.x, g.y, cxp, cyp)) continue;
        best = { x: cxp, y: cyp };
        bestD = d;
      }
    }
    return best;
  };

  /** A guard who has not noticed you: walks his round or holds his post, looking around. */
  const calmMove = (g: Guard, dt: number) => {
    g.look += dt;
    if (g.kind !== "patrol" && g.kind !== "hunter") {
      g.heading = g.postAngle + Math.sin(g.look * 0.5) * 0.7;
      return;
    }
    if (g.wait > 0) {
      g.wait -= dt;
      g.heading += Math.sin(g.look * 1.3) * dt * 0.8;
      return;
    }
    if (!g.path.length) {
      if (!g.route.length) {
        g.wait = 2;
        return;
      }
      g.routeAt = (g.routeAt + 1) % g.route.length;
      g.path = pathTo(cellOf(g), g.route[g.routeAt]);
      if (!g.path.length) {
        g.wait = 1.5;
        return;
      }
    }
    const next = g.path[0];
    const tx = (next % MAP_W) + 0.5;
    const ty = Math.floor(next / MAP_W) + 0.5;
    const l = Math.hypot(tx - g.x, ty - g.y);
    if (l < 0.12) {
      g.path.shift();
      if (!g.path.length) g.wait = rand(1.2, 3);
      return;
    }
    const s = Math.min(l, PATROL_SPEED * dt * (g.alert ? 1.5 : 1));
    const bx = g.x;
    const by = g.y;
    move(g, ((tx - g.x) / l) * s, ((ty - g.y) / l) * s, 0.25);
    if (g.x === bx && g.y === by) g.path = [];
    g.heading = Math.atan2(tx - bx, ty - by);
    g.walk += dt * 0.7;
  };

  const updateGuard = (g: Guard, dt: number, moving: boolean) => {
    if (g.dying > 0) {
      g.dying -= dt;
      if (g.dying <= 0) g.dying = -1;
      return;
    }
    if (g.dying < 0) return;
    const dx = player.x - g.x;
    const dy = player.y - g.y;
    const dist = Math.max(0.01, Math.hypot(dx, dy));
    // Calm guards far away think a few times a second.
    if (!g.alert && dist > AI_FAR) {
      g.skip += dt;
      if (g.skip < 0.25) return;
      dt = g.skip;
    }
    g.skip = 0;
    g.hurt = Math.max(0, g.hurt - dt);
    g.reload = Math.max(0, g.reload - dt);
    g.stagger = Math.max(0, g.stagger - dt);
    g.chase = Math.max(0, g.chase - dt);
    let sees = false;
    if (dist < GUARD_SEES) {
      if (g.alert) sees = seesFrom(g.x, g.y, player.x, player.y);
      else {
        const ahead = Math.cos(Math.atan2(dx, dy) - g.heading);
        if ((dist < 2.2 || ahead > 0.45) && seesFrom(g.x, g.y, player.x, player.y)) sees = true;
      }
    }
    if (!g.alert) {
      if (sees) {
        g.suspicion += dt * (dist < 4 ? 3 : 1.4);
        if (g.suspicion >= 1) spot(g);
      } else g.suspicion = Math.max(0, g.suspicion - dt * 0.4);
    }
    g.sees = sees && g.alert;
    if (g.sees) g.chase = Math.max(g.chase, CHASE_SECONDS);
    if (!g.alert || (!g.sees && g.chase <= 0)) {
      calmMove(g, dt);
      return;
    }
    const nx = dx / dist;
    const ny = dy / dist;
    if (g.stagger > 0) {
      move(g, -nx * 1.4 * dt, -ny * 1.4 * dt, 0.25);
      return;
    }
    if (g.sees) {
      // Cover behind a desk or a partition edge when one is near; the boss keeps moving between them.
      g.coverFor -= dt;
      if (g.coverFor <= 0) {
        g.cover = findCover(g);
        g.coverFor = g.kind === "boss" ? rand(1.5, 2.6) : rand(2.5, 4);
      }
      if (g.cover) {
        const tx = g.cover.x - g.x;
        const ty = g.cover.y - g.y;
        const l = Math.hypot(tx, ty);
        if (l > 0.1) {
          const s = Math.min(l, GUARD_SPEED * 1.2 * dt);
          move(g, (tx / l) * s, (ty / l) * s, 0.25);
          g.walk += dt;
        }
      } else {
        g.strafeFor -= dt;
        if (g.strafeFor <= 0) {
          g.strafe = Math.random() < 0.5 ? -1 : 1;
          g.strafeFor = rand(0.8, 2);
        }
        const toward = dist > GUARD_KEEPS ? 1 : 0;
        const bx = g.x;
        const by = g.y;
        move(g, (nx * toward - ny * g.strafe * 0.55) * GUARD_SPEED * dt, (ny * toward + nx * g.strafe * 0.55) * GUARD_SPEED * dt, 0.25);
        if (g.x === bx && g.y === by) g.strafe *= -1;
        g.walk += dt;
      }
      g.heading = Math.atan2(dx, dy);
    } else {
      // Hunt: follow the way to you through the doors.
      g.cover = null;
      g.coverFor = 0;
      const gx = Math.floor(g.x);
      const gy = Math.floor(g.y);
      const here = walkCell(gx, gy) ? flow[gy * MAP_W + gx] : -1;
      let best = -1;
      let tx = player.x;
      let ty = player.y;
      for (const [ddx, ddy] of N4) {
        if (!walkCell(gx + ddx, gy + ddy)) continue;
        const f = flow[(gy + ddy) * MAP_W + gx + ddx];
        if (f >= 0 && (best < 0 || f < best)) {
          best = f;
          tx = gx + ddx + 0.5;
          ty = gy + ddy + 0.5;
        }
      }
      if (here === 0 || (here > 0 && best >= here)) {
        tx = player.x;
        ty = player.y;
      }
      const l = Math.hypot(tx - g.x, ty - g.y) || 1;
      move(g, ((tx - g.x) / l) * GUARD_SPEED * dt, ((ty - g.y) / l) * GUARD_SPEED * dt, 0.25);
      g.heading = Math.atan2(tx - g.x, ty - g.y);
      g.walk += dt;
    }
    if (g.sees && g.reload <= 0 && floorClock > GRACE_SECONDS) {
      const diff = DIFFICULTIES[difficulty];
      g.reload = rand(...(g.kind === "boss" ? BOSS_FIRES_EVERY : GUARD_FIRES_EVERY)) / Math.sqrt(diff.accuracy);
      (g.flash.material as THREE.MeshBasicMaterial).opacity = 1;
      sound.guardShot(Math.sin(relAngle(g.x, g.y)), dist);
      const from = new THREE.Vector3();
      g.flash.getWorldPosition(from);
      const chance = Math.min(0.92, Math.max(0.15, 0.8 - dist * 0.055 - (moving ? 0.15 : 0) - (player.z > 0 ? 0.1 : 0)) * diff.accuracy);
      const hitYou = Math.random() < chance;
      const to = camera.position.clone().add(new THREE.Vector3(rand(-0.6, 0.6), hitYou ? -0.25 : rand(-0.8, 0.6), rand(-0.6, 0.6)));
      addTracer(from, to, tracerMat);
      if (hitYou) hurtPlayer(g);
    }
  };

  /** Doors want open when you come near and the elevator is yours; they close behind you on a ride. */
  const updateCars = (dt: number) => {
    for (const car of cars) {
      const d = Math.hypot(car.x - player.x, car.y - player.y);
      let want = false;
      if ((phase === "play" || phase === "roof") && !(ride && ride.car === car)) {
        if (car.roof) want = roofT > 0.6;
        else if (car.up) {
          if (floorDone && d < 3.2) {
            if (alarm && car.call !== 0) {
              if (car.call < 0) car.call = CALL_SECONDS;
              car.call = Math.max(0, car.call - dt);
              want = car.call === 0;
            } else want = true;
          }
        } else if (floorIndex === LAST) want = finale > 0 ? d < 3.2 : d < 1.3;
        else want = d < 3.2;
      }
      car.open = Math.min(1, Math.max(0, car.open + (want ? dt : -dt) / DOOR_SECONDS));
    }
  };

  const startRoof = () => {
    phase = "roof";
    roofT = 0;
    ride = null;
    sound.alarm(false);
    radioQueue.length = 0;
    radioLine = "";
    buildRoof();
    roofReady = false;
    compileStaged().then(() => {
      swapIn();
      roofReady = true;
    }, swallow);
    radio("The bird's on the roof. Go, go!");
  };
  let roofReady = false;

  const showResults = (won: boolean, reason: string) => {
    if (phase === "results") return;
    phase = "results";
    keypad = null;
    sound.alarm(false);
    if (won) sound.win();
    if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
    const diff = DIFFICULTIES[difficulty];
    const accuracy = shots ? Math.round((hits / shots) * 100) : 0;
    const score = Math.max(
      0,
      Math.round(((won ? 5000 : 0) + kills * 60 + headshots * 30 + intel * 400 + accuracy * 12 - alarms * 350 - deaths * 600 - civiliansHit * 500 + (won ? Math.max(0, 1200 - elapsed) * 3 : floorIndex * 300)) * diff.score),
    );
    const rank = !won ? "C" : score >= 9000 ? "S" : score >= 7000 ? "A" : score >= 5000 ? "B" : "C";
    const best = readBest();
    if (score > best && !(import.meta.env.DEV && testUsed)) {
      try {
        localStorage.setItem(BEST_KEY, String(score));
      } catch {
        // Storage can be unavailable; the score still shows.
      }
    }
    const time = `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`;
    setText(resultsEl.querySelector(".raid-kicker")!, `${import.meta.env.DEV && testUsed ? "Test run · " : ""}${diff.name} · ${won ? "Mission complete" : "Mission failed"}`);
    setText(resultsEl.querySelector("h2")!, won ? "You're out with the secrets." : reason === "Locked down" ? "Locked down." : "Caught.");
    setText(resultsEl.querySelector(".raid-rank b")!, rank);
    setText(resultsEl.querySelector(".raid-rank span")!, `Score ${score}`);
    const rows: [string, string][] = [
      ["Time", time],
      ["Kills", String(kills)],
      ["Headshots", String(headshots)],
      ["Accuracy", `${accuracy}%`],
      ["Alarms raised", String(alarms)],
      ["Intel found", `${intel} / ${FLOORS.length}`],
      ["Deaths", String(deaths)],
      ["Civilians hit", String(civiliansHit)],
      ["Floor reached", String(Math.min(floorIndex + 1, FLOORS.length))],
    ];
    resultsEl.querySelector("dl")!.innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
    setText(resultsEl.querySelector(".raid-best")!, import.meta.env.DEV && testUsed ? "Test run: the best score is not saved." : score > best ? "A new best score." : `Best score ${best}`);
    resultsEl.classList.add("shown", won ? "won" : "lost");
    lastSummary = `${won ? "Out with the secrets" : reason}: rank ${rank}, score ${score}, ${kills} guards down, ${accuracy}% accuracy.`;
  };
  let lastSummary = "";

  // ---- the floor's job, pickups and interactions ----
  const updateObjectives = (dt: number, pressedE: boolean) => {
    let usedE = pressedE;
    const takeE = () => {
      const was = usedE;
      usedE = false;
      return was;
    };
    for (const p of pickups) {
      if (p.taken || !near(p.at, REACH + 0.1)) continue;
      if (p.kind === "medkit") {
        if (player.health >= maxHealth) continue;
        player.health = Math.min(maxHealth, player.health + MEDKIT_HEAL);
        showBanner(`Medkit +${MEDKIT_HEAL}`);
      } else {
        intel++;
        showBanner(`Intel ${intel} of ${FLOORS.length}`);
        radio("Nice find. That's worth something to the right people.");
      }
      p.taken = true;
      stow(p.node);
      if (p.spot) p.spot.intensity = p.spot.base = 0;
      sound.pickup();
    }
    if (keycardAt && !hasKey && near(keycardAt, REACH)) {
      hasKey = true;
      keyDoorOpen = true;
      flowFrom = -1;
      if (keycardNode) stow(keycardNode);
        if (keycardSpot) keycardSpot.intensity = keycardSpot.base = 0;
      if (keyDoorNode) {
        keyDoorNode.visible = false;
        blockers.splice(blockers.indexOf(keyDoorNode), 1);
      }
      sound.pickup();
      showBanner("Keycard: the server room is open");
    }
    if (badgeAt && badgeNode?.visible && near(badgeAt, REACH + 0.2)) {
      badgeNode.visible = false;
      sound.pickup();
      unlockFloor("Badge taken: the elevator is yours");
    }

    let busy = false;
    // Keypad doors.
    const door = doors.find((d) => !d.open && near(d, 2.05));
    if (door && !keypad) {
      prompt = { key: "E", text: door.known ? `Enter the door code · ${door.code}` : "Enter the door code", bar: null, warn: false };
      if (takeE()) {
        keypad = { door, input: "", flash: 0, ok: false };
        keys.clear();
      }
    }
    // Notes.
    const note = notes.find((n) => !n.read && near(n, 1.1));
    if (note && !prompt) {
      prompt = { key: "E", text: "Read the note", bar: null, warn: false };
      if (takeE()) {
        note.read = true;
        learnCode(note.door);
      }
    }
    // Terminals and cabinets you hold E at.
    const holdable = (s: Station) => !s.done && (s.kind === "Y" || s.kind === "F" || (s.kind === "T" && floorIndex === 0));
    const s = stations.find((st) => holdable(st) && near(st, USE_REACH));
    if (s && !prompt) {
      const need = s.kind === "Y" ? READ_SECONDS : HOLD_SECONDS;
      if (keys.has("KeyE") && !keypad) {
        if (holdAt !== s) hold = 0;
        holdAt = s;
        hold += dt;
        busy = true;
        if (hold >= need) {
          completeStation(s);
          holdAt = null;
          hold = 0;
        }
      } else {
        holdAt = null;
        hold = 0;
      }
      if (!s.done) prompt = { key: "Hold E", text: s.kind === "Y" ? "Read the door code" : s.kind === "F" ? "Pull the fuse" : "Hack the terminal", bar: hold / need, warn: false };
    } else if (!s) {
      holdAt = null;
      hold = 0;
    }
    // The download (open office) and the upload (server floor).
    if (floorIndex === 1 && !run && !prompt) {
      const t = stations.find((st) => st.kind === "T" && !st.done && near(st, USE_REACH));
      if (t) {
        prompt = { key: "E", text: "Start the download", bar: null, warn: false };
        if (takeE()) {
          startRun(t, DOWNLOAD_SECONDS, "Downloading the access codes", () => {
            finishStation(t);
            backupT = 0;
            unlockFloor("Access codes downloaded: the elevator is yours");
          });
          backupT = BACKUP_SECONDS;
          radio("Download's running. Backup security is on its way: about half a minute.");
        }
      }
    }
    if (floorIndex === LAST && hasKey && rackAt && !run && finale <= 0 && !floorDone && near(rackAt, USE_REACH + 0.3)) startRun(rackAt, UPLOAD_SECONDS, "Uploading the secrets", startFinale);
    if (run) {
      const r = run;
      const close = near(r.at, STAY_RANGE);
      if (close) {
        r.t += dt;
        busy = true;
      }
      r.spawnClock += dt;
      if (r.spawned < REINFORCE_MAX && r.spawnClock >= REINFORCE_EVERY) {
        r.spawnClock = 0;
        if (reinforce()) r.spawned++;
      }
      const pct = Math.floor((r.t / r.total) * 100);
      if (!prompt || close) prompt = close ? { key: "", text: `${r.label} · ${pct}%`, bar: r.t / r.total, warn: false } : { key: "", text: "Paused · get back in range", bar: r.t / r.total, warn: true };
      if (r.t >= r.total) {
        run = null;
        r.finish();
      }
    }
    if (backupT > 0 && floorIndex === 1) {
      backupT -= dt;
      if (backupT <= 0) {
        backupT = 0;
        raiseAlarm("Backup security has arrived.");
        for (let i = 0; i < 2; i++) reinforce();
      }
    }
    if (busy) {
      tickClock += dt;
      if (tickClock >= 0.5) {
        tickClock = 0;
        sound.progressTick();
      }
    } else tickClock = 0.4;

    // The lockdown.
    if (finale > 0) {
      finale -= dt;
      const into = FINALE_SECONDS - finale;
      if (finaleWave < FINALE_WAVES.length && into >= FINALE_WAVES[finaleWave]) {
        finaleWave++;
        for (let i = 0; i < WAVE_SIZE; i++) reinforce();
      }
      if (finale <= 0) {
        finale = 0;
        failReason = "Locked down";
        failT = 2.6;
        setText(downEl.querySelector("h2")!, "Locked down.");
        setText(downEl.querySelector("p")!, "The building sealed before you reached the elevator.");
        sound.alarm(false);
        sound.lose();
        return;
      }
    }

    // The elevator up: locked until the floor's job is done.
    const up = cars.find((c) => c.up);
    if (up && near(up, 1.9) && !prompt) {
      if (!floorDone) prompt = { key: "", text: `Elevator locked · ${objectiveText()}`, bar: null, warn: true };
      else if (alarm && up.call > 0) prompt = { key: "", text: `Alarm is up · the elevator is on its way · ${Math.ceil(up.call)} s`, bar: 1 - up.call / CALL_SECONDS, warn: true };
    }
  };
  const completeStation = (s: Station) => {
    if (s.kind === "Y") {
      s.done = true;
      sound.done();
      learnCode(s.door);
      return;
    }
    finishStation(s);
    const left = stations.filter((st) => st.kind === s.kind && !st.done).length;
    if (s.kind === "T") {
      if (!left) {
        gatesOpen = true;
        camsOff = true;
        flowFrom = -1;
        for (const f of flaps) f.visible = false;
        mats.gateLamp.color.setHex(MINT);
        showBanner("Cameras down, gates open");
        radio("Cameras are dark and the gates are open. Go.");
      } else showBanner(`Terminal hacked · ${left} to go`);
    } else if (s.kind === "F") {
      if (!left) unlockFloor("Laser grid down: the elevator is yours");
      else showBanner(`Fuse pulled · ${left} to go`);
    }
  };

  const step = (dt: number) => {
    const pressedE = ePressed;
    ePressed = false;
    // Effects run even when paused, so nothing freezes mid-air.
    for (const s of sparks) {
      s.life -= dt;
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, s.life / s.max);
      if (s.vel) {
        s.vel.y -= 6 * dt;
        s.mesh.position.addScaledVector(s.vel, dt);
      } else s.mesh.scale.setScalar(1 + (0.25 - s.life) * 6);
    }
    for (const t of tracers) {
      t.life -= dt;
      (t.line.material as THREE.LineBasicMaterial).opacity = Math.max(0, t.life / 0.08);
    }
    for (const list of [sparks, tracers] as { life: number; mesh?: THREE.Mesh; line?: THREE.Line }[][]) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].life > 0) continue;
        const obj = (list[i].mesh ?? list[i].line)!;
        scene.remove(obj);
        (obj.material as THREE.Material).dispose();
        if (list[i].line) list[i].line!.geometry.dispose();
        list.splice(i, 1);
      }
    }
    for (let i = casings.length - 1; i >= 0; i--) {
      const c = casings[i];
      c.life -= dt;
      c.vel.y -= 9.8 * dt;
      c.mesh.position.addScaledVector(c.vel, dt);
      c.mesh.rotation.x += c.spin.x * dt;
      c.mesh.rotation.y += c.spin.y * dt;
      if (c.mesh.position.y < 0.01) {
        c.mesh.position.y = 0.01;
        c.vel.multiplyScalar(0.4);
        c.vel.y = Math.abs(c.vel.y) * 0.5;
        c.spin.multiplyScalar(0.5);
      }
      if (c.life <= 0) {
        scene.remove(c.mesh);
        casings.splice(i, 1);
      } else if (c.life < 0.25) c.mesh.scale.setScalar(c.life / 0.25);
    }
    hitmark = Math.max(0, hitmark - dt);
    headshotFlash = Math.max(0, headshotFlash - dt);
    banner = Math.max(0, banner - dt);
    player.hurt = Math.max(0, player.hurt - dt);
    player.land = Math.max(0, player.land - dt);
    shake *= Math.exp(-dt * 9);
    for (const a of arcs) a.life = Math.max(0, a.life - dt);
    if (keypad) keypad.flash = Math.max(0, keypad.flash - dt);
    // The radio types its line, holds it, then takes the next.
    if (!radioLine && radioQueue.length) {
      radioLine = radioQueue.shift()!;
      radioShown = 0;
      radioHold = 0;
    }
    if (radioLine) {
      radioShown += dt * 45;
      if (radioShown >= radioLine.length) {
        radioHold += dt;
        if (radioHold > 3.4) radioLine = "";
      }
    }
    if (alarmSoundT > 0) {
      alarmSoundT -= dt;
      if (alarmSoundT <= 0 && finale <= 0) sound.alarm(false);
    }
    prompt = null;

    if (phase === "intro") {
      const line = INTRO[introLine];
      if (line) {
        introChars += dt * 40;
        if (introChars >= line.length) {
          introHold += dt;
          if (introHold > 0.9) {
            introLine++;
            introChars = 0;
            introHold = 0;
          }
        }
      } else {
        introHold += dt;
        if (introHold > 0.6 && !loading) startPlay();
      }
      return;
    }
    if (phase === "roof") {
      stepRoof(dt);
      return;
    }
    if (phase !== "play" || paused()) return;

    if (downT > 0 || restarting) {
      if (downT > 0) {
        downT -= dt;
        if (downT <= 0) restartFloor();
      }
      return;
    }
    if (failT > 0) {
      failT -= dt;
      if (failT <= 0) showResults(false, failReason);
      return;
    }

    if (loading && !ride) return;
    elapsed += dt;
    floorClock += dt;
    spotCooldown = Math.max(0, spotCooldown - dt);
    player.reload = Math.max(0, player.reload - dt);
    if (player.reloading > 0) {
      player.reloading -= dt;
      if (player.reloading <= 0) {
        player.reloading = 0;
        player.ammo = MAG;
      }
    }
    updateCars(dt);

    // The elevator ride: doors close, the car hums and shakes, the next floor replaces this one.
    if (ride) {
      const r = ride;
      r.t += dt;
      if (r.phase === "closing") {
        if (r.car.open <= 0) {
          if (r.exit) {
            startRoof();
            return;
          }
          r.phase = "moving";
          r.t = 0;
        }
      } else {
        shake = Math.max(shake, 0.005);
        // The next floor is built while the car rides; the doors stay shut until it is ready.
        if (!r.swapped && !r.loading && r.t >= RIDE_SECONDS / 2) {
          r.loading = true;
          const [u, v] = carLocal(r.car, player.x, player.y);
          const rel = player.yaw - carYaw(r.car);
          loadFloor(floorIndex + 1, false, () => {
            const to = cars.find((c) => !c.up)!;
            const [x, y] = fromLocal(to.dir, u, v);
            player.x = Math.floor(to.x) + x;
            player.y = Math.floor(to.y) + y;
            player.px = player.x;
            player.py = player.y;
            player.yaw = carYaw(to) + rel;
            player.health = Math.min(maxHealth, player.health + FLOOR_HEAL);
            r.car = to;
          }).then(() => {
            r.swapped = true;
          }, swallow);
        }
        if (r.swapped && r.t >= RIDE_SECONDS) {
          ride = null;
          sound.ding();
          radio(ARRIVE[floorIndex]);
        }
      }
      return;
    }

    // Walking, and jumping: W forward, S back, A left, D right; the arrow keys turn without a mouse.
    const forward = keypad ? 0 : (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
    const right = keypad ? 0 : (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
    const turn = keypad ? 0 : (keys.has("ArrowRight") ? 1 : 0) - (keys.has("ArrowLeft") ? 1 : 0);
    player.yaw += turn * TURN_SPEED * dt;
    const running = keys.has("ShiftLeft") || keys.has("ShiftRight");
    player.px = player.x;
    player.py = player.y;
    if (forward || right) {
      const len = Math.hypot(forward, right);
      const speed = WALK * (running ? SPRINT : 1) * dt;
      const f = (forward / len) * speed;
      const r = (right / len) * speed;
      const cos = Math.cos(player.yaw);
      const sin = Math.sin(player.yaw);
      move(player, cos * f - sin * r, sin * f + cos * r, PLAYER_RADIUS);
      player.walk += dt * (running ? SPRINT : 1);
      if (player.z === 0) {
        stepClock += dt;
        if (stepClock >= (running ? 0.32 : 0.45)) {
          stepClock = 0;
          sound.step(running);
        }
      }
    } else stepClock = 0.3;
    if (player.z > 0 || player.vz > 0) {
      player.vz -= GRAVITY * dt;
      player.z += player.vz * dt;
      if (player.z <= 0) {
        player.z = 0;
        player.vz = 0;
        player.land = 0.18;
        sound.step(true);
      }
    }

    for (const car of cars) {
      if (ride || car.open < 0.95) continue;
      const goesUp = car.up && floorDone;
      const exits = !car.up && floorIndex === LAST && finale > 0;
      if ((goesUp || exits) && inCar(car)) {
        ride = { car, phase: "closing", t: 0, swapped: false, loading: false, exit: exits };
        keypad = null;
      }
    }

    updateObjectives(dt, pressedE);
    if (failT > 0 || phase !== "play") return;

    // Cameras: a sweep, a cone, and the alarm when you stay in view.
    for (const cam of cams) {
      if (cam.dead || camsOff) {
        cam.sees = false;
        cam.seen = 0;
        continue;
      }
      cam.t += dt;
      cam.yaw = cam.base + Math.sin(cam.t * cam.speed + cam.phase) * cam.amp;
      const dx = player.x - cam.mx;
      const dy = player.y - cam.my;
      let sees = false;
      if (Math.hypot(dx, dy) < CAM_RANGE && Math.abs(wrap(Math.atan2(dy, dx) - cam.yaw)) < CAM_FOV && seesFrom(cam.sx, cam.sy, player.x, player.y)) sees = true;
      cam.sees = sees;
      if (sees) {
        cam.seen += dt;
        if (cam.seen > CAM_NOTICE) {
          if (!alarm) raiseAlarm("A camera saw you.");
          else for (const g of guards) g.chase = Math.max(g.chase, CHASE_SECONDS);
        }
      } else cam.seen = Math.max(0, cam.seen - dt);
    }
    // Tripwires: cross one with your feet below the beam and the alarm goes.
    for (const w of wires) {
      w.flash = Math.max(0, w.flash - dt);
      const line = (w.alongX ? w.y : w.x) + 0.5;
      const a = w.alongX ? player.py : player.px;
      const b = w.alongX ? player.y : player.x;
      const along = w.alongX ? player.x : player.y;
      const lo = w.alongX ? w.x : w.y;
      const crossed = (a - line) * (b - line) <= 0 || Math.abs(b - line) < 0.08;
      if (crossed && along > lo && along < lo + 1 && player.z < WIRE_HEIGHT && w.flash <= 0) {
        w.flash = 1;
        raiseAlarm("You tripped a laser wire.");
      }
    }

    updateFlow();
    for (const g of guards) {
      updateGuard(g, dt, !!(forward || right));
      if (phase !== "play" || downT > 0 || failT > 0) return;
    }
    for (const c of civs) updateCiv(c, dt);
  };

  /** Calm until shooting or an alarm; then they run a few steps and cower. */
  const panicCiv = (c: Civ) => {
    if (c.state !== "calm") return;
    c.state = c.sit ? "cower" : "flee";
    c.sit = false;
    c.fleeFor = rand(1.2, 2);
  };
  const updateCiv = (c: Civ, dt: number) => {
    if (c.state === "down") {
      c.dying = Math.max(0, c.dying - dt);
      return;
    }
    const dx = c.x - player.x;
    const dy = c.y - player.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 26 && c.state === "calm") return;
    c.t += dt;
    if (alarm) panicCiv(c);
    if (c.witness > 0) {
      c.witness -= dt;
      if (c.witness <= 0) {
        // Still close and still watched: they call it in.
        c.witness = -1;
        if (dist < 7 && seesFrom(c.x, c.y, player.x, player.y)) raiseAlarm("A civilian called security.");
      }
    }
    if (c.state === "flee") {
      c.fleeFor -= dt;
      const l = dist || 1;
      const bx = c.x;
      const by = c.y;
      move(c, (dx / l) * 2.2 * dt, (dy / l) * 2.2 * dt, 0.2);
      if (c.x !== bx || c.y !== by) c.yaw = Math.atan2(c.x - bx, c.y - by);
      if (c.fleeFor <= 0 || (c.x === bx && c.y === by)) c.state = "cower";
    }
  };

  const startPlay = () => {
    phase = "play";
    floorClock = 0;
    radio(ARRIVE[floorIndex]);
  };
  const beginIntro = () => {
    if (phase !== "menu") return;
    sound.start();
    lock();
    maxHealth = DIFFICULTIES[difficulty].health;
    player.health = maxHealth;
    phase = "intro";
    introLine = 0;
    introChars = 0;
    introHold = 0;
    if (import.meta.env.DEV && testFloor > 0) {
      testUsed = true;
      loadFloor(testFloor, true).catch(swallow);
    }
  };
  const skipIntro = () => {
    if (phase === "intro" && !loading) startPlay();
  };

  const stepRoof = (dt: number) => {
    if (!roofReady) return; // the doors stay shut until the roof is ready to draw
    roofT += dt;
    updateCars(dt);
    if (!heli || !heliTarget) return;
    const pad = new THREE.Vector3(40, 0, 22);
    const start = new THREE.Vector3(80, 18, -14);
    const hover = new THREE.Vector3(40, 7, 22);
    const pos = roofT < 3.5 ? start.clone().lerp(hover, smooth(roofT / 3.5)) : hover.clone().lerp(new THREE.Vector3(pad.x, 1.3, pad.z), smooth((roofT - 3.5) / 2.5));
    heli.node.position.copy(pos);
    heli.node.rotation.y = -Math.PI / 2 + (1 - smooth(roofT / 4)) * 0.6;
    heli.node.rotation.z = Math.sin(roofT * 1.3) * 0.04;
    heli.rotor.rotation.y += dt * 28;
    heli.tail.rotation.x += dt * 40;
    heli.strobe.visible = Math.sin(roofT * 8) > 0.6;
    heliTarget.position.set(player.x * U, 0, player.y * U);
    heli.beam.lookAt(heliTarget.position);
    // You walk out to the pad, looking at the helicopter.
    if (roofT > 1.3) {
      const t = smooth((roofT - 1.3) / 4.5);
      player.x = 5.5 + 0.42 + (16.5 - 5.92) * t;
      player.y = 10.5 + (11 - 10.5) * t;
      player.walk += dt * (t < 1 ? 1 : 0);
    }
    const want = Math.atan2(pos.z / U - player.y, pos.x / U - player.x);
    player.yaw += wrap(want - player.yaw) * Math.min(1, dt * 2.5);
    const pitchWant = Math.atan2(pos.y + 1.5 - EYE, Math.hypot(pos.x - player.x * U, pos.z - player.y * U));
    player.pitch += (pitchWant - player.pitch) * Math.min(1, dt * 2.5);
    if (roofT > 5.4 && roofT - dt <= 5.4) radio("Wheels up. Good work.");
    if (roofT > ROOF_SECONDS) showResults(true, "");
  };

  const draw = (dt: number, clock: number) => {
    const playing = phase === "play" && !paused();
    const moving = playing && !keypad && !ride && (keys.has("KeyW") || keys.has("KeyS") || keys.has("KeyA") || keys.has("KeyD") || keys.has("ArrowUp") || keys.has("ArrowDown"));
    const bob = (moving && player.z === 0) || (phase === "roof" && roofT > 1.3 && roofT < 5.8) ? Math.sin(player.walk * 10) * 0.035 : 0;
    const dip = player.land > 0 ? Math.sin((player.land / 0.18) * Math.PI) * 0.07 : 0;
    camera.position.set(player.x * U, EYE + bob + player.z - dip, player.y * U);
    camera.rotation.y = -player.yaw - Math.PI / 2 + (Math.random() - 0.5) * shake;
    camera.rotation.x = player.pitch + (Math.random() - 0.5) * shake + shake * 0.5;
    // Hide the pistol but keep its light, so the scene's light count (and every compiled shader) stays the same.
    const showPistol = phase === "play" && downT <= 0 && failT <= 0;
    for (const child of pistol.node.children) if (child !== pistol.light) child.visible = showPistol;
    if (!showPistol) pistol.light.intensity = 0;
    const kick = player.reload > SHOT_EVERY - 0.07 ? (player.reload - (SHOT_EVERY - 0.07)) / 0.07 : 0;
    const lower = player.reloading > 0 ? Math.sin((1 - player.reloading / RELOAD_SECONDS) * Math.PI) : 0;
    pistol.node.position.set(0.19 + (moving ? Math.sin(player.walk * 5) * 0.01 : 0), -0.16 + bob * 0.4 - lower * 0.12 - dip * 0.5, -0.4 + kick * 0.05);
    pistol.node.rotation.set(kick * 0.22 - lower * 0.6 + (keypad ? -0.5 : 0), 0, lower * 0.4);
    const flash = pistol.flash.material as THREE.MeshBasicMaterial;
    flash.opacity = Math.max(0, flash.opacity - dt * 20);
    pistol.light.intensity = Math.max(0, pistol.light.intensity - dt * 500);

    for (const g of guards) {
      g.node.position.set(g.x * U, 0, g.y * U);
      const gf = g.flash.material as THREE.MeshBasicMaterial;
      gf.opacity = Math.max(0, gf.opacity - dt * 16);
      if (!g.node.visible) {
        g.node.rotation.y = g.heading;
        continue;
      }
      if (g.dying === 0) {
        g.node.rotation.y = g.heading;
        g.node.rotation.x = -g.stagger * 1.4;
        const swing = Math.sin(g.walk * 9) * 0.55;
        g.legs[0].rotation.x = swing;
        g.legs[1].rotation.x = -swing;
        g.visor.emissive.setHex(g.kind === "boss" ? GOLD : g.alert ? CORAL : g.suspicion > 0 ? ACCENT : 0x6cc4ff);
        for (const m of g.skin) m.emissive.setHex(g.hurt > 0 ? 0x661111 : 0x000000);
      } else {
        const t = g.dying > 0 ? 1 - g.dying / 0.6 : 1;
        g.node.rotation.x = -t * (Math.PI / 2) * 0.95;
        g.node.position.y = t * 0.12;
        g.visor.emissiveIntensity = 2 * (1 - t);
        for (const m of g.skin) m.emissive.setHex(0x000000);
      }
    }
    for (const c of civs) {
      if (!c.node.visible) continue;
      const [al, ar] = c.arms;
      const [ll, lr] = c.legs;
      c.node.position.set(c.x * U, 0, c.y * U);
      c.node.rotation.y = c.yaw;
      al.rotation.z = ar.rotation.z = 0;
      c.head.rotation.set(0, 0, 0);
      if (c.state === "down") {
        const t = 1 - c.dying / 0.6;
        c.node.rotation.x = -t * (Math.PI / 2) * 0.95;
        c.node.position.y = t * 0.12;
        continue;
      }
      if (c.state === "cower") {
        // Crouched, hands up, head down.
        c.node.position.y = -0.4;
        ll.rotation.x = lr.rotation.x = -1.3;
        al.rotation.x = ar.rotation.x = -2.8;
        al.rotation.z = 0.3;
        ar.rotation.z = -0.3;
        c.head.rotation.x = 0.4;
        continue;
      }
      if (c.state === "flee") {
        const swing = Math.sin(c.t * 12) * 0.7;
        ll.rotation.x = swing;
        lr.rotation.x = -swing;
        al.rotation.x = -swing;
        ar.rotation.x = swing;
        continue;
      }
      c.node.position.y = c.sit ? -0.42 : 0;
      ll.rotation.x = lr.rotation.x = c.sit ? -1.45 : 0;
      c.head.rotation.y = Math.sin(c.t * 0.45 + c.x) * 0.3;
      if (c.act === "type") {
        al.rotation.x = -1.25 + Math.sin(c.t * 15) * 0.05;
        ar.rotation.x = -1.25 + Math.sin(c.t * 15 + 1.7) * 0.05;
      } else if (c.act === "work") {
        al.rotation.x = -1.1 + Math.sin(c.t * 4) * 0.15;
        ar.rotation.x = -1.3;
      } else if (c.act === "talk") {
        al.rotation.x = -0.5 + Math.sin(c.t * 2.6 + c.x) * 0.35;
        ar.rotation.x = -0.2;
        c.head.rotation.y = Math.sin(c.t * 0.8) * 0.15;
      } else {
        const sipping = c.t % 6 < 1.4;
        ar.rotation.x = sipping ? -2.3 : -0.1;
        al.rotation.x = 0;
        c.head.rotation.x = sipping ? -0.2 : 0;
      }
    }
    for (const cam of cams) {
      if (cam.dead) continue;
      cam.head.rotation.y = -cam.yaw - Math.PI / 2;
      cam.cone.visible = !camsOff;
      cam.cone.material = cam.sees ? mats.coneHot : mats.coneIdle;
      cam.led.material = camsOff ? mats.camLedOff : mats.camLed;
    }
    for (const w of wires) w.beam.visible = w.flash > 0 ? Math.sin(clock * 40) > 0 : true;
    for (const d of doors) {
      d.t = Math.min(1, Math.max(0, d.t + (d.open ? dt : -dt) / 0.8));
      d.leaves[0].position.x = -0.475 - d.t * 0.9;
      d.leaves[1].position.x = 0.475 + d.t * 0.9;
      d.lamp.color.setHex(d.open ? MINT : keypad?.door === d && keypad.flash > 0 && !keypad.ok ? 0xffffff : CORAL);
    }
    for (const car of cars) {
      car.doors[0].position.x = -0.28 - car.open * 0.48;
      car.doors[1].position.x = 0.28 + car.open * 0.48;
      const usable = car.roof || (car.up ? floorDone : floorIndex !== LAST || finale > 0);
      car.arrow.color.setHex(usable ? ACCENT : CORAL);
      const movingCar = ride?.car === car && ride.phase === "moving";
      drawIndicator(car, car.roof ? "R" : String(floorIndex + 1), movingCar);
    }
    // The car you ride counts up while the next floor is built.
    if (ride && !cars.includes(ride.car)) drawIndicator(ride.car, String(floorIndex + 1), ride.phase === "moving");
    for (const node of [keycardNode, badgeNode]) {
      if (!node?.visible) continue;
      node.rotation.y += dt * 2;
      node.position.y = (node === badgeNode ? 0.6 : 1.1) + Math.sin(clock * 2.4) * 0.08;
    }
    for (const p of pickups) {
      p.node.rotation.y += dt * 0.8;
      p.node.position.y = 0.45 + Math.sin(clock * 2 + p.at.x) * 0.05;
    }
    tex.mist.offset.x = clock * 0.004;
    tex.mist.offset.y = clock * 0.002;
    if (finale > 0 && floorMats) {
      const pulse = 0.55 + 0.45 * Math.sin(clock * 6);
      for (const l of activeSpots) {
        if (!l.lamp) continue;
        l.color.setHex(ALARM);
        l.intensity = 26 * pulse;
      }
      floorMats.ceiling.emissive.setHex(ALARM);
      floorMats.ceiling.emissiveIntensity = 0.4 + pulse;
      hemi.color.setHex(0xff6a5a);
    }

    // People you cannot see (behind solid walls, or far) are not drawn.
    cullT -= dt;
    if (cullT <= 0) {
      cullT = 0.12;
      for (const g of guards) g.node.visible = inView(g.x, g.y);
      for (const c of civs) c.node.visible = inView(c.x, c.y);
    }
    updateLightPool(dt);
    renderer.render(scene, camera);

    // HUD.
    hud.classList.toggle("hud-off", phase !== "play");
    setText(floorEl, `Floor ${floorIndex + 1} / ${FLOORS.length}`);
    setText(floorName, THEMES[floorIndex].name);
    alarmEl.classList.toggle("shown", alarm);
    setText(objectiveEl, objectiveText());
    const known = doors.filter((d) => d.known && !d.open).map((d) => `Door code ${d.code}`);
    setText(codesEl, known.join(" · "));
    const timer = finale > 0 ? ["Lockdown", finale] : backupT > 0 ? ["Backup arrives", backupT] : null;
    timerEl.classList.toggle("shown", !!timer && phase === "play");
    if (timer) {
      setText(timerLabel, String(timer[0]));
      setText(timerNum, `0:${String(Math.ceil(Number(timer[1]))).padStart(2, "0")}`);
    }
    css(bannerEl, "opacity", op(banner / 0.4));
    radioEl.classList.toggle("shown", !!radioLine && phase !== "intro" && phase !== "results");
    setText(radioText, radioLine.slice(0, Math.floor(radioShown)));
    promptEl.classList.toggle("shown", !!prompt && phase === "play" && !keypad);
    if (prompt) {
      setText(promptKey, prompt.key);
      css(promptKey, "display", prompt.key ? "" : "none");
      setText(promptText, prompt.text);
      promptEl.classList.toggle("warn", prompt.warn);
      promptEl.classList.toggle("bar", prompt.bar !== null);
      css(promptBar, "width", `${Math.round(Math.min(1, prompt.bar ?? 0) * 200) / 2}%`);
    }
    keypadEl.classList.toggle("shown", !!keypad);
    if (keypad) {
      digitEls.forEach((d, i) => setText(d, keypad!.input[i] ?? ""));
      keypadEl.classList.toggle("wrong", keypad.flash > 0 && !keypad.ok);
      keypadEl.classList.toggle("ok", keypad.ok);
    }
    for (const a of arcs) {
      css(a.node, "opacity", op(a.life));
      if (a.life > 0) css(a.node, "transform", `translate(-50%, -50%) rotate(${a.angle.toFixed(2)}rad)`);
    }
    css(healthBar, "width", `${Math.round((Math.max(0, player.health) / maxHealth) * 100)}%`);
    healthBar.classList.toggle("low", player.health <= maxHealth * 0.35);
    setText(healthNum, String(Math.max(0, Math.ceil(player.health))));
    setText(livesEl, "●".repeat(Math.max(0, MAX_DEATHS - deaths)) + "○".repeat(Math.min(MAX_DEATHS, deaths)));
    setText(ammoNum, player.reloading > 0 ? "··" : String(player.ammo));
    setText(ammoNote, player.reloading > 0 ? "Reloading" : player.ammo === 0 ? "R to reload" : `/ ${MAG}`);
    css(hurtEl, "opacity", op(player.hurt / 0.4));
    alarmGlow.classList.toggle("shown", (alarm || finale > 0) && phase === "play");
    css(hitEl, "opacity", op(hitmark / 0.18));
    hitEl.classList.toggle("kill", hitKind === "kill");
    hitEl.classList.toggle("head", hitKind === "head");
    css(headshotEl, "opacity", op(headshotFlash / 0.3));
    css(headshotEl, "transform", `translateX(-50%) scale(${(1 + Math.max(0, headshotFlash - HEADSHOT_SECONDS + 0.15) * 3).toFixed(2)})`);
    introEl.classList.toggle("shown", phase === "intro" || phase === "menu");
    introEl.classList.toggle("typing", phase === "intro");
    introLines.forEach((p, i) => setText(p, i < introLine ? INTRO[i] : i === introLine ? (INTRO[i] ?? "").slice(0, Math.floor(introChars)) : ""));
    downEl.classList.toggle("shown", downT > 0 || failT > 0 || restarting);
    if (import.meta.env.DEV && testBadge) css(testBadge, "display", testUsed ? "" : "none");
    startEl.classList.toggle("shown", phase === "menu");
    diffButtons.forEach((b, i) => b.classList.toggle("on", i === difficulty));
    pausedEl.classList.toggle("shown", paused());
    host.classList.toggle("locked", locked);
    fadeEl.classList.toggle("shown", phase === "roof" && roofT > ROOF_SECONDS - 0.6);
  };

  const finish = () => {
    if (lastSummary) toast.info("Raid the HQ", lastSummary);
    onExit();
  };

  let booted = false;
  let frame = 0;
  let last = performance.now();
  let clock = 0;
  // Resolution follows the frame rate: down a step when frames run long, back up when there is room.
  const maxRatio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
  let ratio = maxRatio;
  let perfTime = 0;
  let perfFrames = 0;
  let roomy = 0;
  let showFps = false;
  const fpsEl = el(".raid-fps");
  const loop = (now: number) => {
    const raw = (now - last) / 1000;
    const dt = Math.min(raw, 0.1);
    last = now;
    clock += dt;
    step(dt);
    draw(dt, clock);
    perfTime += raw;
    perfFrames++;
    if (perfTime >= 1) {
      const avg = perfTime / perfFrames;
      const settled = phase === "play" && !loading && !ride && !paused(); // loading hitches are not the GPU
      if (!settled) roomy = 0;
      else if (avg > 1 / 48 && ratio > 0.75) {
        ratio = Math.max(0.75, ratio - 0.125);
        renderer.setPixelRatio(ratio);
        roomy = 0;
      } else if (avg < 1 / 57 && ratio < maxRatio) {
        if (++roomy >= 3) {
          ratio = Math.min(maxRatio, ratio + 0.125);
          renderer.setPixelRatio(ratio);
          roomy = 0;
        }
      } else roomy = 0;
      if (showFps) setText(fpsEl, `${Math.round(perfFrames / perfTime)} fps · ${(avg * 1000).toFixed(1)} ms · ${renderer.info.render.calls} draws · ${LIGHT_POOL + 1} lights · ${ratio.toFixed(2)}x`);
      perfTime = 0;
      perfFrames = 0;
    }
    frame = requestAnimationFrame(loop);
  };
  /** Loading with real stages: textures, the first floor, the lighting and shaders; then the loop starts. */
  const boot = async () => {
    report("Drawing textures", 0.2, 0);
    let t0 = performance.now();
    for (let i = 0; i < texJobs.length; i++) {
      texJobs[i]();
      if (performance.now() - t0 > SLICE_MS) {
        report("Drawing textures", 0.2 + (0.1 * (i + 1)) / texJobs.length, 0);
        await nextFrame();
        if (disposed) throw ABORT;
        t0 = performance.now();
      }
    }
    await drive(floorSteps(0, true), (label, f) => report(label, 0.3 + 0.45 * f, f));
    report("Preparing lights and materials", 0.76, 1);
    await nextFrame();
    if (disposed) throw ABORT;
    envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envMap;
    await nextFrame();
    if (disposed) throw ABORT;
    const probe = new THREE.Group();
    for (const m of Object.values(mats)) for (const one of Array.isArray(m) ? m : [m]) probe.add(new THREE.Mesh(box(0.1, 0.1, 0.1), one));
    await compileStaged((f) => report("Preparing lights and materials", 0.78 + 0.2 * f, 1), [city, pistol.node, ...probe.children]);
    swapIn();
    report("Ready", 1, 1);
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (disposed) throw ABORT;
    booted = true;
    last = performance.now();
    frame = requestAnimationFrame(loop);
    onReady();
  };
  boot().catch((e: unknown) => {
    if (e !== ABORT) onError(e instanceof Error ? e : new Error(String(e)));
  });

  // ---- the controls ----
  const canvas = renderer.domElement;
  const lock = () => {
    const request = canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
    request?.catch?.(() => {});
  };
  const submitCode = () => {
    if (!keypad || keypad.input.length < 4) return;
    const k = keypad;
    if (k.input === k.door.code) {
      k.ok = true;
      k.door.open = true;
      k.door.known = true;
      flowFrom = -1;
      sound.done();
      showBanner("Door open");
      setTimeout(() => {
        if (keypad === k) keypad = null;
      }, 350);
    } else {
      k.flash = 0.5;
      k.door.wrong++;
      sound.empty();
      k.input = "";
      if (k.door.wrong % 3 === 0) {
        keypad = null;
        raiseAlarm("Three wrong codes.");
      }
    }
  };
  /** Dev builds only: skip floors, finish objectives, god mode. */
  const testKey = (e: KeyboardEvent) => {
    if (!import.meta.env.DEV || phase !== "play" || loading || ride) return false;
    if (e.code === "F9") {
      const to = e.shiftKey ? Math.max(0, floorIndex - 1) : Math.min(LAST, floorIndex + 1);
      testUsed = true;
      keypad = null;
      loadFloor(to, true).then(() => radio(ARRIVE[to]), swallow);
    } else if (e.code === "F10") {
      testUsed = true;
      if (floorIndex === 0) for (const st of stations) if (st.kind === "T" && !st.done) completeStation(st);
      if (floorIndex === 1 || floorIndex === 3) {
        run = null;
        backupT = 0;
        if (boss && boss.dying === 0) {
          boss.health = 0;
          boss.dying = 0.6;
        }
        unlockFloor("Test: objective done");
      }
      if (floorIndex === 2) for (const st of stations) if (st.kind === "F" && !st.done) completeStation(st);
      if (floorIndex === LAST) {
        hasKey = keyDoorOpen = true;
        flowFrom = -1;
        if (keycardNode) stow(keycardNode);
        if (keycardSpot) keycardSpot.intensity = keycardSpot.base = 0;
        if (keyDoorNode) keyDoorNode.visible = false;
        if (finale <= 0) startFinale();
      }
    } else if (e.code === "F11") {
      testUsed = true;
      god = !god;
      showBanner(god ? "Test: god mode on" : "Test: god mode off");
    } else return false;
    e.preventDefault();
    return true;
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!booted) {
      if (e.code === "Escape") onExit();
      return;
    }
    if (import.meta.env.DEV && testKey(e)) return;
    if (e.code === "Escape") {
      // While the mouse is held the browser releases it on Esc (and the game pauses); a second Esc leaves.
      if (keypad) keypad = null;
      if (!locked) {
        if (phase === "results") finish();
        else onExit();
      }
      return;
    }
    if (e.code === "F8" && !e.repeat) {
      showFps = !showFps;
      fpsEl.classList.toggle("shown", showFps);
      setText(fpsEl, "… fps");
      e.preventDefault();
      return;
    }
    if (e.code === "KeyM" && !e.repeat) {
      muted = !muted;
      sound.setMuted(muted);
    }
    if (phase === "menu") {
      if (e.code === "Digit1" || e.code === "Digit2" || e.code === "Digit3") difficulty = Number(e.code.slice(-1)) - 1;
      if (e.code === "Enter") beginIntro();
      return;
    }
    if (phase === "intro") {
      if (["KeyE", "Enter", "Space"].includes(e.code)) skipIntro();
      if (e.code === "Space") e.preventDefault();
      return;
    }
    if (phase === "results") {
      if (e.code === "Enter") finish();
      return;
    }
    if (keypad) {
      e.preventDefault();
      const digit = /^(Digit|Numpad)(\d)$/.exec(e.code);
      if (digit && keypad.input.length < 4 && !keypad.ok) {
        keypad.input += digit[2];
        sound.progressTick();
        if (keypad.input.length === 4) setTimeout(submitCode, 220);
      } else if (e.code === "Backspace") keypad.input = keypad.input.slice(0, -1);
      else if (e.code === "Enter" || e.code === "NumpadEnter") submitCode();
      else if (e.code === "KeyE" && !e.repeat) keypad = null;
      return;
    }
    if (e.code === "KeyR") reload();
    if (e.code === "KeyE" && !e.repeat) ePressed = true;
    if (e.code === "Space" && !e.repeat && phase === "play" && !ride && player.z === 0 && player.vz === 0 && downT <= 0) {
      player.vz = JUMP_SPEED;
      player.z = 0.0001;
    }
    keys.add(e.code);
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  const onPointerDown = (e: PointerEvent) => {
    const target = e.target as HTMLElement;
    if (!booted || target.closest("select, label")) return;
    const diffButton = target.closest<HTMLElement>("[data-diff]");
    if (diffButton) {
      if (phase === "menu") difficulty = Number(diffButton.dataset.diff);
      return;
    }
    if (target.closest("[data-leave]")) {
      finish();
      return;
    }
    if (e.button !== 0) return;
    if (phase === "menu") {
      if (target.closest("[data-start]")) beginIntro();
      return;
    }
    if (phase === "results") return;
    if (!locked) {
      lock();
      return;
    }
    if (phase === "intro") skipIntro();
    else if (phase === "play") shoot();
  };
  const onMouseMove = (e: MouseEvent) => {
    if (!locked || phase !== "play" || ride?.phase === "moving" || keypad) return;
    player.yaw += e.movementX * MOUSE_TURN;
    player.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, player.pitch - e.movementY * MOUSE_TURN));
  };
  const onLockChange = () => {
    locked = document.pointerLockElement === canvas;
    if (locked) everLocked = true;
    else {
      keys.clear();
      keypad = null;
    }
  };
  const onBlur = () => keys.clear();
  const onResize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", onResize);
  host.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("pointerlockchange", onLockChange);
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    document.documentElement.classList.remove("playing-game");
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("resize", onResize);
    host.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("pointerlockchange", onLockChange);
    sound.dispose();
    if (heli) heli.dispose();
    scene.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) o.dispose();
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
      }
    });
    for (const d of perFloorDisposables.splice(0)) d.dispose();
    for (const g of geoCache.values()) g.dispose();
    for (const g of Object.values(shapes)) g.dispose();
    for (const m of Object.values(mats)) for (const one of Array.isArray(m) ? m : [m]) one.dispose();
    for (const t of tex.all) t.dispose();
    tracerMat.dispose();
    myTracerMat.dispose();
    envMap?.dispose();
    pmrem.dispose();
    renderer.dispose();
    canvas.remove();
    hud.innerHTML = "";
  };
}

export function RaidGame({ onExit }: { onExit(): void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [boot, setBoot] = useState({ progress: 0.2, step: "Starting the engine", built: 0 });
  const [failure, setFailure] = useState<Error | null>(null);
  // A failure while building (no WebGL, say) goes to the error boundary around the game.
  if (failure) throw failure;

  useEffect(() => {
    const host = hostRef.current;
    const hud = hudRef.current;
    if (!host || !hud) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    let shown = { step: "", progress: 0 };
    const report = (step: string, progress: number, built: number) => {
      if (cancelled || (step === shown.step && progress - shown.progress < 0.01 && progress < 1)) return;
      shown = { step, progress };
      setBoot((b) => ({ step, progress: Math.max(b.progress, progress), built: Math.max(b.built, built) }));
    };
    // Start after the loading screen has painted.
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      try {
        stop = runRaid(host, hud, onExit, report, () => !cancelled && setReady(true), (e) => !cancelled && setFailure(e));
      } catch (e) {
        setFailure(e instanceof Error ? e : new Error(String(e)));
      }
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stop?.();
    };
  }, [onExit]);

  return (
    <div ref={hostRef} className={ready ? "raid-game" : "raid-game raid-loading"} aria-label="Raid the headquarters: a hidden game. Press Escape to leave.">
      <div ref={hudRef} className="raid-hud" />
      {!ready && <RaidLoadingScreen progress={boot.progress} step={boot.step} plan={FLOORS[0]} built={boot.built} />}
    </div>
  );
}
