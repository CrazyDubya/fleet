// THE RECESS BELL — end-of-ball bonus, design doc §4.4:
//   (playtime x 10 000 + shots x 5 000 + modes x 250 000) x bonusX
// `modes` (completed-this-ball mode count) has no source until T7 wires mode tracking
// through rules/game.js; it defaults to 0 here so T7 only has to supply a number, not
// touch this formula. Pure function — no clock reads; `playtimeS` is computed by the
// caller from tick-stamped launch/end times, never read from the wall clock in here.
export function computeBonus({ playtimeS, shots, modes = 0, bonusX = 1 }) {
  const raw = playtimeS * 10000 + shots * 5000 + modes * 250000;
  return Math.round(raw * bonusX);
}
