// T4 scoring mechanisms — pure data, per design doc §4.2/§4.3. Each builder returns plain
// collision/zone descriptors; no THREE, no DOM, no mutable module state (drop-target
// "dropped" state lives in src/game/mechanisms.js, which owns the shape objects returned
// here and toggles their `.active` flag at runtime).
import { Circle, Segment, Zone } from '../physics/shapes.js';
import { E_RUBBER, E_WALL, POP_BUMPER_KICK, SLINGSHOT_KICK, KICKBACK_SPEED, BALL_RADIUS } from '../physics/constants.js';
import { normalize, scale } from '../physics/vec2.js';
import {
  SW_POP_DUCK, SW_POP_HORSE, SW_POP_ROCKET,
  SW_SLING_LEFT, SW_SLING_RIGHT,
  SW_KICKBACK,
  SW_HOPSCOTCH, SW_SAND,
  SW_TREEHOUSE,
  SW_FUN,
  SW_TETHERBALL_SPIN, SW_PINWHEEL_SPIN,
  SW_MERRY_GO_ROUND,
} from './switches.js';

const POP_SKIRT_RADIUS = 0.03;

/** Spring riders — pop bumpers. §4.3: duck (-0.075,0.760), horse (-0.005,0.815), rocket (-0.100,0.860). */
export function buildPopBumpers() {
  const specs = [
    { name: 'duck', tag: SW_POP_DUCK, centre: { x: -0.075, y: 0.76 } },
    { name: 'horse', tag: SW_POP_HORSE, centre: { x: -0.005, y: 0.815 } },
    { name: 'rocket', tag: SW_POP_ROCKET, centre: { x: -0.1, y: 0.86 } },
  ];
  return specs.map((s) => {
    const shape = Circle(s.centre, POP_SKIRT_RADIUS, E_RUBBER, s.tag);
    shape.kick = POP_BUMPER_KICK;
    return { ...s, shape };
  });
}

const KICKBACK_RADIUS = 0.012;

/**
 * Left outlane kickback. recess.js's own note: "Outlanes/inlanes... are not modelled yet" — the
 * table has no separate outlane channel, only the converging apron wall (recess.js's
 * `apron-left`) standing in for "the eventual outlane/inlane split." Placed along that wall's
 * lower run (between APRON_MID and APRON_NECK, roughly (-0.205,0.12) to (-0.15,0.02)), near the
 * drain end where a real kickback sits, offset clear of the wall into the field — a judgement
 * call recorded here rather than hidden, the same way this project records every other
 * deviation from a not-yet-built piece of geometry.
 *
 * Physics-level contact is PASSIVE — no `.kick`, unlike the pop bumpers/slingshots above, which
 * fire unconditionally on every hit. A kickback's whole point is that it doesn't always fire:
 * whether a given contact launches the ball is a lit/once-per-ball decision
 * (game/mechanisms.js's tryKickback), so the physics layer only reports the contact (the tag);
 * main.js applies `kick.vel` to the ball's velocity ONLY when that decision says yes. `kick` is
 * bundled the same shape as ramps.js's `sandbox.eject` ({vel, tag}) for the same reason: one
 * ready-to-apply vector, not direction and speed left for a caller to recombine.
 */
export function buildKickback() {
  // Offset from the apron-left wall's own lower-run midpoint, along that wall's outward
  // normal, by radius + an 8mm clearance margin — checked by hand (~20mm centre-to-wall
  // distance, comfortably clear of KICKBACK_RADIUS) so the collider doesn't embed in the wall,
  // the same class of problem test/drain-sweep-mechanisms.test.mjs caught for the swing-set
  // crossbar. drain-sweep-mechanisms.test.mjs's own sweep (below) is what actually verifies
  // this rather than the hand computation alone.
  const centre = { x: -0.162, y: 0.084 };
  const dir = normalize({ x: 0.35, y: 1 }); // back up into the field, away from the drain
  return {
    centre, radius: KICKBACK_RADIUS,
    shape: Circle(centre, KICKBACK_RADIUS, E_RUBBER, SW_KICKBACK),
    kick: { vel: scale(dir, KICKBACK_SPEED), tag: SW_KICKBACK },
  };
}

