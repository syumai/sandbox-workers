const name = process.env.NAME ?? "world";
console.log(`Hello, ${name}!`);
({
  greeting: `Hello, ${name}!`,
  engine: "SpiderMonkey inside WebAssembly",
});
