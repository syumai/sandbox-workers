# Session mode only: top-level state survives from one run to the next in
# the same session, so this keeps counting instead of resetting to 1.
runs = globals().get("runs", 0) + 1


def describe():
    return f"This session has run {runs} time(s)."


# Run again to see the counter increase
describe()