/**
 * Swing-set slingshots. §4.3 gives apexes at (∓0.135, 0.175); we model each as the two
 * outer faces of a shallow kite (apex -> inlane feed, apex -> flipper pivot area) so the
 * ball can be kicked from either face, mirroring a real kite slingshot's two rubber faces.
 */
export function buildSlingshots() {
  const left = [
    Segment({ x: -0.15, y: 0.22 }, { x: -0.135, y: 0.175 }, E_RUBBER, SW_SLING_LEFT),
    Segment({ x: -0.135, y: 0.175 }, { x: -0.1, y: 0.115 }, E_RUBBER, SW_SLING_LEFT),
  ];
  const right = [
    Segment({ x: 0.15, y: 0.22 }, { x: 0.135, y: 0.175 }, E_RUBBER, SW_SLING_RIGHT),
    Segment({ x: 0.135, y: 0.175 }, { x: 0.1, y: 0.115 }, E_RUBBER, SW_SLING_RIGHT),
  ];
  for (const seg of [...left, ...right]) seg.kick = SLINGSHOT_KICK;
  return { left, right };
}

/**
 * Swing-set posts (art pass): a decorative swing-set frame flanks each slingshot, apex at
 * (∓0.135, 0.175) — the same apex the slingshot kite's own middle point sits at. Each frame
 * draws as two vertical side posts plus one horizontal top crossbar, all r 4mm cylinders.
 *
 * This game's physics is flat — collision is x,y only, z is a render-only height offset and
 * never gates it — so a collider was first added at all six cylinder positions, crossbar
 * included. That created a real dead pocket (a ball wedged between the crossbar collider and
 * its neighbouring side post — see test/drain-sweep-mechanisms.test.mjs). The crossbar is
 * physically overhead (scene y=0.09, well above BALL_RADIUS*2 — see its height-clearance
 * comment at the mesh in main.js), the same case as the TREEHOUSE roof: drawn where it
 * physically is, a ball rolls under it, no collider. Only the two SIDE posts — which span
 * table height 0 to 0.09, reaching ball height — get colliders here. Four Circle colliders,
 * r SWING_SET_POST_RADIUS, restitution E_WALL (a solid post, not rubber). Not scored: each
 * gets its own tag for future use, nothing consumes them yet.
 *
 * Single source of truth: main.js's mesh builder reads SWING_SET_APEXES for the crossbar's
 * own position and this function's data for the side posts, rather than a second literal
 * position list.
 */
export const SWING_SET_APEXES = [{ x: -0.135, y: 0.175 }, { x: 0.135, y: 0.175 }];
export const SWING_SET_POST_RADIUS = 0.004;
// dx from the apex: the two side posts (the crossbar itself, dx=0, is drawn but not a collider).
const SWING_SET_POST_DX = [-0.03, 0.03];

export function buildSwingSetPosts() {
  const posts = [];
  for (const apex of SWING_SET_APEXES) {
    const side = apex.x < 0 ? 'left' : 'right';
    for (const dx of SWING_SET_POST_DX) {
      const centre = { x: apex.x + dx, y: apex.y + 0.02 };
      const tag = `swingset_${side}_post${dx < 0 ? '1' : '2'}`;
      posts.push({ tag, centre, shape: Circle(centre, SWING_SET_POST_RADIUS, E_WALL, tag) });
    }
  }
  return posts;
}

/**
 * A row of drop targets: thin segments perpendicular to the bank's line direction, spaced
 * by `pitch` along a line through `centre` angled at `angleDeg` (0 = vertical row, i.e.
 * targets stacked along +y; §4.3's "pitch 0.028, line angled +15°" reads as the row axis
 * rotated 15° from vertical).
 */
