import { beforeEach, describe, expect, it, vi } from "vitest"
import * as grc20 from "./grc20"
import { queryEval } from "./dao/shared"
import { getLaunchpadNftCollection } from "./launchpadNft"
import { getLaunchpadMarketOffer, getLaunchpadMarketTokenOwner, isLaunchpadMarketPolicyReady } from "./launchpadMarket"
import { buildMakeNativeOfferMsg, makeNativeOfferRequest, readOfferReadiness, type OfferReadiness } from "./launchpadOfferTrade"

vi.mock("./dao/shared", async (original) => ({ ...(await original<typeof import("./dao/shared")>()), queryEval: vi.fn() }))
vi.mock("./launchpadNft", () => ({ getLaunchpadNftCollection: vi.fn() }))
vi.mock("./launchpadMarket", () => ({ getLaunchpadMarketOffer: vi.fn(), getLaunchpadMarketTokenOwner: vi.fn(), isLaunchpadMarketPolicyReady: vi.fn() }))

const buyer = `g1${"p".repeat(38)}`
const owner = `g1${"q".repeat(38)}`
const artist = `g1${"a".repeat(38)}`
const collection = { id: "C7", mode: "open", tradable: true, royaltyBPS: 500n,
    royalties: [{ account: artist, bps: 500n }] } as never
const readiness: OfferReadiness = { collection, number: 3n, buyer, owner, configVersion: 4n, feeBPS: 50n, policyReady: true }

function mockRead(count = 4) {
    vi.mocked(getLaunchpadNftCollection).mockResolvedValue(collection)
    vi.mocked(getLaunchpadMarketTokenOwner).mockResolvedValue(owner)
    vi.mocked(isLaunchpadMarketPolicyReady).mockResolvedValue(true)
    vi.mocked(queryEval).mockImplementation(async (_rpc, _path, expr) => {
        if (expr === "GetCurrentVersion()") return "(4 int64)"
        if (expr === "GetVersion(4).NFTSecondaryFeeBPS") return "(50 int64)"
        if (expr === "OfferCount()") return `(${count} int64)`
        throw new Error(`Unexpected query: ${expr}`)
    })
}

describe("native funded NFT offers", () => {
    beforeEach(() => vi.resetAllMocks())

    it("reads a different owner's active Open NFT and pinned market terms", async () => {
        mockRead()
        await expect(readOfferReadiness("rpc", "C7", 3n, buyer)).resolves.toMatchObject({ buyer, owner, configVersion: 4n, feeBPS: 50n })
        vi.mocked(getLaunchpadMarketTokenOwner).mockResolvedValueOnce(buyer)
        await expect(readOfferReadiness("rpc", "C7", 3n, buyer)).rejects.toThrow("not available")
    })

    it("builds one lossless native escrow call and rejects paused or expired offers", () => {
        const price = 9007199254740993n
        const msg = buildMakeNativeOfferMsg(readiness, price, 1_086_400n, 1_000_000n)
        expect(msg).toEqual({ type: "vm/MsgCall", value: { caller: buyer, send: "9007199254740993ugnot",
            pkg_path: "gno.land/r/samcrew/launchpad/market/v1", func: "MakeOffer",
            args: ["C7", "3", price.toString(), "1086400", "ugnot", "4"], max_deposit: "5000000ugnot" } })
        expect(grc20.toAdenaMessages([msg])[0]).toMatchObject({ type: "/vm.m_call", value: { send: "9007199254740993ugnot" } })
        expect(() => buildMakeNativeOfferMsg({ ...readiness, policyReady: false }, price, 1_086_400n, 1_000_000n)).toThrow("not ready")
        expect(() => buildMakeNativeOfferMsg(readiness, price, 1_000_000n, 1_000_000n)).toThrow("not ready")
    })

    it("rechecks terms before signing and confirms only the next exact funded record", async () => {
        mockRead(4)
        const price = 1_250_000n
        const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 86400)
        const req = makeNativeOfferRequest({ readiness, price, expiresAt, rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        await expect(req.recheck?.(undefined)).resolves.toBeUndefined()
        vi.mocked(queryEval).mockImplementation(async (_rpc, _path, expr) => expr === "OfferCount()" ? "(5 int64)" : "(4 int64)")
        vi.mocked(getLaunchpadMarketOffer).mockResolvedValue({ id: "O5", collection: "C7", number: 3n, buyer, price,
            currency: "ugnot", expiresAt, createdAt: 100n, configVersion: 4n,
            protocolFeeBPS: 50n, royaltyBPS: 500n, status: "active" } as never)
        await expect(req.verify?.(undefined, "hash", undefined)).resolves.toBe(true)
        vi.mocked(getLaunchpadMarketOffer).mockResolvedValueOnce({ id: "O5", collection: "C7", number: 3n, buyer,
            price: price + 1n, currency: "ugnot", expiresAt, createdAt: 100n, configVersion: 4n,
            protocolFeeBPS: 50n, royaltyBPS: 500n, status: "active" } as never)
        await expect(req.verify?.(undefined, "hash", undefined)).resolves.toBe(false)
        vi.mocked(queryEval).mockImplementation(async (_rpc, _path, expr) => expr === "OfferCount()" ? "(6 int64)" : "(4 int64)")
        await expect(req.verify?.(undefined, "hash", undefined)).resolves.toBe(false)
        expect(req.lines(undefined)).toContainEqual(["Escrow deposit", "1.25 GNOT (1,250,000 ugnot)"])
    })

    it("broadcasts a single exact funding message without wallet retry", async () => {
        const broadcast = vi.spyOn(grc20, "doContractBroadcast").mockResolvedValue({ hash: "hash" })
        const req = makeNativeOfferRequest({ readiness, price: 1_250_000n,
            expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86400), rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        const beforeSign = vi.fn()
        await req.send(undefined, beforeSign)
        expect(broadcast).toHaveBeenCalledWith([req.prepare(undefined).msgs[0]], expect.stringContaining("Offer on C7 #3"),
            { gasWanted: 50_000_000, retry: false, beforeSign })
    })
})
