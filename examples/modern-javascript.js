class Counter {
  #value = 0;
  increment() {
    return ++this.#value;
  }
}
const counter = new Counter();
const values = await Promise.all([1, 2, 3].map(async (n) => n ** 2));
console.log("Private fields:", counter.increment());
console.log(
  "Named captures:",
  /(?<year>\d{4})-(?<month>\d{2})/.exec("2026-09").groups,
);
({ values, bigint: 2n ** 64n, unique: [...new Set([1, 1, 2, 3])] });
