# zkClaim web app

React + Vite front end: Register, Claim, Explorer and Admin pages, all against devnet.

```
cp .env.example .env.local     # set VITE_RPC_URL (Helius devnet)
yarn
yarn dev                       # http://localhost:5173
```

- Claims go through the relayer (`../relayer`, port 8787); Vite proxies `/relayer` to it.
- Proofs are generated in the browser from `public/zk/zkclaim.wasm` and `public/zk/zkclaim_final.zkey`.
- The active campaign comes from `?campaign=<id>` (or the switcher in the header); default is the demo campaign.
