// THE RECESS BELL — end-of-ball bonus, design doc §4.4:
//   (playtime x 10 000 + shots x 5 000 + modes x 250 000) x bonusX
// `modes` (completed-this-ball mode count) has no source until T7 wires mode tracking
// through rules/game.js; it defaults to 0 here so T7 only has to supply a number, not
// touch this formula. Pure function — no clock reads; `playtimeS` is computed by the
// caller from tick-stamped launch/end times, never read from the wall clock in here.
//
// HUD-BUILD: returns the three PRE-multiplier components alongside the total, not just the
// total — the end-of-ball bonus screen (main.js) shows what the bonus was MADE OF
// (haiku-fs2's HUD inventory: "rules compute a full breakdown, HUD shows nothing").
// `amount` is computed exactly as before (sum the three raw terms, THEN multiply by bonusX,
// THEN round once) — unchanged scoring, not a rebalance. The three component fields are
// each individually rounded for display only (`toLocaleString` on `shots * 5000`, an
// already-integer product, needs no rounding; `playtimeS * 10000` can carry sub-second
// fractional cents from a real elapsed-seconds timestamp) — display rounding never touches
// what actually gets added to the score.
export function computeBonus({ playtimeS, shots, modes = 0, bonusX = 1 }) {
  const playtimePoints = playtimeS * 10000;
  const shotsPoints = shots * 5000;
  const modesPoints = modes * 250000;
  const amount = Math.round((playtimePoints + shotsPoints + modesPoints) * bonusX);
  return {
    amount, bonusX,
    playtimePoints: Math.round(playtimePoints),
    shotsPoints: Math.round(shotsPoints),
    modesPoints: Math.round(modesPoints),
  };
}
