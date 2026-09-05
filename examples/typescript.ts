interface Greeting {
  message: string;
  loud: boolean;
}

enum Volume {
  Quiet,
  Loud,
}

function shout<T extends string>(text: T, volume: Volume): string {
  return volume === Volume.Loud ? text.toUpperCase() : text;
}

const name = (process.env.NAME ?? "world") as string;
const volume = Volume.Loud satisfies Volume;
const greeting: Greeting = {
  message: shout(`Hello, ${name}!`, volume),
  loud: volume === Volume.Loud,
};

greeting;
