// Poseidon over BN254, circomlib parameters (spec 3.2 / 3.3), via circomlibjs.
import { buildPoseidon } from 'circomlibjs'

let instance: Promise<any> | null = null
const get = () => (instance ??= buildPoseidon())

export async function poseidon(inputs: bigint[]): Promise<bigint> {
  const p = await get()
  return p.F.toObject(p(inputs)) as bigint
}
