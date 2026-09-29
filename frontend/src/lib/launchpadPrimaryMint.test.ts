import { beforeEach, describe, expect, it, vi } from "vitest"
import { queryEval } from "./dao/shared"
import { readActionTerms } from "./launchpadActionTerms"
import { readFixedDropStages } from "./launchpadDropStages"
import { getLaunchpadNftCollection, getLaunchpadNftToken } from "./launchpadNft"
import { buildMintFixedMsg, mintFixedRequest, primaryMintSplit, readNativeMintReadiness, validateNativeMint,
    type NativeMintReadiness } from "./launchpadPrimaryMint"

vi.mock("./dao/shared", async (original) => ({ ...(await original<typeof import("./dao/shared")>()), queryEval: vi.fn() }))
vi.mock("./launchpadActionTerms", async (original) => ({ ...(await original<typeof import("./launchpadActionTerms")>()), readActionTerms: vi.fn() }))
vi.mock("./launchpadDropStages", async (original) => ({ ...(await original<typeof import("./launchpadDropStages")>()), readFixedDropStages: vi.fn() }))
vi.mock("./launchpadNft", () => ({ getLaunchpadNftCollection: vi.fn(), getLaunchpadNftToken: vi.fn() }))

const buyer = `g1${"p".repeat(38)}`
const creator = `g1${"c".repeat(38)}`
const treasury = `g1${"t".repeat(38)}`
const now = BigInt(Math.floor(Date.now() / 1000))
const collection = { id: "C1", name: "Founders", creator, mode: "soulbound", revocable: true,
    revealed: true, minted: 1n, maxSupply: 100n } as never
const stage = { collection: "C1", index: 0, start: now - 3600n, end: now + 3600n,
    price: 1_250_000n, currency: "ugnot", supplyCap: 100n, perWallet: 2n, minted: 0n }
const terms = { lane: "drops", currency: "ugnot", version: 3n, treasury, collectionFee: 0n, primaryFeeBPS: 200n,
    currencyConfigured: true, currencyAllowed: true, paused: false, laneReady: true, actionReady: true } as const
const readiness: NativeMintReadiness = { buyer, collection, stage, terms, claimed: 0n }

describe("native primary NFT mint", () => {
    beforeEach(() => vi.resetAllMocks())

    it("reads exact eligibility and rejects expired, hidden and wallet-limited mints", async () => {
        vi.mocked(getLaunchpadNftCollection).mockResolvedValue(collection)
        vi.mocked(readFixedDropStages).mockResolvedValue([stage])
        vi.mocked(readActionTerms).mockResolvedValue(terms)
        vi.mocked(queryEval).mockResolvedValue("(0 int64)")
        await expect(readNativeMintReadiness("rpc", "C1", 0, buyer)).resolves.toEqual(readiness)
        expect(queryEval).toHaveBeenCalledWith("rpc", "gno.land/r/samcrew/launchpad/drops/v1",
            `ClaimedInStage("C1", 0, "${buyer}")`, true)
        expect(() => validateNativeMint({ ...readiness, claimed: 2n }, now)).toThrow("wallet limit")
        expect(() => validateNativeMint({ ...readiness, collection: { ...collection, revealed: false } }, now)).toThrow("awaiting reveal")
        expect(() => validateNativeMint(readiness, stage.end)).toThrow("closed")
    })

    it("sends one exact native price and reviews the atomic DAO and creator split", () => {
        expect(primaryMintSplit(1_250_000n, 200n)).toEqual({ protocol: 25_000n, creator: 1_225_000n })
        expect(buildMintFixedMsg(readiness, now).value).toMatchObject({ caller: buyer, send: "1250000ugnot", func: "MintFixed",
            args: ["C1", "0", "3"] })
        const request = mintFixedRequest({ readiness, rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 50000 })
        expect(request.title).toBe("Claim Soulbound NFT")
        expect(request.lines(undefined)).toContainEqual(["DAO primary fee", "0.025 GNOT (200 bps)"])
        expect(request.lines(undefined)).toContainEqual(["Creator credit", `1.225 GNOT → ${creator}`])
        expect(request.prepare(undefined).msgs[0].value.send).toBe("1250000ugnot")
    })

    it("rechecks exact chain terms and verifies the recipient owns the new token", async () => {
        vi.mocked(getLaunchpadNftCollection).mockResolvedValue(collection)
        vi.mocked(readFixedDropStages).mockResolvedValue([stage])
        vi.mocked(readActionTerms).mockResolvedValue(terms)
        vi.mocked(queryEval).mockResolvedValue("(0 int64)")
        const request = mintFixedRequest({ readiness, rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 50000 })
        await expect(request.recheck?.(undefined)).resolves.toBeUndefined()
        vi.mocked(readActionTerms).mockResolvedValueOnce({ ...terms, primaryFeeBPS: 201n })
        await expect(request.recheck?.(undefined)).rejects.toThrow("changed")
        vi.mocked(getLaunchpadNftCollection).mockResolvedValue({ ...collection, minted: 2n })
        vi.mocked(readFixedDropStages).mockResolvedValue([{ ...stage, minted: 1n }])
        vi.mocked(queryEval).mockResolvedValue("(1 int64)")
        vi.mocked(getLaunchpadNftToken).mockResolvedValue({ collection: "C1", number: 2n, owner: buyer, status: "active", soulbound: true } as never)
        await expect(request.verify?.(undefined, "hash", undefined)).resolves.toBe(true)
        vi.mocked(getLaunchpadNftToken).mockResolvedValueOnce({ collection: "C1", number: 2n, owner: creator, status: "active", soulbound: true } as never)
        await expect(request.verify?.(undefined, "hash", undefined)).resolves.toBe(false)
    })
})
