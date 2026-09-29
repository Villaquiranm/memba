import { beforeEach, describe, expect, it, vi } from "vitest"
import * as grc20 from "./grc20"
import { getLaunchpadMarketOffer, getLaunchpadMarketTokenOwner, getLaunchpadOfferQuote, isLaunchpadMarketPolicyReady,
    type LaunchpadMarketOffer, type LaunchpadOfferQuote } from "./launchpadMarket"
import { acceptOfferRequest, buildAcceptOfferMsg } from "./launchpadOfferAccept"

vi.mock("./launchpadMarket", () => ({ getLaunchpadMarketOffer: vi.fn(), getLaunchpadMarketTokenOwner: vi.fn(),
    getLaunchpadOfferQuote: vi.fn(), isLaunchpadMarketPolicyReady: vi.fn() }))

const seller = `g1${"p".repeat(38)}`
const buyer = `g1${"q".repeat(38)}`
const treasury = `g1${"t".repeat(38)}`
const artist = `g1${"a".repeat(38)}`
const offer: LaunchpadMarketOffer = { id: "O7", collection: "C4", number: 2n, buyer, price: 10_000n,
    currency: "ugnot", expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86400), createdAt: 100n,
    configVersion: 3n, protocolFeeBPS: 50n, royaltyBPS: 500n, status: "active" }
const quote: LaunchpadOfferQuote = { offer: "O7", price: 10_000n, currency: "ugnot", sellerAmount: 9_450n,
    protocolAmount: 50n, royaltyTotal: 500n, treasury, currentConfigVersion: 4n, executable: true,
    royalties: [{ account: artist, amount: 500n }] }

describe("seller accepts a funded offer", () => {
    beforeEach(() => {
        vi.resetAllMocks()
        vi.mocked(getLaunchpadMarketOffer).mockResolvedValue(offer)
        vi.mocked(getLaunchpadOfferQuote).mockResolvedValue(quote)
        vi.mocked(getLaunchpadMarketTokenOwner).mockResolvedValue(seller)
        vi.mocked(isLaunchpadMarketPolicyReady).mockResolvedValue(true)
    })

    it("builds a no-payment, current-policy call and rejects ineligible terms", () => {
        expect(buildAcceptOfferMsg(offer, quote, seller)).toEqual({ type: "vm/MsgCall", value: {
            caller: seller, send: "", pkg_path: "gno.land/r/samcrew/launchpad/market/v1", func: "AcceptOffer",
            args: ["O7", "4"], max_deposit: "5000000ugnot" } })
        expect(() => buildAcceptOfferMsg(offer, quote, buyer)).toThrow("not ready")
        expect(() => buildAcceptOfferMsg(offer, { ...quote, executable: false }, seller)).toThrow("not ready")
        expect(() => buildAcceptOfferMsg(offer, { ...quote, sellerAmount: 9_449n }, seller)).toThrow("not ready")
        expect(() => buildAcceptOfferMsg({ ...offer, status: "expired" }, quote, seller)).toThrow("not ready")
    })

    it("rechecks owner, policy and exact payout before signing", async () => {
        const request = acceptOfferRequest({ offer, quote, seller, rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 70_000 })
        await expect(request.recheck?.(undefined)).resolves.toBeUndefined()
        vi.mocked(getLaunchpadMarketTokenOwner).mockResolvedValueOnce(buyer)
        await expect(request.recheck?.(undefined)).rejects.toThrow("changed")
        vi.mocked(getLaunchpadOfferQuote).mockResolvedValueOnce({ ...quote, treasury: artist })
        await expect(request.recheck?.(undefined)).rejects.toThrow("changed")
        vi.mocked(isLaunchpadMarketPolicyReady).mockResolvedValueOnce(false)
        await expect(request.recheck?.(undefined)).rejects.toThrow("changed")
        expect(request.lines(undefined)).toContainEqual(["You receive", "9,450 ugnot"])
        expect(request.lines(undefined)).toContainEqual(["DAO treasury", treasury])
    })

    it("verifies both terminal offer state and buyer ownership", async () => {
        const request = acceptOfferRequest({ offer, quote, seller, rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 70_000 })
        vi.mocked(getLaunchpadMarketOffer).mockResolvedValueOnce({ ...offer, status: "accepted" })
        vi.mocked(getLaunchpadMarketTokenOwner).mockResolvedValueOnce(buyer)
        await expect(request.verify?.(undefined, "hash", undefined)).resolves.toBe(true)
        vi.mocked(getLaunchpadMarketOffer).mockResolvedValueOnce({ ...offer, status: "accepted" })
        await expect(request.verify?.(undefined, "hash", undefined)).resolves.toBe(false)
        vi.mocked(getLaunchpadMarketOffer).mockResolvedValueOnce({ ...offer, status: "cancelled" })
        await expect(request.verify?.(undefined, "hash", undefined)).resolves.toBe(false)
    })

    it("sends once without wallet retry", async () => {
        const broadcast = vi.spyOn(grc20, "doContractBroadcast").mockResolvedValue({ hash: "hash" })
        const request = acceptOfferRequest({ offer, quote, seller, rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 70_000 })
        const beforeSign = vi.fn()
        await request.send(undefined, beforeSign)
        expect(broadcast).toHaveBeenCalledWith([request.prepare(undefined).msgs[0]], "Accept offer O7",
            { gasWanted: 50_000_000, retry: false, beforeSign })
    })
})