function buildTargetRow(id, tags, centre, pitch, angleDeg, targetWidth = 0.018) {
  const rad = (angleDeg * Math.PI) / 180;
  const axis = { x: Math.sin(rad), y: Math.cos(rad) }; // row direction
  const perp = { x: Math.cos(rad), y: -Math.sin(rad) }; // target face direction
  const n = tags.length;
  const start = -(n - 1) / 2;
  const targets = tags.map((tag, i) => {
    const off = (start + i) * pitch;
    const cx = centre.x + axis.x * off;
    const cy = centre.y + axis.y * off;
    const a = { x: cx - perp.x * targetWidth, y: cy - perp.y * targetWidth };
    const b = { x: cx + perp.x * targetWidth, y: cy + perp.y * targetWidth };
    const shape = Segment(a, b, 0.25, tag);
    return { tag, shape, centre: { x: cx, y: cy } };
  });
  return { id, targets };
}

/** HOPSCOTCH 1-2-3-4 bank. §4.3: centred (0.055, 0.640), pitch 0.028, angled +15°. */
export function buildHopscotchBank() {
  return buildTargetRow('hopscotch', SW_HOPSCOTCH, { x: 0.055, y: 0.64 }, 0.028, 15);
}

/**
 * S-A-N-D bank. §4.3: centred (0.175, 0.560), near-vertical. Built as 4 targets (S,A,N,D)
 * — see the deviation note in table/switches.js.
 */
export function buildSandBank() {
  return buildTargetRow('sand', SW_SAND, { x: 0.175, y: 0.56 }, 0.026, 3);
}

/** TREEHOUSE standup. §4.3: (0.010, 0.965). A fixed post — hit registers, never drops. */
export function buildTreehouseStandup() {
  return { tag: SW_TREEHOUSE, shape: Circle({ x: 0.01, y: 0.965 }, 0.012, 0.3, SW_TREEHOUSE) };
}

/**
 * F-U-N top rollover lanes. §4.3: y ≈ 0.985 at x = -0.06, 0.00, +0.06. Each lane is a short
 * crossing zone spanning the lane's width so a ball rolling through registers exactly once.
 */
export function buildFunLanes() {
  const y = 0.985;
  const xs = [-0.06, 0.0, 0.06];
  const halfWidth = 0.018;
  return xs.map((x, i) => ({
    tag: SW_FUN[i],
    zone: Zone({ x: x - halfWidth, y }, { x: x + halfWidth, y }, SW_FUN[i]),
  }));
}

/**
 * TETHERBALL (left orbit lane, x≈-0.170, y 0.30→0.46) and PINWHEEL (at the SLIDE mouth,
 * ~(-0.060, 0.430)) spinners. Modelled as short crossing zones the ball passes through
 * repeatedly as it rolls up/down the lane; each crossing is one "click"/revolution.
 *
 * Physics follows art here — the one mismatch tonight resolved that direction, because the
 * visible blade IS the physical spinner: a ball clipping the blade's edge should register a
 * spin. Both zones previously spanned less than their shared 50mm blade mesh (16mm/30mm) —
 * SPINNER_BLADE_LENGTH is the one shared constant both the zone span here and the blade mesh
 * in main.js read, so they can't drift apart again. Centred at each spinner's original
 * midpoint — only the span changed, not the position.
 */
export const SPINNER_BLADE_LENGTH = 0.05;

function spinnerZone(centre, tag) {
  const half = SPINNER_BLADE_LENGTH / 2;
  return Zone({ x: centre.x - half, y: centre.y }, { x: centre.x + half, y: centre.y }, tag);
}

export function buildSpinners() {
  const tetherball = spinnerZone({ x: -0.17, y: 0.38 }, SW_TETHERBALL_SPIN);
  const pinwheel = spinnerZone({ x: -0.06, y: 0.43 }, SW_PINWHEEL_SPIN);
  return { tetherball, pinwheel };
}

