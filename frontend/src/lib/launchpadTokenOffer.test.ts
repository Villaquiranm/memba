import { beforeEach, describe, expect, it, vi } from "vitest"
import { queryEval } from "./dao/shared"
import { getLaunchpadNftCollection } from "./launchpadNft"
import { getLaunchpadMarketOffer, getLaunchpadMarketTokenOwner, isLaunchpadMarketPolicyReady } from "./launchpadMarket"
import { readOfferReadiness } from "./launchpadOfferTrade"
import { approveWugnotOfferRequest, buildMakeWugnotOfferMsg, makeWugnotOfferRequest } from "./launchpadTokenOffer"
import { MARKET_SPENDER, WUGNOT_KEY, type WugnotSpend } from "./launchpadTokenTrade"

vi.mock("./dao/shared", async (original) => ({ ...(await original<typeof import("./dao/shared")>()), queryEval: vi.fn() }))
vi.mock("./launchpadNft", () => ({ getLaunchpadNftCollection: vi.fn() }))
vi.mock("./launchpadMarket", () => ({ getLaunchpadMarketOffer: vi.fn(), getLaunchpadMarketTokenOwner: vi.fn(), isLaunchpadMarketPolicyReady: vi.fn() }))

const buyer = `g1${"p".repeat(38)}`
const owner = `g1${"q".repeat(38)}`
const artist = `g1${"a".repeat(38)}`
const collection = { id: "C7", mode: "open", tradable: true, royaltyBPS: 500n,
    royalties: [{ account: artist, bps: 500n }] } as never
const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 86400)
const baseSpend: WugnotSpend = { currency: WUGNOT_KEY, owner: buyer, spender: MARKET_SPENDER,
    name: "wrapped GNOT", symbol: "wugnot", decimals: 0, balance: 1000n, allowance: 0n }

function setup(allowance = 0n, count = 4n) {
    vi.mocked(getLaunchpadNftCollection).mockResolvedValue(collection)
    vi.mocked(getLaunchpadMarketTokenOwner).mockResolvedValue(owner)
    vi.mocked(isLaunchpadMarketPolicyReady).mockResolvedValue(true)
    vi.mocked(queryEval).mockImplementation(async (_rpc, _path, expr) => {
        if (expr === "GetCurrentVersion()") return "(4 int64)"
        if (expr === "GetVersion(4).NFTSecondaryFeeBPS") return "(50 int64)"
        if (expr === "OfferCount()") return `(${count} int64)`
        if (expr.startsWith("TokenSpendJSON(")) return `(${JSON.stringify(JSON.stringify({ currency: WUGNOT_KEY, owner: buyer,
            spender: MARKET_SPENDER, name: "wrapped GNOT", symbol: "wugnot", decimals: "0",
            balance: "1000", allowance: allowance.toString() }))} string)`
        throw new Error(`Unexpected query: ${expr}`)
    })
}

describe("WUGNOT funded NFT offers", () => {
    beforeEach(() => vi.resetAllMocks())

    it("approves exact WUGNOT separately after checking its own policy", async () => {
        setup()
        const readiness = await readOfferReadiness("rpc", "C7", 3n, buyer, WUGNOT_KEY)
        expect(isLaunchpadMarketPolicyReady).toHaveBeenCalledWith("rpc", WUGNOT_KEY)
        const request = approveWugnotOfferRequest({ readiness, spend: baseSpend, price: 1000n, expiresAt,
            rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        expect(request.prepare(undefined).msgs[0]).toMatchObject({ value: { caller: buyer, send: "", func: "Approve",
            args: [MARKET_SPENDER, "1000"] } })
        await expect(request.recheck?.(undefined)).resolves.toBeUndefined()
        vi.mocked(isLaunchpadMarketPolicyReady).mockResolvedValueOnce(false)
        await expect(request.recheck?.(undefined)).rejects.toThrow("changed")
        setup(1000n)
        await expect(request.verify?.(undefined, "hash", undefined)).resolves.toBe(true)
    })

    it("funds exact WUGNOT escrow with no sent coins and verifies the next offer", async () => {
        setup(1000n)
        const readiness = await readOfferReadiness("rpc", "C7", 3n, buyer, WUGNOT_KEY)
        const spend = { ...baseSpend, allowance: 1000n }
        expect(buildMakeWugnotOfferMsg(readiness, spend, 1000n, expiresAt, BigInt(Math.floor(Date.now() / 1000)))).toMatchObject({
            value: { caller: buyer, send: "", func: "MakeOffer", args: ["C7", "3", "1000", expiresAt.toString(), WUGNOT_KEY, "4"] },
        })
        expect(() => buildMakeWugnotOfferMsg(readiness, baseSpend, 1000n, expiresAt, BigInt(Math.floor(Date.now() / 1000)))).toThrow("allowance")
        const request = makeWugnotOfferRequest({ readiness, spend, price: 1000n, expiresAt,
            rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        await expect(request.recheck?.(undefined)).resolves.toBeUndefined()
        setup(1000n, 5n)
        vi.mocked(getLaunchpadMarketOffer).mockResolvedValue({ id: "O5", collection: "C7", number: 3n, buyer, price: 1000n,
            currency: WUGNOT_KEY, expiresAt, configVersion: 4n, protocolFeeBPS: 50n, royaltyBPS: 500n, status: "active" } as never)
        await expect(request.verify?.(undefined, "hash", undefined)).resolves.toBe(true)
        vi.mocked(getLaunchpadMarketOffer).mockResolvedValueOnce({ id: "O5", collection: "C7", number: 3n, buyer, price: 1000n,
            currency: "ugnot", expiresAt, configVersion: 4n, protocolFeeBPS: 50n, royaltyBPS: 500n, status: "active" } as never)
        await expect(request.verify?.(undefined, "hash", undefined)).resolves.toBe(false)
        expect(request.lines(undefined)).toContainEqual(["Escrow deposit", "1,000 wugnot"])
    })
})
