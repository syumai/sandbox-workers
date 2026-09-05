# REPL mode only: "our" variables survive from one run to the next in
# the same session, so this keeps counting instead of resetting to 1.
our $runs;
$runs = ($runs // 0) + 1;
sub describe { return "This session has run $runs time(s)."; }
# Run again to see the counter increase
describe();