/**
 * MERRY-GO-ROUND lock (T8). §4.3: centre (0.010, 0.900), r 0.075, fed from the top orbit
 * (THE TUNNEL). Modelled as a capture zone, same pattern as the SANDBOX scoop — the ball
 * always physically settles into it on entry; rules/multiball.js decides afterwards whether
 * that's a genuine lock, a re-lock jackpot escalator, or an unlit pass-through that gets
 * kicked straight back out (world.js's checkCaptures doesn't gate on game state, deliberately
 * matching the SANDBOX scoop's existing shape rather than adding a second capture pattern).
 *
 * Geometry deviation, recorded: §4.3's tunnel exit (table/ramps.js's buildTunnelRamp,
 * frozen by T5/T5b) dumps at SPRING_RIDER_FEED (-0.050, 0.780) heading down-left into the
 * spring riders, not directly at (0.010, 0.900) — reworking a T5 ramp exit is out of this
 * task's scope. The merry-go-round sits just past the spring riders on the natural rebound
 * line up toward TREEHOUSE, so "fed from the top orbit" reads as "reachable off a tunnel
 * shot", not "the tunnel's exit point is inside it" — the same kind of deviation T4/T5
 * recorded for the lane-inner clip and the tunnel gate placement.
 */
export function buildMerryGoRound() {
  const centre = { x: 0.01, y: 0.9 };
  const radius = 0.075;
  return { centre, radius, captureZone: { centre, radius, tag: SW_MERRY_GO_ROUND } };
}

// Design doc's own preferred release heading — down/in toward the main field, away from the
// spring-rider cluster it was originally (wrongly) never checked against. Kept as the
// starting point so an unobstructed table still gets the intended-looking release.
const MGR_RELEASE_PREFERRED_HEADING = normalize({ x: -0.15, y: -1 });

// Minimum clearance a computeEjectPlacement landing point must keep past every obstacle's
// (and its own zone's) radius+ball-radius boundary, on top of `margin`. 5mm is comfortably
// larger than the sweep's own 1-degree angular step at these radii — small enough that a
// tighter number couldn't move the chosen heading by more than a fraction of a degree, large
// enough that a real layout nudge can't quietly eat it. Without a named floor here, a
// landing point that grazes a skirt by half a millimetre (as the first version of this sweep
// did against the horse bumper) reads as "clears" just as validly as one with centimetres to
// spare — the property can't tell "fixed" from "barely not broken".
export const SAFETY_M = 0.005;

/**
 * Where a ball leaves a capture zone under its own power — a merry-go-round release/eject, a
 * SANDBOX add-a-ball, or any future mechanism with the same shape of problem. Derived from
 * the zone's own geometry and the surrounding table layout instead of a hardcoded heading, so
 * a future mechanism-layout change can't silently reintroduce a ball landing back inside its
 * own zone or another mechanism's collision skirt.
 *
 * This exists because of a real bug: the merry-go-round's original hardcoded (-0.15, -1)
 * release heading was chosen only to clear its own capture radius (an arbitrary 1.05x
 * margin) and was never checked against anything else. It landed 7.85mm inside the horse
 * spring-rider's 30mm skirt — every release/relock ball spawned already overlapping the pop
 * bumper, which re-kicked it back into the merry-go-round's capture zone, which re-doubled an
 * uncapped jackpot, forever (500,000 -> 1.757e+165 in ~5s, confirmed live). A second instance
 * of the same class of bug was found in the SANDBOX add-a-ball spawn, which placed the ball at
 * literally its own capture zone's centre (0.00000m clearance) — re-captured on the very next
 * physics step, discarding the launch and orphaning whatever ball the scoop was already
 * holding. See the 2026-09-01 and 2026-09-04 handoffs for the full traces.
 *
 * `zone` is `{ centre, radius }` — the capture zone the ball is leaving; the landing point
 * must clear this too, not just the obstacles list, so the zone doesn't immediately
 * re-capture its own ejected ball. `preferredHeading` is the design's intended direction
 * (any nonzero vector — normalized internally). `obstacles` is every other circular
 * mechanism skirt the landing point must clear — `{ centre, radius }` pairs. `margin` on top
 * of each radius accounts for the ball's own footprint (defaults to BALL_RADIUS); `safety` is
 * an additional flat clearance floor on top of that (defaults to SAFETY_M).
 *
 * Starts from the preferred heading; if that lands inside some obstacle's (or the zone's own)
 * radius+margin+safety, sweeps outward from it in 1-degree steps (alternating either side) to
 * the nearest heading that clears everything. Throws if literally nothing within 180 degrees
 * clears — that would mean the zone is boxed in by the layout itself, a table-design problem
 * no placement heading can paper over.
 */
