const locale = process.env.LOCALE ?? "ja-JP";
const amount = Number(process.env.AMOUNT ?? 1234567.891);
const words = (process.env.WORDS ?? "Zürich,Ångström,Åland,apple").split(",");

const currency = new Intl.NumberFormat(locale, {
  style: "currency",
  currency: process.env.CURRENCY ?? "JPY",
}).format(amount);
console.log(`Formatted ${amount} as`, currency);

const date = new Intl.DateTimeFormat(locale, {
  dateStyle: "long",
  timeStyle: "short",
}).format(new Date(Date.UTC(2026, 8, 5, 9, 30)));

const collator = new Intl.Collator(locale);
const sorted = [...words].sort(collator.compare);
console.log("Collated order:", sorted.join(", "));

({ locale, currency, date, sorted });
