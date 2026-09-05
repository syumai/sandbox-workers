// Session mode only: top-level state survives from one run to the next in
// the same session, so this keeps counting instead of resetting to 1.
var runs = (typeof runs === "number" ? runs : 0) + 1;
function describe() {
  return `This session has run ${runs} time(s).`;
}
// Run again to see the counter increase
describe();
