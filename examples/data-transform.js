const orders = input?.orders ?? [
  { category: "Books", total: 24 },
  { category: "Tools", total: 80 },
  { category: "Books", total: 16 },
];
const totals = orders.reduce((acc, { category, total }) => {
  acc[category] = (acc[category] ?? 0) + total;
  return acc;
}, Object.create(null));
console.log(totals);
return Object.entries(totals).map(([category, total]) => ({ category, total }));
