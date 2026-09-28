import { beforeEach, describe, expect, it, vi } from "vitest"
import * as grc20 from "./grc20"
import { getLaunchpadMarketListing, getLaunchpadMarketQuote, getLaunchpadMarketTokenOwner, isLaunchpadMarketPolicyReady, type LaunchpadMarketListing, type LaunchpadMarketQuote } from "./launchpadMarket"
import { buildLaunchpadBuyNativeMsg, buyLaunchpadNativeRequest } from "./launchpadTrade"

vi.mock("./launchpadMarket", () => ({
    getLaunchpadMarketListing: vi.fn(), getLaunchpadMarketQuote: vi.fn(), getLaunchpadMarketTokenOwner: vi.fn(), isLaunchpadMarketPolicyReady: vi.fn(),
}))

const buyer = `g1${"q".repeat(38)}`
const seller = `g1${"p".repeat(38)}`
const treasury = `g1${"z".repeat(38)}`
const artist = `g1${"a".repeat(38)}`
const listing: LaunchpadMarketListing = {
    id: "L7", collection: "C3", number: 2n, seller, price: 9007199254740993n,
    currency: "ugnot", expiresAt: 4102444800n, createdAt: 100n, configVersion: 8n,
    protocolFeeBPS: 50n, royaltyBPS: 500n, status: "active",
}
const protocol = listing.price * 50n / 10000n
const royalty = listing.price * 500n / 10000n
const quote: LaunchpadMarketQuote = {
    listing: listing.id, price: listing.price, currency: "ugnot",
    sellerAmount: listing.price - protocol - royalty, protocolAmount: protocol, royaltyTotal: royalty,
    treasury, currentConfigVersion: 9n, executable: true,
    royalties: [{ account: artist, amount: royalty }],
}

describe("Launchpad native purchase review", () => {
    beforeEach(() => vi.resetAllMocks())

    it("builds one exact native Buy call with lossless price, current version and storage cap", () => {
        const msg = buildLaunchpadBuyNativeMsg(listing, quote, buyer, 1000)
        expect(msg).toEqual({ type: "vm/MsgCall", value: {
            caller: buyer, send: "9007199254740993ugnot", pkg_path: "gno.land/r/samcrew/launchpad/market/v1",
            func: "Buy", args: ["L7", "9"], max_deposit: "5000000ugnot",
        } })
        expect(grc20.toAdenaMessages([msg])[0]).toMatchObject({ type: "/vm.m_call", value: { send: "9007199254740993ugnot", args: ["L7", "9"] } })
        expect(() => buildLaunchpadBuyNativeMsg({ ...listing, currency: "token" }, quote, buyer, 1000)).toThrow("ready to buy")
        expect(() => buildLaunchpadBuyNativeMsg({ ...listing, status: "filled" }, quote, buyer, 1000)).toThrow("ready to buy")
        expect(() => buildLaunchpadBuyNativeMsg(listing, { ...quote, protocolAmount: protocol + 1n, sellerAmount: quote.sellerAmount - 1n }, buyer, 1000)).toThrow("ready to buy")
    })

    it("stops before wallet review when listing or payout terms changed", async () => {
        const req = buyLaunchpadNativeRequest({ listing, quote, caller: buyer, rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        vi.mocked(getLaunchpadMarketListing).mockResolvedValueOnce({ ...listing, price: listing.price + 1n })
        vi.mocked(getLaunchpadMarketQuote).mockResolvedValueOnce(quote)
        await expect(req.recheck?.(undefined)).rejects.toThrow("changed")
        vi.mocked(getLaunchpadMarketListing).mockResolvedValueOnce(listing)
        vi.mocked(getLaunchpadMarketQuote).mockResolvedValueOnce({ ...quote, treasury: seller })
        await expect(req.recheck?.(undefined)).rejects.toThrow("changed")
        vi.mocked(getLaunchpadMarketListing).mockResolvedValueOnce(listing)
        vi.mocked(getLaunchpadMarketQuote).mockResolvedValueOnce(quote)
        vi.mocked(isLaunchpadMarketPolicyReady).mockResolvedValueOnce(false)
        await expect(req.recheck?.(undefined)).rejects.toThrow("policy changed")
    })

    it("confirms a purchase only when the token is active and owned by the buyer", async () => {
        const req = buyLaunchpadNativeRequest({ listing, quote, caller: buyer, rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        vi.mocked(getLaunchpadMarketListing).mockResolvedValue({ ...listing, status: "filled" })
        vi.mocked(getLaunchpadMarketTokenOwner).mockResolvedValueOnce(seller).mockResolvedValueOnce(buyer)
        await expect(req.verify?.(undefined, "hash", undefined)).resolves.toBe(false)
        await expect(req.verify?.(undefined, "hash", undefined)).resolves.toBe(true)
    })

    it("uses the OS broadcaster without automatic retry and carries its pre-sign recheck", async () => {
        const broadcast = vi.spyOn(grc20, "doContractBroadcast").mockResolvedValue({ hash: "hash" })
        const beforeSign = vi.fn()
        const req = buyLaunchpadNativeRequest({ listing, quote, caller: buyer, rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        await req.send(undefined, beforeSign)
        expect(broadcast).toHaveBeenCalledWith([req.prepare(undefined).msgs[0]], expect.stringContaining("Buy C3 #2"),
            { gasWanted: 50_000_000, retry: false, beforeSign })
    })
})
