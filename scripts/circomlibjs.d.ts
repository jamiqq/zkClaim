declare module "circomlibjs" {
  export type Poseidon = ((inputs: readonly bigint[]) => unknown) & {
    F: {
      toObject(value: unknown): { toString(): string };
    };
  };

  export function buildPoseidon(): Promise<Poseidon>;
}
