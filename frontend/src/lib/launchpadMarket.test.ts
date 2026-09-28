import { beforeEach, describe, expect, it, vi } from "vitest"
import * as shared from "./dao/shared"
import { LAUNCHPAD_MARKET_PATH } from "./nftConfig"
import { getLaunchpadMarketQuote, listLaunchpadMarketListings, parseLaunchpadMarketListing, parseLaunchpadMarketQuote } from "./launchpadMarket"

const listing = {
    id: "L1", collection: "C4", number: "1", seller: "g1seller",
    price: "10000", currency: "ugnot", expiresAt: "1000", createdAt: "500",
    configVersion: "2", protocolFeeBPS: "50", royaltyBPS: "500", status: "active",
}
const quote = {
    listing: "L1", price: "10000", currency: "ugnot",
    sellerAmount: "9450", protocolAmount: "50", royaltyTotal: "500",
    treasury: "g1treasury", currentConfigVersion: "2", executable: true,
    royalties: [{ account: "g1artist", amount: "500" }],
}
const qeval = (value: unknown) => `(${JSON.stringify(JSON.stringify(value))} string)`

describe("Launchpad market reads", () => {
    beforeEach(() => vi.restoreAllMocks())

    it("reads exact listing JSON without losing price precision", async () => {
        vi.spyOn(shared, "queryEval").mockResolvedValue(qeval([{ ...listing, price: "9007199254740993" }]))
        const items = await listLaunchpadMarketListings("https://rpc.example", 0, 20)
        expect(items[0].price).toBe(9007199254740993n)
        expect(items[0].protocolFeeBPS).toBe(50n)
        expect(shared.queryEval).toHaveBeenCalledWith("https://rpc.example", LAUNCHPAD_MARKET_PATH, "ListListingsJSON(0, 20)", true)
    })

    it("treats missing and malformed RPC results as errors, not empty inventory", async () => {
        vi.spyOn(shared, "queryEval").mockResolvedValueOnce(qeval([])).mockResolvedValueOnce(null).mockResolvedValueOnce(qeval({}))
        await expect(listLaunchpadMarketListings("rpc")).resolves.toEqual([])
        await expect(listLaunchpadMarketListings("rpc")).rejects.toThrow("Could not read")
        await expect(listLaunchpadMarketListings("rpc")).rejects.toThrow("Invalid listing list")
    })

    it("rejects impossible listing economics and status", () => {
        expect(() => parseLaunchpadMarketListing({ ...listing, price: "0" })).toThrow("Inconsistent listing terms")
        expect(() => parseLaunchpadMarketListing({ ...listing, royaltyBPS: "1001" })).toThrow("Inconsistent listing terms")
        expect(() => parseLaunchpadMarketListing({ ...listing, status: "pending" })).toThrow("Invalid listing status")
        expect(() => parseLaunchpadMarketListing({ ...listing, price: 1000 })).toThrow("Invalid listing price")
    })

    it("checks that a quote allocates the entire listing price", async () => {
        const item = parseLaunchpadMarketListing(listing)
        vi.spyOn(shared, "queryEval").mockResolvedValue(qeval(quote))
        const result = await getLaunchpadMarketQuote("https://rpc.example", item)
        expect(result.sellerAmount + result.protocolAmount + result.royaltyTotal).toBe(item.price)
        expect(shared.queryEval).toHaveBeenCalledWith("https://rpc.example", LAUNCHPAD_MARKET_PATH, 'QuoteJSON("L1")', true)
        expect(() => parseLaunchpadMarketQuote({ ...quote, protocolAmount: "51" }, item)).toThrow("Inconsistent market quote")
        expect(() => parseLaunchpadMarketQuote({ ...quote, protocolAmount: "51", sellerAmount: "9449" }, item)).toThrow("Inconsistent market quote")
        expect(() => parseLaunchpadMarketQuote({ ...quote, royalties: [] }, item)).toThrow("Inconsistent market quote")
        expect(() => parseLaunchpadMarketQuote({ ...quote, listing: "L2" }, item)).toThrow("Inconsistent market quote")
    })
})
