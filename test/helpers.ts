export function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve: () => resolve(),
  };
}

export function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
