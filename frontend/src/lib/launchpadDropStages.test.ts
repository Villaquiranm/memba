import { beforeEach, describe, expect, it, vi } from "vitest"
import { queryEval } from "./dao/shared"
import { readActionTerms } from "./launchpadActionTerms"
import { addFixedDropStageRequest, buildAddFixedDropStageMsg, parseFixedDropStages, readFixedDropStages,
    validateFixedDropStage } from "./launchpadDropStages"
import { getLaunchpadNftCollection } from "./launchpadNft"

vi.mock("./dao/shared", async (original) => ({ ...(await original<typeof import("./dao/shared")>()), queryEval: vi.fn() }))
vi.mock("./launchpadActionTerms", async (original) => ({ ...(await original<typeof import("./launchpadActionTerms")>()), readActionTerms: vi.fn() }))
vi.mock("./launchpadNft", () => ({ getLaunchpadNftCollection: vi.fn() }))

const creator = `g1${"p".repeat(38)}`
const treasury = `g1${"t".repeat(38)}`
const terms = { lane: "drops", currency: "ugnot", version: 3n, treasury, collectionFee: 40n, primaryFeeBPS: 200n,
    currencyConfigured: true, currencyAllowed: true, paused: false, laneReady: true, actionReady: true } as const
const now = BigInt(Math.floor(Date.now() / 1000))
const draft = { collection: "C1", creator, start: now + 7200n, end: now + 10800n, price: 1_250_000n,
    supplyCap: 100n, perWallet: 2n }
const rawStage = { collection: "C1", index: 0, kind: "fixed", start: draft.start.toString(), end: draft.end.toString(),
    price: draft.price.toString(), currency: "ugnot", supplyCap: "100", perWallet: "2", minted: "0" }
const qeval = (value: unknown) => `(${JSON.stringify(JSON.stringify(value))} string)`

describe("native fixed drop stages", () => {
    beforeEach(() => vi.resetAllMocks())

    it("strictly parses chain stages and rejects changed identity, overflow and overlap", async () => {
        expect(parseFixedDropStages([rawStage], "C1")).toEqual([{ collection: "C1", index: 0, start: draft.start,
            end: draft.end, price: draft.price, currency: "ugnot", supplyCap: 100n, perWallet: 2n, minted: 0n }])
        expect(() => parseFixedDropStages([{ ...rawStage, collection: "C2" }], "C1")).toThrow("identity")
        expect(() => parseFixedDropStages([{ ...rawStage, price: "01" }], "C1")).toThrow("amount")
        expect(() => parseFixedDropStages([rawStage, { ...rawStage, index: 1 }], "C1")).toThrow("Overlapping")
        vi.mocked(queryEval).mockResolvedValue(qeval([rawStage]))
        await expect(readFixedDropStages("rpc", "C1")).resolves.toHaveLength(1)
        expect(queryEval).toHaveBeenCalledWith("rpc", "gno.land/r/samcrew/launchpad/drops/v1", 'ListStagesJSON("C1")', true)
    })

    it("builds a no-payment, version-bound stage and rejects bad scheduling", () => {
        expect(buildAddFixedDropStageMsg(draft, terms, [], now).value).toMatchObject({ caller: creator, send: "",
            func: "AddFixedStage", args: ["C1", draft.start.toString(), draft.end.toString(), "1250000", "100", "2", "ugnot", "3"] })
        expect(() => validateFixedDropStage({ ...draft, perWallet: 101n }, terms, [], now)).toThrow("overlap")
        expect(() => validateFixedDropStage({ ...draft, start: now - 1n }, terms, [], now)).toThrow("overlap")
        expect(() => validateFixedDropStage(draft, { ...terms, actionReady: false }, [], now)).toThrow("unavailable")
        expect(() => validateFixedDropStage(draft, terms, parseFixedDropStages([rawStage], "C1"), now)).toThrow("overlap")
    })

    it("rechecks policy and creator authority, then verifies exactly one new stage", async () => {
        vi.mocked(readActionTerms).mockResolvedValue(terms)
        vi.mocked(getLaunchpadNftCollection).mockResolvedValue({ id: "C1", creator, maxSupply: 100n, minted: 0n } as never)
        vi.mocked(queryEval).mockResolvedValue(qeval([]))
        const request = addFixedDropStageRequest({ draft, terms, collection: { id: "C1", creator, maxSupply: 100n, minted: 0n } as never,
            stages: [], rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 50000 })
        await expect(request.recheck?.(undefined)).resolves.toBeUndefined()
        expect(request.lines(undefined)).toContainEqual(["DAO primary fee", "200 bps from the mint price"])
        vi.mocked(readActionTerms).mockResolvedValueOnce({ ...terms, primaryFeeBPS: 201n })
        await expect(request.recheck?.(undefined)).rejects.toThrow("changed")
        vi.mocked(getLaunchpadNftCollection).mockResolvedValueOnce({ id: "C1", creator, maxSupply: 99n, minted: 0n } as never)
        await expect(request.recheck?.(undefined)).rejects.toThrow("remaining supply")
        vi.mocked(queryEval).mockResolvedValue(qeval([rawStage]))
        await expect(request.verify?.(undefined, "hash", undefined)).resolves.toBe(true)
        vi.mocked(queryEval).mockResolvedValueOnce(qeval([{ ...rawStage, price: "1250001" }]))
        await expect(request.verify?.(undefined, "hash", undefined)).resolves.toBe(false)
    })
})