export function computeEjectPlacement(zone, preferredHeading, obstacles, { margin = BALL_RADIUS, safety = SAFETY_M } = {}) {
  const preferred = normalize(preferredHeading);
  const clear = zone.radius + margin + safety;
  const landingFor = (heading) => ({
    x: zone.centre.x + heading.x * clear,
    y: zone.centre.y + heading.y * clear,
  });
  const clearsAll = (heading) => {
    const p = landingFor(heading);
    return obstacles.every((o) => Math.hypot(p.x - o.centre.x, p.y - o.centre.y) >= o.radius + margin + safety);
  };

  if (clearsAll(preferred)) return { heading: preferred, pos: landingFor(preferred) };

  const baseAngle = Math.atan2(preferred.y, preferred.x);
  for (let deg = 1; deg <= 180; deg++) {
    for (const sign of [1, -1]) {
      const angle = baseAngle + (sign * deg * Math.PI) / 180;
      const heading = { x: Math.cos(angle), y: Math.sin(angle) };
      if (clearsAll(heading)) return { heading, pos: landingFor(heading) };
    }
  }
  throw new Error('computeEjectPlacement: no heading within 180 degrees clears every obstacle with the required safety margin');
}

/** Thin wrapper kept for the merry-go-round's own call sites/tests: its zone is itself
 * (`{ centre, radius }`, already the shape buildMerryGoRound returns at the top level) and
 * its preferred heading is the design doc's release direction. */
export function computeMergeGoRoundRelease(mgr, obstacles, opts) {
  return computeEjectPlacement({ centre: mgr.centre, radius: mgr.radius }, MGR_RELEASE_PREFERRED_HEADING, obstacles, opts);
}

/**
 * Every real ejection site in the current table layout, each with its landing point already
 * computed via computeEjectPlacement — the registry test/mechanisms.test.mjs's ejection-site
 * property runs over, so a future mechanism added here is covered with no new test. Takes
 * `sandbox` (from table/ramps.js's buildSandbox — mechanisms.js doesn't import ramps.js to
 * avoid a layer that doesn't need it depending on one that does; callers already have both).
 */
export function buildEjectionSites(sandbox) {
  const popBumpers = buildPopBumpers();
  const treehouse = buildTreehouseStandup();
  const merryGoRound = buildMerryGoRound();

  const bumperObstacles = popBumpers.map((b) => ({ centre: b.centre, radius: b.shape.radius }));
  const treehouseObstacle = { centre: treehouse.shape.centre, radius: treehouse.shape.radius };
  const sandboxObstacle = { centre: sandbox.captureZone.centre, radius: sandbox.captureZone.radius };
  const mgrObstacle = { centre: merryGoRound.centre, radius: merryGoRound.radius };

  const sites = [
    {
      name: 'merry_go_round_release',
      zone: { centre: merryGoRound.centre, radius: merryGoRound.radius },
      preferredHeading: MGR_RELEASE_PREFERRED_HEADING,
      obstacles: [...bumperObstacles, treehouseObstacle, sandboxObstacle],
    },
    {
      name: 'sandbox_add_a_ball',
      zone: { centre: sandbox.captureZone.centre, radius: sandbox.captureZone.radius },
      preferredHeading: sandbox.eject.vel,
      obstacles: [...bumperObstacles, treehouseObstacle, mgrObstacle],
    },
  ];

  return sites.map((s) => ({ ...s, placement: computeEjectPlacement(s.zone, s.preferredHeading, s.obstacles) }));
}
