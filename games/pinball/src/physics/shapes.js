// Collision primitives — plain data, no behaviour. See design doc §2.3.

// `oneWay`, when set, is { allow: {x,y}, threshold }: the segment is skipped entirely
// (ball passes through) when the ball's velocity along `allow` exceeds `threshold` —
// modelling a one-way gate flap (e.g. the launch-lane entry).
export function Segment(a, b, restitution = 0.45, tag = 'wall', padding = 0, oneWay = null) {
  return { kind: 'segment', a, b, restitution, tag, padding, oneWay };
}

export function Arc(centre, radius, a0, a1, restitution = 0.45, tag = 'arc', padding = 0) {
  // a0, a1 in radians, a0 -> a1 sweeping counter-clockwise (standard atan2 convention).
  return { kind: 'arc', centre, radius, a0, a1, restitution, tag, padding };
}

export function Circle(centre, radius, restitution = 0.45, tag = 'post', padding = 0) {
  return { kind: 'circle', centre, radius, restitution, tag, padding };
}

// Non-blocking trigger: the ball passes straight through. Detected as a crossing of the
// segment a->b between a ball's position at the start and end of a physics substep (see
// world.js `checkZoneCrossings`) — not a collision primitive, never touched by earliestImpact.
export function Zone(a, b, tag = 'zone') {
  return { kind: 'zone', a, b, tag };
}
