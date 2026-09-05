const name = input?.name ?? "world";
console.log(`Hello, ${name}!`);
return {
  greeting: `Hello, ${name}!`,
  engine: "SpiderMonkey inside WebAssembly",
};
