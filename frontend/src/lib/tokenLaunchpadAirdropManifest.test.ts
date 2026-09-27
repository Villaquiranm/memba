import { describe, expect, it } from "vitest"
import { derivePkgBech32Addr } from "./dao/realmAddress"
import { prepareAirdropManifest, verifyAirdropManifest } from "./tokenLaunchpadAirdropManifest"

const A = "g1x7k4628w93a7wzdhqc06atzx0v50rnshweuxu0"
const B = "g1q2euyngkmee5jzasmczftpxqpna9fv8u0ejz0z"
const ROOT_TWO = "73ddbe812e0750ff9bba132e016c012ad8d7d4d8500c83c7d79785c70aa85a18"
const PROOF_ZERO = "ca5f7f9389073ef13eb39a0d32fa93b80fec82869700c8796c2209807af05dba"
const PROOF_ONE = "fba635a8ae40a1148255d48c10c24864cb5940535ea559d1c4d8930c0ee1a918"

const twoEntries = [
    { index: 0, beneficiary: A, amount: "15" },
    { index: 1, beneficiary: B, amount: "20" },
]

describe("Launchpad airdrop manifest", () => {
    it("matches the Gno sorted-pair SHA-256 commitment and proof grammar", () => {
        // Constants use the Gno p/merkle/v1 vector algorithm, independently
        // checked against its alpha/bravo/charlie root before this fixture.
        const manifest = prepareAirdropManifest("T7", "40", [twoEntries[1], twoEntries[0]])
        expect(manifest).toEqual({
            tokenId: "T7", root: ROOT_TWO, fundedTotal: "40", allocatedTotal: "35",
            unallocated: "5", claims: [
                { ...twoEntries[0], proof: PROOF_ZERO },
                { ...twoEntries[1], proof: PROOF_ONE },
            ],
        })
        expect(verifyAirdropManifest(manifest, { tokenId: "T7", root: ROOT_TWO, total: "40" })).toEqual(manifest)
    })

    it("promotes an odd leaf unchanged and emits an empty proof for one leaf", () => {
        const three = prepareAirdropManifest("T7", "40", [...twoEntries, { index: 2, beneficiary: A, amount: "5" }])
        expect(three.root).toBe("3b11c9702119e7f7c065fead69baffed1621268696d73709f949a8cef081f46e")
        expect(three.claims[2].proof).toBe(ROOT_TWO)
        const one = prepareAirdropManifest("T7", "15", [twoEntries[0]])
        expect(one.claims[0].proof).toBe("")
        expect(one.unallocated).toBe("0")
    })

    it("keeps MaxInt64 allocations exact without Number conversion", () => {
        const max = "9223372036854775807"
        const manifest = prepareAirdropManifest("T7", max, [{ index: 0, beneficiary: A, amount: max }])
        expect(manifest.allocatedTotal).toBe(max)
        expect(manifest.unallocated).toBe("0")
        expect(manifest.claims[0].amount).toBe(max)
    })

    it("rejects invalid identities, indices, recipients and amounts before hashing", async () => {
        const sales = await derivePkgBech32Addr("gno.land/r/samcrew/launchpad/sales/v1")
        expect(() => prepareAirdropManifest("T0", "40", twoEntries)).toThrow("token ID")
        expect(() => prepareAirdropManifest("T7", "0", twoEntries)).toThrow("positive int64")
        expect(() => prepareAirdropManifest("T7", "40", [])).toThrow("entry count")
        expect(() => prepareAirdropManifest("T7", "40", [twoEntries[0], twoEntries[0]])).toThrow("indices")
        expect(() => prepareAirdropManifest("T7", "40", [twoEntries[1]])).toThrow("indices")
        expect(() => prepareAirdropManifest("T7", "40", [{ ...twoEntries[0], beneficiary: `${A.slice(0, -1)}q` }])).toThrow("beneficiary")
        expect(() => prepareAirdropManifest("T7", "40", [{ ...twoEntries[0], beneficiary: sales }])).toThrow("beneficiary")
        expect(() => prepareAirdropManifest("T7", "40", [{ ...twoEntries[0], amount: "015" }])).toThrow("canonical decimal")
        expect(() => prepareAirdropManifest("T7", "40", [{ ...twoEntries[0], amount: "9".repeat(100_000) }])).toThrow("canonical decimal")
        expect(() => prepareAirdropManifest("T7", "40", [{ ...twoEntries[0], amount: "9223372036854775808" }])).toThrow("int64")
        expect(() => prepareAirdropManifest("T7", "34", twoEntries)).toThrow("exceed funded")
    })

    it("rejects published manifests that differ from chain commitment or computed proofs", () => {
        const manifest = prepareAirdropManifest("T7", "40", twoEntries)
        const commitment = { tokenId: "T7", root: ROOT_TWO, total: "40" }
        expect(() => verifyAirdropManifest(manifest, { ...commitment, total: "41" })).toThrow("chain commitment")
        expect(() => verifyAirdropManifest(manifest, { ...commitment, tokenId: "T8" })).toThrow("chain commitment")
        expect(() => verifyAirdropManifest(manifest, { ...commitment, root: "0".repeat(64) })).toThrow("chain commitment")
        expect(() => verifyAirdropManifest({ ...manifest, claims: [{ ...manifest.claims[0], proof: PROOF_ONE }, manifest.claims[1]] }, commitment)).toThrow("root, totals or proofs")
    })
})
