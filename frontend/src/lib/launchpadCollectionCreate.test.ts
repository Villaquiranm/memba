import { beforeEach, describe, expect, it, vi } from "vitest"
import * as grc20 from "./grc20"
import { queryEval } from "./dao/shared"
import { readActionTerms } from "./launchpadActionTerms"
import { buildCreateCollectionMsg, createStaticCollectionRequest, validateStaticCollection,
    type StaticCollectionDraft } from "./launchpadCollectionCreate"
import { getLaunchpadNftCollection } from "./launchpadNft"

vi.mock("./dao/shared", async (original) => ({ ...(await original<typeof import("./dao/shared")>()), queryEval: vi.fn() }))
vi.mock("./launchpadActionTerms", async (original) => ({ ...(await original<typeof import("./launchpadActionTerms")>()), readActionTerms: vi.fn() }))
vi.mock("./launchpadNft", () => ({ getLaunchpadNftCollection: vi.fn() }))

const creator = `g1${"p".repeat(38)}`
const treasury = `g1${"t".repeat(38)}`
const draft: StaticCollectionDraft = { creator, name: "Civic Art", symbol: "CIVIC", description: "A public art edition",
    image: "ipfs://image", banner: "", website: "https://example.org", mode: "open", revocable: false,
    maxSupply: 100n, baseURI: "ipfs://collection/" }
const terms = { lane: "collection", currency: "ugnot", version: 2n, treasury, collectionFee: 40n,
    primaryFeeBPS: 100n, currencyConfigured: true, currencyAllowed: true, paused: false, laneReady: true, actionReady: true } as const

describe("static Launchpad collection creation", () => {
    beforeEach(() => vi.resetAllMocks())

    it("builds the exact native-fee drops call and discloses permanent rights", () => {
        expect(buildCreateCollectionMsg(draft, terms)).toMatchObject({ value: { caller: creator, send: "40ugnot",
            pkg_path: "gno.land/r/samcrew/launchpad/drops/v1", func: "CreateCollection",
            args: ["Civic Art", "CIVIC", "A public art edition", "ipfs://image", "", "https://example.org",
                "open", "false", "100", "ipfs://collection/", "ugnot", "2"] } })
        const soulbound = { ...draft, mode: "soulbound" as const, revocable: true }
        expect(buildCreateCollectionMsg(soulbound, terms).value.args).toContain("true")
        expect(() => validateStaticCollection({ ...draft, mode: "open", revocable: true })).toThrow("permanent")
        expect(() => validateStaticCollection({ ...draft, baseURI: "https://example.org/no-slash" })).toThrow("ending in /")
        expect(() => validateStaticCollection({ ...draft, symbol: "not-uppercase" })).toThrow("permanent")
        expect(() => buildCreateCollectionMsg(draft, { ...terms, paused: true, actionReady: false })).toThrow("unavailable")
    })

    it("rechecks DAO fee/version and confirms only the exact newly created collection", async () => {
        vi.mocked(readActionTerms).mockResolvedValue(terms)
        vi.mocked(queryEval).mockResolvedValue("(4 int64)")
        const request = createStaticCollectionRequest({ draft, terms, rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        await expect(request.recheck?.(undefined)).resolves.toBeUndefined()
        vi.mocked(readActionTerms).mockResolvedValueOnce({ ...terms, collectionFee: 41n })
        await expect(request.recheck?.(undefined)).rejects.toThrow("changed")
        vi.mocked(queryEval).mockResolvedValue("(5 int64)")
        vi.mocked(getLaunchpadNftCollection).mockResolvedValue({ ...draft, id: "C5", metadataMode: "static_base",
            metadataFrozen: true, revealed: true, configVersion: 2n, royaltyBPS: 0n, royalties: [], minted: 0n, totalSupply: 0n } as never)
        await expect(request.verify?.(undefined, "hash", undefined)).resolves.toBe(true)
        vi.mocked(getLaunchpadNftCollection).mockResolvedValueOnce({ ...draft, id: "C5", metadataMode: "static_base",
            metadataFrozen: true, revealed: true, configVersion: 2n, creator: treasury, royaltyBPS: 0n, royalties: [], minted: 0n, totalSupply: 0n } as never)
        await expect(request.verify?.(undefined, "hash", undefined)).resolves.toBe(false)
        expect(request.lines(undefined)).toContainEqual(["DAO collection fee", "40 ugnot"])
        expect(request.lines(undefined)).toContainEqual(["Creator royalties", "None · cannot be added later"])
    })

    it("broadcasts once with bounded gas and no retry", async () => {
        const broadcast = vi.spyOn(grc20, "doContractBroadcast").mockResolvedValue({ hash: "hash" })
        const request = createStaticCollectionRequest({ draft, terms, rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        const beforeSign = vi.fn()
        await request.send(undefined, beforeSign)
        expect(broadcast).toHaveBeenCalledWith([request.prepare(undefined).msgs[0]], "Create Civic Art collection",
            { gasWanted: 50_000_000, retry: false, beforeSign })
    })
})
