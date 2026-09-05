const words = (process.env.WORDS ?? "Books,Tools,Books,Books,Tools").split(
  ",",
);
const counts = words.reduce((acc, word) => {
  acc[word] = (acc[word] ?? 0) + 1;
  return acc;
}, Object.create(null));
console.log(counts);
Object.entries(counts).map(([word, count]) => ({ word, count }));
